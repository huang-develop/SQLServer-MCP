#!/usr/bin/env node
/**
 * SQLServer MCP Server
 * ------------------------------------------------------------
 * 通过 MCP 协议连接本地（或任意）SQL Server 数据库，
 * 提供查询、执行、元数据查看等能力，支持任意 SQL 操作。
 *
 * 配置优先级：环境变量 > config.json > 默认值
 *   环境变量: SQLSERVER_SERVER / SQLSERVER_PORT / SQLSERVER_INSTANCE
 *             SQLSERVER_DATABASE / SQLSERVER_USER / SQLSERVER_PASSWORD
 *             SQLSERVER_WINDOWS_AUTH / SQLSERVER_ENCRYPT / SQLSERVER_TRUST_CERT
 *             SQLSERVER_TIMEOUT / SQLSERVER_DEBUG
 *
 * 注意：stdout 只走 MCP 协议流，日志一律输出到 stderr。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const mssql = require('mssql');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_MAX_ROWS = 500;
const SAFE_IDENT = /^[A-Za-z0-9_\[\]\s.\-]+$/;

// ---------------- 日志（写 stderr，避免污染 stdout 协议流） ----------------
const DEBUG =
  process.env.SQLSERVER_DEBUG === '1' || process.env.SQLSERVER_DEBUG === 'true';
function log(...args) {
  if (DEBUG) console.error('[SQLServerMCP]', ...args);
}

/** 统一提取错误信息（msnodesqlv8 的错误 message 可能是对象） */
function fmtErr(e) {
  if (!e) return String(e);
  if (typeof fmtErr(e) === 'object' && fmtErr(e) !== null) {
    try { return JSON.stringify(fmtErr(e)); } catch (err) { return String(fmtErr(e)); }
  }
  if (typeof fmtErr(e) === 'string') return fmtErr(e);
  try { return JSON.stringify(e); } catch (err) { return String(e); }
}

// ---------------- 配置加载 ----------------
function loadConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[SQLServerMCP] 解析 config.json 失败，使用默认配置:', fmtErr(e));
  }
  const env = process.env;
  const bool = (v, def) => {
    if (v === undefined || v === null || v === '') return def;
    return String(v).toLowerCase() === 'true';
  };
  return {
    server: env.SQLSERVER_SERVER || fileCfg.server || 'localhost',
    port: parseInt(env.SQLSERVER_PORT || fileCfg.port || '1433', 10),
    instanceName: env.SQLSERVER_INSTANCE || fileCfg.instanceName || '',
    database: env.SQLSERVER_DATABASE || fileCfg.database || 'master',
    user: env.SQLSERVER_USER || fileCfg.user || 'sa',
    password: env.SQLSERVER_PASSWORD || fileCfg.password || '',
    windowsAuth: bool(env.SQLSERVER_WINDOWS_AUTH, !!fileCfg.windowsAuth),
    encrypt: bool(env.SQLSERVER_ENCRYPT, fileCfg.encrypt !== undefined ? !!fileCfg.encrypt : true),
    trustServerCertificate: bool(
      env.SQLSERVER_TRUST_CERT,
      fileCfg.trustServerCertificate !== undefined ? !!fileCfg.trustServerCertificate : true
    ),
    requestTimeout: parseInt(env.SQLSERVER_TIMEOUT || fileCfg.requestTimeout || '60000', 10),
    odbcDriver: env.SQLSERVER_ODBC_DRIVER || fileCfg.odbcDriver || 'ODBC Driver 17 for SQL Server'
  };
}

function saveConfig(cfg) {
  const { password, ...safe } = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...safe, password: password || '' }, null, 2), 'utf8');
}

function poolKey(cfg) {
  return `${cfg.server}\\${cfg.instanceName}:${cfg.port}/${cfg.database}`;
}

function withDatabase(db) {
  const cfg = { ...currentConfig };
  if (db !== undefined && db !== null && db !== '') {
    if (!SAFE_IDENT.test(String(db))) throw new Error('非法数据库名称: ' + db);
    cfg.database = String(db).replace(/\[|\]/g, '');
  }
  return cfg;
}

