# Reproducible builds (Android)

AegisLink's value proposition is "trust the math, not us." A published APK you
can't tie back to the source is a trust gap: you'd be trusting our build machine.
Reproducible builds close it — anyone can rebuild the exact bytes from the public
source and confirm the published binary has no hidden changes.

## What "reproducible" means here

Given **the same source commit** and the **pinned toolchain**, the build produces
a **byte-for-byte identical unsigned release APK**. Signing is deliberately out
of scope: the signature is the one part that legitimately differs per signer
(our release key, F-Droid's key, your own). Verification compares the *unsigned*
artifact, exactly as F-Droid does.

## Pinned toolchain

| Component | Version | Pinned by |
|-----------|---------|-----------|
| Node | 22 | CI (`setup-node`), `mobile/package-lock.json` for deps |
| JDK | 17 (Temurin) | CI (`setup-java`) |
| Android compileSdk / buildTools | 35 / 35.0.0 | `mobile/app.json` |
| Gradle / AGP | Expo SDK 54 prebuild template + `gradle-wrapper.properties` | `mobile/package.json` (Expo SDK) |
| JS deps | exact | `mobile/package-lock.json` (`npm ci`) |

## What we do to make it deterministic

- **Strip the `dependenciesInfo` blob.** By default the Android Gradle Plugin
  embeds an encrypted, Google-readable Protobuf of the dependency tree in every
  release APK. It is non-reproducible *and* it is opaque metadata — both reasons
  to remove it. Done in [`mobile/app.plugin.js`](../mobile/app.plugin.js)
  (`withReproducibleBuild`), so it survives `expo prebuild`.
- **Pin embedded time/locale.** The build runs with `TZ=UTC`, `LC_ALL=C`, and
  `SOURCE_DATE_EPOCH` set to the commit time.
- **No Gradle daemon** (`--no-daemon`) so stale daemon state can't leak in.
- **Disable lintVital** (in the same injected block). Android's release lint
  never touches the packaged bytes; it was only slowing/failing the build.

CI runs the [`Reproducible build`](../.github/workflows/reproducible-build.yml)
workflow in two modes:

- **On PRs** that touch the build setup: a fast single-ABI (`arm64-v8a`) smoke
  build — proves the config + plugin injection compile and produce an APK.
- **On release tags / on demand:** the full proof — build **all ABIs twice** in
  a clean environment and fail unless the two outputs are byte-for-byte identical.

## Verify it yourself

```bash
git clone https://github.com/gabinotech22-cmyk/AegisLink.git
cd AegisLink
git checkout <the-release-tag>          # e.g. v1.0.0

cd mobile
scripts/build-reproducible.sh --clean   # needs Node 22, JDK 17, Android SDK 35

# Compare against the published release APK (also unsigned, or strip its signature):
#   unzip -d published   published.apk  'META-INF/*'   # remove signature files
# then diff the zip contents, or compare sha256 of the unsigned artifacts.
```

The script prints the SHA-256 of the produced unsigned APK. It should match the
hash we publish alongside each GitHub release.

> Comparing a *signed* store APK: strip `META-INF/*.SF`, `*.RSA`, `*.EC` and the
> v2/v3 signing block from both sides first (e.g. with `apksigner`/`zipalign`
> round-trip or `diffoscope`), since the signature is expected to differ.

## Scope & roadmap

- This covers the standard build (which still uses FCM for push). A **FOSS
  build flavor** with no proprietary dependencies — required for F-Droid's main
  repository — is the next milestone: it removes `firebase-messaging` and moves
  wake-ups to the persistent socket + a foreground service. Tracked separately.
- iOS reproducibility is not addressed here (App Store re-encryption makes
  byte-for-byte verification impractical); Android is where it's meaningful.
