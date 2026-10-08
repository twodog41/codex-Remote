function Get-RemoteNode {
    $bundled = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return [pscustomobject]@{ Source = $bundled } }
    return Get-Command node.exe -ErrorAction Stop
}
