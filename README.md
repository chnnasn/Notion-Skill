# Notion Local Computer

在 Notion 聊天中使用 Skill，浏览本机目录、查询路径、读取文件，并按需打开文件、文件夹和已配置的程序。Windows 客户端通过登录后的 Notion 账户主动领取任务，再将执行结果写回任务页。

```text
Notion Agent → Skill 创建任务页
                     ↑ ↓
          本机客户端主动连接 Notion MCP
                     ↓
       任务到达后启动 MCP → 本地文件与 Windows 应用
       当前批次完成后关闭 MCP
```

Skill 根据当前聊天上下文获取业务页面地址，创建独立任务子页。上下文缺少目标页面时创建私有任务页。客户端通过设备标识发现任务，首次配置所需的设备信息自动写入 Skill。

## 首次使用

克隆本仓库，或下载源码 ZIP 并解压到 Windows 电脑上的固定目录。在包含 `install.ps1` 的目录打开 PowerShell，执行这一条命令。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本完成依赖准备、本机配置、浏览器登录授权、Skill 安装和桌面快捷方式创建，最后打开 Notion。已有 Node.js 22.16 或更新版本时直接使用，否则从 Node.js 官网下载便携运行时并核对 SHA-256，支持 Windows x64 和 ARM64。运行时保存在程序目录中。

首次配置默认开放程序所在目录，并加入记事本。希望首次开放其他目录时，使用下面的完整命令，将示例路径换为实际存在的目录。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Roots "D:\Documents"
```

浏览器出现授权页面时登录 Notion，客户端使用 OAuth、PKCE 和动态客户端注册，通过 Windows DPAPI 加密保存凭据。授权回调临时监听 `127.0.0.1:3211`。Skill 会自动安装并开启自动使用，页面地址保存在 `.runtime/skill.json`。

## 日常使用

1. 双击桌面上的 **Notion 本机助手**，同时打开 Notion 和后台接收器。已安装 Notion 桌面版时通过其应用协议打开，否则打开网页版。
2. 在 Notion 新建聊天，让新会话加载已启用的 Skill，然后提出本机任务。
3. 接收器约每 10 秒查询一次任务，收到任务后自动启动独立的 MCP 进程，并将结果回传至任务页。当前批次处理完后关闭 MCP。

重复打开快捷方式会复用接收器。自动连接由这个专用快捷方式触发，后台接收器持续运行到手动停止或 Windows 会话结束。电脑重启后再次使用该快捷方式即可。

例如可以说“列出这台电脑允许访问的目录”“读取当前项目的 README.md 并总结”“在资源管理器中打开当前项目”或“需要时启动记事本并打开 README.md”。

客户端连接的是 Notion 官方托管 MCP，本机任务通过按需启动的 stdio MCP 执行。登录流程和自动选择 Skill 的能力见官方说明。[Notion MCP 客户端接入](https://developers.notion.com/guides/mcp/build-mcp-client) · [Notion Skills](https://www.notion.com/help/create-and-manage-skills)

## 在新电脑上使用

每台电脑分别解压程序包，并执行上面的一键安装命令。配置、Windows 用户凭据和设备标识都会在该电脑上创建。安装完成后会输出新设备的 Skill 链接。

多台电脑同时在线时，在 Notion 选择目标电脑对应的 Skill。当前版本根据 Skill 中的设备标识确定执行电脑。仅使用新电脑时，可在 Notion 的 Skill 设置中停用旧设备 Skill。

## 状态与停止

在程序目录运行以下命令查看状态，返回的 `phase` 为 `waiting` 时正在等候任务，`mcpPid` 为 `null` 时 MCP 处于关闭状态。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Status
```

