$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\document-host\Build-Document-Pane.ps1')
if (-not $?) { throw 'Document pane build failed.' }
$previewTools = Join-Path $env:LOCALAPPDATA 'SpecHarness\word-preview-tools'
$previewState = Join-Path $env:LOCALAPPDATA 'SpecHarness\word-preview'
if (-not (Test-Path -LiteralPath (Join-Path $previewTools 'node_modules\office-addin-dev-certs'))) {
    & npm.cmd install --prefix $previewTools --ignore-scripts --no-audit --no-fund office-addin-debugging@7.0.1 office-addin-dev-certs@3.0.1
    if ($LASTEXITCODE -ne 0) { throw 'Office preview tools installation failed.' }
}
& node (Join-Path $PSScriptRoot 'server.mjs') --certificates-only
if ($LASTEXITCODE -ne 0) { throw 'Development certificate setup failed.' }
& node (Join-Path $PSScriptRoot 'prepare.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Word preview registration failed.' }
& (Join-Path $PSScriptRoot '..\document-host\Ensure-Preview-Server.ps1') -ServerPath (Join-Path $PSScriptRoot 'server.mjs') -StateDirectory $previewState -Port 43481
if (-not $?) { throw 'Word document server failed.' }
$wordPath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE').'(default)'
Start-Process -FilePath $wordPath -ArgumentList ('/n "' + (Join-Path $previewState 'Word-Preview.docx') + '"')
