param([string]$AutoCADRoot = 'C:\Program Files\Autodesk\AutoCAD 2024')
$ErrorActionPreference = 'Stop'
$forkRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$cadOutput = Join-Path $env:LOCALAPPDATA 'SpecHarness\autocad-preview\plugin'
$cadObjects = Join-Path $env:LOCALAPPDATA 'SpecHarness\autocad-preview\obj'
if (-not (Test-Path -LiteralPath (Join-Path $AutoCADRoot 'AcMgd.dll'))) { throw 'AutoCAD 2024 managed API not found.' }
& (Join-Path $PSScriptRoot '..\document-host\Build-Document-Pane.ps1')
if (-not $?) { throw 'Document pane build failed.' }
& dotnet build (Join-Path $PSScriptRoot 'SpecHarness.AutoCAD.csproj') -c Release "-p:AutoCADRoot=$AutoCADRoot" "-p:BaseIntermediateOutputPath=$cadObjects\" -o $cadOutput
if ($LASTEXITCODE -ne 0) { throw 'AutoCAD plug-in build failed.' }
$cadAssets = Join-Path $cadOutput 'assets'
New-Item -ItemType Directory -Path $cadAssets -Force | Out-Null
foreach ($file in @('index.html', 'pane.js', 'interactions.js', 'pane.css')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\document-host\$file") -Destination (Join-Path $cadAssets $file) }
Copy-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'SpecHarness\document-host\assets\client.js') -Destination (Join-Path $cadAssets 'client.js')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bootstrap.js') -Destination (Join-Path $cadAssets 'bootstrap.js')
Copy-Item -LiteralPath (Join-Path $forkRoot 'prototypes\word-preview\panel.css') -Destination (Join-Path $cadAssets 'panel.css')
Copy-Item -LiteralPath (Join-Path $forkRoot 'packages\desktop\build\icon.png') -Destination (Join-Path $cadAssets 'icon.png')
Write-Host "Built without starting AutoCAD or ZCODE: $cadOutput\SpecHarness.AutoCAD.dll"
