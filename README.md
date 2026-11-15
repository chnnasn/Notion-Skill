# Notion-skill

通过原生 HTTPS MCP 在 Notion 中操作 Windows 电脑，支持读取、写入、新建目录、复制文件、打开程序，以及执行 PowerShell、CMD 和 Git 命令。Notion 直接调用工具，审批由聊天中的“为我审核 / Review for me”管理。

```text
Notion Agent + Notion-skill → HTTPS 隧道 → 本机 HTTP MCP → 文件、命令与 Windows 应用
```

## 安装

在 Windows 电脑上克隆或解压本仓库，在项目目录运行。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装器准备 Node.js 与依赖，下载官方 cloudflared 并核对 SHA256，创建配置，在浏览器中登录 Notion，安装原生 Skill，然后在当前 Windows 会话后台启动 MCP 和临时 HTTPS 隧道。安装器支持便携 Node.js，运行时信息保存在 `.runtime/native-runtime.json`。

首次配置默认全电脑访问。希望限定目录时，在首次安装传入实际目录。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Roots "D:\Documents"
```

Notion 登录仅用于安装和更新 Skill。OAuth 凭据通过 Windows DPAPI 加密保存在本机。日常工具调用使用 MCP Bearer token。

## 连接 Notion

1. 打开 Notion 设置 → 连接 → 浏览连接 → 添加连接 → 自定义 MCP 连接。
2. URL 填 `.runtime/native-connection.json` 中的 `url`，名称填 `Notion-skill`。
3. 验证选 Bearer token，前缀选 Bearer。Token 字段填 `headers.Authorization` 去掉开头 `Bearer ` 后的部分。支持自定义请求头的表单可填写完整 Authorization 值。
4. 点击连接，在管理 → Notion 代理中确认连接有效。读取工具设为“自动运行”，写入工具设为“为我审核”。当前有 10 个读取工具和 12 个写入工具。
5. 新建聊天，选择 Notion-skill，并确认聊天审批模式为“为我审核 / Review for me”。

工作区需要允许自定义 MCP。Notion 会审查操作，并在判断可能不安全时询问用户。[连接说明](https://www.notion.com/help/connect-mcp-servers-to-your-notion-agent)、[认证方式](https://www.notion.com/help/mcp-connections-for-custom-agents)、[审批设置](https://www.notion.com/help/choose-how-notion-agent-asks-for-your-approval)

连接配置含访问凭据，保存在文件工具保护且 Git 忽略的 `.runtime` 中。持有凭据的客户端拥有当前 Windows 账户可用的工具权限。host 模式将审批交由已认证客户端，服务端无法验证某次调用是否经过人工点击批准。

## 启动、状态与停止

首次安装后服务在本次 Windows 会话后台运行。重启电脑或停止服务后，在项目目录运行。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native.ps1 -Action Start
powershell -NoProfile -ExecutionPolicy Bypass -File .\native.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\native.ps1 -Action Stop
```

Start 复用已运行的原生服务。Status 返回进程、phase 和当前 URL，ready 表示本机服务已监听。Stop 取消命令任务并关闭 MCP 与隧道。服务运行到手动停止或 Windows 会话结束。

临时隧道每次启动生成新地址，需在 Notion 中更新连接。当前地址以 `.runtime/native-connection.json` 为准。隧道在线状态取决于网络，服务就绪后可以通过 Notion 调用确认公网可达性。日志为 `.runtime/native.log` 和 `.runtime/native-error.log`。

也可用 `npm run native`、`npm run native:status`、`npm run native:stop`。这些命令需要当前终端能找到 Node.js。

已有安装更新代码后，先停止原生服务，运行 `install.ps1` 更新运行时配置和 Skill，再使用生成的新地址连接。先前版本运行的原生进程需结束后再启动新版服务。旧目录授权记录会继续加载。

## 使用示例

