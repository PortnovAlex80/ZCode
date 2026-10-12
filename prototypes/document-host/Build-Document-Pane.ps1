$ErrorActionPreference = 'Stop'
$forkRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$paneOutput = Join-Path $env:LOCALAPPDATA 'SpecHarness\document-host\assets'
New-Item -ItemType Directory -Path $paneOutput -Force | Out-Null
Push-Location $forkRoot
try {
    & pnpm.cmd exec esbuild packages/ui/src/document-host/client.ts --bundle --minify --format=esm --platform=browser --alias:@=./packages/ui/src --outfile="$paneOutput\client.js"
    if ($LASTEXITCODE -ne 0) { throw 'Document client build failed.' }
} finally { Pop-Location }
Write-Host "Document client built: $paneOutput\client.js"
