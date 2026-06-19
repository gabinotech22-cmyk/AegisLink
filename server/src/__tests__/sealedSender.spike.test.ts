/**
 * sealedSender.spike.test.ts — Phase 0 spike (docs/SEALED-SENDER-ARCHITECTURE.md)
 *
 * Validates the sealed-sender envelope's correctness + authentication properties
 * and BENCHMARKS the per-message crypto overhead. The benchmark is the go/no-go
 * input for migrating real-time call signaling: ICE trickle fires many small
 * sealed messages per call, so the ephemeral-keygen + sign + verify cost per
 * message must stay well under the network RTT to be invisible to users.
 *
 * The benchmark asserts only a generous ceiling (so CI stays stable across
 * hardware) and prints the measured numbers for the human go/no-go decision.
 */

import nacl from 'tweetnacl';
import {
  sealEnvelope,
  openEnvelope,
  SEALED_TS_SKEW_MS,
  type SealedWire,
} from '../crypto/sealedSender.js';
import {
  generateDeliveryToken,
  hashDeliveryToken,
  verifyDeliveryToken,
} from '../crypto/deliveryToken.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const alice = {
  box: nacl.box.keyPair(),
  sign: nacl.sign.keyPair(),
  aegisId: 'AAA-BBBB-CCCC',
};
const bob = {
  box: nacl.box.keyPair(),
  sign: nacl.sign.keyPair(),
  aegisId: 'DDD-EEEE-FFFF',
};
const mallory = { sign: nacl.sign.keyPair(), aegisId: 'XXX-YYYY-ZZZZ' };

// Bob's contact directory: aegisId → signing pubkey (what the recipient holds).
const bobContacts: Record<string, Uint8Array> = { [alice.aegisId]: alice.sign.publicKey };
const resolveForBob = (from: string): Uint8Array | null => bobContacts[from] ?? null;

const NOW = 1_750_000_000_000; // fixed clock for determinism

describe('sealed-sender envelope — correctness & authentication', () => {
  test('round-trips a payload and recovers the authenticated sender', () => {
    const wire = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, 'hello bob', NOW);
    // Wire carries NO sender identity.
    expect(Object.keys(wire).sort()).toEqual(['ciphertext', 'epk', 'nonce']);
    expect(JSON.stringify(wire)).not.toContain(alice.aegisId);

    const opened = openEnvelope(wire, bob.box.secretKey, resolveForBob, NOW);
    expect(opened).not.toBeNull();
    expect(opened!.from).toBe(alice.aegisId);
    expect(opened!.payload).toBe('hello bob');
  });

  test('every message uses a fresh ephemeral key (unlinkable on the wire)', () => {
    const w1 = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, 'm', NOW);
    const w2 = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, 'm', NOW);
    expect(w1.epk).not.toBe(w2.epk);
    expect(w1.nonce).not.toBe(w2.nonce);
  });

  test('rejects a tampered ciphertext (Poly1305 MAC)', () => {
    const wire = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, 'x', NOW);
    const bytes = Buffer.from(wire.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered: SealedWire = { ...wire, ciphertext: bytes.toString('base64') };
    expect(openEnvelope(tampered, bob.box.secretKey, resolveForBob, NOW)).toBeNull();
  });

  test('rejects an unknown sender (not in recipient contacts)', () => {
    // Mallory seals claiming to be a stranger Bob does not have.
    const wire = sealEnvelope(bob.box.publicKey, mallory.aegisId, mallory.sign.secretKey, 'spam', NOW);
    expect(openEnvelope(wire, bob.box.secretKey, resolveForBob, NOW)).toBeNull();
  });

  test('rejects a forged `from`: Mallory cannot impersonate Alice', () => {
    // Mallory seals to Bob but claims from = Alice, signing with HER OWN key.
    const wire = sealEnvelope(bob.box.publicKey, alice.aegisId, mallory.sign.secretKey, 'fake', NOW);
    // Bob resolves Alice's real signing key → signature check fails.
    expect(openEnvelope(wire, bob.box.secretKey, resolveForBob, NOW)).toBeNull();
  });

  test('rejects a stale/replayed envelope outside the skew window', () => {
    const wire = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, 'old', NOW);
    const tooLate = NOW + SEALED_TS_SKEW_MS + 1;
    expect(openEnvelope(wire, bob.box.secretKey, resolveForBob, tooLate)).toBeNull();
  });

  test('rejects when opened with the wrong recipient key', () => {
    const wire = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, 'priv', NOW);
    expect(openEnvelope(wire, alice.box.secretKey, resolveForBob, NOW)).toBeNull();
  });
});

