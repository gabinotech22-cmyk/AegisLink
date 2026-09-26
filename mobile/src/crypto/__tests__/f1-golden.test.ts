/**
 * F-1 golden fixtures — frozen output of the TweetNaCl/@noble implementation.
 *
 * `fixtures/f1-golden.json` was generated ONCE with the pure-JS primitives,
 * before the switch to native libsodium. These tests replay it through the
 * CURRENT `src/crypto/sodium` backend:
 *   - `vectors`: deterministic inputs → exact bytes for every facade primitive.
 *   - `sealed`: a sealed-sender envelope that must still open and authenticate.
 *   - `ratchet.{classic,hybrid}`: a persisted Bob state + Alice's messages (one
 *     delivered out of order) and Bob's reply to a persisted Alice state. Old
 *     sessions stored on disk must keep decrypting after the backend swap.
 *
 * Any mismatch means the new backend is NOT byte-compatible: that breaks every
 * existing session, backup and message on the wire. Never regenerate this file
 * to make a failing test pass — the whole point is that it predates the swap.
 * (Generator kept for provenance: `F1_GOLDEN_REGEN=1` with no fixture present.)
 *
 * The same fixture is replayed by desktop (`desktop/src/renderer/crypto/__tests__/
 * f1-golden.test.ts`) and, for the NaCl subset it uses, by the relay
 * (`server/src/__tests__/f1-golden.test.ts`).
 */
import fs from 'fs';
import path from 'path';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { nacl, sha256, sha512, hmacSha256, hkdfSha256 } from '../sodium';
import { initRatchet, ratchetEncrypt, ratchetDecrypt, type RatchetState } from '../signal/ratchet';
import { serializeRatchetState, reviveRatchetState } from '../../socket/ratchetSerde';
import { sealEnvelope, openEnvelope, type SealedWire } from '../sealedSender';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { vk } from './helpers/rawIdentity';

const FIXTURE = path.join(__dirname, 'fixtures', 'f1-golden.json');
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

// ─── generator (provenance only) ─────────────────────────────────────────────
function toWire(
  r: { ciphertext: Uint8Array; nonce: Uint8Array; header: { ratchetKey: Uint8Array; n: number; pn: number; pqPub?: Uint8Array; pqCt?: Uint8Array } },
  plaintext: string,
): WireMsg {
  const h: WireHeader = { ratchetKey: b64(r.header.ratchetKey), n: r.header.n, pn: r.header.pn };
  if (r.header.pqPub) h.pqPub = b64(r.header.pqPub);
  if (r.header.pqCt) h.pqCt = b64(r.header.pqCt);
  return { header: h, ciphertext: b64(r.ciphertext), nonce: b64(r.nonce), plaintext };
}

function generateTranscript(hybrid: boolean): Transcript {
  const root = nacl.randomBytes(32);
  const spk = nacl.box.keyPair();
  const pq = hybrid ? ml_kem768.keygen() : null;
  const alice = initRatchet(new Uint8Array(root), spk.publicKey, true, undefined, null, pq ? pq.publicKey : null);
  const bob = initRatchet(new Uint8Array(root), new Uint8Array(), false, spk, pq, null);
  const bobState = serializeRatchetState(bob);
  const texts = ['golden-1', 'golden-2 (delivered last)', 'golden-3'];
  const aliceMsgs = texts.map((t) => toWire(ratchetEncrypt(alice, utf8.encode(t)), t));
  const aliceStateAfterSend = serializeRatchetState(alice);
  for (const m of aliceMsgs) {
    if (!ratchetDecrypt(bob, headerFrom(m.header), unb64(m.ciphertext), unb64(m.nonce))) throw new Error('generator: bob decrypt');
  }
  const reply = 'golden-reply';
  return { bobState, aliceMsgs, aliceStateAfterSend, bobReply: toWire(ratchetEncrypt(bob, utf8.encode(reply)), reply) };
}

function generate(): Golden {
  const recipient = nacl.box.keyPair.fromSecretKey(fill(32, (i) => 0x33 + i));
  const sender = nacl.sign.keyPair.fromSeed(fill(32, (i) => 0x55 + i));
  const nowMs = 1_790_000_000_000;
  const payload = '{"golden":"sealed-sender"}';
  return {
    vectors: computeVectors(),
    sealed: {
      recipientSeed: b64(fill(32, (i) => 0x33 + i)),
      senderSeed: b64(fill(32, (i) => 0x55 + i)),
      senderId: 'golden-sender',
      nowMs,
      payload,
      wire: sealEnvelope(recipient.publicKey, 'golden-sender', vk(sender.secretKey), payload, nowMs),
    },
    ratchet: { classic: generateTranscript(false), hybrid: generateTranscript(true) },
  };
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

if (!fs.existsSync(FIXTURE) && process.env.F1_GOLDEN_REGEN === '1') {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(generate(), null, 1) + '\n');
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
    const opened = openEnvelope(s.wire, vk(recipient.secretKey), (from) => (from === s.senderId ? sender.publicKey : null), s.nowMs);
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
