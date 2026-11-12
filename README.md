# Notion Local Computer

在 Notion 聊天中使用 Skill，根据任务增加目录访问范围、浏览本机目录、查询路径、读取文件，并按需打开文件、文件夹和已配置的程序。也可以在 Notion 中手动开启、关闭 MCP 或查看状态。本机接收器以 Node.js 脚本运行，通过登录后的 Notion 账户主动领取任务，再将执行结果写回任务页。

```text
Notion Agent → Skill 创建任务页
                     ↑ ↓
          本机客户端主动连接 Notion MCP
                     ↓
       接收器处理 MCP 开关与状态查询
                     ↓
       按需或手动启动 MCP → 本地文件与 Windows 应用
```

Skill 根据当前聊天上下文获取业务页面地址，创建独立任务子页。上下文缺少目标页面时创建私有任务页。客户端通过设备标识发现任务，首次配置所需的设备信息自动写入 Skill。

## 首次使用

克隆本仓库，或下载源码 ZIP 并解压到 Windows 电脑上的固定目录。在包含 `install.ps1` 的目录打开 PowerShell，执行这一条命令。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本完成依赖准备、本机配置、浏览器登录授权、Skill 安装，随后启动接收器并打开 Notion。已有 Node.js 22.16 或更新版本时直接使用，否则从 Node.js 官网下载便携运行时并核对 SHA-256，支持 Windows x64 和 ARM64。运行时保存在程序目录中。

首次配置默认开放程序所在目录，并加入记事本。后续访问其他位置时，直接在 Notion 中提出任务，由 Skill 添加所需目录。也可以在首次安装时指定基础目录，将下面的示例路径换为实际存在的目录。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Roots "D:\Documents"
```

浏览器出现授权页面时登录 Notion，客户端使用 OAuth、PKCE 和动态客户端注册，通过 Windows DPAPI 加密保存凭据。授权回调临时监听 `127.0.0.1:3211`。Skill 会自动安装并开启自动使用，页面地址保存在 `.runtime/skill.json`。

## 日常使用

1. 首次安装完成后，接收器在当前 Windows 会话中运行。
2. 在 Notion 新建聊天，让新会话加载已启用的 Skill。可以输入 `/` 选择“Notion-skill”，也可以直接提出本机任务。
3. 接收器约每 10 秒查询一次任务。默认按需模式会在收到有效的本机操作后启动独立的 MCP 进程，完成当前批次后关闭，并将结果回传至任务页。

在 Notion 聊天中使用下面的指令控制本机 MCP。

| 指令 | 效果 |
| --- | --- |
| 开启 MCP | 进入 `on` 模式，MCP 在本次接收器会话中保持运行 |
| 关闭 MCP | 进入 `off` 模式，关闭 MCP，后续文件与应用任务返回 `MCP_DISABLED` |
| 查看 MCP 状态 | 返回模式、实际运行状态、进程 ID 和查询时间 |
| 恢复按需启动 | 进入 `auto` 模式，后续任务按批次启动和关闭 MCP |

重复开启会复用同一 MCP 进程。状态查询由接收器直接处理。关闭 MCP 后，接收器继续在线等待开启或恢复按需指令。连续开关按照任务完成顺序操作，查询结果反映任务执行时的状态。

手动模式作用于本次接收器会话。任务触发、手动开关和状态查询都依赖接收器在线，Notion 任务页中的 `succeeded`、`failed` 或 `review` 表示该次请求的实际处理结果。手动关闭后的文件任务需要先开启 MCP 或恢复按需模式，再创建新任务。

接收器持续运行到手动停止或 Windows 会话结束。电脑重启或接收器退出后，在项目目录执行下面的命令恢复连接。重复执行会复用接收器。每次接收器启动时默认使用 `auto` 模式。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Start
```

例如可以说“列出这台电脑允许访问的目录”“读取当前项目的 README.md 并总结”“在资源管理器中打开当前项目”或“需要时启动记事本并打开 README.md”。

