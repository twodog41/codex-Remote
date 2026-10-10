$ErrorActionPreference = 'Stop'
# Accept only a pipe owned by this user's registered official Codex Store app.
$package = Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PublisherId -eq '2p2nqsd0c76g0' } | Select-Object -First 1
if (-not $package) { Write-Output '[]'; exit }
$executables = @('ChatGPT.exe', 'Codex.exe') | ForEach-Object { Join-Path $package.InstallLocation ('app\' + $_) }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class RemoteCodexPipeOwner {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeServerProcessId(IntPtr handle, out uint pid);
}
'@
$verifiedPipes = @()
$trustedServers = @{}
$pipes = @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -match '^\\\\\.\\pipe\\codex-browser-use-[a-f0-9-]{36}$' } | Select-Object -First 24)
foreach ($path in $pipes) {
    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $path.Substring(9), [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    try {
        $client.Connect(150)
        $serverId = [uint32]0
        if (-not [RemoteCodexPipeOwner]::GetNamedPipeServerProcessId($client.SafePipeHandle.DangerousGetHandle(), [ref]$serverId)) { continue }
        $serverKey = [string]$serverId
        if (-not $trustedServers.ContainsKey($serverKey)) {
            $trustedServers[$serverKey] = $false
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId"
            if ($process -and $process.ExecutablePath -in $executables) {
                $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner
                $trustedServers[$serverKey] = ($owner.ReturnValue -eq 0 -and ($owner.Domain + '\' + $owner.User) -eq $identity)
            }
        }
        if ($trustedServers[$serverKey]) { $verifiedPipes += $path }
    } catch { } finally { $client.Dispose() }
}
ConvertTo-Json -InputObject @($verifiedPipes) -Compress
