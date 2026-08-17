param([switch]$Force, [switch]$New)
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$EnvFile = Join-Path $Root '.env'
$Example = Join-Path $Root '.env.example'
$InstanceFile = Join-Path $Root '.instance.env'
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Copy-Item -LiteralPath $Example -Destination $EnvFile -Force
}

function New-Suffix4 {
  $bytes = New-Object byte[] 2
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

$current = $null
if (Test-Path -LiteralPath $InstanceFile) {
  $content = Get-Content -LiteralPath $InstanceFile -Raw -Encoding UTF8
  if ($content -match '(?m)^MIRASIM_INSTANCE_ID=([a-f0-9]{4})$') { $current = $Matches[1] }
}
if (($Force -or $New) -or -not $current) { $suffix = New-Suffix4 } else { $suffix = $current }

$content = @"
MIRASIM_INSTANCE_ID=$suffix
MIRASIM_COMPOSE_PROJECT_NAME=mirasim150-$suffix
MIRASIM_CONTAINER_NAME=mirasim-150-$suffix
COMPOSE_PROJECT_NAME=mirasim150-$suffix
"@
[System.IO.File]::WriteAllText($InstanceFile, $content.Replace("`r`n", "`n"), [System.Text.UTF8Encoding]::new($false))
Write-Host "generated .instance.env"
Write-Host "MIRASIM_CONTAINER_NAME=mirasim-150-$suffix"
