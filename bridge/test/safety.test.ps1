$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('remote-codex-safety-native-' + [guid]::NewGuid().ToString('N'))
$previousRemoteHome = $env:REMOTE_CODEX_HOME
try {
    $env:REMOTE_CODEX_HOME = Join-Path $taskRoot 'config'
    $project = Join-Path $taskRoot 'project'
    $other = Join-Path $taskRoot 'other'
    New-Item -ItemType Directory -Path $project, $other -Force | Out-Null
    $scripts = Join-Path $PSScriptRoot '..\..\scripts'
    $setupOutput = & (Join-Path $scripts 'setup.ps1') -Project $project -Quiet -ShowToken 6>&1
    $configFile = Join-Path $env:REMOTE_CODEX_HOME 'config.json'
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.token.StartsWith('dpapi-current-user:')) { throw 'Setup left pairing token in plaintext.' }
    if ($config.allowlistEnabled -ne $false) { throw 'Allowlist must be disabled on first setup.' }
    $config.allowlistEnabled = $true
    [System.IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 8))
    if (($setupOutput | Out-String) -notmatch '[a-f0-9]{64}') { throw 'Explicit pairing token display failed.' }
    $repeatOutput = & (Join-Path $scripts 'setup.ps1') -Project $project -Quiet -ShowToken 6>&1
    if (($repeatOutput | Out-String) -notmatch '[a-f0-9]{64}') { throw 'Encrypted token could not be shown for pairing.' }
    & (Join-Path $scripts 'allow-project.ps1') -Project $other
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.allowlistEnabled -ne $true) { throw 'Repeated setup did not retain the allowlist switch.' }
    if (@($config.allowedProjects).Count -ne 2) { throw 'PC allowlist add failed.' }
    & (Join-Path $scripts 'allow-project.ps1') -Project $other -Remove
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($config.allowedProjects).Count -ne 1) { throw 'PC allowlist removal failed.' }
    & (Join-Path $scripts 'allow-project.ps1') -Project $project -Remove
    $repeatOutput = & (Join-Path $scripts 'setup.ps1') -Project $project -Quiet 6>&1
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($config.allowedProjects).Count -ne 0) { throw 'Setup silently reapproved a removed project.' }
    & (Join-Path $scripts 'emergency-stop.ps1') -WhatIf
    if (Test-Path -LiteralPath (Join-Path $env:REMOTE_CODEX_HOME 'remote-disabled')) { throw 'Preview mutated stop state.' }
    & (Join-Path $scripts 'emergency-stop.ps1')
    if (-not (Test-Path -LiteralPath (Join-Path $env:REMOTE_CODEX_HOME 'remote-disabled'))) { throw 'Persistent stop failed.' }
    & (Join-Path $scripts 'enable-remote.ps1')
    if (Test-Path -LiteralPath (Join-Path $env:REMOTE_CODEX_HOME 'remote-disabled')) { throw 'PC recovery failed.' }
    [System.IO.File]::WriteAllText((Join-Path $env:REMOTE_CODEX_HOME 'weixin.json'), '{"token":"test-fixture"}')
    & (Join-Path $scripts 'unbind-wechat.ps1') -WhatIf
    if (-not (Test-Path -LiteralPath (Join-Path $env:REMOTE_CODEX_HOME 'weixin.json'))) { throw 'Unbind preview deleted credentials.' }
    & (Join-Path $scripts 'unbind-wechat.ps1')
    if (Test-Path -LiteralPath (Join-Path $env:REMOTE_CODEX_HOME 'weixin.json')) { throw 'Local unbind failed.' }
    if (-not (Test-Path -LiteralPath $configFile)) { throw 'Unbind deleted configuration.' }
    Write-Output 'PASS: Windows PowerShell 5 encrypted setup, pairing display, allowlist, stop/recovery and local unbind.'
} finally {
    $env:REMOTE_CODEX_HOME = $previousRemoteHome
    $absolute = [System.IO.Path]::GetFullPath($taskRoot)
    $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $absolute) -notlike 'remote-codex-safety-native-*') { throw 'Unsafe native test cleanup.' }
    Remove-Item -LiteralPath $absolute -Recurse -Force
}
