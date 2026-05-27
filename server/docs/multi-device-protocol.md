# AegisLink — Multi-Device Protocol

## Overview

A user can link additional devices (e.g., a tablet, a desktop) to the same
AegisLink identity. The primary device holds the master identity key; linked
devices receive a derived session key bundle. The relay is a blind forwarder
during the linking handshake — it never sees plaintext key material.

---

## 1. Linking Flow

### Option A: Token-based (manual entry or QR code)

```
Device A (existing)         Relay                      Device B (new)
     |                        |                              |
     |-- POST /devices/link-request ─────────────────────▶  |
     |   { aegisId, deviceId }                              |
     |◀─ { linkToken, expiresAt } ────────────────────────  |
     |                        |                              |
     | (Display token as QR or 6-word phrase)               |
     |                        |                              |
     |                        |◀── POST /devices/link-confirm|
     |                        |    { linkToken,              |
     |                        |      newDeviceId,            |
     |                        |      newDevicePubKey }       |
     |                        |                              |
     |◀── socket: device_linked ──────────────────────────  |
     |    { newDeviceId,       |                              |
     |      newDevicePubKey }  |                              |
     |                        |                              |
     |  (Device A performs     |                              |
     |   E2EE key handoff     |                              |
     |   directly to B)       |                              |
     |─────────── envelope with key material ──────────────▶|
```

**Token properties:**
- 64 hex characters (32 random bytes), unpredictable.
- Expires in 5 minutes.
- Single-use: invalidated immediately on confirm.
- Max 3 pending tokens per aegisId at a time (rate limit).

---

## 2. Secure Key Material Delivery (Device A → Device B)

After Device A receives the `device_linked` socket event it has Device B's
X25519 public key (`newDevicePubKey`). Device A:

1. Generates an ephemeral X25519 key pair.
2. Derives a shared secret: `ECDH(ephemeralSecretKey, newDevicePubKey)`.
3. Derives an encryption key via HKDF-SHA256.
4. Encrypts the key bundle (identity secret key, ratchet state export) with
   XSalsa20-Poly1305 (TweetNaCl box).
5. Sends the encrypted blob to Device B as a normal `envelope` message
   addressed to the shared `aegisId`.

Device B decrypts using its secret key and the ephemeral public key included
in the envelope header.

The relay never sees the key material — it is inside the sealed envelope
ciphertext.

---

## 3. Message Delivery to Multiple Devices

When the relay receives an envelope addressed to an `aegisId`:

- It looks up `sockets.get(aegisId)` which is a `Set<Socket>`.
- All active sockets in the set receive the `envelope` event simultaneously.
- If the recipient is offline, one copy is enqueued in SQLite; all active
  devices drain it upon reconnecting.

**Read receipts:** Only the device that actually displays and reads the message
should emit `msg:read`. The other device(s) will receive the read receipt as a
forwarded event from the original sender and should update their local state
accordingly.

**Deduplication:** Each device should track message IDs it has already
processed. Since all devices share the same `aegisId`, two devices may both
receive the same queued message on drain — the second to drain should detect
the duplicate by ID and discard it silently.

---

## 4. Device Revocation

### Via HTTP (from any trusted client):

```
DELETE /devices/:aegisId/:deviceId
```

- Marks `revoked = 1` in `linked_devices` SQLite table.
- Emits `device_revoked { deviceId }` to all sockets under `aegisId`.

### Via Socket.IO (from authenticated mobile):

```javascript
socket.emit('device:revoke', { deviceId: '<id>' }, (res) => {
  // res: { ok: true } | { ok: false, error: 'not_found' }
});
```

The relay disconnects the revoked device's socket if it is currently online.

### After revocation:

- The revoked device loses relay access on next auth attempt (identity still
  valid but device association gone).
- Device A should re-derive a new session for remaining devices (forward
  secrecy: the revoked device must not be able to decrypt future messages).
- In practice: rotate the ratchet state and distribute fresh SPK + OPKs.

---

## 5. Listing Active Devices (Socket)

```javascript
socket.emit('device:list', (res) => {
  // res: { count: number, platforms: string[] }
});
```

Returns only the count and platform types of currently online sockets —
no device IDs or socket IDs are exposed. This is intentional to minimise
metadata leakage.

For a persistent device list (including offline devices), query SQLite via a
future `GET /devices/:aegisId` endpoint that requires authenticated proof of
ownership.
