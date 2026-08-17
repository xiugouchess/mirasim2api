$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root
$envPath = Join-Path $Root '.env'
$examplePath = Join-Path $Root '.env.example'
$instancePath = Join-Path $Root '.instance.env'
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath $examplePath -Destination $envPath -Force
}
$needsInit = $true
if (Test-Path -LiteralPath $instancePath) {
  $content = Get-Content -LiteralPath $instancePath -Raw -Encoding UTF8
  if ($content -match '(?m)^MIRASIM_CONTAINER_NAME=mirasim-150-[a-f0-9]{4}$') { $needsInit = $false }
}
if ($needsInit) { & (Join-Path $Root 'scripts\init-instance.ps1') }
& (Join-Path $Root 'scriptsender-ports.ps1') | Out-Null
Get-Content -LiteralPath $instancePath -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}
& docker compose -f docker-compose.yml -f .compose.ports.yml @args
exit $LASTEXITCODE
