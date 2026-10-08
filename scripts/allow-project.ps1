param([Parameter(Mandatory = $true)][string]$Project, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = if ($env:REMOTE_CODEX_HOME) { $env:REMOTE_CODEX_HOME } else { Join-Path $env:LOCALAPPDATA 'RemoteCodex' }
$file = Join-Path $root 'config.json'
$config = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
$path = (Resolve-Path -LiteralPath $Project).Path
if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw '项目必须是已存在的目录。' }
. (Join-Path $PSScriptRoot 'runtime.ps1')
$nodeForPaths = Get-RemoteNode
$path = & $nodeForPaths.Source -e "process.stdout.write(require('fs').realpathSync.native(process.argv[1]));" $path
if ($LASTEXITCODE -ne 0 -or -not $path) { throw '无法解析项目的真实目录。' }
$approved = @($config.allowedProjects)
if (-not $config.PSObject.Properties['allowedProjects']) { $approved = @($config.project) }
if ($Remove) { $approved = @($approved | Where-Object { $_ -ne $path }) }
elseif ($approved -notcontains $path) { $approved += $path }
$config | Add-Member -NotePropertyName allowedProjects -NotePropertyValue @($approved) -Force
[System.IO.File]::WriteAllText($file + '.tmp', ($config | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath ($file + '.tmp') -Destination $file -Force
Write-Host '电脑端项目白名单已保存。重启遥控入口生效。'
