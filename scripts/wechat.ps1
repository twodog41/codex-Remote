param([string]$Project, [switch]$LoginOnly, [string]$ThreadId, [switch]$Independent)
$ErrorActionPreference = 'Stop'
$configRoot = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFullPath($configRoot).ToLowerInvariant())))).Replace('-', '') }
finally { $hash.Dispose() }
$mutex = New-Object System.Threading.Mutex($false, ('Local\RemoteCodexWeChat-' + $key))
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { Write-Host '微信遥控已经运行，不需要重复启动。'; return }
if ($Project) { & (Join-Path $PSScriptRoot 'setup.ps1') -Project $Project -Quiet }
if (-not (Test-Path -LiteralPath (Join-Path $configRoot 'config.json'))) {
    throw '第一次运行请指定项目目录：.\scripts\wechat.ps1 -Project "D:\你的项目"'
}
$configFile = Join-Path $configRoot 'config.json'
$configData = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($configData.proxy) {
    if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $configData.proxy }
    if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $configData.proxy }
}
if ($ThreadId -and $Independent) { throw 'ThreadId 与 Independent 不能同时使用。' }
if ($ThreadId -or $Independent) {
    if ($Independent) { $configData.PSObject.Properties.Remove('desktop') }
    else {
        if ($ThreadId -notmatch '^[a-fA-F0-9-]{36}$') { throw '会话 ID 格式无效。' }
        if (-not $configData.desktop) { throw '尚未绑定桌面连接，请先在 Codex 中让助手运行 bind-desktop.mjs。' }
        $configData.desktop.threadId = $ThreadId
    }
    [System.IO.File]::WriteAllText($configFile, ($configData | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}
& (Join-Path $PSScriptRoot 'start.ps1') -Weixin -LoginOnly:$LoginOnly
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
