# Download portable Node.js if not installed
$ErrorActionPreference = 'Continue'

$portableDir = Join-Path $env:TEMP 'lyric-hub-portable-node'
if (Test-Path $portableDir) {
    $existingNode = Get-ChildItem $portableDir -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingNode) {
        Write-Host "Portable Node.js already exists: $($existingNode.FullName)"
        exit 0
    }
}

New-Item -ItemType Directory -Path $portableDir -Force | Out-Null

$zip = Join-Path $env:TEMP 'node-portable.zip'
$url = 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip'

Write-Host "Downloading Node.js v22.11.0 (~30MB)..."
try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L -o $zip $url 2>$null
    } else {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
} catch {
    Write-Host "Download failed: $($_.Exception.Message)"
    Write-Host "Please install Node.js from https://nodejs.org/"
    exit 1
}

if (-not (Test-Path $zip)) {
    Write-Host "Download failed: zip not found"
    exit 1
}

Write-Host "Extracting..."
Expand-Archive -Path $zip -DestinationPath $portableDir -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue

$innerNode = Get-ChildItem $portableDir -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($innerNode) {
    $target = Join-Path $portableDir 'node.exe'
    if ($innerNode.FullName -ne $target) {
        Move-Item $innerNode.FullName $target -Force
    }
    Write-Host "Node.js ready: $target"
    exit 0
}

Write-Host "Something went wrong - node.exe not found after extract"
exit 1
