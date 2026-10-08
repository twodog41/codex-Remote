$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
Write-Host '微信遥控启动中。保持此窗口运行，可以最小化；关闭窗口会断开微信转发。'
& (Join-Path $PSScriptRoot 'wechat.ps1')