停止时会等待当前任务结束后退出接收器。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Stop
```

日志位于 `.runtime/client.log` 与 `.runtime/client-error.log`。修复依赖、刷新登录或重新创建快捷方式时，可再次运行一键安装命令。

## 本机配置

配置文件为 `.notion-local-mcp.json`。修改后重新启动客户端。

- `roots` 设置可访问目录列表，相对路径从第一个目录解析。
- `desktop.enabled` 控制桌面工具是否可用。
- `desktop.apps` 将短名称映射到实际 `.exe` 路径。`ensure_app` 与 `open_path.app` 使用这些名称。
- 应用使用 Windows 商店启动别名时，可通过 `packageName` 识别对应安装包中的实际进程。
- `desktop.openExtensions` 设置通过系统默认应用打开的扩展名。其他类型可以指定已配置程序，或在资源管理器中定位。
- `notion.pollSeconds` 设置查询间隔，范围为 5 到 300 秒。
- `notion.deviceId` 关联本机与 Skill。变更设备标识后需要重新安装对应 Skill。

应用配置示例，合并到现有 `desktop.apps` 中。

```json
{
  "notepad": {
    "executable": "C:\\Windows\\System32\\notepad.exe",
    "description": "记事本",
    "packageName": "Microsoft.WindowsNotepad"
  }
}
```

凭据和本机运行记录保存在 `.runtime`，由 `.gitignore` 排除。文件工具会保护客户端配置和运行目录。授权需要更新时，重新运行一键安装命令。

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `list_roots` | 列出允许目录和相对路径基准 |
| `list_directory` | 分页列出文件和子目录 |
| `get_path_info` | 查询真实路径、类型、大小和时间 |
| `search_files` | 递归按文件名子串搜索 |
| `read_file` | 分块读取 UTF-8、UTF-16 LE 或 Base64 字节 |
| `list_apps` | 获取已配置应用及当前会话中的进程 |
| `ensure_app` | 检查应用状态，按需启动 |
| `open_path` | 打开文件或目录，或在资源管理器中定位 |

路径校验覆盖 `..`、根目录前缀混淆、符号链接与 Windows junction、设备路径及备用数据流。读取前后核对实际文件。目录分页与文件分块使用返回的 `next_offset`。

文本读取适用于 Markdown、TXT、JSON、CSV 和源码。PDF、Office 等二进制文件可读取原始字节，正文提取需要相应的解析能力。每个 Notion 任务最多回传 80,000 字节 JSON，超过时缩小读取长度或结果数量。

`open_requested` 和 `launch_requested` 表示请求已提交给 Windows。应用窗口是否可见及窗口内部操作需要另外观察。

## 任务协议与恢复

每个任务使用独立页面，标题由设备前缀、状态和简短名称组成。正文中的 `NLCREQUESTBEGIN` 和 `NLCREQUESTEND` 包含 JSON 请求。详细格式保存在 `skills/notion-local-files/SKILL.md` 模板中，安装时自动替换设备信息。

任务状态依次为 `pending`、`running`，最后进入 `succeeded`、`failed` 或 `review`。结果保存在 `NLCRESULTBEGIN` 和 `NLCRESULTEND` 之间。业务页面内容由 Skill 根据用户要求单独更新。

客户端通过 Windows 命名管道互斥，防止同一配置同时运行多个执行进程。每个任务执行前后写入本地记录，结果回传失败时复用已保存结果。打开或启动过程中客户端中断时，该任务标记为 `review`，需要检查实际电脑状态后决定是否创建新任务。新操作使用新任务页。

搜索索引和网络响应会影响发现任务的时间。每次搜索最多获取 50 条匹配结果，后续轮次继续处理。客户端断线后自动重连，重试间隔最多 60 秒。

## 验证

```powershell
npm test
npm run verify
npm run client -- --once
```

`npm test` 覆盖文件读取、分页、路径权限、HTTP MCP、桌面操作分发、任务恢复、Notion Markdown 转义、互斥和凭据加密。

`npm run verify` 使用真实登录创建私有验证任务，确认客户端能搜索到任务、通过本机 MCP 获取允许目录，并把一致的结果保存回 Notion。验证页面会保留供检查。`client -- --once` 执行一轮实际任务查询。

这些命令与持续运行的客户端共享互斥，操作前先停止正在运行的客户端。

## 本地 HTTP MCP 接口

`npm start` 提供 `http://127.0.0.1:3210/mcp`，供支持 Streamable HTTP 的本机 MCP 客户端使用。认证使用配置中的 `token`，请求头为 `Authorization: Bearer <token>`。`GET /health` 提供进程健康状态。

HTTP 服务和 Notion 任务客户端复用同一组文件、路径和桌面工具。`NOTION_MCP_CONFIG` 可以指定其他配置文件。
