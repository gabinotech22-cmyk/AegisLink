# Maestro E2E flows

End-to-end UI tests that run against the **compiled app on a real Android
system** (an emulator in CI, or your phone locally). Unlike the Jest suite
(which renders components in a Node/JSDOM-like environment with mocks), these
exercise the actual APK: native modules, storage, navigation, the works.

## Flows

| File | What it proves | Needs network? |
|------|----------------|----------------|
| `01-launch-smoke.yaml` | App builds, installs, boots, renders onboarding | No |
| `02-onboarding.yaml` | Real identity generation → reaches main app | No (relay optional) |

## Run locally (against an emulator or a plugged-in phone)

```bash
# 1. Install Maestro once: https://maestro.mobile.dev/getting-started/installing-maestro
# 2. Have a debug build installed on the device/emulator:
cd mobile
npx expo prebuild --platform android
(cd android && ./gradlew installDebug)
# 3. Run the flows:
maestro test .maestro/
```

## Run in CI

The `mobile-e2e` job in `.github/workflows/ci.yml` builds a debug APK, boots a
headless Android emulator, and runs every flow in this folder. It is currently
**manual only** (`workflow_dispatch`) while we stabilise the native build — it
does not block pull requests yet. Trigger it from the Actions tab → "CI" → "Run
workflow". Screenshots are uploaded as a build artifact.

## Honest scope — what E2E does and does NOT replace

These tests catch the majority of regressions automatically on every run, but a
CI emulator has no real hardware. The following still warrant a quick check on a
**physical device** before a release:

- 📷 **Camera QR scanning** (`ScanQR`) — the emulator can't point a lens at a
  real code; this is the one path inherently un-automatable here.
- 🔔 **Push notifications** (FCM/APNs round-trip)
- 📞 **Voice/video calls** (WebRTC + DTLS-SRTP)
- 👆 **Biometric unlock**
- Vendor-specific quirks (Samsung/Xiaomi) and **iOS** (these flows are Android).

The goal is to shrink manual testing from "re-check everything, every change" to
"the machine checks the rest; you spot-check ~5 hardware things before release."
