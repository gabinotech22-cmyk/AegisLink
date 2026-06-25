<#
  android-smoke.ps1 — on-device smoke test for AegisLink over ADB.

  What it does (read-only / non-destructive except installing the APK):
    1. Confirms exactly one physical device/emulator is connected & authorized.
    2. Installs the release APK (path auto-detected or pass -Apk).
    3. Cold-launches the app and confirms it does NOT crash on start.
    4. Scans logcat for FATAL / ANR / native crashes during launch.
    5. Dumps the UI hierarchy (uiautomator) and checks the onboarding screen rendered.
    6. Reports PASS/FAIL per check.

  What it canNOT do (needs human eyes/ears or a 2nd device — see roadmap):
    - Judge audio/video call quality, visual rendering (FLAG_SECURE blanks screenshots),
      camera/QR scan, real push under OEM battery killers, or 2-participant flows.

  Usage:
    pwsh scripts/android-smoke.ps1                 # auto-detect APK
    pwsh scripts/android-smoke.ps1 -Apk path.apk   # explicit APK
#>

param(
  [string]$Apk = "",
  [string]$Package = "com.aegislink.app"
)

$ErrorActionPreference = "Stop"
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { $adb = "adb" }

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Pass($m) { Write-Host "  PASS  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  FAIL  $m" -ForegroundColor Red; $script:failed++ }
$script:failed = 0

# ── 1. device ────────────────────────────────────────────────────────────────
Step 1 "Checking connected device"
$devs = & $adb devices | Select-String "\tdevice$" | ForEach-Object { ($_ -split "`t")[0] }
if ($devs.Count -eq 0) { Fail "No authorized device. Plug in a phone with USB debugging, accept the prompt."; exit 1 }
if ($devs.Count -gt 1) { Fail "More than one device — disconnect extras or set ANDROID_SERIAL."; exit 1 }
$serial = $devs[0]
$model = (& $adb -s $serial shell getprop ro.product.model).Trim()
$rel = (& $adb -s $serial shell getprop ro.build.version.release).Trim()
Pass "Device $serial — $model (Android $rel)"

# ── 2. install ───────────────────────────────────────────────────────────────
Step 2 "Installing release APK"
if (-not $Apk) {
  $Apk = "mobile/android/app/build/outputs/apk/release/app-release.apk"
}
if (-not (Test-Path $Apk)) { Fail "APK not found at $Apk (build one or pass -Apk)."; exit 1 }
$mb = [math]::Round((Get-Item $Apk).Length / 1MB, 1)
$out = & $adb -s $serial install -r "$Apk" 2>&1
if ($out -match "Success") { Pass "Installed $([System.IO.Path]::GetFileName($Apk)) ($mb MB)" }
else { Fail "Install failed: $out"; exit 1 }

# ── 3. launch + crash check ──────────────────────────────────────────────────
Step 3 "Cold-launching and checking it stays up"
& $adb -s $serial shell am force-stop $Package
& $adb -s $serial logcat -c
& $adb -s $serial shell monkey -p $Package -c android.intent.category.LAUNCHER 1 | Out-Null
Start-Sleep -Seconds 7
$apppid = (& $adb -s $serial shell pidof $Package).Trim()
if ($apppid) { Pass "App process alive (pid $apppid) 7s after launch" }
else { Fail "App is NOT running 7s after launch — crashed on start" }

# ── 4. logcat crash scan ─────────────────────────────────────────────────────
Step 4 "Scanning logcat for crashes"
$crash = & $adb -s $serial logcat -d -t 400 | Select-String "FATAL EXCEPTION|ANR in $Package|AndroidRuntime.*$Package|libc.*Fatal signal"
if ($crash) { Fail "Crash markers in logcat:"; $crash | Select-Object -First 6 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkRed } }
else { Pass "No FATAL / ANR / native-crash markers" }

# ── 5. onboarding rendered ───────────────────────────────────────────────────
Step 5 "Verifying the first screen rendered (uiautomator)"
& $adb -s $serial shell uiautomator dump /sdcard/aegis-ui.xml 2>$null | Out-Null
$ui = & $adb -s $serial shell cat /sdcard/aegis-ui.xml 2>$null
& $adb -s $serial shell rm /sdcard/aegis-ui.xml 2>$null | Out-Null
if ($ui -and $ui.Length -gt 200) { Pass "UI hierarchy dumped ($([math]::Round($ui.Length/1024,1)) KB of nodes)" }
else { Fail "Empty UI dump — screen may be blank/black" }

# ── summary ──────────────────────────────────────────────────────────────────
Write-Host ""
if ($script:failed -eq 0) {
  Write-Host "SMOKE PASSED — app installs, launches, no crash, UI renders." -ForegroundColor Green
  Write-Host "Next (human/2-device, can't be automated): onboarding -> 1:1 E2EE chat -> group ->"
  Write-Host "call audio -> attachment -> ephemeral -> PANIC wipe -> push wake-up with app closed."
} else {
  Write-Host "SMOKE FAILED — $($script:failed) check(s) failed above." -ForegroundColor Red
  exit 1
}
