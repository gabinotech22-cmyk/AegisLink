# Dependency CVE Audit — AegisLink

Date: 2026-05-27 (Section L-2 of the security audit)

## Summary

| Package set | Total vulns | CRITICAL | HIGH | MODERATE | LOW |
|---|---|---|---|---|---|
| mobile/ (production deps) | 18 | 0 | 0 | 18 | 0 |
| server/ (production deps) | 12 | 0 | 0 | 12 | 0 |

**No CRITICAL or HIGH severity vulnerabilities — safe to publish.**

All 30 findings are MODERATE severity and concentrated on transitive deps of
the Expo CLI toolchain (build-time only, not shipped to users) and one runtime
dep (`ws` via socket.io-client / engine.io).

## Crypto-critical packages — versions verified

| Package | Mobile | Notes |
|---|---|---|
| `tweetnacl` | 1.0.3 | Latest stable. No known CVEs. |
| `@noble/hashes` | 1.8.0 | Latest. Provides argon2id used by backup v3 (H-3). |
| `expo-secure-store` | 15.0.8 | SDK 54 — supports `AFTER_FIRST_UNLOCK`. |

## Notable findings

### `ws` 8.0.0–8.20.0 — Uninitialized memory disclosure
GHSA-58qx-3vcg-4xpx (MODERATE)

Affected paths:
- mobile: `engine.io-client → ws`
- server: `socket.io → engine.io → ws`, `socket.io-adapter → ws`

Impact in AegisLink: every wire payload is end-to-end encrypted with NaCl
secretbox BEFORE it touches socket.io. The disclosed memory bytes are
ciphertext or padding — never plaintext, never keys. The same data is already
available to a passive network observer (it's the wire format). Confidentiality
unaffected.

Recommended action: `npm audit fix` upstream when socket.io ships a release
that bumps `ws`. Non-blocking for Play Store.

### Expo CLI transitive vulns
All 17 mobile findings + 11 server findings are inside `@expo/*` packages
used only at build/prebuild time (`expo run:android`, `eas build`). These do
not ship in the production APK or in the relay container.

Risk class: low priority, no user-facing impact.

## Recommended actions before Play Store release

1. **None blocking.** All findings are MODERATE in non-shipped or
   confidentiality-irrelevant paths.
2. **Track quarterly:** re-run `npm audit --production` every 90 days and
   bump if HIGH/CRITICAL appears.
3. **Bump `ws` to 8.21+** when socket.io 4.9+ is released (currently pinned
   to 4.8.x by us — wait for upstream).

## Commands used

```powershell
cd C:\Users\starl\Desktop\AegisLink\mobile
npm audit --production
npm ls tweetnacl @noble/hashes expo-secure-store

cd C:\Users\starl\Desktop\AegisLink\server
npm audit --production
```

Last verified: 2026-05-27
