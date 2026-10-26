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
Push-Location $stage
try {
  # bsdtar (Windows tar) writes forward-slash ZIP entries, unlike
  # Compress-Archive which writes backslashes that break Linux extraction.
  & tar -a -c -f $out *
  if ($LASTEXITCODE -ne 0) { throw "tar failed creating $out (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($out)
try {
  $bad = @($zip.Entries | Where-Object { $_.FullName.Contains("\") })
  if ($bad.Count -gt 0) {
    throw "ZIP contains backslash entry names and is not safe for cPanel: $($bad[0].FullName)"
  }
} finally {
  $zip.Dispose()
}
Remove-Item $stage -Recurse -Force

Write-Host "Created $out"
Write-Host ("Size: {0:N0} bytes" -f (Get-Item $out).Length)