客户端连接的是 Notion 官方托管 MCP，本机任务通过按需启动的 stdio MCP 执行。登录流程和自动选择 Skill 的能力见官方说明。[Notion MCP 客户端接入](https://developers.notion.com/guides/mcp/build-mcp-client) · [Notion Skills](https://www.notion.com/help/create-and-manage-skills)

## 按任务增加访问目录

在 Notion 中直接提出“读取 `D:\资料\报告.md`”或“查看 `E:\Projects` 中的项目”。Skill 会根据任务使用 `allow_path` 增加需要的访问范围，然后继续读取、搜索或打开目标。

指定文件会授权其所在目录，指定目录会授权该目录。工具校验路径存在并返回真实路径，后续操作使用返回的 `path`。新增目录保存在 `.runtime/access.json`，后续启动时自动加载。已授权目录和配置中的基础目录一起出现在 `list_roots` 结果中。

授权结果中的 `status` 为 `allowed` 时，`added_root` 给出本次新增的目录。`already_allowed` 表示该路径已有访问权限，可以继续执行原任务。在 Notion 中提出“列出当前允许访问的目录”，即可检查完整范围。

授权由当前接收器处理，运行中的 MCP 会重新加载访问范围。手动关闭模式下，先在 Notion 开启 MCP 或恢复按需模式，再提交授权与文件任务。需要移除已保存的授权时，可以编辑 `.runtime/access.json` 的 `roots` 数组，然后重新启动接收器。

## 在新电脑上使用

每台电脑分别解压程序包，并执行上面的一键安装命令。配置、Windows 用户凭据和设备标识都会在该电脑上创建。安装完成后会输出新设备的 Skill 链接。

Skill 的显示名称固定为 `Notion-skill`，设备标识保存在 Skill 正文中。多台电脑同时在线时，可打开 Skill 页面查看设备标识，再选择目标电脑对应的 Skill。当前版本根据 Skill 中的设备标识确定执行电脑。仅使用新电脑时，可在 Notion 的 Skill 设置中停用旧设备 Skill。

已有安装再次运行安装脚本时，会将对应 Skill 更新为 `Notion-skill`。安装器支持按正文中的设备标识查找固定名称和旧名称的页面。

## 状态与停止

在程序目录运行以下命令查看接收器状态，返回的 `phase` 为 `waiting` 时正在等候任务，`mcpMode` 表示控制模式，`mcpPid` 为 `null` 时 MCP 处于关闭状态。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Status
```

停止接收器时会等待当前任务结束并关闭 MCP，然后退出。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Stop
```

日志位于 `.runtime/client.log` 与 `.runtime/client-error.log`。修复依赖、刷新登录或更新已安装的 Skill 时，可再次运行一键安装命令。更新过程会重启接收器并恢复 `auto` 模式，随后在 Notion 新建聊天加载更新后的 Skill。

## 本机配置

配置文件为 `.notion-local-mcp.json`。修改后重新启动客户端。

- `roots` 设置基础访问目录，相对路径从第一个目录解析。Skill 根据任务追加的目录保存在 `.runtime/access.json`。
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
| `allow_path` | 根据任务授权文件所在目录或指定目录，由接收器处理 |
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

接收器支持 `mcp_control` 任务，参数 `action` 为 `start`、`stop`、`status` 或 `auto`。该任务通过 Notion 任务页控制本次接收器会话中的 MCP 生命周期。现有本机工具沿用同一任务格式。请求验证、结果重发和状态查询由接收器处理。

任务状态依次为 `pending`、`running`，最后进入 `succeeded`、`failed` 或 `review`。结果保存在 `NLCRESULTBEGIN` 和 `NLCRESULTEND` 之间。业务页面内容由 Skill 根据用户要求单独更新。

客户端通过 Windows 命名管道互斥，防止同一配置同时运行多个执行进程。每个任务执行前后写入本地记录，结果回传失败时复用已保存结果。打开文件、启动应用、增加目录授权或切换 MCP 模式过程中客户端中断时，该任务标记为 `review`，需要检查实际电脑状态后决定是否创建新任务。新操作使用新任务页。

搜索索引和网络响应会影响发现任务的时间。每次搜索最多获取 50 条匹配结果，后续轮次继续处理。客户端断线后自动重连，重试间隔最多 60 秒。

## 验证

```powershell
npm test
npm run verify
npm run client -- --once
```

`npm test` 覆盖文件读取、分页、路径权限、按任务授权目录与即时加载、HTTP MCP、桌面操作分发、MCP 手动开关与按需恢复、任务恢复、Notion Markdown 转义、互斥和凭据加密。

`npm run verify` 使用真实登录创建私有验证任务，确认客户端能搜索到任务、通过本机 MCP 获取允许目录，并把一致的结果保存回 Notion。验证页面会保留供检查。`client -- --once` 执行一轮实际任务查询。

`npm run verify` 与 `npm run client -- --once` 和持续运行的客户端共享互斥，执行这两条命令前先停止接收器，完成后使用 `client.ps1 -Action Start` 恢复连接。`npm test` 使用隔离的测试配置。

## 本地 HTTP MCP 接口

`npm start` 提供 `http://127.0.0.1:3210/mcp`，供支持 Streamable HTTP 的本机 MCP 客户端使用。认证使用配置中的 `token`，请求头为 `Authorization: Bearer <token>`。`GET /health` 提供进程健康状态。

HTTP 服务和 Notion 任务客户端复用同一组文件、路径和桌面工具。`NOTION_MCP_CONFIG` 可以指定其他配置文件。

Notion 中的 `mcp_control` 管理接收器创建的 stdio MCP 子进程。通过 `npm start` 启动的 HTTP 服务由运行该命令的终端管理。

`allow_path` 由 Notion 任务接收器处理。单独运行的 HTTP 服务会在下次启动时加载已保存的目录授权。
