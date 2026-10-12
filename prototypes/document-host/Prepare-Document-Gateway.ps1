param([string[]]$WorkspacePath = @((Join-Path $PSScriptRoot '..\..')))
$ErrorActionPreference = 'Stop'
$documentState = Join-Path $env:LOCALAPPDATA 'SpecHarness\document-host'
New-Item -ItemType Directory -Path $documentState -Force | Out-Null
$gatewayConfigPath = Join-Path $documentState 'gateway.json'
$resolvedWorkspaces = @($WorkspacePath | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
$devCertificates = Join-Path $env:USERPROFILE '.office-addin-dev-certs'
if (-not (Test-Path -LiteralPath (Join-Path $devCertificates 'localhost.crt'))) { throw 'Run Start-Word-Preview.ps1 once to prepare the local HTTPS certificate.' }
if (-not (Test-Path -LiteralPath (Join-Path $devCertificates 'ca.crt'))) { throw 'The local Office developer CA certificate is missing. Run Start-Word-Preview.ps1.' }
$gatewayConfig = @{
    port = 43485
    token = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    keyPath = Join-Path $devCertificates 'localhost.key'
    certPath = Join-Path $devCertificates 'localhost.crt'
    caPath = Join-Path $devCertificates 'ca.crt'
    nodePath = (Get-Command node).Source
    helperPath = Join-Path $PSScriptRoot 'mcp-server.mjs'
    statePath = Join-Path $documentState 'bindings.json'
    workspaces = $resolvedWorkspaces
    origins = @('https://localhost:43481', 'https://localhost:43483', 'https://acad-preview.invalid')
}
if (Test-Path -LiteralPath $gatewayConfigPath) { $previousConfig = Get-Content -LiteralPath $gatewayConfigPath -Raw | ConvertFrom-Json; $gatewayConfig.token = $previousConfig.token }
$gatewayConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $gatewayConfigPath -Encoding UTF8
Write-Host "Gateway prepared without launching ZCODE. Config: $gatewayConfigPath"
Write-Host 'On the next fork launch, set ZCODE_DOCUMENT_GATEWAY_CONFIG to this path.'
Write-Host 'The pairing token is in gateway.json. Paste it into the document pane; it is not a model credential.'
