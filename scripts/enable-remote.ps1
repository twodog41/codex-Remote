$ErrorActionPreference = 'Stop'
$root = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
$flag = Join-Path $root 'remote-disabled'
if (Test-Path -LiteralPath $flag) { Remove-Item -LiteralPath $flag -Force }
Write-Host '已在电脑端恢复遥控入口。请重新启动。'
