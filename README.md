# AegisLink

![AegisLink — the messenger that knows nothing about you: E2EE chat with sealed sender, encrypted calls, and panic mode with decoy profile](https://raw.githubusercontent.com/gabinotech22-cmyk/aegislink-assets/main/readme/hero.png)

**End-to-end encrypted messenger. Zero metadata. Anonymous by default.**

AegisLink is a privacy-first messaging app: no email, no phone number, no real
name required. All cryptography runs on your device — private keys never leave
your phone. The relay server is designed to know as little as possible: it
cannot read your messages, your call signaling, or your attachments, and it
keeps no logs of who talks to whom.

> **Status:** pre-release. The protocol and code are published here so anyone
> can inspect them. An independent security audit has not yet been performed —
> review, issues and responsible disclosure are very welcome (see
> [SECURITY.md](SECURITY.md)).

## Non-negotiable principles

1. **Zero metadata** — no IP logs, no access timestamps, no message sizes, no
   communication-frequency records on the server.
2. **Keys on device** — no private key ever leaves the user's phone.
3. **Anonymous by default** — registration without email, phone number or real
   name.
4. **Open and auditable** — all cryptography in this repository is verifiable
   by third parties.

## How it works (short version)

- **Identity**: generated on-device (Ed25519 + X25519 via TweetNaCl). Your
  address is a random Aegis ID — nothing personal.
- **1:1 chat**: Double Ratchet with X3DH key agreement (hybrid post-quantum
  PQXDH). The relay routes opaque ciphertext and keeps no logs of who talks to
  whom. Sender identity is never persisted (sealed-sender at rest); full
  transport-level sealed-sender — hiding the sender from the relay process
  itself — is in active development (see
  [docs/SEALED-SENDER-ARCHITECTURE.md](docs/SEALED-SENDER-ARCHITECTURE.md)).
- **Calls (1:1 and group)**: WebRTC with DTLS-SRTP media encryption. SDP
  offers/answers and ICE candidates are sealed with NaCl `box` before they
  reach the relay, so the server never sees IPs, DTLS fingerprints or codecs
  inside signaling.
- **Attachments**: encrypted client-side before upload; the server stores
  opaque blobs.
- **Push notifications**: FCM/APNs are used as a wake-up signal only — the
  payload is generic and never contains content or sender identity.
- **Backups**: encrypted locally with a key derived from your passphrase
  (Argon2id); the key belongs to the user only.

## Known limitations (read this)

AegisLink is **pre-release**, and we would rather you hear the sharp edges from
us than discover them yourself. The full, auditor-grade version of this list —
with the exact code paths — is in [docs/PROTOCOL.md §8](docs/PROTOCOL.md). The
short version:

- **No independent audit yet.** The protocol and code are public so they *can* be
  reviewed, but no third party has formally audited them. Funding an audit is the
  project's top priority.
- **The relay can still see your IP, and correlate sender↔recipient in real
  time.** Message *content* is end-to-end encrypted and the sender is **not stored
  at rest** (sealed-sender at rest; access logs omit IPs), but full
  *transport-level* sealed sender — hiding the sender from the relay **process**
  itself — is still in active development. Until it ships, a malicious or compelled
  relay operator watching the live authenticated socket can observe who is talking
  to whom. See
  [docs/SEALED-SENDER-ARCHITECTURE.md](docs/SEALED-SENDER-ARCHITECTURE.md).
- **No defense against traffic analysis** by a global passive adversary who can
  watch network flows in and out of the relay (timing/volume correlation).
- **Post-quantum protection is gated.** The hybrid PQXDH handshake (X25519 +
  ML-KEM-768) protects sessions where *both* ends are upgraded; sessions with a
  not-yet-upgraded peer (including the still-v1 desktop client) fall back to
  classical X25519.
- **The crypto core runs in JavaScript.** It uses constant-time libraries
  (TweetNaCl / `@noble`), but the constant-time guarantee is source-level, not
  verified through the JS engine's JIT+GC. Practical exploitation would require an
  already-compromised device. Migration to a native libsodium binding is on the
  roadmap ([docs/PROTOCOL.md §2.1](docs/PROTOCOL.md)).
- **Push still touches Google/Apple.** FCM/APNs deliver a generic wake-up with no
  content or sender, but Google/Apple learn that *a* device received *a* push.
  Migrating to [UnifiedPush](https://unifiedpush.org/) (ntfy/Gotify) to drop that
  dependency is a roadmap goal.
- **Endpoint compromise is out of scope.** Malware on an unlocked device with the
  keystore unsealed can read plaintext; panic-wipe and decoy modes mitigate
  coercion but are not cryptographic defenses.

## Repository layout

| Path        | What it is                                              | License   |
|-------------|---------------------------------------------------------|-----------|
| `mobile/`   | The app — Expo SDK 54 + React Native + TypeScript       | GPL-3.0   |
| `server/`   | Relay — Node.js, Socket.IO, SQLite, push wake-ups, TURN credentials | AGPL-3.0  |
| `desktop/`  | Desktop client (work in progress)                       | GPL-3.0   |

## Quick start — run a relay locally

Spin up your own relay and point a client at it. Two ways:

**A. Node directly** (Node.js 22+, fastest):

```bash
cd server
npm install
cp ../.env.example .env       # localhost defaults are fine for dev
npm start                     # listens on http://localhost:3001
curl http://localhost:3001/health   # -> ok
```

In dev mode (`NODE_ENV` unset) the relay accepts any origin and needs no
production secrets, so this is the 2-minute path.

**B. Docker** (just the relay service):

```bash
# from the repo root — generate the two fail-closed secrets the relay needs
printf 'BLOB_SECRET=%s\nTURN_SECRET=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
docker compose up relay       # relay only — coturn needs a TLS host config (see deploy docs)
```

The relay listens on `127.0.0.1:3001`; check `GET /health`. (The Compose file is
production-shaped — it runs the relay with `NODE_ENV=production` and the coturn
service expects a rendered `turnserver.conf` + certs, so only the `relay` service
comes up locally.)

**Point a client at your relay.** Set the relay URL in `.env` before building:
`http://10.0.2.2:3001` for the Android emulator, `http://localhost:3001` for the
desktop client (see the commented dev block in [.env.example](.env.example)).

## Building the apps

**Mobile** (requires a dev build — uses native modules, not Expo Go):

```bash
cd mobile
npm install
npx expo run:android   # or: eas build --profile development
```

Calls require a [coturn](https://github.com/coturn/coturn) TURN server; set
`TURN_SECRET` in the server `.env` to your coturn `static-auth-secret`.

## License

- The repository as a whole, including the mobile and desktop clients, is
  licensed under the **GNU General Public License v3.0** ([LICENSE](LICENSE)).
- The relay server (`server/`) is licensed under the **GNU Affero General
  Public License v3.0** ([server/LICENSE](server/LICENSE)) — if you run a
  modified relay as a service, you must publish your modifications.

## Patents

AegisLink is a member of the [Open Invention Network](https://openinventionnetwork.com/),
the community patent non-aggression pool for open-source software. We hold no
patents and assert none against open-source technologies — this membership is a
defensive commitment to keep the project free of patent threats.

## Community

- **Matrix**: [#aegislink:matrix.org](https://matrix.to/#/#aegislink:matrix.org)
- **Discord**: [discord.gg/qNEfz86yDJ](https://discord.gg/qNEfz86yDJ) — questions, bug reports, crypto review
- **Protocol & threat model**: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- **Contact**: gabinotech22@gmail.com

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy, and
[docs/LEGAL.md](docs/LEGAL.md) for what we can — and cannot — produce in
response to a legal order.

Internal hardening is tracked openly in
[docs/SECURITY-ROADMAP-2026-06.md](docs/SECURITY-ROADMAP-2026-06.md). An
independent third-party audit is still pending (see the status note above).
