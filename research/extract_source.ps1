param([string]$inputFile, [string]$outputFile)
$json = Get-Content $inputFile -Raw | ConvertFrom-Json
Write-Host "ContractName: $($json.result[0].ContractName)"
Write-Host "CompilerVersion: $($json.result[0].CompilerVersion)"
Write-Host "SourceCodeLength: $($json.result[0].SourceCode.Length)"
$src = $json.result[0].SourceCode
$src | Out-File -FilePath $outputFile -Encoding UTF8
