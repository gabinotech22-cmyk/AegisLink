/**
 * F-1 golden fixtures — desktop replay (golden rule #5: parity).
 *
 * Replays the SAME frozen fixture as mobile
 * (`mobile/src/crypto/__tests__/fixtures/f1-golden.json`, generated once with
 * the pure-JS TweetNaCl/@noble primitives before the switch to native
 * libsodium) through the desktop renderer's `crypto/sodium` facade, ratchet,
 * ratchetSerde and sealed sender. Desktop and mobile talk to each other, so
 * they must accept exactly the same bytes. See the mobile twin for details;
 * never regenerate the fixture to make a failing test pass.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { nacl, sha256, sha512, hmacSha256, hkdfSha256 } from '../sodium';
import { ratchetDecrypt, type RatchetState } from '../signal/ratchet';
import { serializeRatchetState, reviveRatchetState } from '../../socket/ratchetSerde';
import { openEnvelope, type SealedWire } from '../sealedSender';

const FIXTURE = path.resolve(__dirname, '../../../../../mobile/src/crypto/__tests__/fixtures/f1-golden.json');
const b64 = encodeBase64;
const unb64 = decodeBase64;
const utf8 = new TextEncoder();
const fill = (n: number, f: (i: number) => number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);

// ─── deterministic inputs ────────────────────────────────────────────────────
const A_SK = fill(32, (i) => i + 1);
const B_SK = fill(32, (i) => 0x80 + i);
const KEY = fill(32, (i) => 0x40 + i);
const SEED = fill(32, (i) => 0x11 * (i % 15));
const NONCE = fill(24, (i) => 0xa0 + i);
const MSG_LENGTHS = [0, 1, 100, 1000];
const msg = (n: number): Uint8Array => fill(n, (i) => i * 7);

type Vectors = Record<string, string>;
type WireHeader = { ratchetKey: string; n: number; pn: number; pqPub?: string; pqCt?: string };
type WireMsg = { header: WireHeader; ciphertext: string; nonce: string; plaintext: string };
interface Transcript {
  bobState: string;
  aliceMsgs: WireMsg[];
  aliceStateAfterSend: string;
  bobReply: WireMsg;
}
interface Golden {
  vectors: Vectors;
  sealed: { recipientSeed: string; senderSeed: string; senderId: string; nowMs: number; payload: string; wire: SealedWire };
  ratchet: { classic: Transcript; hybrid: Transcript };
}

function computeVectors(): Vectors {
  const v: Vectors = {};
  const aPk = nacl.scalarMult.base(A_SK);
  const bPk = nacl.scalarMult.base(B_SK);
  v.aPk = b64(aPk);
  v.bPk = b64(bPk);
  v.boxKeyPairFromSecret = b64(nacl.box.keyPair.fromSecretKey(A_SK).publicKey);
  v.dh = b64(nacl.scalarMult(A_SK, bPk));
  v.boxBefore = b64(nacl.box.before(bPk, A_SK));
  const sign = nacl.sign.keyPair.fromSeed(SEED);
  v.signPk = b64(sign.publicKey);
  v.signSk = b64(sign.secretKey);
  for (const n of MSG_LENGTHS) {
    const m = msg(n);
    v[`box_${n}`] = b64(nacl.box(m, NONCE, bPk, A_SK));
    v[`secretbox_${n}`] = b64(nacl.secretbox(m, NONCE, KEY));
    v[`sig_${n}`] = b64(nacl.sign.detached(m, sign.secretKey));
    v[`sha256_${n}`] = b64(sha256(m));
    v[`sha512_${n}`] = b64(sha512(m));
    v[`hmac_${n}`] = b64(hmacSha256(KEY, m));
  }
  v.hkdfSalted = b64(hkdfSha256(KEY, NONCE, utf8.encode('AegisLinkRoot'), 64));
  v.hkdfNoSalt = b64(hkdfSha256(KEY, undefined, utf8.encode('AegisLinkMailbox'), 32));
  v.hkdfNoInfo = b64(hkdfSha256(KEY, NONCE, undefined, 16));
  return v;
}

function headerFrom(h: WireHeader): { ratchetKey: Uint8Array; n: number; pn: number; pqPub?: Uint8Array; pqCt?: Uint8Array } {
  return {
    ratchetKey: unb64(h.ratchetKey),
    n: h.n,
    pn: h.pn,
    ...(h.pqPub ? { pqPub: unb64(h.pqPub) } : {}),
    ...(h.pqCt ? { pqCt: unb64(h.pqCt) } : {}),
  };
}

function decryptWire(state: RatchetState, m: WireMsg): string | null {
  const pt = ratchetDecrypt(state, headerFrom(m.header), unb64(m.ciphertext), unb64(m.nonce));
  return pt ? new TextDecoder().decode(pt) : null;
}

// ─── replay ──────────────────────────────────────────────────────────────────
describe('F-1 golden fixtures (pre-libsodium output must stay valid)', () => {
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Golden;

  it('every facade primitive reproduces the frozen bytes', () => {
    expect(computeVectors()).toEqual(golden.vectors);
  });

  it('frozen ciphertexts open and frozen signatures verify', () => {
    const bPk = unb64(golden.vectors.bPk);
    const aPk = unb64(golden.vectors.aPk);
    const signPk = unb64(golden.vectors.signPk);
    for (const n of MSG_LENGTHS) {
      expect(nacl.box.open(unb64(golden.vectors[`box_${n}`]), NONCE, aPk, B_SK)).toEqual(msg(n));
      expect(nacl.secretbox.open(unb64(golden.vectors[`secretbox_${n}`]), NONCE, KEY)).toEqual(msg(n));
      expect(nacl.sign.detached.verify(msg(n), unb64(golden.vectors[`sig_${n}`]), signPk)).toBe(true);
    }
    const tampered = unb64(golden.vectors.box_100);
    tampered[20] ^= 1;
    expect(nacl.box.open(tampered, NONCE, bPk, A_SK)).toBeNull();
  });

  it('a frozen sealed-sender envelope still opens and authenticates', () => {
    const s = golden.sealed;
    const recipient = nacl.box.keyPair.fromSecretKey(unb64(s.recipientSeed));
    const sender = nacl.sign.keyPair.fromSeed(unb64(s.senderSeed));
    const opened = openEnvelope(s.wire, recipient.secretKey, (from) => (from === s.senderId ? sender.publicKey : null), s.nowMs);
    expect(opened).not.toBeNull();
    expect(opened!.from).toBe(s.senderId);
    expect(opened!.payload).toBe(s.payload);
  });

  for (const kind of ['classic', 'hybrid'] as const) {
    it(`a persisted ${kind} ratchet session keeps decrypting (incl. out-of-order)`, () => {
      const t = golden.ratchet[kind];
      const bob = reviveRatchetState(t.bobState);
      const [m1, m2, m3] = t.aliceMsgs;
      expect(decryptWire(bob, m1)).toBe(m1.plaintext);
      expect(decryptWire(bob, m3)).toBe(m3.plaintext);
      expect(decryptWire(bob, m2)).toBe(m2.plaintext); // from MKSKIPPED

      const alice = reviveRatchetState(t.aliceStateAfterSend);
      expect(decryptWire(alice, t.bobReply)).toBe(t.bobReply.plaintext); // DH ratchet step
    });
  }
});
