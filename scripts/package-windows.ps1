param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$nodeVersion = '24.21.0'
$nodeHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$dist = Join-Path $repoRoot 'dist'
$cache = Join-Path $dist 'cache'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$download = Join-Path $cache "node-v$nodeVersion-win-x64.zip"
if (-not (Test-Path -LiteralPath $download)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $download
}
if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeHash) {
    throw 'Node archive checksum mismatch. Package was not built.'
}
$runtimeRoot = Join-Path $cache "node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'node.exe'))) { Expand-Archive -LiteralPath $download -DestinationPath $cache -Force }
$stageRoot = Join-Path $dist ('package-' + [guid]::NewGuid().ToString('N'))
$folderName = "RemoteCodex-$version-windows-x64"
$stage = Join-Path $stageRoot $folderName
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$previousPath = $env:PATH
try {
    # Explicit source roots: never copy Git metadata or local credentials/runtime data.
    foreach ($directory in @('bridge', 'scripts', 'docs', 'ios')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination $stage -Recurse
    }
    foreach ($file in @('README.md', 'VALIDATION.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '启动微信.cmd', '紧急停用遥控.cmd', '紧急停止Codex.cmd', '查看运行记录.cmd', '支持开发.jpg')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $stage
    }
    New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') | Out-Null
    foreach ($file in @('node.exe', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $runtimeRoot $file) -Destination (Join-Path $stage 'runtime')
    }
    $env:PATH = $runtimeRoot + ';' + $previousPath
    & (Join-Path $runtimeRoot 'npm.cmd') ci --ignore-scripts --omit=dev --no-audit --no-fund --prefix $stage
    if ($LASTEXITCODE -ne 0) { throw 'Installing pinned package dependencies failed.' }
    Add-Type -TypeDefinition ([System.IO.File]::ReadAllText((Join-Path $repoRoot 'scripts\launcher.cs'))) -Language CSharp -ReferencedAssemblies 'System.dll','System.Windows.Forms.dll' -OutputAssembly (Join-Path $stage 'RemoteCodex.exe') -OutputType WindowsApplication
    Copy-Item -LiteralPath (Join-Path $stage 'RemoteCodex.exe') -Destination (Join-Path $dist 'RemoteCodex.exe') -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $output = Join-Path $dist ($folderName + '.zip')
    $temporaryZip = $stageRoot + '.zip'
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $temporaryZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    # The output file is created outside the archived directory to avoid including itself.
    Move-Item -LiteralPath $temporaryZip -Destination $output -Force
    $checksum = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText($output + '.sha256', "$checksum  $folderName.zip`n", (New-Object System.Text.UTF8Encoding($false)))
    $exeHash = (Get-FileHash -LiteralPath (Join-Path $dist 'RemoteCodex.exe')).Hash.ToLowerInvariant()
    [System.IO.File]::AppendAllText($output + '.sha256', "$exeHash  RemoteCodex.exe`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "Portable package: $output"
} finally {
    $env:PATH = $previousPath
    $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
    $distPrefix = [System.IO.Path]::GetFullPath($dist).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolvedStage) -notlike 'package-*') { throw 'Unsafe staging cleanup path.' }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