// ---------------- 连接池管理 ----------------
const pools = new Map(); // key -> ConnectionPool

async function getPool(cfg) {
  const key = poolKey(cfg);
  const existing = pools.get(key);
  if (existing && existing.connected) return existing;
  if (existing) {
    try { await existing.close(); } catch (e) { log('关闭旧连接池失败:', fmtErr(e)); }
    pools.delete(key);
  }

  log('创建连接池:', key);
  const server = cfg.instanceName ? `${cfg.server}\\${cfg.instanceName}` : cfg.server;
  const connCfg = {
    server,
    port: cfg.port,
    database: cfg.database,
    requestTimeout: cfg.requestTimeout,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
      enableArithAbort: true
    }
  };

  let driver = mssql;
  if (cfg.windowsAuth) {
    try {
      driver = require('mssql/msnodesqlv8');
    } catch (e) {
      throw new Error('Windows 集成认证需要 msnodesqlv8 驱动，请在 SQLServerMCP 目录执行: npm install msnodesqlv8');
    }
    connCfg.driver = 'msnodesqlv8';
    connCfg.options.trustedConnection = true;
    // mssql 在 Windows 上默认使用已过时的 'SQL Server Native Client 11.0'，
    // 通过 beforeConnect 改写连接串，改用本机实际安装的 ODBC 驱动（默认 Driver 17）
    connCfg.beforeConnect = (rawCfg) => {
      const serverPart = cfg.instanceName
        ? `${cfg.server}\\${cfg.instanceName}`
        : `${cfg.server},${cfg.port}`;
      rawCfg.conn_str = [
        `Driver={${cfg.odbcDriver || 'ODBC Driver 17 for SQL Server'}}`,
        `Server=${serverPart}`,
        `Database=${cfg.database}`,
        'Trusted_Connection=Yes',
        `Encrypt=${cfg.encrypt ? 'Yes' : 'No'}`,
        `TrustServerCertificate=${cfg.trustServerCertificate ? 'Yes' : 'No'}`
      ].join(';') + ';';
    };
  } else {
    connCfg.user = cfg.user;
    connCfg.password = cfg.password;
  }

  const pool = new driver.ConnectionPool(connCfg);
  await pool.connect();
  pools.set(key, pool);
  return pool;
}

async function closeAllPools() {
  for (const [key, pool] of pools) {
    try { await pool.close(); } catch (e) { log('关闭连接池失败:', key, fmtErr(e)); }
  }
  pools.clear();
}

