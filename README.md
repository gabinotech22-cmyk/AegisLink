# AegisLink

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
- **1:1 chat**: Double Ratchet with X3DH key agreement, sealed-sender
  envelopes. The relay routes opaque ciphertext only.
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

## Repository layout

| Path        | What it is                                              | License   |
|-------------|---------------------------------------------------------|-----------|
| `mobile/`   | The app — Expo SDK 54 + React Native + TypeScript       | GPL-3.0   |
| `server/`   | Relay — Node.js, Socket.IO, SQLite, push wake-ups, TURN credentials | AGPL-3.0  |
| `desktop/`  | Desktop client (work in progress)                       | GPL-3.0   |

## Building

**Server** (Node.js 22+):

```bash
cd server
npm install
cp ../.env.example .env   # adjust values — see comments inside
npm start
```

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

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy.
