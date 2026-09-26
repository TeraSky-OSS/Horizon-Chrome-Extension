# Opens Chrome so you can load this extension from the extension folder.
# Author: Guy Hemed | Company: Terasky

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$extensionDir = (Resolve-Path (Join-Path $root "extension")).Path
$manifestPath = Join-Path $extensionDir "manifest.json"

if (-not (Test-Path $manifestPath)) {
    Write-Host "ERROR: extension\manifest.json was not found." -ForegroundColor Red
    Write-Host "Run this script from the HorizonPoolImages folder."
    exit 1
}

Write-Host ""
Write-Host "Horizon Pool Images" -ForegroundColor Cyan
Write-Host "Extension folder:" -ForegroundColor Green
Write-Host "  $extensionDir"
Write-Host ""

try {
    Set-Clipboard -Value $extensionDir
    Write-Host "Path copied to clipboard." -ForegroundColor Green
} catch {
    Write-Host "Could not copy to clipboard. Copy the path above manually." -ForegroundColor Yellow
}

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$opened = $false
foreach ($chrome in $chromeCandidates) {
    if (Test-Path $chrome) {
        Start-Process $chrome "chrome://extensions"
        $opened = $true
        break
    }
}

if (-not $opened) {
    Start-Process "chrome://extensions"
}

Write-Host ""
Write-Host "Finish install in Chrome:" -ForegroundColor Cyan
Write-Host "  1. Turn on Developer mode (top-right)"
Write-Host "  2. Click Load unpacked"
Write-Host "  3. Select the extension folder (path is on the clipboard)"
Write-Host "  4. Open Horizon Console -> Inventory -> Desktops"
Write-Host ""
Write-Host "Keep this folder on disk. Chrome loads the extension from it." -ForegroundColor Yellow
Write-Host "Full guide: README.md"
Write-Host ""
