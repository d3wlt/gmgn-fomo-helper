param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ($Tag -notmatch '^v\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "Invalid version tag: $Tag"
}

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root "release-notes\$Tag.md"
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Missing release notes: release-notes/$Tag.md"
}

$content = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8).Trim()
$title = ($content -split "`r?`n")[0]
if ($title -ne "# GMGN FOMO Helper $Tag" -and $title -ne "# better gmgn $Tag") {
  throw "Release-note title does not match product and tag: $Tag"
}
$requiredSections = @(
  '## Highlights',
  '## Installation',
  '## Usage',
  '## Updating',
  '## Security and privacy'
)
foreach ($section in $requiredSections) {
  if (-not $content.Contains($section)) {
    throw "Release notes are missing section: $section"
  }
}
if (-not $content.Contains($Tag)) {
  throw "Release-note title does not include tag: $Tag"
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
[IO.File]::WriteAllText($OutputPath, "$content`n", [Text.UTF8Encoding]::new($false))

Write-Output "release_notes=$OutputPath"
Write-Output "tag=$Tag"
Write-Output "characters=$($content.Length)"
