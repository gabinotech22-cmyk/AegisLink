# AegisLink — Full audit (2026-06-30)

> Scope requested: **security + quality + architecture + tests**, deliverable **report + fix**.
> Method: orchestrated multi-surface audit (relay, crypto, desktop, mobile, infra/web3,
> arch, docs/tests). Findings below are **directly verified against code** (file:line).
> Complements — does not replace — `SECURITY-ROADMAP-2026-06.md` (the 12 "olas", mostly closed).
>
> Severity: 🔴 CRITICAL · 🟠 HIGH · 🟡 MEDIUM · 🔵 LOW · ✅ verified-clean.
> Status column: `OPEN` / `FIXED` / `ACCEPTED` (documented trade-off) / `DEFERRED-WORK`.
>
> **Scope note (2026-06-30):** "AegisLink Work" (the enterprise variant) will move to its
> **own separate repo**. Therefore all Work-only findings (H1, H2, M2) are marked
> `DEFERRED-WORK` and are **NOT** fixed here — they travel with the Work code to its repo.
> This audit's active scope is **AegisLink normal** only.

## Verified-clean (spot-checked, no action)
- ✅ No silent plaintext fallback in crypto (`catch { return body }`) on either platform.
- ✅ `plain:` key writes all gated by `app.isPackaged` throw → **fail closed in prod** (`desktop/src/main/ipc/database.ts:83,126,154`, `secureStorage.ts:71`).
- ✅ `shell.openExternal` scheme-gated to http(s) only (`desktop/src/main/index.ts:34-44`) — A-11 holds.
- ✅ Relay socket auth (Ed25519/X25519 challenge-response, constant-time, 30s TTL) and mailbox proof-of-possession — correct (`handler.ts:494-527,599-751`).
- ✅ Sender identity for envelopes/rekey/sender-key-dist taken from authenticated socket, never client payload (golden rule #7).
- ✅ `chain_key_b64` migrated out (DROP COLUMN) — C-3 holds. SSRF defense on link-preview solid.
- ✅ No committed private keys. `certificate.pem` is the **public** Expo code-signing cert (intended). `_keystore_backup/` correctly gitignored. `.github/SECRETS.md` is doc-only.

---

## 🟠 HIGH

### H1 — Work admin signatures don't bind the mutated payload (signature replay / param substitution)
- `server/src/routes/work.ts:87-89` (`verifyAdminSig`), used by ~20 endpoints.
- Signed message = `` `${orgId}:${action}:${bucket}` `` only. Target id, `role`, `retentionDays`,
  `body`, channel id, permissions — **none are signed**. A captured valid signature for `action`
  can be replayed with attacker-chosen parameters within the ~60s window (two 30s buckets).
- Violates golden rule #3 (the sig must prove the *action with these parameters*, not just identity+action+time).
  Exploitation needs a signature leak (traffic is TLS) → rated HIGH not CRITICAL, but it's a design flaw.
- **Fix:** include a canonical digest of the full mutated payload in the signed message
  (`sign(orgId:action:targetId:sha256(fields):bucket)`). Regression test: captured sig + modified body → 403.
- Status: **DEFERRED-WORK** (Work moves to its own repo; fix travels with it, not done here).

### H2 — Work REST `POST .../messages` persists plaintext bodies (M-6 fail-closed bypass)
- `server/src/routes/work.ts:836-874`. `body` inserted directly; **no `encrypted===true` + `nonce` guard**,
  unlike the socket `channel:msg` path which fails closed.
- Plaintext Work message bodies at-rest in `work_messages.body`. Violates golden rule #1 / M-6.
- **Fix:** add the same fail-closed encryption guard to the REST handler, or explicitly document Work-REST
  as a server-side-readable compliance path (decide intent). Regression test mirroring the socket path.
- Status: **DEFERRED-WORK** (Work moves to its own repo; fix travels with it, not done here).

### H3 — `@noble/hashes` major-version drift between platforms (crypto parity)
- mobile `package.json` `^1.6.1` (25 source files) vs desktop `^2.2.0` (13 source files).
- Same crypto/HKDF/hashing code runs on two **major** versions (v2 changed APIs/output helpers).
  Direct golden-rule-#5 (mobile↔desktop parity) risk; subtle divergence could break interop or hashing.
- **Fix:** pin both platforms to one major version; add a cross-platform KAT (known-answer test) for
  the shared hash/HKDF paths. Audit v1→v2 call sites for behavioral change.
- Status: **MITIGATED** — added a cross-platform KAT on **both** platforms
  (`mobile/src/crypto/__tests__/noble-kat.test.ts` v1, `desktop/src/renderer/crypto/__tests__/noble-kat.test.ts` v2)
  asserting SHA-256/HMAC/HKDF/PBKDF2 against public RFC vectors. Both pass with identical output →
  parity proven and locked (any future divergence fails CI). Full version unification (mobile→v2)
  is a **scheduled migration** requiring on-device Metro build verification — not a blind bump here.
  Note: `desktop/.../signal/kdf.ts:15` already adapts the one v1↔v2 API difference (HKDF `info`
  must be `Uint8Array` in v2) so outputs match.

---

## 🟡 MEDIUM

### M1 — `pubchannel:msg` delivery token doesn't encode channel role (no server-side post restriction)
- `server/src/relay/handler.ts:2104-2152`. Single shared delivery token gates posting; relay has no
  concept of `readonly`/`moderated`/`approval` for sealed public channels (unlike Work `can_send`).
- Posting restriction is client/manifest-advisory only. **Fix:** separate write-capability token from read
  token if server enforcement is intended, OR document explicitly that channel-type enforcement is client-side.
- Status: OPEN (confirm intent vs SEALED-PUBLIC-CHANNELS design)

### M2 — CSV audit export lacks formula-injection escaping
- `server/src/routes/work.ts:259-282`. `escape()` quotes `,"\n` but not leading `= + - @` →
  Excel/Sheets formula injection via audit `message`/`metadata` (e.g. channel name).
- **Fix:** prefix cells starting with `= + - @ \t \r` with `'`.
- Status: **DEFERRED-WORK** (an initial fix was prototyped then reverted — it belongs in the Work repo).

### M3 — Incomplete logger migration: raw `console.*` in production source
- Re-scoped: **mobile is already clean (0)** — M-5 finished it. All 74 remaining were **desktop-only**,
  which had **no logger** at all (`desktop/src/renderer/socket/client.ts` alone had 54).
- Defense-in-depth gap (no runtime level-gating; dev leakage risk to devtools/log files).
- Status: **FIXED** — ported the leveled logger to `desktop/src/renderer/utils/logger.ts`
  (API-identical to mobile, Vite `import.meta.env.DEV` gate) and swept all 74 `console.*` → `logger.*`
  across 7 files. Desktop typecheck clean; 144/144 desktop tests pass.
- Follow-up (optional): add an ESLint `no-console` rule for `desktop/src/renderer/**` to prevent regressions.

### M4 — God files far over the 800-line hard limit (coding-style rule)
| File | Lines | |
|------|------:|--|
| `mobile/src/socket/client.ts` | 4167 | 5.2× limit |
| `mobile/src/screens/Chat.tsx` | 2607 | |
| ~~`server/src/relay/handler.ts`~~ | 2257→756 | ✅ split → schemas/rateLimits/callSignaling/handlers/* |
| ~~`server/src/db/client.ts`~~ | 2534→701 | ✅ split → sqlite/pg/driver/types/repos/work |
| `desktop/src/renderer/socket/client.ts` | 2517 | |
| `mobile/src/db/local.ts` | 2310 | |
| `mobile/src/screens/GroupChat.tsx` | 1905 | |
| ~~`server/src/routes/work.ts`~~ | 1244 | DEFERRED-WORK (own repo) |
- High coupling, hard to review, parity drift risk (the two socket clients are ~the same logic duplicated).
- **Fix:** extract cohesive modules (transport, ratchet wiring, handlers). Prioritize the two `socket/client.ts`
  since their divergence is the parity hotspot. Effort L — schedule, don't rush.
- Status: **IN PROGRESS** — 2 of the server god-files done:
  - `server/src/db/client.ts` (2241→701; extracted `db/sqlite.ts`, `db/pg.ts`, `db/driver.ts`,
    `db/types.ts`, `db/repos/work.ts`).
  - `server/src/relay/handler.ts` (2257→756; extracted `relay/schemas.ts`, `relay/rateLimits.ts`,
    `relay/callSignaling.ts`, `relay/handlers/{messaging,prekeys,channels,devices}.ts`). Handlers
    pulled out as `attach*(socket, me, deps)` following the existing `attachCallSignaling` pattern;
    sealed-sender v1/v2 asymmetry preserved verbatim (not "fixed").
  - Both: behavior-preserving relocation, every module <800, typecheck clean + 186 server tests
    green per commit.
  Remaining: `mobile/src/socket/client.ts`, `mobile/src/screens/Chat.tsx`,
  `desktop/src/renderer/socket/client.ts`, `mobile/src/db/local.ts`,
  `mobile/src/screens/GroupChat.tsx` (the two `socket/client.ts` are the parity hotspot —
  port together, don't rush).

### M5 — `any` density (type-safety holes): desktop 48, mobile 26 (server 0 ✓)
- **Fix:** replace with `unknown` + narrowing at boundaries; enable `noImplicitAny` if not already. Effort M.
- Status: **PARTIALLY FIXED** — the high-value cluster is done; the rest is triaged.
  - ✅ **`desktop/src/main/ipc/database.ts`: 33 → 0.** Added `dbTypes.ts` (Input/Row interfaces),
    applied via the `prepare<_, Row>()` generic so `.get()/.all()` are typed (TS now verifies every
    row→DTO mapping), handler returns inferred. Typecheck clean; 15/15 DB tests pass.
  - ⏸️ **Remaining ~40 are triaged, not blindly removed:**
    - **Legitimate library-gap casts (keep as-is):** `mobile/src/webrtc/peer.ts` (8× `pc as any` —
      react-native-webrtc methods untyped), `groupCalls.ts` `mediaDevices as any`, `videoTrim.ts`
      native-module casts, `mobile/src/net/tor.ts:119` (already eslint-justified, mirrors socket.io
      listener typing). Forcing these out would mean fake types / `@ts-ignore` (worse).
    - **IPC contract (`preload/index.ts` 17, `ipc-types.ts` 11):** typing the *return* values
      cascades into the renderer's own `db/local.ts` type layer — a real "reconcile duplicated
      types" refactor. Scheduled, not rushed (cascade risk to the renderer build).
    - **Scattered low-value:** component-prop `: any` (`AddContact.tsx` ×3), socket parse helpers.
      Worth a pass when those files are next touched.

---

## 🔵 LOW
- L1 — `uploads/*.png` (2 screenshots) tracked in git; `uploads/` not gitignored → structure-rule violation. Remove + ignore.
- L2 — `mintDownloadToken` truncates HMAC to 128 bits (`blob.ts:36`) — adequate; add a comment confirming intent.
- L3 — In-memory rate-limiters reset on relay restart (A-1, ACCEPTED/deferred — single-instance).

---

## Surfaces with partial coverage (re-run directly, no agents)
The crypto-core, mobile-non-crypto, architecture, and docs/tests deep-dives were started but their
full outputs were lost to a session limit. Re-derived the high-value items directly (above). Still
**TODO to complete the "full" mandate** in a follow-up pass:
- Crypto: zeroization coverage in X3DH/PQXDH intermediates; ML-KEM all-zero check; constant-time audit of remaining compares.
- Mobile non-crypto: deep storage/notification/webrtc sealed-sender review; dead code in `mobile/src/_unused/`.
- Tests: desktop IPC/ratchet-serde/DB-encryption coverage map; doc↔code drift sweep across status markers.

---

## Proposed fix order — AegisLink normal only (Work findings excluded)
1. ✅ **L1** (untrack uploads) — DONE (commit `93ccd27`)
2. **L2** (HMAC bit-strength comment) — XS
3. **H3** (noble version alignment + cross-platform KAT) — S, careful (crypto parity)
4. **M3** (logger sweep + lint banning `console.*` in `src/`) — S mechanical
5. **M5** (`any` reduction) — M
6. **M4** (god-file refactor, two `socket/client.ts` first) — L, scheduled
7. **M1** (sealed-channel role) — decision/intent, then document or implement

### Deferred to the AegisLink **Work** repo (not actioned here)
- **H1** — Work admin signatures don't bind payload
- **H2** — Work REST persists plaintext bodies
- **M2** — Work CSV audit export formula-injection
- **M4 (partial)** — `server/src/routes/work.ts` refactor
