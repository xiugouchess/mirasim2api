$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root
& (Join-Path $Root 'scripts\compose.ps1') up -d --build
exit $LASTEXITCODE
