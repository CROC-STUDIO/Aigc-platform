param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^v\d+\.\d+\.\d+$")]
  [string]$Version,

  [string]$DesktopDir = "$env:USERPROFILE\Desktop"
)

$ErrorActionPreference = "Stop"

$appDir = $PSScriptRoot
$serverPath = Join-Path $appDir "server.mjs"
$appJsPath = Join-Path $appDir "public\app.js"

Get-ChildItem -LiteralPath (Join-Path $appDir "public") -Filter "*.html" -File | ForEach-Object {
  $html = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
  $html = [regex]::Replace($html, '<span class="app-version">v\d+\.\d+\.\d+</span>', "<span class=`"app-version`">$Version</span>")
  Set-Content -LiteralPath $_.FullName -Value $html -Encoding UTF8
}

node --check $serverPath | Out-Null
node --check $appJsPath | Out-Null

$pkgRoot = Join-Path $DesktopDir "seedance-ad-picture-web-package"
$dest = Join-Path $pkgRoot "ad-picture-web"
if (Test-Path $pkgRoot) { Remove-Item -LiteralPath $pkgRoot -Recurse -Force }
New-Item -ItemType Directory -Path $pkgRoot -Force | Out-Null
Copy-Item -LiteralPath $appDir -Destination $dest -Recurse -Force

Remove-Item -LiteralPath (Join-Path $dest "server-start.log") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $dest "server-error.log") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $dest "env.export.txt") -Force -ErrorAction SilentlyContinue

@'
{
  "users": [
    {
      "username": "admin",
      "password": "admin123",
      "displayName": "管理员",
      "role": "admin"
    }
  ]
}
'@ | Set-Content -LiteralPath (Join-Path $dest "users.example.json") -Encoding UTF8

@'
{
  "users": [
    {
      "username": "admin",
      "password": "admin123",
      "displayName": "admin",
      "role": "admin"
    }
  ]
}
'@ | Set-Content -LiteralPath (Join-Path $dest "users.json") -Encoding UTF8

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-PortableZip($sourceDir, $zipPath) {
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  $sourceFull = (Resolve-Path $sourceDir).Path.TrimEnd("\")
  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $sourceFull -File -Recurse | ForEach-Object {
      $relative = $_.FullName.Substring($sourceFull.Length + 1).Replace("\", "/")
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally {
    $zip.Dispose()
  }
}

$generic = Join-Path $DesktopDir "seedance-ad-picture-web-package.zip"
$versioned = Join-Path $DesktopDir "seedance-ad-picture-web-package-$Version.zip"
New-PortableZip -sourceDir $pkgRoot -zipPath $generic
New-PortableZip -sourceDir $pkgRoot -zipPath $versioned

$checkZip = [System.IO.Compression.ZipFile]::OpenRead($versioned)
try {
  $bad = @($checkZip.Entries | Where-Object { $_.FullName -like "*\*" } | Select-Object -First 5 -ExpandProperty FullName)
  if ($bad.Count) { throw "Zip contains backslash entries: $($bad -join ', ')" }
} finally {
  $checkZip.Dispose()
}

Get-Item $generic, $versioned | Select-Object FullName, Length, LastWriteTime