- “列出这台电脑的磁盘，读取桌面的报告并总结。”
- “新建一个文本文件，写入下面的内容。”
- “把这个文件复制到指定目录。”
- “clone 仓库到 E:\Projects，并告诉我结果。”
- “运行项目测试，超时设为五分钟。”
- “在资源管理器中定位文件，用记事本打开。”

Skill 根据 list_roots 的 locations 定位真实桌面、下载和文档目录，包括已移动到其他磁盘的位置。原生模板为 `skills/notion-local-files/SKILL.md`。

## 工具

| 工具 | 参数与行为 |
| --- | --- |
| list_roots | 返回访问模式、磁盘、相对路径基准和系统目录 |
| list_directory | path、offset、limit，分页列出目录 |
| get_path_info | path，查询真实路径、类型、大小与时间 |
| search_files | path、query、max_depth、limit，按文件名搜索 |
| read_file | path、offset、length、encoding，支持 utf8、utf16le、base64 |
| write_file | path、content、encoding，新建文件。默认拒绝覆盖，overwrite=true 替换时保留同目录备份并返回 backup_path |
| create_directory | path，在现有父目录下新建一级目录，多级目录逐级创建 |
| copy_file | source、destination，复制普通文件，拒绝覆盖。文件夹使用 copy_directory |
| move_path | source、destination，移动文件或同磁盘目录，拒绝覆盖目标 |
| rename_path | path、name，重命名文件或目录，name 为单个名称 |
| copy_directory | source、destination，递归复制到新目录，最多 10000 项、2 GiB |
| edit_file | path、encoding、edits，按顺序精确替换文本，返回备份和摘要 |
| read_document | path、offset、length，分页提取 PDF、DOCX、XLSX、PPTX 和文本正文 |
| run_command | 同步执行短命令，返回输出与退出码 |
| start_command | 启动后台命令，立即返回 task_id |
| get_command_task | task_id，查询运行状态及完成结果 |
| list_command_tasks | offset、limit，分页找回持久化任务记录 |
| read_command_log | task_id、offset、length，增量读取执行中的 stdout/stderr |
| cancel_command_task | task_id，请求终止命令进程树，随后查询实际状态 |
| list_apps | 查看配置中的程序及运行状态 |
| ensure_app | name，按需启动配置中的应用 |
| open_path | path、mode、app，打开文件、目录或定位文件 |

文件读取与目录分页使用返回的 next_offset，null 表示结束。分页间 modified_at 改变时重新读取。文件工具保护服务配置及 `.runtime`，限定目录模式会检查路径与链接目标，写入目标拒绝符号链接。

文件写入上限为 262144 字符。新建与复制先写临时文件再发布，已有文件默认返回 EEXIST。覆盖写入保留备份，避免在其他程序同时修改目标时覆盖。操作受 Windows 账户权限和文件系统支持限制。

移动支持跨磁盘普通文件，同磁盘目录使用重命名操作。跨磁盘目录移动会返回 CROSS_DEVICE_DIRECTORY，可先复制并核对结果。移动和重命名拒绝覆盖已有目标，访问根目录和包含服务配置的目录受保护。目录复制拒绝符号链接，复制失败会清理本次临时目录，源数据保留。

局部编辑支持最多 512 KiB 的 UTF-8 或 UTF-16LE 文本，结果最多 262144 字符。edits 中每项为 old_text、new_text 和可选的 replace_all，按顺序处理。默认必须唯一匹配，重复或无匹配返回 EDIT_MATCH。可用 expected_sha256 核对原始文件摘要，审批期间内容变化返回 FILE_CHANGED。成功后返回 backup_path，保留 BOM 和换行。

read_document 接受最多 20 MiB 文件，offset/length 按字符计数，每次最多返回 16000 字符。提取最多 100 万字符，PDF/PPTX 最多 200 页，截断通过 extraction_truncated 报告。解析在有内存和 30 秒时间限制的独立工作线程执行。PDF 使用文字层，扫描文档需要 OCR；DOCX 提取正文，XLSX 返回工作表及行列文字，PPTX 提取幻灯片文字。图片、图表、复杂排版可能需要另外处理，warnings 会说明范围。旧版 DOC/XLS/PPT 先转换格式。

