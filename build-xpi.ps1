param(
  [string]$OutputPath = "dist/ipaddr2country.xpi"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$database = Join-Path $root "data/ip-country.json"
if (-not (Test-Path -LiteralPath $database)) {
  throw "Offline database is missing. Run: python scripts/update-db.py YYYY MM"
}
$databaseContent = Get-Content -LiteralPath $database -Raw
if ($databaseContent -notmatch '"ipv4":\[\[' -and $databaseContent -notmatch '"ipv6":\[\[') {
  throw "Offline database contains no IP ranges. Re-run scripts/update-db.py after fixing the CSV import."
}

$destination = Join-Path $root $OutputPath
$destinationDirectory = Split-Path -Parent $destination
New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
if (Test-Path -LiteralPath $destination) {
  Remove-Item -LiteralPath $destination -Force
}

$stagingRoot = Join-Path $root "dist/.staging"
New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
$buildId = [guid]::NewGuid().ToString("N")
$staging = Join-Path $stagingRoot $buildId
$temporaryArchive = Join-Path $stagingRoot ($buildId + ".zip")
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $root "manifest.json") -Destination $staging
  Copy-Item -LiteralPath (Join-Path $root "background.js") -Destination $staging
  Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $staging
  Copy-Item -LiteralPath (Join-Path $root "LICENSE-DB-IP.txt") -Destination $staging
  Copy-Item -LiteralPath (Join-Path $root "experiments") -Destination $staging -Recurse
  New-Item -ItemType Directory -Path (Join-Path $staging "data") | Out-Null
  Copy-Item -LiteralPath $database -Destination (Join-Path $staging "data/ip-country.json")
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $temporaryArchive -CompressionLevel Optimal
  Move-Item -LiteralPath $temporaryArchive -Destination $destination -Force
  Write-Output "Created $destination"
} finally {
  $resolvedStaging = [System.IO.Path]::GetFullPath($staging)
  $resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedStaging.StartsWith($resolvedStagingRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a staging directory outside dist/.staging"
  }
  Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  $resolvedArchive = [System.IO.Path]::GetFullPath($temporaryArchive)
  if (-not $resolvedArchive.StartsWith($resolvedStagingRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a temporary archive outside dist/.staging"
  }
  if (Test-Path -LiteralPath $resolvedArchive) {
    Remove-Item -LiteralPath $resolvedArchive -Force
  }
}

