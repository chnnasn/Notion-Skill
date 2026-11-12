param(
    [ValidateSet('Open', 'Start', 'Stop', 'Status')]
    [string]$Action = 'Open'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime\launcher.json') -Raw | ConvertFrom-Json
    if (!(Test-Path -LiteralPath $settings.nodeExecutable -PathType Leaf)) { throw 'Please run install.ps1 again to repair the runtime path.' }
    $env:NOTION_MCP_CONFIG = $settings.configFile
    Push-Location -LiteralPath (Split-Path -Parent $settings.configFile)
    try {
        $output = & $settings.nodeExecutable (Join-Path $PSScriptRoot 'src\launcher.js') $Action.ToLowerInvariant() 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
        $output | Write-Output
    } finally { Pop-Location }
} catch {
    if ($Action -eq 'Open') {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show([string]$_.Exception.Message, 'Notion Local Computer') | Out-Null
    }
    Write-Error $_ -ErrorAction Continue
    exit 1
}
