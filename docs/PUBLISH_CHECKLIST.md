# AegisLink — Pre-Publication Checklist

Generated: 2026-05-21
Sprint: Store submission (App Store + Google Play)

---

## 1. EAS Secrets — Must be set in EAS Dashboard

Go to: https://expo.dev/accounts/aegislink/projects/aegislink/secrets

| Secret name        | Used in                          | Status          | How to obtain |
|--------------------|----------------------------------|-----------------|---------------|
| `APPLE_ID`         | submit.production.ios.appleId    | MISSING — add   | Apple ID email used for App Store Connect (e.g. dev@example.com) |
| `ASC_APP_ID`       | submit.production.ios.ascAppId   | MISSING — add   | Numeric App ID from App Store Connect → App → General → Apple ID field |
| `APPLE_TEAM_ID`    | submit.production.ios.appleTeamId| MISSING — add   | Developer portal → Membership → Team ID (10-char alphanumeric) |
| `EXPO_TOKEN`       | All EAS build jobs in CI         | Required in GitHub Secrets (see §4) |

Note: `eas.json` correctly uses `$APPLE_ID`, `$ASC_APP_ID`, `$APPLE_TEAM_ID` — no values are hardcoded. Good.

---

## 2. Android — Service Account Key

| Item | Status | Action required |
|------|--------|-----------------|
| `serviceAccountKeyPath` in eas.json | Set to `./google-service-account.json` | File does NOT exist in repo (correct — it must NOT be committed) |
| Key file for EAS Submit | MISSING | Upload via EAS CLI: `eas secret:create --scope project --name GOOGLE_SERVICE_ACCOUNT_KEY --type file --value ./google-service-account.json` OR configure path in EAS dashboard. Alternatively use `"serviceAccountKeyPath": "$GOOGLE_SERVICE_ACCOUNT_KEY"` and store as secret. |
| Google Play track | Set to `internal` | OK for first submission. Promote to `production` after internal testing passes. |

**Recommended fix:** Change `eas.json` android submit block to use a secret instead of a file path:
```json
"android": {
  "serviceAccountKeyPath": "$GOOGLE_SERVICE_ACCOUNT_KEY",
  "track": "internal"
}
```
Then add the key JSON content as an EAS secret. This avoids the file needing to exist on the CI runner.

---

## 3. App Identity (bundle IDs)

| Platform | Field              | Value               | Status |
|----------|--------------------|---------------------|--------|
| iOS      | bundleIdentifier   | `com.aegislink.app` | CONFIGURED in app.json |
| Android  | package            | `com.aegislink.app` | CONFIGURED in app.json |
| EAS      | projectId          | `b7622ace-13a1-4bd0-84de-550bfdfe14d2` | CONFIGURED in app.json extra.eas |
| EAS      | owner              | `aegislink`         | CONFIGURED in app.json |

Both platforms share the same bundle ID — this is intentional and valid. No action required.

---

## 4. GitHub Secrets — Must be set in GitHub repository

Go to: https://github.com/gabinotech22-cmyk/AegisLink/settings/secrets/actions

| Secret name       | Required for          | Status |
|-------------------|-----------------------|--------|
| `EXPO_TOKEN`      | All EAS build jobs    | Already listed in ci.yml header — verify it is set |
| `DEPLOY_HOST`     | deploy-server job     | Already listed in ci.yml header |
| `DEPLOY_USER`     | deploy-server job     | Already listed in ci.yml header |
| `DEPLOY_SSH_KEY`  | deploy-server job     | Already listed in ci.yml header |
| `DEPLOY_PATH`     | deploy-server job     | Already listed in ci.yml header |
| `APPLE_ID`        | eas-build-production (submit) | MISSING |
| `ASC_APP_ID`      | eas-build-production (submit) | MISSING |

Note: `APPLE_TEAM_ID` is only needed in EAS secrets, not GitHub — EAS reads it at submit time from the EAS secret store.

---

## 5. CI Job for Production Builds

Status: **ALREADY EXISTS** in `.github/workflows/ci.yml` — job `eas-build-production`.

Key properties verified:
- Trigger: `if: startsWith(github.ref, 'refs/tags/v')` — fires ONLY on `v*.*.*` tags, never on push to main. CORRECT.
- Needs: `[server-typecheck, mobile-typecheck, server-test, mobile-test]` — all four gate jobs must pass before building. CORRECT.
- Platform: `--platform all` — builds both iOS and Android. CORRECT.
- Profile: `--profile production` — uses the production EAS profile. CORRECT.
- Flag: `--no-wait` — CI enqueues the build on EAS cloud and exits; does not block the runner. CORRECT.

