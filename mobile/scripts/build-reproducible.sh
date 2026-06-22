#!/bin/bash -eu
# Reproducible release APK build for AegisLink (Android).
#
# Produces an UNSIGNED release APK deterministically: given the same source
# commit and the pinned toolchain (below), the output is byte-for-byte identical,
# so a third party can rebuild and verify the published binary matches the code.
# Signing is intentionally out of scope — F-Droid (and our own release signer)
# sign separately; verification compares the unsigned artifact.
#
# Pinned toolchain (must match CI — see .github/workflows/reproducible-build.yml):
#   - Node:        from mobile/.nvmrc / package.json engines (lockfile = npm ci)
#   - JDK:         17 (Temurin)
#   - Android SDK: compileSdk 35 / buildTools 35.0.0 (mobile/app.json)
#   - Gradle/AGP:  pinned by the Expo SDK 54 prebuild template + gradle-wrapper
#
# Determinism levers applied here + in app.plugin.js (withReproducibleBuild):
#   - dependenciesInfo blob stripped (app.plugin.js) — the #1 non-determinism source
#   - TZ=UTC, LC_ALL=C, SOURCE_DATE_EPOCH pinned to the commit time
#   - --no-daemon so no stale Gradle daemon state leaks in
#
# Usage:
#   mobile/scripts/build-reproducible.sh            # build + print sha256
#   mobile/scripts/build-reproducible.sh --clean    # also wipe android/ first

set -o pipefail
cd "$(dirname "$0")/.."   # -> mobile/

# ── Deterministic environment ────────────────────────────────────────────────
export TZ=UTC
export LC_ALL=C
export LANG=C
# Pin embedded timestamps to the source commit (honored by AGP / zip tooling).
SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
export SOURCE_DATE_EPOCH
echo "[repro] SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH ($(TZ=UTC date -d "@$SOURCE_DATE_EPOCH" 2>/dev/null || echo "n/a"))"

# ── Dependencies (exact lockfile) ────────────────────────────────────────────
npm ci

# ── Regenerate native project deterministically ──────────────────────────────
PREBUILD_ARGS="--platform android --no-install"
if [ "${1:-}" = "--clean" ]; then
  PREBUILD_ARGS="$PREBUILD_ARGS --clean"
fi
# shellcheck disable=SC2086
npx expo prebuild $PREBUILD_ARGS

# ── Build the unsigned release APK ───────────────────────────────────────────
# lintVital is disabled in app/build.gradle via app.plugin.js (it was failing +
# slow and never affects the packaged bytes). AEGIS_REPRO_ABIS optionally narrows
# the built ABIs — used by the fast PR smoke build (single ABI); a full release /
# determinism build leaves it unset so all ABIs are produced.
GRADLE_ARGS="--no-daemon --console=plain"
if [ -n "${AEGIS_REPRO_ABIS:-}" ]; then
  echo "[repro] limiting ABIs to: $AEGIS_REPRO_ABIS"
  GRADLE_ARGS="$GRADLE_ARGS -PreactNativeArchitectures=$AEGIS_REPRO_ABIS"
fi
cd android
# shellcheck disable=SC2086
./gradlew $GRADLE_ARGS :app:assembleRelease

# ── Locate + hash the artifact ───────────────────────────────────────────────
APK="$(find app/build/outputs/apk/release -name '*.apk' | sort | head -1)"
if [ -z "$APK" ]; then
  echo "[repro] ERROR: no APK produced under app/build/outputs/apk/release" >&2
  exit 1
fi

echo
echo "[repro] artifact: mobile/android/$APK"
echo "[repro] sha256:"
sha256sum "$APK"
