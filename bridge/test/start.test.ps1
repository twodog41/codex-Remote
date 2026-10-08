$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $env:TEMP ('remote-codex-start-test-' + [guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA
$originalCodexBin = $env:CODEX_BIN
$originalExpectedBin = $env:REMOTE_CODEX_TEST_BIN
$originalExitCode = $global:LASTEXITCODE
$originalRemoteHome = $env:REMOTE_CODEX_HOME
$originalHTTPProxy = $env:HTTP_PROXY
$originalHTTPSProxy = $env:HTTPS_PROXY
try {
    $fakeBundle = Join-Path $testRoot 'OpenAI\Codex\bin\test-version'
    New-Item -ItemType Directory -Path $fakeBundle -Force | Out-Null
    $env:REMOTE_CODEX_TEST_BIN = Join-Path $fakeBundle 'codex.exe'
    [System.IO.File]::WriteAllText($env:REMOTE_CODEX_TEST_BIN, '')
    $fakeNode = Join-Path $testRoot 'check-node.ps1'
    [System.IO.File]::WriteAllText($fakeNode, 'if ($env:CODEX_BIN -ne $env:REMOTE_CODEX_TEST_BIN) { throw "Wrong bundled Codex selected." }; $global:LASTEXITCODE = 0')
    $env:LOCALAPPDATA = $testRoot
    $env:CODEX_BIN = $null
    # Reproduce a user's terminal with Node available and no Codex command on PATH.
    function Get-Command {
        param($Name, $ErrorAction)
        if ($Name -eq 'node.exe') { return [pscustomobject]@{ Source = $fakeNode } }
        if ($Name -notin @('codex.exe', 'codex.cmd')) { throw "Unexpected command lookup: $Name" }
    }
    & (Join-Path $PSScriptRoot '..\..\scripts\start.ps1')
    if ($env:CODEX_BIN -ne $env:REMOTE_CODEX_TEST_BIN) { throw 'Bundled CLI fallback failed.' }
    Write-Output 'PASS: desktop-bundled Codex is found when CODEX_BIN and PATH commands are absent.'
    $env:REMOTE_CODEX_HOME = Join-Path $testRoot 'isolated-config'
    New-Item -ItemType Directory -Path $env:REMOTE_CODEX_HOME | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $env:REMOTE_CODEX_HOME 'config.json'), '{"proxy":"http://127.0.0.1:12345"}')
    $env:HTTP_PROXY = $null
    $env:HTTPS_PROXY = $null
    [System.IO.File]::WriteAllText($fakeNode, @'
if ($args -contains '--help') { Write-Output '--use-env-proxy'; return }
if ($env:HTTP_PROXY -ne 'http://127.0.0.1:12345' -or $env:HTTPS_PROXY -ne $env:HTTP_PROXY) { throw 'Saved proxy not applied.' }
if ($args -notcontains '--use-env-proxy') { throw 'Node proxy option absent.' }
$global:LASTEXITCODE = 0
'@)
    & (Join-Path $PSScriptRoot '..\..\scripts\wechat.ps1') -LoginOnly
    Write-Output 'PASS: saved proxy is reused by the WeChat launcher without network or model calls.'
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:CODEX_BIN = $originalCodexBin
    $env:REMOTE_CODEX_TEST_BIN = $originalExpectedBin
    $global:LASTEXITCODE = $originalExitCode
    $env:REMOTE_CODEX_HOME = $originalRemoteHome
    $env:HTTP_PROXY = $originalHTTPProxy
    $env:HTTPS_PROXY = $originalHTTPSProxy
    $absoluteTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $tempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $absoluteTestRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $absoluteTestRoot) -notlike 'remote-codex-start-test-*') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $absoluteTestRoot -Recurse -Force
}
