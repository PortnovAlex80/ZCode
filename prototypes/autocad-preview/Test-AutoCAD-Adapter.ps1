param([string]$AutoCADRoot = 'C:\Program Files\Autodesk\AutoCAD 2024')
$ErrorActionPreference = 'Stop'
$cadTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('spec-harness-cad-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $cadTestRoot | Out-Null
$cadTestRoot = (Resolve-Path -LiteralPath $cadTestRoot).Path
$priorReceipt = $env:ZCODE_CAD_ACCEPTANCE_RECEIPT
try {
    $testOutput = Join-Path $cadTestRoot 'plugin'
    & dotnet build (Join-Path $PSScriptRoot 'SpecHarness.AutoCAD.csproj') -c Release '-p:BuildVerification=true' "-p:AutoCADRoot=$AutoCADRoot" "-p:BaseIntermediateOutputPath=$cadTestRoot\obj\" -o $testOutput
    if ($LASTEXITCODE -ne 0) { throw 'CAD verification build failed.' }
    $receipt = Join-Path $cadTestRoot 'receipt.json'
    $env:ZCODE_CAD_ACCEPTANCE_RECEIPT = $receipt
    $testScript = Join-Path $cadTestRoot 'verify.scr'
    @('_TRUSTEDPATHS', ('"' + $testOutput + '"'), '_NETLOAD', ('"' + (Join-Path $testOutput 'SpecHarness.AutoCAD.dll') + '"'), 'SHDOCVERIFY', '_QUIT', '_N', '') | Set-Content -LiteralPath $testScript -Encoding ASCII
    $console = Start-Process -FilePath (Join-Path $AutoCADRoot 'accoreconsole.exe') -ArgumentList @('/s', ('"' + $testScript + '"'), '/isolate', 'SpecHarnessVerification', ('"' + (Join-Path $cadTestRoot 'profile') + '"')) -WorkingDirectory $cadTestRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $cadTestRoot 'stdout.log') -RedirectStandardError (Join-Path $cadTestRoot 'stderr.log')
    if (-not $console.WaitForExit(45000)) { Stop-Process -Id $console.Id -Force; throw 'CAD verification timed out.' }
    if (-not (Test-Path -LiteralPath $receipt)) { throw ('CAD verification did not produce a receipt: ' + (Get-Content -LiteralPath (Join-Path $cadTestRoot 'stdout.log') -Raw)) }
    $result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($result.status -ne 'passed') { throw $result.error }
    Write-Host "AutoCAD native API: $($result.checks) checks passed. No model or ZCODE launched."
} finally {
    $env:ZCODE_CAD_ACCEPTANCE_RECEIPT = $priorReceipt
    $resolvedTestPath = [IO.Path]::GetFullPath($cadTestRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTestPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolvedTestPath)).StartsWith('spec-harness-cad-test-')) { throw 'Unexpected CAD verification cleanup path.' }
    Remove-Item -LiteralPath $resolvedTestPath -Recurse -Force
}
