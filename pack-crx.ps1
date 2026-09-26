# Pack extension\ into a CRX for Group Policy deployment.
# The private key is stored outside this folder so it is not synced.
#
#   powershell -ExecutionPolicy Bypass -File .\pack-crx.ps1 -UpdateBaseUrl "https://intranet.example.com/horizon-pool-images"
#
# Author: Guy Hemed | Company: Terasky

param(
    [string]$UpdateBaseUrl = "https://YOUR-SERVER/horizon-pool-images"
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$extensionDir = Join-Path $root "extension"
$manifestPath = Join-Path $extensionDir "manifest.json"
if (-not (Test-Path $manifestPath)) {
    throw "extension\manifest.json was not found."
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version

function Join-ByteArray {
    $list = New-Object System.Collections.Generic.List[byte]
    foreach ($arr in $args) {
        if ($null -eq $arr) { continue }
        foreach ($b in @($arr)) { $list.Add([byte]$b) }
    }
    return ,$list.ToArray()
}

function Get-DerLengthBytes([int]$Length) {
    if ($Length -lt 128) { return [byte[]]([byte]$Length) }
    if ($Length -lt 256) { return [byte[]]([byte]0x81, [byte]$Length) }
    return [byte[]](
        [byte]0x82,
        [byte](($Length -shr 8) -band 0xFF),
        [byte]($Length -band 0xFF)
    )
}

function Read-DerElement([byte[]]$Data, [ref]$Pos) {
    $start = $Pos.Value
    $tag = $Data[$Pos.Value]
    $Pos.Value++
    $len = [int]$Data[$Pos.Value]
    $Pos.Value++
    if ($len -ge 128) {
        $count = $len - 128
        $len = 0
        for ($i = 0; $i -lt $count; $i++) {
            $len = ($len * 256) + [int]$Data[$Pos.Value]
            $Pos.Value++
        }
    }
    $content = New-Object byte[] $len
    if ($len -gt 0) {
        [Array]::Copy($Data, $Pos.Value, $content, 0, $len)
    }
    $Pos.Value += $len
    $fullLen = $Pos.Value - $start
    $full = New-Object byte[] $fullLen
    [Array]::Copy($Data, $start, $full, 0, $fullLen)
    return [pscustomobject]@{
        Tag = $tag
        Content = $content
        Full = $full
    }
}

function Get-DerChildren([byte[]]$Content) {
    $items = @()
    $pos = 0
    $posRef = [ref]$pos
    while ($pos -lt $Content.Length) {
        $items += Read-DerElement $Content $posRef
    }
    return $items
}

function Convert-PemToRsaPublicKeyTlv([string]$Pem) {
    $isPkcs8 = $Pem -match "BEGIN PRIVATE KEY"
    $isPkcs1 = $Pem -match "BEGIN RSA PRIVATE KEY"
    if (-not $isPkcs8 -and -not $isPkcs1) {
        throw "Private key is not an RSA PEM file."
    }
    $b64 = [regex]::Replace($Pem, "-----[^-]+-----", "")
    $b64 = $b64 -replace "\s", ""
    $der = [Convert]::FromBase64String($b64)
    $pos = 0
    $outer = Read-DerElement $der ([ref]$pos)
    $pkcs1 = $outer.Content
    if ($isPkcs8) {
        $parts = Get-DerChildren $outer.Content
        $octet = $parts | Where-Object { $_.Tag -eq 0x04 } | Select-Object -First 1
        if (-not $octet) { throw "Could not read the PKCS#8 private key." }
        $innerPos = 0
        $inner = Read-DerElement $octet.Content ([ref]$innerPos)
        $pkcs1 = $inner.Content
    }
    $fields = Get-DerChildren $pkcs1
    if ($fields.Count -lt 3) { throw "Could not read the RSA private key." }
    return Join-ByteArray $fields[1].Full $fields[2].Full
}

function Get-ChromeExtensionIdFromPem([string]$PemPath) {
    $pem = Get-Content $PemPath -Raw
    $publicTlv = Convert-PemToRsaPublicKeyTlv $pem
    $rsaPublic = Join-ByteArray ([byte]0x30) (Get-DerLengthBytes $publicTlv.Length) $publicTlv

    $oid = [byte[]](0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00)
    $algorithm = Join-ByteArray ([byte]0x30) (Get-DerLengthBytes $oid.Length) $oid

    $bitBody = Join-ByteArray ([byte]0x00) $rsaPublic
    $bitString = Join-ByteArray ([byte]0x03) (Get-DerLengthBytes $bitBody.Length) $bitBody

    $spkiBody = Join-ByteArray $algorithm $bitString
    $spki = Join-ByteArray ([byte]0x30) (Get-DerLengthBytes $spkiBody.Length) $spkiBody

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($spki)
    } finally {
        $sha.Dispose()
    }

    $hex = -join ($hash[0..15] | ForEach-Object { $_.ToString("x2") })
    $id = -join ($hex.ToCharArray() | ForEach-Object {
        $code = [int][char]$_
        if ($_ -ge '0' -and $_ -le '9') { [char]($code + 49) } else { [char]($code + 10) }
    })
    return $id
}

function Find-Chrome {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    throw "Google Chrome was not found. Install Chrome, then run this script again."
}

$keyDir = Join-Path $env:USERPROFILE ".horizon-pool-images"
New-Item -ItemType Directory -Path $keyDir -Force | Out-Null
$keyPath = Join-Path $keyDir "extension.pem"

$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Path $dist -Force | Out-Null

$chrome = Find-Chrome
$packProfile = Join-Path $env:TEMP "hpi-chrome-pack"
if (Test-Path $packProfile) {
    Remove-Item $packProfile -Recurse -Force -ErrorAction SilentlyContinue
}

$packedCrx = Join-Path $root "extension.crx"
$packedPem = Join-Path $root "extension.pem"
foreach ($stale in @($packedCrx, $packedPem)) {
    if (Test-Path $stale) { Remove-Item $stale -Force }
}

$chromeArgs = @(
    "--user-data-dir=$packProfile",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--pack-extension=$extensionDir"
)
if (Test-Path $keyPath) {
    $chromeArgs += "--pack-extension-key=$keyPath"
}

Write-Host "Packing CRX with Chrome..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -PassThru
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
    if ((Test-Path $packedCrx) -and ((Test-Path $keyPath) -or (Test-Path $packedPem))) { break }
    if ($proc.HasExited -and (Test-Path $packedCrx)) { break }
    Start-Sleep -Milliseconds 400
}

