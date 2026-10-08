param([switch]$StopCodex, [switch]$WhatIf)
$ErrorActionPreference = 'Stop'
$root = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'config.json'))) { throw '未找到遥控配置。' }
if ($WhatIf) { Write-Host '预览：停用微信/手机遥控。StopCodex 另会结束当前用户的所有 Codex 进程树。'; return }
[System.IO.File]::WriteAllText((Join-Path $root 'remote-disabled'), 'Disabled on PC')
Write-Host '已持久停用遥控；不会仅凭关闭窗口就声称桌面任务已停止。'
if ($StopCodex) {
    Add-Type -AssemblyName System.Windows.Forms
    $answer = [System.Windows.Forms.MessageBox]::Show('这会强制结束当前用户的所有 Codex 任务及其子进程，可能中断写入。是否继续？', '紧急停止 Codex', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { Write-Host '已停用遥控，未结束桌面任务。'; return }
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $targets = Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe'"
    foreach ($process in $targets) {
        if (-not (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) { continue }
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner
        if (($owner.Domain + '\' + $owner.User) -eq $currentIdentity) {
            & taskkill.exe /PID $process.ProcessId /T /F
            if ($LASTEXITCODE -ne 0) { throw '未确认所有目标进程停止，请在任务管理器检查。' }
        }
    }
    Write-Host '已对当前用户的 Codex 进程树完成强制结束。'
}