describe('delivery token — anti-abuse gate', () => {
  test('verifies a correct token and rejects a wrong one (constant-time)', () => {
    const token = generateDeliveryToken();
    const stored = hashDeliveryToken(token);
    expect(verifyDeliveryToken(token, stored)).toBe(true);
    expect(verifyDeliveryToken(generateDeliveryToken(), stored)).toBe(false);
    expect(verifyDeliveryToken('', stored)).toBe(false);
    expect(verifyDeliveryToken(token, 'not-base64-…')).toBe(false);
  });

  test('the relay stores only the hash, never the raw token', () => {
    const token = generateDeliveryToken();
    const stored = hashDeliveryToken(token);
    expect(stored).not.toContain(token);
  });
});

describe('latency benchmark — go/no-go for call signaling', () => {
  test('per-message seal+open overhead ratio is bounded; print measured cost', () => {
    const ITER = 200;
    const payload = JSON.stringify({ candidate: 'candidate:842163049 1 udp 1677729535 192.0.2.1 54321 typ srflx', sdpMid: '0', sdpMLineIndex: 0 });

    // Warm up the JIT so the first-call cost is not attributed to one path.
    for (let i = 0; i < 10; i++) {
      const w = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, payload, NOW);
      openEnvelope(w, bob.box.secretKey, resolveForBob, NOW);
    }

    // Sealed-sender: ephemeral keygen + sign + box + open + verify per message.
    const sealedStart = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) {
      const wire = sealEnvelope(bob.box.publicKey, alice.aegisId, alice.sign.secretKey, payload, NOW);
      const opened = openEnvelope(wire, bob.box.secretKey, resolveForBob, NOW);
      if (!opened) throw new Error('benchmark open failed');
    }
    const sealedNs = Number(process.hrtime.bigint() - sealedStart);

    // Baseline: today's call signaling (static-key nacl.box, no ephemeral/sign).
    const baseStart = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) {
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const ct = nacl.box(new TextEncoder().encode(payload), nonce, bob.box.publicKey, alice.box.secretKey);
      const pt = nacl.box.open(ct, nonce, alice.box.publicKey, bob.box.secretKey);
      if (!pt) throw new Error('baseline open failed');
    }
    const baseNs = Number(process.hrtime.bigint() - baseStart);

    const sealedPerMs = sealedNs / ITER / 1e6;
    const basePerMs = baseNs / ITER / 1e6;
    const ratio = sealedPerMs / basePerMs;
    // eslint-disable-next-line no-console
    console.log(
      `[sealed-sender spike] per-message over ${ITER} iters: ` +
        `sealed=${sealedPerMs.toFixed(3)}ms  baseline(box)=${basePerMs.toFixed(3)}ms  ` +
        `ratio=${ratio.toFixed(2)}x (ephemeral keygen + Ed25519 sign + verify)`,
    );

    // Assert the RATIO (hardware-independent), not absolute ms (which is huge on
    // pure-JS TweetNaCl and ~60x worse on Hermes). The finding for the human
    // go/no-go: a fresh asymmetric seal PER MESSAGE multiplies cost several-fold
    // — too expensive for per-ICE-candidate trickle. Mitigation (see design doc):
    // one sealed-sender handshake PER CALL → symmetric secretbox per candidate.
    expect(ratio).toBeLessThan(8);
  });

  test('MITIGATION: one sealed handshake per call + symmetric secretbox per candidate ≈ baseline', () => {
    const ITER = 200;
    const payload = JSON.stringify({ candidate: 'candidate:842163049 1 udp 1677729535 192.0.2.1 54321 typ srflx', sdpMid: '0', sdpMLineIndex: 0 });

    // One sealed-sender handshake establishes a per-call symmetric session key
    // (the caller seals a random 32-byte key inside the call invite). Each ICE
    // candidate is then sealed with cheap nacl.secretbox under that key — no
    // ephemeral keygen / sign / verify per candidate.
    const sessionKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const handshakeWire = sealEnvelope(
      bob.box.publicKey, alice.aegisId, alice.sign.secretKey,
      Buffer.from(sessionKey).toString('base64'), NOW,
    );
    const opened = openEnvelope(handshakeWire, bob.box.secretKey, resolveForBob, NOW);
    expect(opened).not.toBeNull();
    const calleeSessionKey = new Uint8Array(Buffer.from(opened!.payload, 'base64'));
    expect(Buffer.from(calleeSessionKey)).toEqual(Buffer.from(sessionKey));

    const start = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) {
      const n = nacl.randomBytes(nacl.secretbox.nonceLength);
      const ct = nacl.secretbox(new TextEncoder().encode(payload), n, sessionKey);
      const pt = nacl.secretbox.open(ct, n, calleeSessionKey);
      if (!pt) throw new Error('session secretbox open failed');
    }
    const perMs = Number(process.hrtime.bigint() - start) / ITER / 1e6;
    // eslint-disable-next-line no-console
    console.log(`[sealed-sender spike] amortized per-candidate (secretbox under session key) = ${perMs.toFixed(3)}ms`);

    // secretbox is symmetric → far cheaper than the per-message asymmetric seal.
    // This is the recommended path for call signaling (one handshake, cheap trickle).
    expect(perMs).toBeLessThan(5);
  });
});
