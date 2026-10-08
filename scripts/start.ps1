param([switch]$Weixin, [switch]$LoginOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node.exe -ErrorAction Stop
$codex = if ($env:CODEX_BIN) { $env:CODEX_BIN } else {
    $exe = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($exe) { $exe.Source } else {
        # npm on Windows exposes codex.cmd. Find its native executable instead of launching a shell.
        $shim = Get-Command codex.cmd -ErrorAction SilentlyContinue
        $vendorRoot = if ($shim) { Join-Path (Split-Path -Parent $shim.Source) 'node_modules\@openai' } else { '' }
        $candidates = if ($vendorRoot -and (Test-Path -LiteralPath $vendorRoot)) {
            Get-ChildItem -LiteralPath $vendorRoot -Filter codex.exe -Recurse -File |
                Where-Object { $_.FullName -match '(x86_64|aarch64)-pc-windows' }
        }
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
        $match = $candidates | Where-Object { $_.FullName -match $arch } | Select-Object -First 1
        if (-not $match) {
            # Desktop Codex bundles its CLI without adding it to a normal PowerShell PATH.
            $bundledRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
            if (Test-Path -LiteralPath $bundledRoot) {
                $match = Get-ChildItem -LiteralPath $bundledRoot -Filter codex.exe -Recurse -File |
                    Sort-Object LastWriteTime -Descending | Select-Object -First 1
            }
        }
        if (-not $match) { throw '找不到 codex.exe。请设置 CODEX_BIN 为 exe 的完整路径，或安装 Codex CLI。' }
        $match.FullName
    }
}
if (-not (Test-Path -LiteralPath $codex -PathType Leaf)) { throw 'CODEX_BIN 必须指向真实的 codex.exe。' }
$env:CODEX_BIN = $codex
$nodeOptions = @()
if ($Weixin) {
    $dependency = Join-Path $repoRoot 'node_modules\qrcode-terminal\package.json'
    if (-not (Test-Path -LiteralPath $dependency)) {
        $npm = Get-Command npm.cmd -ErrorAction Stop
        & $npm.Source install --ignore-scripts --no-audit --no-fund --prefix $repoRoot
        if ($LASTEXITCODE -ne 0) { throw '安装扫码依赖失败。' }
    }
    if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
        $helpText = & $node.Source --help
        if ($helpText -match '--use-env-proxy') { $nodeOptions += '--use-env-proxy' }
    }
    $entry = Join-Path $repoRoot 'bridge\weixin.mjs'
} else { $entry = Join-Path $repoRoot 'bridge\server.mjs' }
$entryOptions = if ($LoginOnly) { @('--login', '--login-only') } else { @() }
& $node.Source @nodeOptions $entry @entryOptions
if ($LASTEXITCODE -ne 0) { throw "Bridge 已退出，代码 $LASTEXITCODE。" }
