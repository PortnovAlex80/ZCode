$ErrorActionPreference = 'Stop'
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
$running = $false
try { $running = (Invoke-RestMethod 'https://localhost:43481/health').preview -eq $true } catch { }
if (-not $running) {
    $previewProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewState 'server.log') -RedirectStandardError (Join-Path $previewState 'server-error.log')
    $previewProcess.Id | Set-Content (Join-Path $previewState 'server.pid')
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        try { if ((Invoke-RestMethod 'https://localhost:43481/health').preview) { $running = $true; break } } catch { }
    }
    if (-not $running) { throw 'Word preview HTTPS server did not start. See server-error.log.' }
}
$wordPath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE').'(default)'
Start-Process -FilePath $wordPath -ArgumentList ('/n "' + (Join-Path $previewState 'Word-Preview.docx') + '"')
