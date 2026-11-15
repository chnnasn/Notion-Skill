param(
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$runtimeDirectory = Join-Path $PSScriptRoot '.runtime'
$cloudflaredPath = Join-Path $runtimeDirectory 'cloudflared.exe'
if ($Action -eq 'Start' -and !(Test-Path -LiteralPath $cloudflaredPath)) {
    throw '请先将官方 cloudflared-windows-amd64.exe 保存为 .runtime\cloudflared.exe。下载说明见 README。'
}
$settings = Get-Content -LiteralPath (Join-Path $runtimeDirectory 'native-runtime.json') -Raw | ConvertFrom-Json
$env:NOTION_MCP_CONFIG = $settings.configFile
Push-Location -LiteralPath $PSScriptRoot
try {
    & $settings.nodeExecutable src/runtime.js $Action.ToLowerInvariant()
    if ($LASTEXITCODE -ne 0) { throw 'Native MCP command failed.' }
} finally { Pop-Location }
