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
  whom. **Sealed sender is on by default**: the envelope carries no `from`, on
  the wire or at rest. Once you know a contact's mailbox (from their link or
  their first reply), messages travel over a **separate mailbox connection**.
  The relay sees no sender and no recipient Aegis ID for them (see
  [docs/SEALED-SENDER-ARCHITECTURE.md](docs/SEALED-SENDER-ARCHITECTURE.md) and
  the limits below).
- **Tor, always on**: every connection to the relay — messages, the control
  connection, uploads, downloads — goes through the Tor client built into the
  app, to the relay's onion address. There is no switch and no fallback to the
  normal internet, so the relay never sees your IP. The control and mailbox
  connections use separate Tor circuits, so the relay cannot link them by
  circuit. GIF thumbnails, link-preview images and GIFs you send are
  downloaded over Tor too.
- **Calls (1:1 and group)**: WebRTC with DTLS-SRTP media encryption. SDP
  offers/answers and ICE candidates are sealed with NaCl `box` before they
  reach the relay, so the server never sees IPs, DTLS fingerprints or codecs
  inside signaling.
- **Attachments**: encrypted client-side before upload; the server stores
  opaque blobs.
- **Push notifications**: a wake-up signal only — the payload is generic and
  never contains content or sender identity. On iOS the relay sends it straight
  to Apple (APNs); there is no Expo or other intermediary in the chain. Android
  does not register with Google's FCM: it wakes through the relay's ntfy over
  Tor plus a foreground service (the `foss` build contains no Google code at
  all).
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
- **The relay knows when your Aegis ID is online.** Each client keeps two
  connections to the relay, both over Tor on separate circuits, so the relay
  never sees your IP. The **mailbox** connection carries messages, with no sender
  and no recipient Aegis ID. The **control** connection carries prekeys, the push
  token, your profile and presence, and it is authenticated with your Aegis ID.
  So the relay learns *that* your Aegis ID is connected (not from where). A relay
  that watches both connections could try to link them by **timing**.
- **Tor can be blocked.** Where the network blocks Tor, the app cannot connect
  from that network: there is no fallback to the normal internet by design.
  Bridge support (Snowflake/obfs4) is the next piece of work.
- **A few paths still show the sender→recipient edge to the relay:**
  - a first message to a bare Aegis ID or a legacy (v1) link, until the other
    person replies;
  - any message sent while your mailbox connection is down;
  - calls to contacts on app versions that do not announce sealed calls (≤ 1.0.6).

  The relay still accepts the legacy v1 envelope for older clients. Removing it
  is scheduled once `APP_MIN_VERSION=1.0.7` has been enforced for a while. See
  [docs/PROTOCOL.md §7.3](docs/PROTOCOL.md) and
  [docs/SEALED-SENDER-ARCHITECTURE.md](docs/SEALED-SENDER-ARCHITECTURE.md) §5.
- **No defense against traffic analysis** by a global passive adversary who can
  watch network flows in and out of the relay (timing/volume correlation). Cover
  traffic is not implemented.
- **Post-quantum protection is gated.** The hybrid PQXDH handshake (X25519 +
  ML-KEM-768) protects sessions where *both* ends are upgraded; sessions with a
  not-yet-upgraded peer fall back to
  classical X25519.
- **The crypto core runs in JavaScript.** It uses constant-time libraries
  (TweetNaCl / `@noble`), but the constant-time guarantee is source-level, not
  verified through the JS engine's JIT+GC. Practical exploitation would require an
  already-compromised device. Migration to a native libsodium binding is on the
  roadmap ([docs/PROTOCOL.md §2.1](docs/PROTOCOL.md)).
- **iOS push goes through Apple.** On iPhone the only way to wake a closed app
  is Apple's APNs: the relay sends a generic wake-up with no content or sender,
  but Apple learns that *a* device received *a* push. There is no alternative to
  APNs on iOS. Android uses no Google push service: wake-ups come from the
  relay's ntfy over Tor plus a foreground service.
- **Calls on mobile expose your IP to our TURN server.** Call media is UDP,
  which Tor cannot carry. By default, 1:1 calls relay all media through our
  TURN server (*Hide IP in calls*), so the other person does not see your IP,
  but the TURN server does. The desktop client sends TURN over TCP through Tor.
- **Expo's update server is contacted directly, outside Tor.** The app checks
  `u.expo.dev` for over-the-air fixes on launch, so Expo sees your IP and that
  the app is installed. The check carries no messages, contacts or Aegis ID.
- **One maintainer, one official relay.** The project is maintained by a single
  developer, and the official relay runs in a single region, so expect occasional
  downtime. You can self-host a relay (`.onion`-only) and still talk to contacts
  on other relays — see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- **Endpoint compromise is out of scope.** Malware on an unlocked device with the
  keystore unsealed can read plaintext; panic-wipe and decoy modes mitigate
  coercion but are not cryptographic defenses.

## Repository layout

| Path        | What it is                                              | License   |
|-------------|---------------------------------------------------------|-----------|
| `mobile/`   | The app — Expo SDK 54 + React Native + TypeScript       | GPL-3.0   |
| `server/`   | Relay — Node.js, Socket.IO, SQLite, push wake-ups, TURN credentials | AGPL-3.0  |
| `desktop/`  | Desktop client (Electron, Windows beta — see `docs/DESKTOP-BETA.md`) | GPL-3.0   |

## Quick start — run a relay locally

The relay is fully self-hostable (AGPL-3.0). **Running your own relay for real users:**
`infra/selfhost/` + `docs/SELF-HOSTING.md` — one `./up.sh` brings up relay + Tor onion
service + wake-up push, `.onion`-only (no domain, no TLS, no open port), and prints the
address users paste into *Privacy → Network → My relay*. Contacts on different relays reach
each other directly through Tor (no relay-to-relay protocol; `docs/FEDERATION-DESIGN.md`).
Federation is **on by default since 1.0.7** (slice F7): every published client accepts
relay-qualified (`v2`) contact links and shows that screen. The sections below run a relay
for development.

**A. Node directly** (Node.js 24+ — `node:sqlite`; fastest):

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
