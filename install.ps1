param(
    [string[]]$Roots = @(),
    [switch]$Portable
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$projectDirectory = $PSScriptRoot
$runtimeDirectory = Join-Path $projectDirectory '.runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

function Test-NodeVersion([string]$Executable) {
    if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    $nodeVersion = & $Executable -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0) { return $false }
    return ([version]$nodeVersion -ge [version]'22.16.0')
}

function Invoke-NodeStep([string[]]$NodeArguments) {
    & $script:nodeExecutable @NodeArguments
    if ($LASTEXITCODE -ne 0) { throw "Installation step failed: $($NodeArguments[0])" }
}

try {
    $nodeExecutable = $null
    $installedNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if (!$Portable -and $installedNode -and (Test-NodeVersion $installedNode.Source)) {
        $nodeExecutable = $installedNode.Source
    }
    if (!$nodeExecutable) {
        $cachedRuntimes = Get-ChildItem -LiteralPath $runtimeDirectory -Directory -Filter 'node-v24.*-win-*' | Sort-Object Name -Descending
        foreach ($cached in $cachedRuntimes) {
            $candidate = Join-Path $cached.FullName 'node.exe'
            if (Test-NodeVersion $candidate) { $nodeExecutable = $candidate; break }
        }
    }
    if (!$nodeExecutable) {
        $architecture = 'x64'
        if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $architecture = 'arm64' }
        Write-Host 'Downloading a portable Node.js runtime from nodejs.org...'
        $manifest = Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' -TimeoutSec 60
        $pattern = '^([a-fA-F0-9]{64})\s+(node-(v24\.\d+\.\d+)-win-' + $architecture + '\.zip)$'
        $matchingLines = @($manifest.Content -split "`n" | Where-Object { $_.Trim() -match $pattern })
        if ($matchingLines.Count -ne 1 -or $matchingLines[0].Trim() -notmatch $pattern) { throw 'Unable to identify the official Node.js archive.' }
        $expectedHash = $Matches[1]
        $archiveName = $Matches[2]
        $releaseVersion = $Matches[3]
        $archivePath = Join-Path $runtimeDirectory $archiveName
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$releaseVersion/$archiveName" -OutFile $archivePath -TimeoutSec 120
        if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Node.js archive checksum mismatch.' }
        Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeDirectory -Force
        $nodeExecutable = Join-Path (Join-Path $runtimeDirectory ([IO.Path]::GetFileNameWithoutExtension($archiveName))) 'node.exe'
        if (!(Test-NodeVersion $nodeExecutable)) { throw 'The downloaded Node.js runtime could not start.' }
    }

    $env:PATH = (Split-Path -Parent $nodeExecutable) + [IO.Path]::PathSeparator + $env:PATH
    Push-Location -LiteralPath $projectDirectory
    try {
        $configFile = Join-Path $projectDirectory '.notion-local-mcp.json'
        if ($env:NOTION_MCP_CONFIG) { $configFile = [IO.Path]::GetFullPath($env:NOTION_MCP_CONFIG) }
        $npmCli = Join-Path (Split-Path -Parent $nodeExecutable) 'node_modules\npm\bin\npm-cli.js'
        if (!(Test-Path -LiteralPath $npmCli)) { throw 'npm is missing from this Node.js installation.' }

        # Stop a receiver before replacing dependencies or refreshing OAuth credentials.
        if ((Test-Path -LiteralPath $configFile) -and (Test-Path -LiteralPath 'node_modules\@modelcontextprotocol\sdk\package.json')) {
            Invoke-NodeStep @('src/launcher.js', 'stop')
        }
        Invoke-NodeStep @($npmCli, 'ci', '--no-audit', '--no-fund')
        if (!(Test-Path -LiteralPath $configFile)) { Invoke-NodeStep (@('src/setup.js') + $Roots) }
        Invoke-NodeStep @('src/login.js')
        Invoke-NodeStep @('src/install.js')
        Invoke-NodeStep @('src/launcher.js', 'configure')
        Invoke-NodeStep @('src/launcher.js', 'open')
        Write-Host 'Setup complete. The receiver is online for this Windows session. Use the Skill in Notion to control MCP.'
    } finally { Pop-Location }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
