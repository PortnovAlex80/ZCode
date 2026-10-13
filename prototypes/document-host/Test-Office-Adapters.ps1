param([ValidateSet('both','word','excel')][string]$HostName = 'both')
$ErrorActionPreference = 'Stop'
if (@(Get-Process WINWORD,EXCEL -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Close Word/Excel before running the isolated native acceptance. No application was stopped.' }
if ($HostName -eq 'both') {
    # Office's shared WebView debug endpoints are more stable with one fixture host at a time.
    foreach ($acceptanceHost in @('word', 'excel')) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -HostName $acceptanceHost
        if ($LASTEXITCODE -ne 0) { throw "Native $acceptanceHost acceptance failed." }
    }
    return
}
$officeTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('spec-harness-office-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $officeTestRoot | Out-Null
$priorArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$wordApp = $null; $excelApp = $null
$wordProcess = $null; $excelProcess = $null
function Wait-OfficeObject([string]$ProgramId) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try { return [Runtime.InteropServices.Marshal]::GetActiveObject($ProgramId) } catch { Start-Sleep -Milliseconds 250 }
    }
    throw "Owned Office fixture did not start: $ProgramId"
}
try {
    & (Join-Path $PSScriptRoot 'Build-Document-Pane.ps1')
    if (-not $?) { throw 'Pane build failed.' }
    $localRoot = Join-Path $env:LOCALAPPDATA 'SpecHarness'
    foreach ($officeKind in @('word', 'excel')) {
        & node (Join-Path $PSScriptRoot "..\$officeKind-preview\prepare.mjs")
        if ($LASTEXITCODE -ne 0) { throw 'Office sample preparation failed.' }
        $port = if ($officeKind -eq 'word') { 43481 } else { 43483 }
        & (Join-Path $PSScriptRoot 'Ensure-Preview-Server.ps1') -ServerPath (Join-Path $PSScriptRoot "..\$officeKind-preview\server.mjs") -StateDirectory (Join-Path $localRoot "$officeKind-preview") -Port $port
        if (-not $?) { throw 'Preview server failed.' }
    }
    Copy-Item -LiteralPath (Join-Path $localRoot 'word-preview\Word-Preview.docx') -Destination (Join-Path $officeTestRoot 'Word-Acceptance.docx')
    Copy-Item -LiteralPath (Join-Path $localRoot 'excel-preview\Excel-Preview.xlsx') -Destination (Join-Path $officeTestRoot 'Excel-Acceptance.xlsx')
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=43482'
    # Launch directly so only these fixture processes inherit the temporary CDP flag.
    $wordPath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE').'(default)'
    $excelPath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\EXCEL.EXE').'(default)'
    if ($HostName -ne 'excel') {
        $wordProcess = Start-Process -WindowStyle Hidden -FilePath $wordPath -ArgumentList ('/n "' + (Join-Path $officeTestRoot 'Word-Acceptance.docx') + '"') -PassThru
        $wordApp = Wait-OfficeObject 'Word.Application'
        $wordApp.Visible = $true
    }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=43484'
    if ($HostName -ne 'word') {
        $excelProcess = Start-Process -WindowStyle Hidden -FilePath $excelPath -ArgumentList ('/x "' + (Join-Path $officeTestRoot 'Excel-Acceptance.xlsx') + '"') -PassThru
        $excelApp = Wait-OfficeObject 'Excel.Application'
        $excelApp.Visible = $true
        # Office.js cannot create legacy CSE (Ctrl+Shift+Enter) array formulas, but the
        # adapter must refuse writes to savedAsArray targets. Seed one on the disposable
        # fixture copy through the same owned Excel instance via its application API
        # (not the filesystem) before the acceptance checks start.
        $fixtureWorkbook = $null
        for ($attempt = 0; $attempt -lt 80 -and -not $fixtureWorkbook; $attempt++) {
            $fixtureWorkbook = @($excelApp.Workbooks) | Where-Object { $_.Name -like 'Excel-Acceptance*' } | Select-Object -First 1
            if (-not $fixtureWorkbook) { Start-Sleep -Milliseconds 250 }
        }
        if (-not $fixtureWorkbook) { throw 'Owned Excel acceptance workbook not found.' }
        $fixtureWorkbook.Worksheets.Item(1).Range('AB1:AB2').FormulaArray = '=1+2'
    }
    & node (Join-Path $PSScriptRoot 'office-native-acceptance.mjs') $HostName
    if ($LASTEXITCODE -ne 0) { throw 'Native Office acceptance failed.' }
} finally {
    try { if ($wordApp) { $saveChoice = 0; $wordApp.Quit([ref]$saveChoice); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($wordApp) } }
    finally { if ($excelApp) { $excelApp.DisplayAlerts = $false; $excelApp.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excelApp) } }
    foreach ($ownedProcess in @($wordProcess, $excelProcess)) { if ($ownedProcess -and -not $ownedProcess.HasExited) { $ownedProcess.WaitForExit(5000) | Out-Null } }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $priorArguments
    $resolvedTestPath = [IO.Path]::GetFullPath($officeTestRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTestPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolvedTestPath)).StartsWith('spec-harness-office-test-')) { throw 'Unexpected Office acceptance cleanup path.' }
    Remove-Item -LiteralPath $resolvedTestPath -Recurse -Force
}
