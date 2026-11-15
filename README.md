# Notion Local Computer

通过 Notion 操作 Windows 电脑，支持读取、写入、新建目录、复制文件、打开程序及执行命令。当前提供原生 HTTPS MCP 和任务页接收器两种接入方式。

| 项目 | 原生 HTTPS MCP | 任务页接收器 |
| --- | --- | --- |
| 调用流程 | Notion 直接调用本机公开的 MCP 工具 | Skill 创建任务页，本机轮询领取并回传 |
| 审批位置 | Notion 的“为我审核 / Review for me” | 本机规则判断，必要时显示确认窗口 |
| 长命令 | start_command 返回编号，继续查询状态 | run_command 等待完成后写回任务页 |
| 连接条件 | 本机 MCP 与 HTTPS 隧道运行 | 本机接收器在线并登录 Notion |
| 临时地址 | 隧道重启后需更新 Notion 连接 | 使用任务页与设备标识关联 |

## 原生 MCP 连接与 Notion 审批

原生模式通过 HTTPS 直接提供工具，审批由 Notion 聊天的 **Review for me** 管理。Notion 会审查工具调用并在判断可能不安全时询问用户。可在聊天顶部切换审批模式。自定义 MCP 支持认证请求头，使用下面生成的 Bearer token。[Notion 审批设置](https://www.notion.com/help/choose-how-notion-agent-asks-for-your-approval)、[自定义 MCP 认证](https://www.notion.com/help/mcp-connections-for-custom-agents)

1. 首次安装仍按下文完成运行时配置。下载官方 [cloudflared Windows amd64](https://github.com/cloudflare/cloudflared/releases/latest)，将程序保存为 `.runtime/cloudflared.exe`。核对发布页资产的 SHA256。
2. 在 `.notion-local-mcp.json` 设置 `"approvalMode":"host"`。旧配置默认 `local`，HTTP 模式为 host 时使用客户端审批。stdio 任务页执行仍使用本机确认。
3. 在项目目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\native.ps1`。脚本会停止旧任务页接收器，在本次会话建立隧道并提供原生工具。关闭脚本会结束连接。
4. 在 Notion 的设置 → 连接 → 浏览连接 → 添加连接 → 自定义 MCP 连接，填写 `.runtime/native-connection.json` 中的 `url`，名称填写 `Notion-skill`。验证方式选 Bearer token，前缀选 Bearer，Token 字段填 `headers.Authorization` 中去掉开头 `Bearer ` 后的部分。支持自定义请求头的表单也可直接填写完整 Authorization 值。工作区需允许添加自定义 MCP。
5. 点击连接后，在管理 → Notion 代理中确认连接有效。读取工具设为“自动运行”，写入工具设为“为我审核”。当前有 7 个读取工具和 8 个写入工具。
6. 在项目目录执行下面的命令，按本机配置更新对应 Skill。随后在 Notion 新建聊天并选择 Notion-skill，确认聊天的审批模式为“为我审核 / Review for me”。原生 Skill 直接调用工具，并查询长任务结果。

```powershell
$notionNode = (Get-Content -Raw .\.runtime\launcher.json | ConvertFrom-Json).nodeExecutable
& $notionNode .\src\install.js
```

日常使用时保持 `native.ps1` 运行，可直接说“读取桌面的报告”“新建一个文本文件并写入内容”“复制这个文件到指定目录”或“clone 仓库到 E:\\Projects”。路径不明确时，Skill 会先查询实际位置。执行完成以工具返回结果为准。

`native-connection.json` 含访问凭据，保存在受文件工具保护且 Git 忽略的 `.runtime` 中。任何持有该凭据的客户端均可按当前 Windows 账户权限调用工具。host 模式将审批交由已认证客户端，服务端无法验证某次调用是否经过人工点击批准。应在 Notion 中设置期望的审批方式。

临时隧道每次启动生成新地址，需在 Notion 中更新连接。隧道无持续在线保证，重新连接后可查询仍在运行的命令。长期使用可以配置固定 HTTPS 隧道，再用 `npm start` 提供服务。Quick Tunnel 的功能和限制见 [Cloudflare 文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

固定地址部署时，将 `.notion-local-mcp.json` 的 `publicUrl` 设为对应的 HTTPS 来源，例如 `https://files.example.com`，并将隧道转发到 `http://127.0.0.1:3210`。保留 Bearer 认证，Notion 连接 URL 使用该来源下的 `/mcp`。端口以配置中的 port 为准。

### 文件与长命令工具

| 工具 | 参数与行为 |
| --- | --- |
| `read_file` | 分块读取现有文件，沿用编码与分页参数 |
| `write_file` | `path`、`content`、`encoding`，默认 utf8，父目录须存在。默认拒绝覆盖，`overwrite=true` 替换时返回 `backup_path` |
| `create_directory` | `path`，在现有父目录下新建一级目录，多级目录逐级创建 |
| `copy_file` | `source`、`destination`，复制普通文件，拒绝覆盖。目录逐项列出后复制 |
| `start_command` | 同 run_command 参数，立即返回 `task_id`，用于 clone、脚本、安装或构建 |
| `get_command_task` | `task_id`，每 3–5 秒查询直到终态，结果含输出、退出码及失败原因 |
| `cancel_command_task` | `task_id`，请求终止命令进程树，随后继续查询实际状态 |

长命令执行独立于单次 HTTP 请求，断线后继续使用原 task_id 查询。运行超时由 timeout_ms 控制，最长十分钟。任务完成一小时后记录过期，服务重启会清空内存记录，此时先检查文件或仓库状态再决定重试。取消和失败可能留下部分修改。并发命令最多四个，保存记录最多一百条。

文件工具校验目录范围、服务配置保护和链接目标。新建与复制先写临时文件再发布，避免目标文件暴露未完成的内容。覆盖写入保存同目录备份并替换文件。避免在其他程序同时修改目标时覆盖，文件操作受 Windows 账户权限和文件系统支持限制。

### 超时与连接排查

- 连接失败时确认 `native.ps1` 仍运行，使用 `.runtime/native-connection.json` 中最新的 URL 和认证信息。临时隧道退出后旧地址失效。
- Notion 工具列表中应有“新建或写入文件”“复制文件”“启动长时间命令”和“查询命令任务”。连接后新建聊天，让会话加载最新工具与 Skill。
- 原生模式的写入工具审批为“为我审核”。需要用户确认时，在 Notion 中检查审批提示。若回答仍要求电脑本机弹窗，检查当前会话是否沿用了旧任务页 Skill，以及 HTTP 配置是否为 `approvalMode=host`。
- clone、安装、测试及构建使用 start_command。返回 running 时保留 task_id 并持续查询，调用连接暂时失败后使用同一个编号恢复查询。
- completed 表示命令成功结束。failed、timed_out、cancelled 及 error 字段用于判断命令执行情况。连接超时表示调用链路未及时响应，应继续核查原任务的实际状态。
- TASK_NOT_FOUND 可能发生在服务重启或记录过期之后。先检查目标文件或仓库状态，再决定是否重新提交。

已验证的链路包括公网 Bearer 认证、后台 git clone，以及 Notion 聊天实际调用新建目录、写入、复制和读取工具。测试命令为 `npm test`，覆盖原生任务跨 HTTP 请求查询、文件覆盖备份、并发新建冲突和受保护路径。

## 任务页接收器

原生 Skill 模板为 `skills/notion-local-files/NATIVE.md`，`approvalMode=host` 时安装器使用该模板。任务页模板为 `skills/notion-local-files/SKILL.md`，以下是该接入方式的安装和使用方法。

在 Notion 聊天中使用 Skill，浏览本机全部磁盘、读取文件、执行 PowerShell 或 CMD 命令，并按需打开文件和已配置的程序。也可以在 Notion 中手动开启、关闭 MCP 或查看状态。本机接收器以 Node.js 脚本运行，通过登录后的 Notion 账户主动领取任务，再将执行结果写回任务页。

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

首次配置默认开启全电脑访问模式，并加入记事本。直接在 Notion 中提出“读取 E 盘的 Github 目录”或“查找桌面上的文件”，即可按当前 Windows 账户权限访问对应位置。希望限定访问目录时，在首次安装时传入 `-Roots`，将下面的示例路径换为实际存在的目录。

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
| 关闭 MCP | 进入 `off` 模式，关闭 MCP，后续文件、命令与应用任务返回 `MCP_DISABLED` |
| 查看 MCP 状态 | 返回模式、实际运行状态、进程 ID 和查询时间 |
| 恢复按需启动 | 进入 `auto` 模式，后续任务按批次启动和关闭 MCP |

重复开启会复用同一 MCP 进程。状态查询由接收器直接处理。关闭 MCP 后，接收器继续在线等待开启或恢复按需指令。连续开关按照任务完成顺序操作，查询结果反映任务执行时的状态。

手动模式作用于本次接收器会话。任务触发、手动开关和状态查询都依赖接收器在线，Notion 任务页中的 `succeeded`、`failed` 或 `review` 表示该次请求的实际处理结果。手动关闭后的文件任务需要先开启 MCP 或恢复按需模式，再创建新任务。

接收器持续运行到手动停止或 Windows 会话结束。电脑重启或接收器退出后，在项目目录执行下面的命令恢复连接。重复执行会复用接收器。每次接收器启动时默认使用 `auto` 模式。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Start
```

例如可以说“列出这台电脑的磁盘”“读取 E 盘 Github 目录并总结其中的项目”“读取桌面上的文件”“在资源管理器中打开当前项目”或“需要时启动记事本并打开 README.md”。

客户端连接的是 Notion 官方托管 MCP，本机任务通过按需启动的 stdio MCP 执行。登录流程和自动选择 Skill 的能力见官方说明。[Notion MCP 客户端接入](https://developers.notion.com/guides/mcp/build-mcp-client) · [Notion Skills](https://www.notion.com/help/create-and-manage-skills)

## 全电脑访问

`accessMode` 为 `all` 时，直接在 Notion 中提出“读取 `D:\资料\报告.md`”或“查看 `E:\Github` 中的项目”。Skill 使用目标的绝对路径浏览、搜索、读取或打开文件。新接入的磁盘和当前账户可访问的共享路径也可以直接使用。

`list_roots` 返回 `access_mode="all"`、当前磁盘列表 `roots`，以及相对路径基准 `relative_path_base`。`locations` 字段返回系统实际的桌面、下载、文档和用户目录路径，支持已移动到其他磁盘的位置。名称无匹配时会缩短关键词或列出目录核对，找到文件夹后继续列出其中的文件。

文件工具使用接收器所属的 Windows 账户权限。系统权限错误返回 `EACCES` 或 `EPERM`，文件工具保护客户端自身配置和 `.runtime` 目录。搜索会返回深度和数量限制信息，全电脑查找时按磁盘和相关子目录分批搜索。

### 已有安装切换到全电脑模式

在 `.notion-local-mcp.json` 中加入或修改 `"accessMode": "all"`，保留其他配置，然后停止接收器、更新 Skill 并启动接收器。下面的命令使用安装脚本保存的 Node.js 路径。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Stop
$notionNode = (Get-Content -Raw .\.runtime\launcher.json | ConvertFrom-Json).nodeExecutable
& $notionNode .\src\install.js
powershell -NoProfile -ExecutionPolicy Bypass -File .\client.ps1 -Action Start
```

在 Notion 新建聊天并选择 `Notion-skill`，让会话加载更新后的说明。查询磁盘时确认结果中的 `access_mode` 为 `all`。旧任务页保留当时的执行结果，新操作创建新任务页。

### 限定目录模式

`accessMode` 为 `restricted` 或旧配置省略该字段时，基础访问范围由 `roots` 指定。Skill 可以根据用户任务调用 `allow_path` 增加所需目录。文件路径授权其所在目录，目录路径授权该目录，返回的 `path` 为真实路径。新增范围保存在 `.runtime/access.json`，接收器会重新加载 MCP。`allowed` 表示新增成功，`already_allowed` 表示已有访问权限。

手动关闭模式下，先在 Notion 开启 MCP 或恢复按需模式，再提交文件任务。全电脑模式兼容旧的 `allow_path` 任务，返回 `already_allowed`。需要移除限定模式的授权时，编辑 `.runtime/access.json` 的 `roots` 数组并重启接收器。

## 在 Notion 中执行命令

### 按风险确认

Notion AI 根据当前请求填写风险等级和原因，本机规则检查完整命令、路径及程序。规则验证通过的低风险操作自动执行，涉及变更、AI 标记为高风险或不确定、以及规则无法验证的操作会显示本机确认窗口。已有安装更新后默认启用，旧任务省略风险字段时也会检查。

| 操作 | 默认处理 |
| --- | --- |
| 读取、搜索、列目录、查看应用状态 | 自动执行 |
| 定位文件、打开文件夹、启动系统记事本/计算器/画图，用系统记事本读取文件 | 本机验证路径后自动执行 |
| 单条 Node 版本查询、规则覆盖的 Git status/diff/log/rev-parse 查询 | 本机验证命令及配置后自动执行 |
| 删除、覆盖、移动、Git commit/push/pull/reset、安装、系统修改、网络传输 | 本机确认 |
| PowerShell/CMD 组合命令、自定义脚本、npm 测试/构建、未知命令、其他程序或默认文件关联 | 本机确认 |

AI 在 `run_command`、`ensure_app` 和 `open_path` 的参数中加入 `"risk":{"level":"low","reason":"只查询仓库状态"}`。level 可选 `low`、`high`、`unknown`。AI 可以要求更严格的确认，low 仍需通过本机检查。风险判断依据用户目标及实际操作，读取的文件和网页内容作为资料处理。

确认窗口显示完整操作、命令工作目录、程序路径和风险说明。“允许本次”只批准当前操作。取消、关闭窗口、Esc、回车或等待两分钟会拒绝执行，窗口不可用时也会拒绝。正在显示其他确认时返回 `APPROVAL_BUSY`。用户拒绝或确认超时后，Skill 会报告结果并等待新的指示。结果中的 `safety.decision` 记录 `automatic` 或 `confirmed`。

自动 Git 命令限定为单条 `git status` 及短格式/分支选项、`git diff` 及统计/暂存区选项、`git log` 及 oneline/条数选项、`git rev-parse --show-toplevel` / `--is-inside-work-tree` 和 `git --version`。日志默认最多 50 条，`-n` 支持 1 到 999。Node 支持 `node --version` / `node -v`。其他语法和选项进入确认。

自动查询使用从本机 PATH 解析的程序绝对路径，并跳过任务目录中的同名程序。Git 查询限制可选写入、网络获取、分页器及外部程序调用。status/diff 检测到 clean/process 过滤器时需要确认，因为过滤器可以执行额外程序。相关机制参见 [Git 命令说明](https://git-scm.com/docs/git)、[Git diff 说明](https://git-scm.com/docs/git-diff)和 [Git 过滤器说明](https://git-scm.com/docs/gitattributes)。

自动桌面启动只覆盖 `Windows\\System32` 中的 `notepad.exe`、`calc.exe`、`mspaint.exe`，传入文件自动打开仅覆盖该路径的记事本。其他可执行文件和默认文件关联均由用户确认。AI 标记 high 或 unknown 时，规则覆盖的操作也会要求确认。

批准后的命令使用当前 Windows 账户的完整权限，确认机制依赖用户核对实际操作。文件读取仍按现有访问模式自动执行，内容会写回 Notion 任务页。更新后按下文的安装更新步骤同步 Skill 并重启接收器，新聊天将加载风险判断流程。

### 命令执行

可以直接提出“在 `E:\Github\Notion-Skill` 运行 `git status --short`”“执行 Python 脚本并告诉我结果”或“运行项目测试，超时设为 5 分钟”。Skill 会创建 `run_command` 任务，接收器按当前 MCP 模式执行，并将输出和退出码写回任务页。

也支持“push E:\Github\Notion-Skill”“pull 当前项目”等 Git 请求。Skill 将命令放入 Notion 任务页的 `tool="run_command"` 请求中，由接收器执行。任务页中的输出和退出码用于确认操作结果。

如果聊天直接回复“无法在电脑执行 Git”且没有创建任务页，在输入框键入 `/`，选择 `Notion-skill`，再发送原请求，让当前对话加载 Skill 的执行流程。自动调用由 Notion 根据 Skill 描述选择，手动选择可以明确指定此次使用的 Skill。[Notion Skills 使用方式](https://www.notion.com/help/create-and-manage-skills)

| 参数 | 默认值与用途 |
| --- | --- |
| `command` | 要执行的命令，最长 8000 字符，PowerShell 支持多行脚本 |
| `shell` | 默认 `powershell`，也支持 `cmd` |
| `cwd` | 默认 `.`，相对路径基准为配置中的第一个目录 |
| `timeout_ms` | 默认 60000，支持 1000 到 600000 毫秒 |
| `max_output_bytes` | 默认 8192，支持 256 到 8192，限制两路输出的总字节数 |
| `risk` | AI 判断的 level 和 reason，low 经过本机规则校验，high/unknown 需要本机确认 |

自动查询直接调用已解析的程序，其他命令经确认后启动独立的非交互 shell，在后台执行。结果包含 `stdout`、`stderr`、`exit_code`、`status`、`duration_ms`、`timed_out`、`truncated` 和 `safety`。执行超时从命令启动计时，本机确认另计两分钟。退出码为 0 时返回 `completed`，非零为 `failed`。超时和取消会尝试终止命令进程树，并返回已有输出。`termination_error` 表示终止失败，`truncated` 表示输出被截断。完整日志可以由确认后的命令重定向到文件后分块读取。

命令使用接收器所属账户的完整操作系统权限，可以修改文件、启动程序及访问网络。文件工具的目录限制和凭据保护作用于文件工具，`run_command.cwd` 也接受路径校验。命令执行中的路径访问由 Windows 账户权限决定。Skill 按用户任务生成命令并回报实际结果。

命令继承接收器环境，并将当前 Node.js 运行时目录加入 PATH，便携安装也可调用 Node.js 和 npm。默认 PowerShell 使用 UTF-8 输出并加载独立会话。CMD 通过临时 UTF-8 批处理执行，结束后清理脚本，批处理中调用另一个批处理并继续后续命令时使用 `call`。其他程序的输出编码取决于该程序配置。交互式登录或持续运行的终端会话由对应应用完成。

更新已有安装时，使用上文的停止接收器、运行 `src/install.js`、启动接收器步骤，同步更新 Notion Skill，再新建聊天加载命令工具说明。

### Git 操作示例

在 Notion 聊天中选择此电脑的 `Notion-skill`，并提供仓库的完整路径，例如：

- `查看 E:\Github\Notion-Skill 的 git status`
- `commit E:\Github\Notion-Skill，提交信息为 docs: update README`
- `push E:\Github\Notion-Skill`
- `pull E:\Github\Notion-Skill`

提交会创建本地 commit，不会自动推送；push 只推送已有提交，不会自动提交尚未提交的更改。远程操作需要仓库的上游配置和认证可用。以任务返回的输出和退出码确认结果。

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

- `accessMode` 为 `all` 时开启全电脑访问，为 `restricted` 时启用限定目录。新安装默认 `all`，旧配置省略该字段时使用 `restricted`。
- `roots` 的第一个目录作为相对路径基准。限定模式下，该数组和 `.runtime/access.json` 共同确定可访问范围。全电脑模式按操作系统账户权限访问路径。
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
| `list_roots` | 返回访问模式、磁盘或限定目录、相对路径基准及系统位置 |
| `allow_path` | 兼容限定目录模式的目录授权，由接收器处理 |
| `list_directory` | 分页列出文件和子目录 |
| `get_path_info` | 查询真实路径、类型、大小和时间 |
| `search_files` | 递归按文件名子串搜索 |
| `read_file` | 分块读取 UTF-8、UTF-16 LE 或 Base64 字节 |
| `run_command` | 执行 PowerShell 或 CMD 命令，回传输出、退出码与超时状态 |
| `list_apps` | 获取已配置应用及当前会话中的进程 |
| `ensure_app` | 检查应用状态，按需启动 |
| `open_path` | 打开文件或目录，或在资源管理器中定位 |

全电脑模式支持跨目录、跨磁盘及符号链接的普通路径。限定模式会校验路径及链接目标所属的目录范围。两种模式均校验设备路径和备用数据流，并在读取前后核对实际文件。目录分页与文件分块使用返回的 `next_offset`。

文本读取适用于 Markdown、TXT、JSON、CSV 和源码。PDF、Office 等二进制文件可读取原始字节，正文提取需要相应的解析能力。每个 Notion 任务最多回传 80,000 字节 JSON，超过时缩小读取长度或结果数量。

`open_requested` 和 `launch_requested` 表示请求已提交给 Windows。应用窗口是否可见及窗口内部操作需要另外观察。

## 任务协议与恢复

每个任务使用独立页面，标题由设备前缀、状态和简短名称组成。正文中的 `NLCREQUESTBEGIN` 和 `NLCREQUESTEND` 包含 JSON 请求。详细格式保存在 `skills/notion-local-files/SKILL.md` 模板中，安装时自动替换设备信息。

接收器支持 `mcp_control` 任务，参数 `action` 为 `start`、`stop`、`status` 或 `auto`。该任务通过 Notion 任务页控制本次接收器会话中的 MCP 生命周期。现有本机工具沿用同一任务格式。请求验证、结果重发和状态查询由接收器处理。

任务状态依次为 `pending`、`running`，最后进入 `succeeded`、`failed` 或 `review`。结果保存在 `NLCRESULTBEGIN` 和 `NLCRESULTEND` 之间。业务页面内容由 Skill 根据用户要求单独更新。

客户端通过 Windows 命名管道互斥，防止同一配置同时运行多个执行进程。每个任务执行前后写入本地记录，结果回传失败时复用已保存结果。执行命令、打开文件、启动应用、增加目录授权或切换 MCP 模式过程中客户端中断时，该任务标记为 `review`，需要检查实际电脑状态后决定是否创建新任务。失败或超时的命令可能已产生部分修改，后续操作依据输出与实际状态决定。新操作使用新任务页。

搜索索引和网络响应会影响发现任务的时间。每次搜索最多获取 50 条匹配结果，后续轮次继续处理。客户端断线后自动重连，重试间隔最多 60 秒。

## 验证

```powershell
npm test
npm run verify
npm run client -- --once
```

`npm test` 覆盖全电脑访问、限定模式兼容、文件读取、分页、路径权限、按任务授权目录与即时加载、HTTP 和 stdio MCP、PowerShell 与 CMD 命令、中文输出、退出码、超时进程树终止、取消、截断、风险分级、AI 低风险声明无法越过本机检查、拒绝执行、桌面操作分发、MCP 手动开关与按需恢复、任务恢复、Notion Markdown 转义、互斥和凭据加密。测试通过注入确认结果验证允许和拒绝分支。

`npm run verify` 使用真实登录创建私有验证任务，确认客户端能搜索到任务、通过本机 MCP 获取允许目录，并把一致的结果保存回 Notion。验证页面会保留供检查。`client -- --once` 执行一轮实际任务查询。

`npm run verify` 与 `npm run client -- --once` 和持续运行的客户端共享互斥，执行这两条命令前先停止接收器，完成后使用 `client.ps1 -Action Start` 恢复连接。`npm test` 使用隔离的测试配置。

## 本地 HTTP MCP 接口

`npm start` 提供 `http://127.0.0.1:3210/mcp`，供支持 Streamable HTTP 的本机 MCP 客户端使用。认证使用配置中的 `token`，请求头为 `Authorization: Bearer <token>`。`GET /health` 提供进程健康状态。

HTTP 服务和 Notion 任务客户端复用同一组文件、路径和桌面工具。`NOTION_MCP_CONFIG` 可以指定其他配置文件。

`approvalMode=local` 时 HTTP MCP 使用本机确认，RPC 超时应覆盖两分钟确认、timeout_ms 及至少 30 秒回传余量。`approvalMode=host` 时审批由客户端管理，长命令优先使用 start_command 和 get_command_task。

Notion 中的 `mcp_control` 管理接收器创建的 stdio MCP 子进程。通过 `npm start` 启动的 HTTP 服务由运行该命令的终端管理。

`allow_path` 由 Notion 任务接收器处理。单独运行的 HTTP 服务会在下次启动时加载已保存的目录授权。