if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
}

if ((Test-Path $packedPem) -and -not (Test-Path $keyPath)) {
    Move-Item $packedPem $keyPath -Force
}

if (-not (Test-Path $packedCrx)) {
    throw "Chrome did not create the CRX. Close any leftover Chrome pack window and run this script again."
}
if (-not (Test-Path $keyPath)) {
    throw "Chrome did not create a private key."
}

$extensionId = Get-ChromeExtensionIdFromPem $keyPath
$crxName = "HorizonPoolImages-$version.crx"
$crxOut = Join-Path $dist $crxName
Move-Item $packedCrx $crxOut -Force

$base = $UpdateBaseUrl.TrimEnd("/")
$crxUrl = "$base/$crxName"
$xmlUrl = "$base/updates.xml"

$xml = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$extensionId'>
    <updatecheck codebase='$crxUrl' version='$version' />
  </app>
</gupdate>
"@
$xmlPath = Join-Path $dist "updates.xml"
Set-Content -Path $xmlPath -Value $xml -Encoding ASCII

$gpoJson = @"
{
  "$extensionId": {
    "installation_mode": "force_installed",
    "update_url": "$xmlUrl",
    "override_update_url": true
  }
}
"@
$jsonPath = Join-Path $dist "gpo-extension-settings.json"
Set-Content -Path $jsonPath -Value $gpoJson.Trim() -Encoding ASCII
Set-Content -Path (Join-Path $dist "extension-id.txt") -Value $extensionId -Encoding ASCII

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Extension ID: $extensionId"
Write-Host "  CRX:          $crxOut"
Write-Host "  Update XML:   $xmlPath"
Write-Host "  GPO JSON:     $jsonPath"
Write-Host "  Private key:  $keyPath"
Write-Host ""
Write-Host "Keep the private key. Pack every future version with this same script." -ForegroundColor Yellow
Write-Host "Do not put the private key in GitHub or in the folder you sync." -ForegroundColor Yellow
if ($UpdateBaseUrl -match "YOUR-SERVER") {
    Write-Host ""
    Write-Host "Update URL is still a placeholder. Re-run with -UpdateBaseUrl when the web server path is known." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Copy the CRX and updates.xml to the web server, then paste the GPO JSON into Chrome policy."
