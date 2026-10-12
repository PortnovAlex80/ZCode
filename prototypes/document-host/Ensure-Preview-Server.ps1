param([string]$ServerPath, [string]$StateDirectory, [int]$Port)
$ErrorActionPreference = 'Stop'
$serverFile = (Resolve-Path -LiteralPath $ServerPath).Path
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$health = $null
try { $health = Invoke-RestMethod "https://localhost:$Port/health" } catch { }
if ($health -and $health.documentHostVersion -eq 2) { return }
if ($health) {
    $ownerIds = @(Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($ownerId in $ownerIds) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId"
        if ($owner.Name -ne 'node.exe' -or -not $owner.CommandLine.Contains($serverFile)) { throw "Port $Port belongs to a different server. It was left running." }
        Stop-Process -Id $ownerId
    }
}
$previewProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + $serverFile + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'server.log') -RedirectStandardError (Join-Path $StateDirectory 'server-error.log')
$previewProcess.Id | Set-Content (Join-Path $StateDirectory 'server.pid')
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { if ((Invoke-RestMethod "https://localhost:$Port/health").documentHostVersion -eq 2) { return } } catch { }
}
throw "Document preview server did not start on $Port. See server-error.log."
