param(
  [switch]$Upload,
  [string]$ProdEnvPath = "",
  [string]$JmsHost = "jump.corp.touka.plus",
  [string]$JmsPort = "2222",
  [string]$JmsKey = "$env:USERPROFILE\.ssh\jumpserver_rsa",
  [string]$JmsLogin = "liuxuan@dev@8.219.102.128"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root ".release"
$Stamp = Get-Date -Format "yyyyMMdd-HHmm"
$StampedTar = Join-Path $ReleaseDir "aigc-platform-$Stamp-release.tar.gz"
$LatestTar = Join-Path $ReleaseDir "aigc-platform-release.tar.gz"

New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null

$exclude = @(
  "node_modules", "mysql-data", "project-data", "others", ".git",
  ".env", ".env.*", "env.export.txt", "users.json", "config.json",
  ".understand-anything", ".release\*.tar.gz"
)

Push-Location $Root
try {
  Get-ChildItem -LiteralPath $ReleaseDir -Filter "aigc-platform-*-release.tar.gz" -ErrorAction SilentlyContinue | Remove-Item -Force
  if (Test-Path $LatestTar) { Remove-Item -LiteralPath $LatestTar -Force }

  $tempTar = Join-Path $env:TEMP "aigc-platform-$Stamp-release.tar.gz"
  if (Test-Path $tempTar) { Remove-Item -LiteralPath $tempTar -Force }

  $tarArgs = @("-czf", $tempTar)
  foreach ($name in $exclude) { $tarArgs += "--exclude=$name" }
  $tarArgs += "."
  & tar @tarArgs
  Copy-Item -LiteralPath $tempTar -Destination $StampedTar -Force
  Copy-Item -LiteralPath $tempTar -Destination $LatestTar -Force
  Remove-Item -LiteralPath $tempTar -Force -ErrorAction SilentlyContinue
  Get-Item $StampedTar, $LatestTar | Select-Object FullName, Length, LastWriteTime
} finally {
  Pop-Location
}

if (-not $Upload) {
  Write-Host ""
  Write-Host "Pack complete. Upload with:"
  Write-Host "  powershell -File .release/pack-and-upload.ps1 -Upload"
  exit 0
}

$batch = @(
  "put `"$LatestTar`" /tmp/aigc-platform-release.tar.gz"
  "put `"$(Join-Path $ReleaseDir 'deploy-remote.sh')`" /tmp/deploy-aigc-platform.sh"
)
if ($ProdEnvPath -and (Test-Path $ProdEnvPath)) {
  $batch += "put `"$ProdEnvPath`" /tmp/aigc-platform.prod.env"
}
$batch += "bye"
$batchFile = New-TemporaryFile
Set-Content -LiteralPath $batchFile -Value $batch -Encoding ascii

try {
  & sftp -P $JmsPort -o IdentitiesOnly=yes -i $JmsKey -o "User=$JmsLogin" -b $batchFile $JmsHost
} finally {
  Remove-Item -LiteralPath $batchFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Upload complete. Remote deploy:"
Write-Host "  ssh -p $JmsPort -o IdentitiesOnly=yes -i `"$JmsKey`" -l `"$JmsLogin`" `"$JmsHost`""
Write-Host "  sudo su -"
Write-Host "  chmod +x /tmp/deploy-aigc-platform.sh"
Write-Host "  bash /tmp/deploy-aigc-platform.sh"
