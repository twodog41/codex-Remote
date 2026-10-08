param(
    [Parameter(Mandatory = $true)][string]$Project,
    [ValidateRange(1024, 65535)][int]$Port = 8787,
    [switch]$RotateToken,
    [switch]$ShowToken,
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path -LiteralPath $Project).Path
if (-not (Test-Path -LiteralPath $projectPath -PathType Container)) { throw 'Project 必须是目录。' }
$nodeForPaths = Get-Command node.exe -ErrorAction Stop
$projectPath = & $nodeForPaths.Source -e "process.stdout.write(require('fs').realpathSync.native(process.argv[1]));" $projectPath
if ($LASTEXITCODE -ne 0 -or -not $projectPath) { throw '无法解析项目的真实目录。' }
$configRoot = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
$configPath = Join-Path $configRoot 'config.json'
$statePath = Join-Path $configRoot 'state.json'
if (-not [System.IO.Path]::IsPathRooted($configRoot) -or [System.IO.Path]::GetPathRoot($configRoot) -eq $configRoot.TrimEnd('\') + '\') {
    throw 'REMOTE_CODEX_HOME 必须是专用目录的绝对路径，不能是盘符根目录。'
}
if ((Test-Path -LiteralPath $configRoot) -and -not (Test-Path -LiteralPath $configPath) -and (Get-ChildItem -LiteralPath $configRoot -Force | Select-Object -First 1)) {
    throw '配置目录已有其他文件。请使用一个新的专用目录。'
}
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
# Protect the pairing secret and transcripts with the current Windows user's ACL.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# icacls changes the DACL without Set-Acl's SeSecurityPrivilege requirement on Windows PowerShell 5.
& icacls.exe $configRoot '/grant:r' ('*{0}:(OI)(CI)F' -f $identity.Value) '/inheritance:r' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护配置目录权限。' }
$acl = Get-Acl -LiteralPath $configRoot
foreach ($entry in @($acl.Access)) {
    $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
    if ($sid -ne $identity) {
        & icacls.exe $configRoot '/remove' ('*{0}' -f $sid.Value) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '无法清理配置目录的其他访问权限。' }
    }
}
$old = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
if ($old -and $old.project -ne $projectPath -and (Test-Path -LiteralPath $statePath)) {
    throw '当前配置已绑定其他项目。请设置 REMOTE_CODEX_HOME 为另一个专用目录，原会话会保留。'
}
$pairToken = if ($old -and -not $RotateToken) { $old.token } else {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
$configData = @{ project = $projectPath; port = $Port; token = $pairToken }
if (-not $pairToken.StartsWith('dpapi-current-user:')) {
    Add-Type -AssemblyName System.Security
    $entropy = [Text.Encoding]::UTF8.GetBytes('CodeRemote-local-secrets-v1')
    $protectedToken = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($pairToken), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $configData.token = 'dpapi-current-user:' + [Convert]::ToBase64String($protectedToken)
}
$configData.allowedProjects = @($projectPath)
$configData.allowlistEnabled = $false
if ($old -and $old.PSObject.Properties['allowlistEnabled']) { $configData.allowlistEnabled = ($old.allowlistEnabled -eq $true) }
if ($old -and $old.PSObject.Properties['allowedProjects']) { $configData.allowedProjects = @($old.allowedProjects) }
if ($old.desktop -and $old.project -eq $projectPath) { $configData.desktop = $old.desktop }
if ($old.proxy) { $configData.proxy = $old.proxy }
$config = $configData | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "配置已保存：$configPath"
Write-Host "项目：$projectPath"
if (-not $Quiet) {
    Write-Host '运行 .\scripts\start.ps1 启动 bridge。'
    Write-Host "在安装 Tailscale 的管理员 PowerShell 中运行：tailscale serve --bg http://127.0.0.1:$Port"
}
if ($ShowToken) {
    $displayToken = $pairToken
    if ($pairToken.StartsWith('dpapi-current-user:')) {
        Add-Type -AssemblyName System.Security
        $entropy = [Text.Encoding]::UTF8.GetBytes('CodeRemote-local-secrets-v1')
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($pairToken.Substring(19)), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $displayToken = [Text.Encoding]::UTF8.GetString($bytes)
    }
    Write-Host "配对密钥（请只填入自己的 iPhone）：$displayToken"
}
elseif (-not $Quiet) { Write-Host '需要查看手机配对密钥时，以相同项目重新运行 setup.ps1 并添加 -ShowToken。' }
if ($RotateToken) { Write-Host '密钥已轮换，请重启正在运行的 bridge，并在手机更新密钥。' }