// ---------------- 返回格式辅助 ----------------
function okJson(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function formatRecordset(rs, maxRows) {
  const total = rs.length;
  return { rows: rs.slice(0, maxRows), truncated: total > maxRows, total };
}

function formatQueryResult(result, maxRows, elapsedMs) {
  const out = { elapsedMs };
  // 多结果集（例如多条 SELECT 一起执行）
  if (result.recordsets && result.recordsets.length > 1) {
    out.resultsets = result.recordsets.map((rs) => formatRecordset(rs, maxRows));
    return okJson(out);
  }
  // 单结果集（SELECT）
  if (result.recordset) {
    const { rows, truncated, total } = formatRecordset(result.recordset, maxRows);
    out.rows = rows;
    out.rowCount = total;
    if (truncated) {
      out.truncated = true;
      out.message = `结果超过 ${maxRows} 行，已截断；可用 maxRows 参数调大上限（最大 10000）`;
    }
    return okJson(out);
  }
  // 非查询语句
  out.affected = (result.rowsAffected || []).reduce((a, b) => a + (b || 0), 0);
  out.message = '执行成功（非查询语句）';
  return okJson(out);
}

function buildType(col) {
  const t = String(col.DATA_TYPE || '');
  if (['nvarchar', 'varchar', 'nchar', 'char', 'varbinary', 'binary'].includes(t)) {
    const len = col.CHARACTER_MAXIMUM_LENGTH;
    return `${t}(${len === -1 ? 'max' : len})`;
  }
  if (t === 'decimal' || t === 'numeric') {
    return `${t}(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
  }
  return t;
}

function truncateSql(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '...' : t;
}

/** 按 SQL Server 的 GO 规则拆分脚本为多个批次 */
function splitBatches(sqlText) {
  const lines = String(sqlText).split(/\r?\n/);
  const batches = [];
  let cur = [];
  const flush = (repeat = 1) => {
    const text = cur.join('\n').trim();
    cur = [];
    if (!text) return;
    for (let i = 0; i < repeat; i++) batches.push(text);
  };
  for (const line of lines) {
    const m = line.match(/^\s*GO\s*(\d*)\s*$/i);
    if (m) {
      flush(Math.max(1, parseInt(m[1] || '1', 10) || 1));
    } else {
      cur.push(line);
    }
  }
  flush(1);
  return batches;
}

// ---------------- MCP Server 与工具注册 ----------------
let currentConfig = loadConfig();

const server = new McpServer(
  { name: 'sqlserver-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// 1. 测试连接
server.tool(
  'test_connection',
  '测试与 SQL Server 的连接，返回服务器版本、当前数据库、当前连接配置（密码已脱敏）。无参数。',
  {},
  async () => {
    try {
      const pool = await getPool(currentConfig);
      const r = await pool.request().query(
        `SELECT @@VERSION AS version, DB_NAME() AS current_db,
                SERVERPROPERTY('ProductLevel') AS product_level,
                SERVERPROPERTY('Edition') AS edition`
      );
      const row = r.recordset[0];
      const { password, ...cfgInfo } = currentConfig;
      return okJson({
        connected: true,
        server: `${currentConfig.server}${currentConfig.instanceName ? '\\' + currentConfig.instanceName : ''}:${currentConfig.port}`,
        database: row.current_db,
        edition: row.edition,
        productLevel: row.product_level,
        version: row.version ? String(row.version).split('\n')[0].trim() : '',
        config: cfgInfo
      });
    } catch (e) {
      return err(`连接失败: ${fmtErr(e)}\n请先修改 config.json 或用 configure_connection 工具配置正确的连接信息。`);
    }
  }
);

// 2. 修改连接配置（运行时生效，可选持久化）
server.tool(
  'configure_connection',
  '修改 SQL Server 连接配置（server/port/instanceName/database/user/password 等）。设置后立即生效，下次数据库操作使用新配置；persist=true 时写入 config.json 永久保存。',
  {
    server: z.string().optional().describe('服务器地址，如 localhost 或 192.168.1.10'),
    port: z.number().int().positive().optional().describe('端口，默认 1433'),
    instanceName: z.string().optional().describe('命名实例名，如 SQLEXPRESS'),
    database: z.string().optional().describe('默认数据库，如 master'),
    user: z.string().optional().describe('SQL 登录名'),
    password: z.string().optional().describe('SQL 登录密码'),
    windowsAuth: z.boolean().optional().describe('是否使用 Windows 集成认证（需安装 msnodesqlv8）'),
    odbcDriver: z.string().optional().describe('Windows 认证使用的 ODBC 驱动名，默认 "ODBC Driver 17 for SQL Server"'),
    encrypt: z.boolean().optional().describe('是否加密连接，默认 true'),
    trustServerCertificate: z.boolean().optional().describe('是否信任服务器证书，默认 true'),
    requestTimeout: z.number().int().positive().optional().describe('单条 SQL 超时毫秒数，默认 60000'),
    persist: z.boolean().optional().describe('是否写入 config.json 永久保存，默认 false')
  },
  async (args) => {
    try {
      const next = { ...currentConfig };
      if (args.server !== undefined) next.server = args.server;
      if (args.port !== undefined) next.port = args.port;
      if (args.instanceName !== undefined) next.instanceName = args.instanceName;
      if (args.database !== undefined) next.database = args.database;
      if (args.user !== undefined) next.user = args.user;
      if (args.password !== undefined) next.password = args.password;
      if (args.windowsAuth !== undefined) next.windowsAuth = args.windowsAuth;
      if (args.odbcDriver !== undefined) next.odbcDriver = args.odbcDriver;
      if (args.encrypt !== undefined) next.encrypt = args.encrypt;
      if (args.trustServerCertificate !== undefined) next.trustServerCertificate = args.trustServerCertificate;
      if (args.requestTimeout !== undefined) next.requestTimeout = args.requestTimeout;
      await closeAllPools();
      currentConfig = next;
      if (args.persist) saveConfig(next);
      return okJson({
        configured: true,
        persist: !!args.persist,
        config: { ...next, password: next.password ? '******' : '' }
      });
    } catch (e) {
      return err('配置失败: ' + fmtErr(e));
    }
  }
);

// 3. 列出所有数据库
server.tool('list_databases', '列出 SQL Server 实例上的所有数据库。', {}, async () => {
  try {
    const pool = await getPool(currentConfig);
    const r = await pool.request().query(
      `SELECT name, database_id, create_date, state_desc FROM sys.databases ORDER BY name`
    );
    return okJson({ databases: r.recordset, count: r.recordset.length });
  } catch (e) {
    return err('查询失败: ' + fmtErr(e));
  }
});

// 4. 列出表
server.tool(
  'list_tables',
  '列出指定数据库中的表（可含视图）。',
  {
    database: z.string().optional().describe('目标数据库名，默认使用当前连接数据库'),
    schema: z.string().optional().describe('架构名，默认 dbo'),
    includeViews: z.boolean().optional().describe('是否包含视图，默认 false')
  },
  async (args) => {
    try {
      const cfg = withDatabase(args.database);
      const pool = await getPool(cfg);
      const schema = args.schema || 'dbo';
      const typeFilter = args.includeViews
        ? "AND TABLE_TYPE IN ('BASE TABLE','VIEW')"
        : "AND TABLE_TYPE = 'BASE TABLE'";
      const r = await pool
        .request()
        .input('schema', mssql.NVarChar, schema)
        .query(
          `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
           WHERE TABLE_SCHEMA = @schema ${typeFilter} ORDER BY TABLE_NAME`
        );
      return okJson({ database: cfg.database, schema, tables: r.recordset, count: r.recordset.length });
    } catch (e) {
      return err('查询失败: ' + fmtErr(e));
    }
  }
);

// 5. 查看表结构
server.tool(
  'describe_table',
  '查看表结构：列名、类型、是否可空、默认值、是否主键。',
  {
    table: z.string().describe('表名'),
    schema: z.string().optional().describe('架构名，默认 dbo'),
    database: z.string().optional().describe('目标数据库名，默认当前连接数据库')
  },
  async (args) => {
    try {
      if (!args.table || !String(args.table).trim()) return err('必须提供 table 参数');
      const cfg = withDatabase(args.database);
      const pool = await getPool(cfg);
      const schema = args.schema || 'dbo';
      const r = await pool
        .request()
        .input('schema', mssql.NVarChar, schema)
        .input('table', mssql.NVarChar, String(args.table).trim())
        .query(
          `SELECT
             c.ORDINAL_POSITION,
             c.COLUMN_NAME,
             c.DATA_TYPE,
             c.CHARACTER_MAXIMUM_LENGTH,
             c.NUMERIC_PRECISION,
             c.NUMERIC_SCALE,
             c.IS_NULLABLE,
             c.COLUMN_DEFAULT,
             CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY
           FROM INFORMATION_SCHEMA.COLUMNS c
           LEFT JOIN (
             SELECT kcu.COLUMN_NAME
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
               ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
               AND kcu.TABLE_SCHEMA = @schema AND kcu.TABLE_NAME = @table
           ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
           WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
           ORDER BY c.ORDINAL_POSITION`
        );
      if (!r.recordset.length) return err(`表 [${schema}].[${args.table}] 不存在`);
      const columns = r.recordset.map((col) => ({
        position: col.ORDINAL_POSITION,
        name: col.COLUMN_NAME,
        type: buildType(col),
        nullable: col.IS_NULLABLE === 'YES',
        primaryKey: !!col.IS_PRIMARY_KEY,
        default: col.COLUMN_DEFAULT
      }));
      return okJson({ database: cfg.database, schema, table: args.table, columns, count: columns.length });
    } catch (e) {
      return err('查询失败: ' + fmtErr(e));
    }
  }
);

// 6. 执行任意 SQL
server.tool(
  'execute_query',
  '执行任意 SQL 语句（SELECT/INSERT/UPDATE/DELETE/DDL 等）。支持命名参数：SQL 中写 @name，params 传 { name: value }（键不需要 @ 前缀）。SELECT 返回行数据，非查询语句返回受影响行数。',
  {
    sql: z.string().describe('要执行的 SQL 语句'),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('命名参数，例如 { name: "张三", age: 30 }'),
    database: z.string().optional().describe('目标数据库名，默认当前连接数据库'),
    maxRows: z.number().int().positive().max(10000).optional().describe('SELECT 最多返回行数，默认 500'),
    timeout: z.number().int().positive().optional().describe('超时毫秒数，默认 60000')
  },
  async (args) => {
    const sqlText = String(args.sql || '').trim();
    if (!sqlText) return err('必须提供 sql 参数');
    const maxRows = args.maxRows || DEFAULT_MAX_ROWS;
    try {
      const cfg = withDatabase(args.database);
      const pool = await getPool(cfg);
      const req = pool.request();
      if (args.timeout) req.timeout = args.timeout;
      if (args.params) {
        for (const [k, v] of Object.entries(args.params)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return err(`非法参数名: ${k}`);
          if (v === null) req.input(k, mssql.NVarChar, null);
          else req.input(k, v);
        }
      }
      const t0 = Date.now();
      const result = await req.query(sqlText);
      return formatQueryResult(result, maxRows, Date.now() - t0);
    } catch (e) {
      return err(`SQL 执行失败: ${fmtErr(e)}`);
    }
  }
);

// 7. 批量执行脚本
server.tool(
  'execute_script',
  '批量执行一段 SQL 脚本，支持多条语句与 GO 分隔符（按顺序执行，任一批次失败即停止并报告）。适合建表、初始化数据等场景。',
  {
    sql: z.string().describe('SQL 脚本内容（多条语句用 ; 或 GO 分隔）'),
    database: z.string().optional().describe('目标数据库名，默认当前连接数据库'),
    timeout: z.number().int().positive().optional().describe('每个批次的超时毫秒数')
  },
  async (args) => {
    if (!args.sql || !String(args.sql).trim()) return err('必须提供 sql 参数');
    try {
      const cfg = withDatabase(args.database);
      const pool = await getPool(cfg);
      const batches = splitBatches(args.sql);
      if (!batches.length) return err('脚本内容为空');
      const results = [];
      const t0 = Date.now();
      for (let i = 0; i < batches.length; i++) {
        const req = pool.request();
        if (args.timeout) req.timeout = args.timeout;
        try {
          const r = await req.batch(batches[i]);
          results.push({
            batch: i + 1,
            status: 'ok',
            affected: (r.rowsAffected || []).reduce((a, b) => a + (b || 0), 0),
            sql: truncateSql(batches[i])
          });
        } catch (e) {
          results.push({ batch: i + 1, status: 'error', message: fmtErr(e), sql: truncateSql(batches[i]) });
          return okJson({ success: false, totalBatches: batches.length, elapsedMs: Date.now() - t0, results });
        }
      }
      return okJson({ success: true, totalBatches: batches.length, elapsedMs: Date.now() - t0, results });
    } catch (e) {
      return err('脚本执行失败: ' + fmtErr(e));
    }
  }
);

// ---------------- 启动 ----------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    'SQLServer MCP 已启动，配置:',
    JSON.stringify({
      server: `${currentConfig.server}${currentConfig.instanceName ? '\\' + currentConfig.instanceName : ''}:${currentConfig.port}`,
      database: currentConfig.database,
      user: currentConfig.windowsAuth ? '(Windows 认证)' : currentConfig.user
    })
  );
}

process.on('SIGINT', async () => {
  await closeAllPools();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closeAllPools();
  process.exit(0);
});

main().catch((e) => {
  console.error('[SQLServerMCP] 启动失败:', e);
  process.exit(1);
});
