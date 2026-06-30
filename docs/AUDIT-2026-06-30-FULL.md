# AegisLink — Full audit (2026-06-30)

> Scope requested: **security + quality + architecture + tests**, deliverable **report + fix**.
> Method: orchestrated multi-surface audit (relay, crypto, desktop, mobile, infra/web3,
> arch, docs/tests). Findings below are **directly verified against code** (file:line).
> Complements — does not replace — `SECURITY-ROADMAP-2026-06.md` (the 12 "olas", mostly closed).
>
> Severity: 🔴 CRITICAL · 🟠 HIGH · 🟡 MEDIUM · 🔵 LOW · ✅ verified-clean.
> Status column: `OPEN` / `FIXED` / `ACCEPTED` (documented trade-off).

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
- Status: OPEN

### H2 — Work REST `POST .../messages` persists plaintext bodies (M-6 fail-closed bypass)
- `server/src/routes/work.ts:836-874`. `body` inserted directly; **no `encrypted===true` + `nonce` guard**,
  unlike the socket `channel:msg` path which fails closed.
- Plaintext Work message bodies at-rest in `work_messages.body`. Violates golden rule #1 / M-6.
- **Fix:** add the same fail-closed encryption guard to the REST handler, or explicitly document Work-REST
  as a server-side-readable compliance path (decide intent). Regression test mirroring the socket path.
- Status: OPEN

### H3 — `@noble/hashes` major-version drift between platforms (crypto parity)
- mobile `package.json` `^1.6.1` (25 source files) vs desktop `^2.2.0` (13 source files).
- Same crypto/HKDF/hashing code runs on two **major** versions (v2 changed APIs/output helpers).
  Direct golden-rule-#5 (mobile↔desktop parity) risk; subtle divergence could break interop or hashing.
- **Fix:** pin both platforms to one major version; add a cross-platform KAT (known-answer test) for
  the shared hash/HKDF paths. Audit v1→v2 call sites for behavioral change.
- Status: OPEN

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
- Status: OPEN

### M3 — Incomplete logger migration: 77 raw `console.*` in production source
- mobile+desktop non-test source. M-5 added `src/utils/logger.ts` but 77 call sites remain.
- Defense-in-depth gap (babel strips console in prod, but runtime level-gating is bypassed; dev leakage risk).
- **Fix:** mechanical sweep to `logger.*`; add lint rule banning `console.*` in `src/`.
- Status: OPEN

### M4 — God files far over the 800-line hard limit (coding-style rule)
| File | Lines | |
|------|------:|--|
| `mobile/src/socket/client.ts` | 4167 | 5.2× limit |
| `mobile/src/screens/Chat.tsx` | 2607 | |
| `server/src/relay/handler.ts` | 2559 | |
| `server/src/db/client.ts` | 2534 | |
| `desktop/src/renderer/socket/client.ts` | 2517 | |
| `mobile/src/db/local.ts` | 2310 | |
| `mobile/src/screens/GroupChat.tsx` | 1905 | |
| `server/src/routes/work.ts` | 1244 | |
- High coupling, hard to review, parity drift risk (the two socket clients are ~the same logic duplicated).
- **Fix:** extract cohesive modules (transport, ratchet wiring, handlers). Prioritize the two `socket/client.ts`
  since their divergence is the parity hotspot. Effort L — schedule, don't rush.
- Status: OPEN

### M5 — `any` density (type-safety holes): desktop 48, mobile 26 (server 0 ✓)
- **Fix:** replace with `unknown` + narrowing at boundaries; enable `noImplicitAny` if not already. Effort M.
- Status: OPEN

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

## Proposed fix order (cheapest verified wins first)
1. **M2** (CSV escape) — XS · **L1** (untrack uploads) — XS · **L2** (comment) — XS
2. **H2** (Work REST encryption guard) — S, with regression test
3. **H1** (sign full payload) — S/M, touches ~20 endpoints + test
4. **H3** (noble version alignment + KAT) — S, careful (crypto)
5. **M3** (logger sweep + lint) — S mechanical
6. **M5** (any reduction) — M · **M4** (god-file refactor) — L, scheduled
7. **M1** — decision needed (intent), then implement