No changes needed to ci.yml for this task.

---

## 6. iOS App Store — Manual Steps (App Store Connect)

These cannot be automated and must be done by the team before the first submission:

- [ ] Create the app in App Store Connect (Apps → + → New App)
      - Platform: iOS
      - Bundle ID: `com.aegislink.app` (must match app.json exactly)
      - SKU: e.g. `aegislink-ios-001`
      - Primary language: English
- [ ] Note the numeric Apple ID assigned by ASC — this is `ASC_APP_ID`
- [ ] Add Privacy Policy URL in ASC → App Information (`https://aegis-link.it/privacy.html` — live since PR #343; smoke-test it after `infra/deploy-web.sh`)
- [ ] Complete App Privacy questionnaire (Data Types: select "We do not collect data")
- [ ] Upload screenshots for all required device sizes (6.7", 6.5", 5.5" iPhone; 12.9" iPad if supportsTablet is enabled — currently false, so iPad not required)
- [ ] Set age rating (Unrestricted — no objectionable content)
- [ ] Submit for review after first `eas submit --platform ios --profile production`

---

## 7. Google Play — Manual Steps (Google Play Console)

- [ ] Create app in Google Play Console (All apps → Create app)
      - App name: AegisLink
      - Default language: English
      - App or Game: App
      - Free or Paid: Free (adjust if monetized)
- [ ] Create a Google Cloud service account with Play Developer API access and download the JSON key
      - Google Play Console → Setup → API access → Link to Google Cloud project → Create service account
      - Grant role: "Release manager" at minimum
      - Download JSON key → this is `google-service-account.json`
- [ ] Add Privacy Policy URL (same URL as iOS — required before publishing)
- [ ] Complete Data safety questionnaire (all "No" responses given AegisLink's zero-collection architecture)
- [ ] Upload to internal track first via `eas submit --platform android --profile production`
- [ ] Promote to production after internal testing

---

## 8. Privacy Policy & Terms of Service URLs

Both stores require a publicly accessible URL — not just a local file.

**Canonical URL (decided, PR #343): `https://aegis-link.it/privacy.html`** — a branded
static page generated 1:1 from `docs/privacy-policy.md` (keep both in sync in the same
PR when the policy changes). Deployed by `infra/deploy-web.sh` alongside the landing.

Action required: after merging a policy change, run `infra/deploy-web.sh` and smoke-test
`curl -s -o /dev/null -w '%{http_code}' https://aegis-link.it/privacy.html` (expect 200)
before submitting to review. Use this exact URL in App Store Connect and Play Console.

---

## 9. Permissions Review

iOS `NSPhotoLibraryUsageDescription` is present in `app.json` infoPlist. This key is flagged by the CI permissions audit (it is in the BLOCKED list). Before iOS submission, confirm whether photo library access is strictly necessary; if only camera capture is used (not library picker), remove this key to reduce the attack surface and avoid App Store review friction.

Android permission `android.permission.BLUETOOTH` is declared. Modern Android (API 31+) uses `BLUETOOTH_CONNECT` and `BLUETOOTH_SCAN` instead of the legacy `BLUETOOTH`. Verify this is intentional and does not cause Play Store policy issues with targetSdkVersion 35.

---

## 10. Summary of Gaps — Ordered by Priority

| # | Gap | Blocker? |
|---|-----|----------|
| 1 | `APPLE_ID`, `ASC_APP_ID`, `APPLE_TEAM_ID` not set as EAS secrets | YES — eas submit ios will fail |
| 2 | `google-service-account.json` does not exist / not configured as secret | YES — eas submit android will fail |
| 3 | App not created in App Store Connect | YES — can't submit without it |
| 4 | App not created in Google Play Console | YES — can't submit without it |
| 5 | Privacy Policy not at a public URL | YES — both stores block review without it |
| 6 | Screenshots not uploaded | YES — App Store requires them |
| 7 | Data safety / privacy questionnaire not completed in stores | YES — required before publish |
| 8 | iOS `NSPhotoLibraryUsageDescription` vs CI blocklist mismatch | Soft — review risk |