## 长命令与超时

clone、安装、脚本、测试和构建使用 start_command。参数为 command、shell、cwd、timeout_ms、max_output_bytes，shell 默认为 powershell，也支持 cmd。命令最长 8000 字符，执行超时默认 60 秒，支持 1 秒到 10 分钟，stdout 与 stderr 合计默认最多回传 8192 字节。

返回 task_id 后每隔 3–5 秒查询 get_command_task，直到 completed、failed、timed_out 或 cancelled。结果包含 stdout、stderr、exit_code 和 safety。运行独立于单次 HTTP 请求，断线后使用原编号查询。避免重复提交运行中的命令。

任务记录与日志保存在受保护的 `.runtime/tasks`，完成结果在服务重启后仍可查询。list_command_tasks 找回历史任务编号。重启后原 running 任务标记为 interrupted，执行效果需核查，随后依据实际进程、文件和仓库状态决定是否重试。并发命令最多四个，保存记录最多 1000 条，达到上限请停止服务后归档记录。超时、取消或失败可能留下部分修改。命令使用当前 Windows 账户权限，可以修改文件和访问网络。

read_command_log 可在命令运行期间读取增量日志，offset/length 按字节计数，每次最多 16384 字节。后续调用使用返回的 next_offset，当前 EOF 仍返回可继续读取的偏移。日志标记 stdout/stderr，单任务最多 8 MiB，超限设置 log_truncated。最终结果的 max_output_bytes 限制单独生效。

## 本机配置

`.notion-local-mcp.json` 修改后重启服务。

- accessMode 为 all 时可访问当前 Windows 账户权限内的全电脑路径，为 restricted 时使用 roots 及已有目录授权记录。
- roots 的第一个目录作为相对路径基准，限定模式下可编辑该数组调整访问范围。
- approvalMode 默认 host，由 Notion 管理审批。显式 local 兼容 HTTP 客户端的本机确认模式。
- token 用于 Bearer 认证，port 默认 3210。
- publicUrl 用于固定 HTTPS 来源，例如 https://files.example.com。
- desktop.enabled、desktop.apps 和 desktop.openExtensions 设置程序及文件打开方式。
- notion.deviceId 关联本机 Skill，oauthPort 默认 3211，仅用于登录和更新 Skill。

## 固定 HTTPS 地址

固定隧道转发到本机 `http://127.0.0.1:3210`，按配置调整端口。设置 publicUrl 与 approvalMode=host，然后用 `npm start` 提供 HTTP MCP，Notion 连接 URL 为该来源下的 `/mcp`，保持 Bearer 认证。固定隧道的进程由其启动方式管理。

临时隧道用于试用，无持续在线保证，主机名每次启动会变化。[Cloudflare 文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 更新 Skill 与排查

保留现有登录时，在项目目录运行以下命令更新 Skill，随后在 Notion 新建聊天。

```powershell
$notionNode = (Get-Content -Raw .\.runtime\native-runtime.json | ConvertFrom-Json).nodeExecutable
& $notionNode .\src\install.js
```

连接失败时，先检查 native.ps1 -Action Status、日志、最新 URL 和认证信息。Notion 工具列表应包含写文件、复制文件和长命令工具。需要确认的操作在 Notion 中处理审批。旧聊天仍使用先前执行流程时，新建聊天重新选择 Skill。

running 表示命令仍在执行，连接超时后继续查询同一任务。TASK_NOT_FOUND 表示记录不可用，可能因重启或过期导致，先检查实际状态。失败结果依据 error、stderr 和退出码判断。

## 验证

```powershell
npm test
```

测试覆盖文件路径权限、全电脑访问、已有目录授权兼容、文件覆盖备份、并发新建冲突、移动重命名、目录复制和链接保护、局部编辑冲突、PDF/Office 解析、任务恢复、实时日志、HTTP MCP、PowerShell/CMD、中文输出、退出码、超时终止、取消、桌面工具、安装器互斥和凭据加密。
