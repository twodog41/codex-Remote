param([switch]$WhatIf)
$ErrorActionPreference = 'Stop'
$root = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'config.json'))) { throw '未找到遥控配置。' }
if ($WhatIf) { Write-Host '预览：停用遥控并移除本机微信凭据与发送上下文；保留 Codex 聊天和图片。'; return }
[System.IO.File]::WriteAllText((Join-Path $root 'remote-disabled'), 'Unbound on PC')
foreach ($name in @('weixin.json', 'weixin.json.tmp', 'weixin-state.json', 'weixin-state.json.tmp', 'weixin-login.svg')) {
    $path = Join-Path $root $name
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
Write-Host '本机微信已解绑且遥控停用。服务端凭据撤销需在微信连接设置中解除授权；本机删除不能代替服务端撤销。'
