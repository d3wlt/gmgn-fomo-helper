$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
if ((Get-Item -LiteralPath $manifestPath).Length -eq 0) {
  throw 'manifest.json is empty; restore it before building a release'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "Invalid manifest.json version: $version"
}

$files = @(
  'manifest.json',
  'background.js',
  'page-bridge.js',
  'content.js',
  'debot-bridge.js',
  'debot-content.js',
  'fomo-early.js',
  'styles.css',
  'debot-styles.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
)

foreach ($relativePath in $files) {
  $fullPath = Join-Path $root $relativePath
  if (-not (Test-Path -LiteralPath $fullPath)) {
    throw "Missing release file: $relativePath"
  }
  if ((Get-Item -LiteralPath $fullPath).Length -eq 0) {
    throw "Release file is empty: $relativePath"
  }
}

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Get-ChildItem -LiteralPath $dist -File | Remove-Item -Force
$zipPath = Join-Path $dist "985gmgn-helper-v$version.zip"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($relativePath in $files) {
    $source = Join-Path $root $relativePath
    $entryName = $relativePath.Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $source,
      $entryName,
      [IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText(
  "$zipPath.sha256",
  "$hash  $([IO.Path]::GetFileName($zipPath))`n",
  $utf8NoBom
)

Write-Output "package=$zipPath"
Write-Output "version=$version"
Write-Output "sha256=$hash"
