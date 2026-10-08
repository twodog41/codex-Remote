param([Parameter(Mandatory = $true)][string]$Package)
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('remote-codex-portable-' + [guid]::NewGuid().ToString('N'))
$previousPath = $env:PATH
$previousHome = $env:REMOTE_CODEX_HOME
$previousCodex = $env:CODEX_BIN
$previousHTTP = $env:HTTP_PROXY
$previousHTTPS = $env:HTTPS_PROXY
try {
    $destination = Join-Path $testRoot '中文 路径'
    Expand-Archive -LiteralPath $Package -DestinationPath $destination
    $bundle = (Get-ChildItem -LiteralPath $destination -Directory | Select-Object -First 1).FullName
    $launcher = Start-Process -FilePath (Join-Path $bundle 'RemoteCodex.exe') -ArgumentList '--check' -Wait -PassThru -WindowStyle Hidden
    if ($launcher.ExitCode -ne 0) { throw 'EXE launcher package verification failed.' }
    # Reproduce a PC without Node/npm in PATH. Windows system tools remain available.
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    if (Get-Command node.exe -ErrorAction SilentlyContinue) { throw 'Node still present on test PATH.' }
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { throw 'npm still present on test PATH.' }
    $env:REMOTE_CODEX_HOME = Join-Path $testRoot 'private-config'
    $project = Join-Path $testRoot 'project'
    $other = Join-Path $testRoot 'other'
    New-Item -ItemType Directory -Path $project, $other -Force | Out-Null
    & (Join-Path $bundle 'scripts\setup.ps1') -Project $project -Quiet
    & (Join-Path $bundle 'scripts\allow-project.ps1') -Project $other
    $config = Get-Content -LiteralPath (Join-Path $env:REMOTE_CODEX_HOME 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.token.StartsWith('dpapi-current-user:') -or @($config.allowedProjects).Count -ne 2) { throw 'Portable configuration failed.' }
    $env:CODEX_BIN = Join-Path $bundle 'runtime\node.exe'
    $env:HTTP_PROXY = $null
    $env:HTTPS_PROXY = $null
    # Substitute only the transport entry to avoid sending real WeChat/model messages.
    [System.IO.File]::WriteAllText((Join-Path $bundle 'bridge\weixin.mjs'), @'
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
assert.equal(typeof require('qrcode-terminal').generate, 'function');
assert.match(process.execPath, /runtime[\\/]node.exe$/i);
console.log('PORTABLE_START_OK');
'@)
    & (Join-Path $bundle 'scripts\start.ps1') -Weixin
    if ($LASTEXITCODE -ne 0) { throw 'Portable startup failed.' }
    Write-Output 'PASS: portable setup, allowlist and WeChat startup without system Node/npm, from a Chinese path.'
} finally {
    $env:PATH = $previousPath
    $env:REMOTE_CODEX_HOME = $previousHome
    $env:CODEX_BIN = $previousCodex
    $env:HTTP_PROXY = $previousHTTP
    $env:HTTPS_PROXY = $previousHTTPS
    $absolute = [System.IO.Path]::GetFullPath($testRoot)
    $prefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $absolute) -notlike 'remote-codex-portable-*') { throw 'Unsafe portable test cleanup path.' }
    if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
