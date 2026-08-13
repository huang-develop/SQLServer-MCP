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
| `execute_query` | 执行任意 SQL，支持命名参数，流式接收 SELECT 结果（默认保留 500 行） |
| `execute_script` | 批量执行 SQL 脚本，支持 `GO` 分隔符，默认使用事务、失败回滚 |

## 目录结构

```
SQLServerMCP/
├── index.js             # MCP 服务器主程序（入口）
├── config.json          # 已初始化的连接配置（首次提交，后续本机修改不提交）
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

仓库已提供不含密码的 `config.json`。拉取代码后直接修改该文件：

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

修改完成后，执行下面的命令，让 Git 在本机日常提交时忽略 `config.json` 的修改：

```bash
git update-index --skip-worktree config.json
```

如果以后需要提交公共配置结构的调整，先执行：

```bash
git update-index --no-skip-worktree config.json
```

提交公共配置后，再重新执行 `git update-index --skip-worktree config.json`。

配置优先级为：环境变量 > `config.json` > 默认值。

也可以用环境变量覆盖（优先级最高）：`SQLSERVER_SERVER`、`SQLSERVER_PORT`、`SQLSERVER_DATABASE`、`SQLSERVER_USER`、`SQLSERVER_PASSWORD`、`SQLSERVER_WINDOWS_AUTH` 等。

`configure_connection` 使用 `persist=true` 时会写入 `config.json`，因此配置真实密码后务必执行上面的 `skip-worktree` 命令。

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
- `execute_query` 会流式读取结果，默认仅在内存和响应中保留每个结果集的前 500 行；用 `maxRows` 参数调大（上限 10000）
- `timeout` 会使用具有对应请求超时的独立连接池，不会修改或复用错误超时的现有连接

**多语句脚本**
- 用 `execute_script` 执行，支持 `GO` 分隔符；默认 `atomic=true`，任一批次失败会停止并回滚
- `CREATE DATABASE` 等不允许在事务中执行的语句，可明确传入 `atomic=false`；此时失败前已完成的批次不会回滚
- 单个 `GO` 的重复次数和脚本总批次数上限均为 1000

## 安全提示

本服务器被设计为**全权限直连**，AI 拥有与配置账号等同的数据库权限。请：
- 使用权限受控的专用账号，避免直接使用 `sa`
- 生产库操作前先备份；删除/清空类语句务必确认
