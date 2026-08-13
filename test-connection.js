#!/usr/bin/env node
/**
 * 独立连接测试脚本（不经过 MCP，直接验证 SQL Server 能否连通）。
 *
 * 用法：
 *   node test-connection.js
 *   node test-connection.js --server=192.168.1.10 --database=MyDB --user=sa --password=xxx
 *   node test-connection.js --windowsAuth=true
 *
 * 也可通过环境变量覆盖：SQLSERVER_SERVER / SQLSERVER_PORT / SQLSERVER_DATABASE / SQLSERVER_USER / SQLSERVER_PASSWORD
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mssql = require('mssql');

const CONFIG_PATH = path.join(__dirname, 'config.json');

/** 统一提取错误信息（msnodesqlv8 的错误 message 可能是对象） */
function fmtErr(e) {
  if (!e) return String(e);
  if (typeof e.message === 'object' && e.message !== null) {
    try { return JSON.stringify(e.message); } catch (err) { return String(e.message); }
  }
  if (typeof e.message === 'string') return e.message;
  try { return JSON.stringify(e); } catch (err) { return String(e); }
}

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    // 忽略：使用默认值
  }
  const env = process.env;
  const args = {};
  process.argv.slice(2).forEach((a) => {
    if (a.startsWith('--')) {
      const idx = a.indexOf('=');
      const k = idx === -1 ? a.slice(2) : a.slice(2, idx);
      args[k] = idx === -1 ? true : a.slice(idx + 1);
    }
  });
  const boolValue = (argName, envName, fileValue, defaultValue) => {
    const value = args[argName] !== undefined
      ? args[argName]
      : env[envName] !== undefined
        ? env[envName]
        : fileValue !== undefined
          ? fileValue
          : defaultValue;
    return value === true || String(value).toLowerCase() === 'true';
  };
  return {
    server: args.server || env.SQLSERVER_SERVER || fileCfg.server || 'localhost',
    port: parseInt(args.port || env.SQLSERVER_PORT || fileCfg.port || '1433', 10),
    instanceName: args.instanceName || env.SQLSERVER_INSTANCE || fileCfg.instanceName || '',
    database: args.database || env.SQLSERVER_DATABASE || fileCfg.database || 'master',
    user: args.user || env.SQLSERVER_USER || fileCfg.user || 'sa',
    password: args.password || env.SQLSERVER_PASSWORD || fileCfg.password || '',
    windowsAuth: boolValue('windowsAuth', 'SQLSERVER_WINDOWS_AUTH', fileCfg.windowsAuth, false),
    odbcDriver: args.odbcDriver || env.SQLSERVER_ODBC_DRIVER || fileCfg.odbcDriver || 'ODBC Driver 17 for SQL Server',
    encrypt: boolValue('encrypt', 'SQLSERVER_ENCRYPT', fileCfg.encrypt, true),
    trustServerCertificate: boolValue('trustServerCertificate', 'SQLSERVER_TRUST_CERT', fileCfg.trustServerCertificate, true),
    requestTimeout: parseInt(args.requestTimeout || env.SQLSERVER_TIMEOUT || fileCfg.requestTimeout || '30000', 10)
  };
}

async function main() {
  const cfg = loadConfig();
  const serverName = cfg.instanceName ? `${cfg.server}\\${cfg.instanceName}` : cfg.server;
  console.log('== SQL Server 连接测试 ==');
  console.log(`  服务器 : ${serverName}:${cfg.port}`);
  console.log(`  数据库 : ${cfg.database}`);
  console.log(`  登录   : ${cfg.windowsAuth ? '(Windows 集成认证)' : cfg.user}`);
  console.log('  正在连接...');

  let driver = mssql;
  if (cfg.windowsAuth) {
    try {
      driver = require('mssql/msnodesqlv8');
    } catch (e) {
      throw new Error('Windows 集成认证需要 msnodesqlv8 驱动，请执行: npm install msnodesqlv8');
    }
  }

  const connCfg = {
    server: serverName,
    port: cfg.port,
    database: cfg.database,
    requestTimeout: cfg.requestTimeout,
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
      enableArithAbort: true
    }
  };
  if (cfg.windowsAuth) {
    connCfg.driver = 'msnodesqlv8';
    connCfg.options.trustedConnection = true;
    // mssql 在 Windows 上默认使用已过时的 'SQL Server Native Client 11.0'，
    // 通过 beforeConnect 改写连接串，改用本机实际安装的 ODBC 驱动（默认 Driver 17）
    connCfg.beforeConnect = (rawCfg) => {
      const serverPart = cfg.instanceName
        ? `${cfg.server}\\${cfg.instanceName}`
        : `${cfg.server},${cfg.port}`;
      rawCfg.conn_str = [
        `Driver={${String(cfg.odbcDriver).replace(/}/g, '}}')}}`,
        `Server={${String(serverPart).replace(/}/g, '}}')}}`,
        `Database={${String(cfg.database).replace(/}/g, '}}')}}`,
        'Trusted_Connection=Yes',
        `Encrypt=${cfg.encrypt ? 'Yes' : 'No'}`,
        `TrustServerCertificate=${cfg.trustServerCertificate ? 'Yes' : 'No'}`
      ].join(';') + ';';
    };
  } else {
    connCfg.user = cfg.user;
    connCfg.password = cfg.password;
  }

  const pool = await new driver.ConnectionPool(connCfg).connect();
  pool.on('error', (e) => console.error('  连接池错误:', fmtErr(e)));
  try {
    const r = await pool.request().query('SELECT @@VERSION AS v, DB_NAME() AS db');
    const row = r.recordset[0];
    console.log('');
    console.log('  ✔ 连接成功!');
    console.log(`  当前数据库 : ${row.db}`);
    console.log(`  版本       : ${String(row.v).split('\n')[0].trim()}`);
  } finally {
    await pool.close();
    console.log('  连接已关闭');
  }
}

main().catch((e) => {
  console.error('');
  console.error('  ✘ 连接失败:', fmtErr(e));
  console.error('');
  console.error('  排查建议:');
  console.error('  1. SQL Server 服务是否启动（服务名 MSSQLSERVER / MSSQL$实例名）');
  console.error('  2. 是否开启 TCP/IP 协议：SQL Server 配置管理器 -> SQL Server 网络配置 -> 启用 TCP/IP');
  console.error('  3. 是否启用 SQL Server 身份验证（或改用 --windowsAuth=true）');
  console.error('  4. 端口/实例名是否正确（默认 1433；命名实例用 --instanceName 指定）');
  process.exit(1);
});
