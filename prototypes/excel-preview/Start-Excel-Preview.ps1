$ErrorActionPreference = 'Stop'
$previewTools = Join-Path $env:LOCALAPPDATA 'SpecHarness\word-preview-tools'
$previewState = Join-Path $env:LOCALAPPDATA 'SpecHarness\excel-preview'
if (-not (Test-Path -LiteralPath (Join-Path $previewTools 'node_modules\office-addin-dev-certs'))) {
    & npm.cmd install --prefix $previewTools --ignore-scripts --no-audit --no-fund office-addin-debugging@7.0.1 office-addin-dev-certs@3.0.1
    if ($LASTEXITCODE -ne 0) { throw 'Office preview tools installation failed.' }
}
& node (Join-Path $PSScriptRoot '..\word-preview\server.mjs') --certificates-only
if ($LASTEXITCODE -ne 0) { throw 'Development certificate setup failed.' }
& node (Join-Path $PSScriptRoot 'prepare.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Excel preview registration failed.' }
$running = $false
try { $running = (Invoke-RestMethod 'https://localhost:43483/health').preview -eq $true } catch { }
if (-not $running) {
    $previewProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewState 'server.log') -RedirectStandardError (Join-Path $previewState 'server-error.log')
    $previewProcess.Id | Set-Content (Join-Path $previewState 'server.pid')
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        try { if ((Invoke-RestMethod 'https://localhost:43483/health').preview) { $running = $true; break } } catch { }
    }
    if (-not $running) { throw 'Excel preview HTTPS server did not start. See server-error.log.' }
}
$wordPath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\EXCEL.EXE').'(default)'
Start-Process -FilePath $wordPath -ArgumentList ('/x "' + (Join-Path $previewState 'Excel-Preview.xlsx') + '"')
