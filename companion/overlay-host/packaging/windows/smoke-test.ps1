# Install KeybardHostSetup.exe silently, check the installed app answers in
# normal and paranoid mode, then uninstall and check it is gone. For CI runners;
# it installs into a temporary folder for the current user.
param([Parameter(Mandatory)][string]$Installer, [switch]$ExpectSigned)
$ErrorActionPreference = 'Stop'
$dir = Join-Path ([IO.Path]::GetTempPath()) 'KeybardHostSmokeTest'
$setup = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$dir`"" -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer exited with $($setup.ExitCode)" }

$exe = Join-Path $dir 'Keybard Host.exe'
foreach ($file in @($exe, 'keybard-paranoid.html', '_internal\web\index.html', '_internal\web-paranoid\index.html', '_internal\web-paranoid\SHA256SUMS.txt', 'unins000.exe')) {
    $path = if ([IO.Path]::IsPathRooted($file)) { $file } else { Join-Path $dir $file }
    if (-not (Test-Path -LiteralPath $path)) { throw "Installed app is missing $file" }
}
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Keybard'
foreach ($name in 'Keybard Host', 'Keybard Host (Paranoid)', 'Keybard Paranoid (offline)', 'Uninstall Keybard Host') {
    if (-not (Test-Path -LiteralPath (Join-Path $menu "$name.lnk"))) { throw "Start menu shortcut missing: $name" }
}

if ($ExpectSigned) {
    foreach ($file in @($Installer, $exe, (Join-Path $dir 'unins000.exe'))) {
        $sig = Get-AuthenticodeSignature -LiteralPath $file
        if ($sig.Status -ne 'Valid' -or -not $sig.TimeStamperCertificate) { throw "Not validly signed and timestamped: $file ($($sig.Status))" }
        "signed: $(Split-Path $file -Leaf) by $($sig.SignerCertificate.Subject)"
    }
}

$env:QT_QPA_PLATFORM = 'offscreen'
function Test-Host([string[]]$Extra, [int]$Port, [bool]$Paranoid) {
    $process = Start-Process -FilePath $exe -ArgumentList ($Extra + @('--no-open', '--port', "$Port")) -PassThru
    try {
        $boot = $null
        for ($i = 0; $i -lt 90 -and -not $boot; $i++) {
            try { $boot = Invoke-RestMethod "http://127.0.0.1:$Port/api/host/bootstrap" -TimeoutSec 2 } catch { Start-Sleep -Seconds 1 }
        }
        if (-not $boot) { throw "Keybard Host did not answer on port $Port" }
        if ([bool]$boot.paranoid -ne $Paranoid) { throw "Expected paranoid=$Paranoid, got $($boot.paranoid)" }
        $page = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing
        if ($page.Headers['X-Frame-Options'] -ne 'DENY') { throw 'Host page can be framed' }
        if ($Paranoid -and $page.Content -notmatch "default-src 'none'") { throw 'Paranoid page lacks its policy' }
        "ok: port $Port paranoid=$Paranoid"
    } finally {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }
}
Test-Host @() 5196 $false
Test-Host @('--paranoid') 5197 $true

$uninstall = Start-Process -FilePath (Join-Path $dir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $exe); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path -LiteralPath $exe) { throw 'Uninstall left the app behind' }
if (Test-Path -LiteralPath (Join-Path $menu 'Keybard Host.lnk')) { throw 'Uninstall left Start menu shortcuts behind' }
'Smoke test passed'
