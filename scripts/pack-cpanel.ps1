# Builds belaview-server-cpanel.zip for cPanel File Manager upload.
# Mirrors the JG deployment pattern: runtime source + package files only.
# Excludes node_modules, .env, public/uploads, database schema and docs.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "belaview-server-cpanel.zip"
$stage = Join-Path $env:TEMP "belaview-server-pack"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item (Join-Path $root "index.js") $stage
Copy-Item (Join-Path $root "package.json") $stage
if (Test-Path (Join-Path $root "package-lock.json")) {
  Copy-Item (Join-Path $root "package-lock.json") $stage
}
Copy-Item (Join-Path $root "db") -Destination $stage -Recurse
Copy-Item (Join-Path $root "middleware") -Destination $stage -Recurse

if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $out -Force
Remove-Item $stage -Recurse -Force

Write-Host "Created $out"
Write-Host ("Size: {0:N0} bytes" -f (Get-Item $out).Length)
