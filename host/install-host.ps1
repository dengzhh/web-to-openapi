# install-host.ps1 -- register/unregister the web-to-openapi native messaging host
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-host.ps1             # register
#   powershell -ExecutionPolicy Bypass -File install-host.ps1 -Uninstall  # unregister
# Registers under HKCU (no admin needed), both Edge and Chrome keys
# (Edge reads the Chrome key as a compatibility fallback).
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

$HostName = "com.webtoopenapi.host"
$Manifest = Join-Path $PSScriptRoot "com.webtoopenapi.host.json"

if (-not (Test-Path $Manifest)) { Write-Error "manifest not found: $Manifest"; exit 1 }

$m = Get-Content $Manifest -Raw -Encoding utf8 | ConvertFrom-Json

# Self-heal: native messaging requires an ABSOLUTE path to the launcher.
# Rewrite path to the real run_host.bat next to this script so the package
# works no matter where it is unzipped (the committed path is author-specific).
$RealPath = Join-Path $PSScriptRoot "run_host.bat"
$m.path = $RealPath

# Self-heal 2: native messaging requires allowed_origins to match the real extension ID.
# Derive it from the extension manifest key (SPKI public key, base64) using Chromium's
# algorithm: sha256(DER) -> first 16 bytes -> hex -> each char c maps to 'a'+val(c).
# So the package keeps working even after someone swaps in a self-generated key.
$ExtManifest = Join-Path (Split-Path $PSScriptRoot -Parent) "extension\manifest.json"
if (Test-Path $ExtManifest) {
    $ext = Get-Content $ExtManifest -Raw -Encoding utf8 | ConvertFrom-Json
    if ($ext.key) {
        $der = [System.Convert]::FromBase64String($ext.key)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hash = $sha.ComputeHash($der)
        $sha.Dispose()
        $hex = -join ($hash[0..15] | ForEach-Object { $_.ToString("x2") })
        $id = -join ($hex.ToCharArray() | ForEach-Object {
            [char]([int][char]'a' + [System.Convert]::ToInt32([string]$_, 16))
        })
        $origin = "chrome-extension://$id/"
        if ($m.allowed_origins -notcontains $origin) {
            $m.allowed_origins = @($origin)
            Write-Host "[info] allowed_origins -> $origin (derived from extension key)"
        }
    }
}

$json = $m | ConvertTo-Json -Depth 10
# [System.Text.Encoding]::UTF8 is UTF8Encoding(true) in Windows PowerShell: it prepends a
# UTF-8 BOM on EVERY write. RFC 8259 forbids a BOM in JSON and strict parsers reject such
# files, so re-running this script would reintroduce the BOM. Write without it instead.
[System.IO.File]::WriteAllText($Manifest, $json, (New-Object System.Text.UTF8Encoding($false)))

# Hard check: the manifest must not start with EF BB BF.
$head = [System.IO.File]::ReadAllBytes($Manifest)
if ($head.Length -ge 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
    Write-Error "[verify] FAILED - manifest was written with a UTF-8 BOM"
    exit 1
}

if (-not (Test-Path $m.path)) { Write-Error "host launcher not found: $($m.path)"; exit 1 }
Write-Host "[info] manifest:" $Manifest
Write-Host "[info] host path:" $m.path
Write-Host "[info] allowed_origins:" ($m.allowed_origins -join ", ")

$keys = @(
    "HKEY_CURRENT_USER\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\$HostName"
)

if ($Uninstall) {
    foreach ($k in $keys) {
        if (Test-Path "Registry::$k") {
            Remove-Item "Registry::$k" -Recurse -Force
            Write-Host "[removed]" $k
        } else {
            Write-Host "[skip]" $k "(not present)"
        }
    }
    Write-Host "[done] uninstalled. Remove/disable the extension at edge://extensions or chrome://extensions"
    exit 0
}

foreach ($k in $keys) {
    # Report a stale key before overwriting it. Unzipping an update into a NEW folder
    # and loading the extension without re-running this script is the usual cause of
    # "Specified native messaging host not found": the key still points at the old
    # folder's manifest, and that folder is gone. Saying it out loud turns a silent
    # fix into visible evidence.
    $prev = $null
    if (Test-Path "Registry::$k") {
        $prevKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($k.Substring("HKEY_CURRENT_USER\".Length))
        if ($prevKey) { $prev = $prevKey.GetValue(""); $prevKey.Close() }
    }
    if ($prev -and ($prev -ne $Manifest)) {
        if (Test-Path $prev) {
            Write-Host "[fix] key pointed at another copy:" $prev "(exists; repointed to this folder)"
        } else {
            Write-Host "[fix] key pointed at a MISSING manifest:" $prev
            Write-Host "[fix]   ^ this is exactly what causes 'Specified native messaging host not found'"
        }
    }
    $sub = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($k.Substring("HKEY_CURRENT_USER\".Length))
    $sub.SetValue("", $Manifest, [Microsoft.Win32.RegistryValueKind]::String)
    $sub.Close()
    Write-Host "[registered]" $k "->" $Manifest
}

# read back to verify
$verify = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\Microsoft\Edge\NativeMessagingHosts\$HostName")
$val = $verify.GetValue("")
$verify.Close()
if ($val -eq $Manifest) { Write-Host "[verify] OK - Edge key reads back correctly (Chrome key was written too)" }
else { Write-Error "[verify] FAILED - registry readback mismatch: $val"; exit 1 }

Write-Host ""
$extPath = Join-Path (Split-Path $PSScriptRoot -Parent) "extension"
Write-Host "[next] Open edge://extensions (or chrome://extensions), enable Developer mode, click"
Write-Host "       'Load unpacked' and select: $extPath"
Write-Host "[next] The extension will auto-launch this host; HTTP listens on http://127.0.0.1:8090 (see config.json)"
Write-Host "[test] curl http://127.0.0.1:8090/health"
