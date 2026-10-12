$ErrorActionPreference = 'Stop'
$forkRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$config = Join-Path $env:LOCALAPPDATA 'SpecHarness\document-host\gateway.json'
if (-not (Test-Path -LiteralPath $config)) { throw 'Run Prepare-Document-Gateway.ps1 with the project folders first.' }
$runningZCode = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('electron.exe', 'zcode.exe') -and $_.CommandLine -match '(?i)(zcode-runtime|source-runtime|ZCode-Harness|Program Files\\zcode)'
})
if ($runningZCode.Count -gt 0) { throw 'Quit the current ZCODE normally before enabling the document gateway. No process was stopped.' }
$priorConfig = $env:ZCODE_DOCUMENT_GATEWAY_CONFIG
try {
    $env:ZCODE_DOCUMENT_GATEWAY_CONFIG = $config
    & (Join-Path $forkRoot 'Start-Harness.cmd')
} finally { $env:ZCODE_DOCUMENT_GATEWAY_CONFIG = $priorConfig }
