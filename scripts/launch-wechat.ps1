$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
Write-Host '微信遥控启动中。保持此窗口运行，可以最小化；关闭窗口会断开微信转发。'
$configRoot = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
if (-not (Test-Path -LiteralPath (Join-Path $configRoot 'config.json'))) {
    $project = (Read-Host '首次使用：请输入要让 Codex 工作的项目文件夹完整路径').Trim().Trim('"')
    if (-not $project) { throw '项目路径不能为空。' }
    & (Join-Path $PSScriptRoot 'wechat.ps1') -Project $project
} else { & (Join-Path $PSScriptRoot 'wechat.ps1') }
