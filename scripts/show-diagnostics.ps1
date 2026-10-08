$ErrorActionPreference = 'Stop'
$root = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
$file = Join-Path $root 'diagnostics.log'
if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Encoding UTF8 -Tail 80 }
else { Write-Host '尚无运行记录。请先运行新版微信入口。' }
Read-Host '按回车关闭' | Out-Null
