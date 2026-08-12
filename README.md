# SQLServer MCP Server

一个基于 [MCP](https://modelcontextprotocol.io) 协议的 SQL Server 数据库操作服务器，可以让 AI 助手直接连接本地（或任意）SQL Server，执行**任意 SQL 操作**：查询、增删改、建表、跑脚本等。

## 功能（工具列表）

| 工具 | 说明 |
| --- | --- |
| `test_connection` | 测试连接，返回服务器版本、当前数据库、连接配置（密码脱敏） |
| `configure_connection` | 运行时修改连接配置（服务器/端口/库/账号/密码等），可选持久化 |
| `list_databases` | 列出实例上所有数据库 |
| `list_tables` | 列出指定数据库的表（可含视图、指定架构） |
| `describe_table` | 查看表结构：列、类型、可空、默认值、主键 |
| `execute_query` | 执行任意 SQL，支持命名参数，SELECT 返回行数据（默认最多 500 行） |
| `execute_script` | 批量执行 SQL 脚本，支持 `GO` 分隔符，失败即停并报告 |

## 目录结构

```
SQLServerMCP/
├── index.js             # MCP 服务器主程序（入口）
├── config.json          # 连接配置（编辑这里改数据库）
├── config.example.json  # 配置示例
├── test-connection.js   # 独立连接测试脚本（不经过 MCP）
├── package.json
└── node_modules/
```

## 快速开始

### 1. 安装依赖（已装可跳过）

```bash
cd D:\DATA\Desktop\SQLServerMCP
npm install
```

### 2. 配置连接

编辑 `config.json`：

```json
{
  "server": "localhost",        // 服务器地址
  "port": 1433,                 // 端口
  "instanceName": "",           // 命名实例，如 SQLEXPRESS
  "database": "master",         // 默认数据库
  "user": "sa",                 // SQL 登录名
  "password": "你的密码",        // SQL 登录密码
  "windowsAuth": false,         // true = Windows 集成认证（需装 msnodesqlv8）
  "odbcDriver": "ODBC Driver 17 for SQL Server",  // Windows 认证用的 ODBC 驱动名
  "encrypt": true,
  "trustServerCertificate": true,
  "requestTimeout": 60000
}
```

> 提示：Windows 认证模式下，程序会自动改写连接串使用 `odbcDriver` 指定的驱动（mssql 默认的 `SQL Server Native Client 11.0` 在 Win 上常未安装）。若本机装的是 Driver 18，把这里改成 `ODBC Driver 18 for SQL Server` 即可。

也可以用环境变量覆盖（优先级最高）：`SQLSERVER_SERVER`、`SQLSERVER_PORT`、`SQLSERVER_DATABASE`、`SQLSERVER_USER`、`SQLSERVER_PASSWORD`、`SQLSERVER_WINDOWS_AUTH` 等。

### 3. 测试连接

```bash
node test-connection.js
```

看到 `✔ 连接成功` 即表示配置正确。

### 4. 在 WorkBuddy 中启用

1. 打开 WorkBuddy **连接器管理页**，右上角「自定义连接」入口
2. 对 `sqlserver-mcp` 点击 **信任（Trust）** 启用
3. 在对话中直接说"查询 X 表的数据"即可使用

## 使用示例（对话中）

- 「测试一下 SQL Server 连接」
- 「列出所有数据库」
- 「查看数据库 MyDB 里有哪些表」
- 「查看表 [dbo].[Orders] 的结构」
- 「执行 SQL：SELECT TOP 10 * FROM Orders WHERE Status = 1」
- 「在 MyDB 里建一张表并插入几条测试数据」

## 常见问题

**连接失败 / 登录失败**
- 确认 SQL Server 服务已启动（服务名 `MSSQLSERVER` 或 `MSSQL$<实例名>`）
- 在「SQL Server 配置管理器 → SQL Server 网络配置」中**启用 TCP/IP**，并重启服务
- 若用 SQL 账号登录，需在服务器属性中启用「SQL Server 和 Windows 身份验证模式」
- 本机默认实例端口 1433；命名实例用 `instanceName` 配置（如 `SQLEXPRESS`），无需写端口

**Windows 集成认证**
- `windowsAuth: true` 需要额外的原生驱动：`npm install msnodesqlv8`（本项目已装好）
- 如果报 `SQL Server Native Client 11.0` 相关错误，说明本机没装该旧驱动，程序已自动改用 `odbcDriver` 指定的驱动（默认 `ODBC Driver 17 for SQL Server`），确认本机 ODBC 驱动名后可在配置中调整

**查询结果被截断**
- `execute_query` 默认最多返回 500 行，用 `maxRows` 参数调大（上限 10000）

**多语句脚本**
- 用 `execute_script` 执行，支持 `GO` 分隔符；任一批次失败会停止并报告出错批次

## 安全提示

本服务器被设计为**全权限直连**，AI 拥有与配置账号等同的数据库权限。请：
- 使用权限受控的专用账号，避免直接使用 `sa`
- 生产库操作前先备份；删除/清空类语句务必确认
