param([string]$AutoCADRoot = 'C:\Program Files\Autodesk\AutoCAD 2024')
$ErrorActionPreference = 'Stop'
if (@(Get-Process acad -ErrorAction SilentlyContinue).Count -gt 0) { throw 'AutoCAD is already open. Use NETLOAD and SHDOC in that instance; no application was changed.' }
$plugin = Join-Path $env:LOCALAPPDATA 'SpecHarness\autocad-preview\plugin\SpecHarness.AutoCAD.dll'
if (-not (Test-Path -LiteralPath $plugin)) { & (Join-Path $PSScriptRoot 'Build-AutoCAD-Preview.ps1') -AutoCADRoot $AutoCADRoot; if (-not $?) { throw 'AutoCAD pane build failed.' } }
$startup = Join-Path $env:LOCALAPPDATA 'SpecHarness\autocad-preview\startup.scr'
$nativePath = ([IO.Path]::GetFullPath($plugin)).Replace('\','/').Replace('"','\"')
[IO.File]::WriteAllText($startup, "_.NETLOAD`n" + '"' + $nativePath + '"' + "`nSHDOC`n", [Text.UTF8Encoding]::new($false))
# This explicitly invoked command opens the interactive CAD application, not ZCODE.
Start-Process -FilePath (Join-Path $AutoCADRoot 'acad.exe') -ArgumentList ('/nologo /b "' + $startup + '"')
