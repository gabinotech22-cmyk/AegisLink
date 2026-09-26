#!/usr/bin/env -S node --experimental-strip-types
/**
 * Interop + differential test of the C core's Double Ratchet
 * (`cpp/aegis_ratchet.c`, F-1b phase 3) against its TypeScript twin
 * (`jest/ratchetCore.ts`, the algorithm the app ran in JavaScript before).
 *
 *   node --experimental-strip-types modules/aegis-sodium/test/ratchet-interop.mjs build/aegis-sodium/aegis_sodium_cli
 *
 * - Conversations C ↔ reference in both roles, classic and hybrid, with
 *   out-of-order delivery, lost messages, forgeries and replays: every
 *   message must decrypt on the other side (the wire is unchanged).
 * - Differential: after each C step the harness opens the C state (it knows
 *   the test KEK) and runs the reference on the same input; the deterministic
 *   parts of the result must be byte-identical.
 * - Contract: the error codes (no chain, too many skipped, low-order key,
 *   downgrade, tampered / foreign / locked state, type confusion with key
 *   blobs), the pre-F-1b import and trim.
 * Run by CI (`aegis-sodium-native`), also under ASan + UBSan.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import * as core from '../jest/ratchetCore.ts';
import * as layout from '../ratchetState.ts';

const require = createRequire(import.meta.url);
const sodium = require('sodium-native');
const { ml_kem768 } = await import('@noble/post-quantum/ml-kem.js');

const cli = process.argv[2];
if (!cli) {
  console.error('usage: ratchet-interop.mjs <path to aegis_sodium_cli>');
  process.exit(2);
}
const ITER = Number(process.env.AEGIS_DIFF_ITER || 400);
const CONVERSATIONS = Math.max(6, Math.round(ITER / 10));

// ── the C core, one line per call ──────────────────────────────────────────
const child = spawn(cli, { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
const waiting = [];
lines.on('line', (l) => waiting.shift()(l));
const hex = (b) => (b.length === 0 ? '_' : Buffer.from(b).toString('hex'));
const unhex = (s) => (s === '_' ? new Uint8Array(0) : new Uint8Array(Buffer.from(s, 'hex')));
/** args: Uint8Array (input) or a number (an output buffer of that many bytes). */
function call(op, ...args) {
  return new Promise((resolve) => {
    waiting.push((l) => {
      const [rc, ...outs] = l.split(' ');
      resolve({ rc: Number(rc), outs: outs.map(unhex) });
    });
    child.stdin.write([op, ...args.map((a) => (typeof a === 'number' ? `#${a}` : hex(a)))].join(' ') + '\n');
  });
}

const OK = 0, EVERIFY = 1, EBADLEN = -1, ENOKEY = -3;
const E = { STATE: -10, NO_CHAIN: -11, TOO_MANY: -12, LOW_ORDER: -13, DOWNGRADE: -14 };
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const rand = (n) => new Uint8Array(randomBytes(n));
const randInt = (max) => Math.floor(Math.random() * (max + 1));
const eq = (a, b) => (a === null || b === null ? a === b : Buffer.from(a).equals(Buffer.from(b)));
const enc = new TextEncoder();

let checks = 0;
const failures = [];
function check(ok, what) {
  checks++;
  if (!ok) failures.push(what);
}

// ── the reference: the TypeScript twin on node libsodium + @noble ML-KEM ───
const prims = {
  randomBytes: rand,
  x25519Keypair: () => {
    const publicKey = new Uint8Array(32), secretKey = new Uint8Array(32);
    sodium.crypto_box_keypair(publicKey, secretKey);
    return { publicKey, secretKey };
  },
  x25519: (sk, pk) => {
    const q = new Uint8Array(32);
    try { sodium.crypto_scalarmult(q, sk, pk); } catch { return null; }
    return q;
  },
  secretbox: (m, n, k) => { const c = new Uint8Array(m.length + 16); sodium.crypto_secretbox_easy(c, m, n, k); return c; },
  secretboxOpen: (c, n, k) => {
    if (c.length < 16) return null;
    const m = new Uint8Array(c.length - 16);
    return sodium.crypto_secretbox_open_easy(m, c, n, k) ? m : null;
  },
  hmacSha256: (k, m) => new Uint8Array(createHmac('sha256', k).update(m).digest()),
  hkdfSha256: (ikm, salt, info, len) => new Uint8Array(hkdfSync('sha256', ikm, salt, info, len)),
  mlkemKeygen: () => ml_kem768.keygen(),
  mlkemEncapsulate: (pk) => ml_kem768.encapsulate(pk),
  mlkemDecapsulate: (ct, sk) => ml_kem768.decapsulate(ct, sk),
};

// ── the vault: a profile whose KEK the harness knows (to open C states) ────
const SLOT = enc.encode('self');
const OTHER = enc.encode('selg'); // same length, another profile
const KEK = rand(32);
const OTHER_KEK = rand(32);
const BLOB = 28 + 16 + 2 + SLOT.length + layout.RATCHET_STATE_LEN;

/** The raw state inside a C blob (only possible because the test holds the KEK). */
function openC(blob, slot = SLOT, kek = KEK) {
  const plain = new Uint8Array(blob.length - 28 - 16);
  if (!sodium.crypto_secretbox_open_easy(plain, blob.subarray(28), blob.subarray(4, 28), kek)) throw new Error('openC');
  return layout.decodeRatchetState(plain.subarray(2 + slot.length));
}

const packHeader = (h) => layout.packRatchetHeader(h);

// One party: either the C core (state = sealed blob) or the reference (state = raw).
class CParty {
  constructor(blob) { this.blob = blob; }
  async encrypt(m) {
    const r = await call('ratchet_encrypt', BLOB, layout.RATCHET_INFO_LEN, layout.RATCHET_HEADER_LEN, 40 + m.length, SLOT, this.blob, m);
    if (r.rc !== OK) throw new Error(`C encrypt rc ${r.rc}`);
    const [blob, , hdr, box] = r.outs;
    const before = openC(this.blob);
    this.blob = blob;
    return { header: layout.unpackRatchetHeader(hdr), nonce: box.slice(0, 24), ciphertext: box.slice(24), before };
  }
  async decrypt(msg) {
    const box = new Uint8Array(24 + msg.ciphertext.length);
    box.set(msg.nonce, 0);
    box.set(msg.ciphertext, 24);
    const r = await call('ratchet_decrypt', BLOB, layout.RATCHET_INFO_LEN, msg.ciphertext.length - 16, SLOT, this.blob, packHeader(msg.header), box);
    if (r.rc === OK) {
      // Differential: the reference on the same input state and message.
      const pre = openC(this.blob);
      const ref = core.ratchetDecrypt(prims, pre, msg.header, msg.ciphertext, msg.nonce);
      const post = openC(r.outs[0]);
      check(ref !== null && eq(ref.plaintext, r.outs[2]), 'differential: reference plaintext');
      if (ref) {
        const turned = !eq(pre.DHr, post.DHr);
        const same = (a, b) => eq(layout.encodeRatchetState(a), layout.encodeRatchetState(b));
        if (!turned) {
          check(same(ref.state, post), 'differential: chain step state byte-identical');
        } else {
          // A chain turn draws fresh keys; everything derived before them must match.
          check(eq(ref.state.DHr, post.DHr) && eq(ref.state.PQr, post.PQr) && eq(ref.state.CKr, post.CKr), 'differential: turn DHr/PQr/CKr');
          check(ref.state.Nr === post.Nr && ref.state.PN === post.PN && ref.state.Ns === 0 && post.Ns === 0, 'differential: turn counters');
          check(eq(layout.encodeRatchetState({ ...ref.state, skipped: ref.state.skipped }).subarray(6064), layout.encodeRatchetState(post).subarray(6064)), 'differential: turn skipped keys');
        }
      }
      this.blob = r.outs[0];
      return r.outs[2];
    }
    if (r.rc === EVERIFY) return null;
    throw Object.assign(new Error(`C decrypt rc ${r.rc}`), { rc: r.rc });
  }
}

class RefParty {
  constructor(state) { this.state = state; }
  async encrypt(m) {
    const r = core.ratchetEncrypt(prims, this.state, m);
    this.state = r.state;
    return { header: r.header, nonce: r.nonce, ciphertext: r.ciphertext };
  }
  async decrypt(msg) {
    const r = core.ratchetDecrypt(prims, this.state, msg.header, msg.ciphertext, msg.nonce);
    if (!r) return null;
    this.state = r.state;
    return r.plaintext;
  }
}

async function cImport(raw) {
  const handle = await call('vault_import', 4, 28 + 16 + 2 + SLOT.length + raw.length, raw.length === 32 ? 32 : 1184, SLOT, u32le(raw.length === 32 ? 5 : 3), raw);
  if (handle.rc !== OK) throw new Error(`vault_import rc ${handle.rc}`);
  return new DataView(handle.outs[0].buffer).getUint32(0, true);
}

/** A fresh session: roles (which side is C) and kind (classic / hybrid). */
async function session(cIsAlice, hybrid) {
  const rk = rand(32);
  const spk = prims.x25519Keypair();
  const pq = hybrid ? ml_kem768.keygen() : null;
  let alice, bob;
  if (cIsAlice) {
    const r = await call('ratchet_init_alice', BLOB, layout.RATCHET_INFO_LEN, SLOT, rk, spk.publicKey, pq ? pq.publicKey : new Uint8Array(0));
    if (r.rc !== OK) throw new Error(`init_alice rc ${r.rc}`);
    alice = new CParty(r.outs[0]);
    bob = new RefParty(core.initBob(prims, rk, spk, pq));
  } else {
    const h = await cImport(spk.secretKey);
    const hp = pq ? await cImport(pq.secretKey) : 0;
    const r = await call('ratchet_init_bob', BLOB, layout.RATCHET_INFO_LEN, SLOT, rk, u32le(h), u32le(hp));
    if (r.rc !== OK) throw new Error(`init_bob rc ${r.rc}`);
    await call('vault_release', u32le(h));
    if (hp) await call('vault_release', u32le(hp));
    bob = new CParty(r.outs[0]);
    alice = new RefParty(core.initAlice(prims, rk, spk.publicKey, pq ? pq.publicKey : null));
  }
  return { alice, bob };
}

const text = (b) => Buffer.from(b).toString();

/** A random conversation: bursts, out-of-order delivery within the skip limit, forgeries, replays. */
async function conversation(cIsAlice, hybrid) {
  const { alice, bob } = await session(cIsAlice, hybrid);
  const sides = [alice, bob];
  let turn = 0; // Alice starts: Bob has no sending chain yet
  const steps = 6 + randInt(10);
  for (let s = 0; s < steps; s++) {
    const from = sides[turn], to = sides[1 - turn];
    const burst = [];
    for (let i = 0, n = 1 + randInt(6); i < n; i++) {
      const m = enc.encode(`${turn ? 'b' : 'a'}${s}.${i} ${hex(rand(randInt(40)))}`);
      burst.push({ m, msg: await from.encrypt(m) });
    }
    // Deliver in a shuffled order; maybe drop one (it stays in the skipped keys).
    const order = burst.map((_, i) => i).sort(() => Math.random() - 0.5);
    if (burst.length > 2 && Math.random() < 0.3) order.pop();
    for (const i of order) {
      const { m, msg } = burst[i];
      if (Math.random() < 0.15) {
        const forged = { ...msg, ciphertext: Uint8Array.from(msg.ciphertext) };
        forged.ciphertext[randInt(forged.ciphertext.length - 1)] ^= 1 << randInt(7);
        check((await to.decrypt(forged)) === null, 'forgery rejected');
      }
      const got = await to.decrypt(msg);
      check(got !== null && eq(got, m), `${cIsAlice ? 'C→ref' : 'ref→C'} ${hybrid ? 'hybrid' : 'classic'} delivers ${text(m).slice(0, 8)}`);
      if (Math.random() < 0.1) check((await to.decrypt(msg)) === null, 'replay of a consumed message rejected');
    }
    if (Math.random() < 0.8) turn = 1 - turn;
    if (s === 0) turn = 1; // make sure both sides send
  }
}

// ── contract ───────────────────────────────────────────────────────────────
async function contract() {
  const info = layout.RATCHET_INFO_LEN, hdrLen = layout.RATCHET_HEADER_LEN;
  // Bob before his first message has no sending chain.
  {
    const { bob } = await session(false, false);
    const r = await call('ratchet_encrypt', BLOB, info, hdrLen, 41, SLOT, bob.blob, enc.encode('x'));
    check(r.rc === E.NO_CHAIN, `bob encrypt before receiving → NO_CHAIN (${r.rc})`);
  }
  // Low-order ratchet key, too many skipped, downgrade.
  {
    const { alice, bob } = await session(true, true);
    const m0 = await alice.encrypt(enc.encode('m0'));
    const low = { ...m0, header: { ...m0.header, ratchetKey: new Uint8Array(32) } };
    const box = (m) => { const b = new Uint8Array(24 + m.ciphertext.length); b.set(m.nonce); b.set(m.ciphertext, 24); return b; };
    // bob here is the reference; test against a C receiver instead:
    const s2 = await session(false, true);
    const a0 = await s2.alice.encrypt(enc.encode('a0'));
    const lowC = await call('ratchet_decrypt', BLOB, info, a0.ciphertext.length - 16, SLOT, s2.bob.blob, packHeader({ ...a0.header, ratchetKey: new Uint8Array(32) }), box(a0));
    check(lowC.rc === E.LOW_ORDER, `low-order ratchet key → LOW_ORDER (${lowC.rc})`);
    const stripped = await call('ratchet_decrypt', BLOB, info, a0.ciphertext.length - 16, SLOT, s2.bob.blob, packHeader({ ratchetKey: a0.header.ratchetKey, n: a0.header.n, pn: a0.header.pn }), box(a0));
    check(stripped.rc === E.DOWNGRADE, `hybrid turn without PQ material → DOWNGRADE (${stripped.rc})`);
    const far = await call('ratchet_decrypt', BLOB, info, a0.ciphertext.length - 16, SLOT, s2.bob.blob, packHeader({ ...a0.header, n: layout.MAX_SKIPPED + 1 }), box(a0));
    check(far.rc === E.TOO_MANY, `skip past the cap → TOO_MANY_SKIPPED (${far.rc})`);
    check((await s2.bob.decrypt(a0)) !== null, 'the state survives every refused message');
    void low; void bob; void m0;
  }
  // Exactly MAX skipped is accepted, and the cap holds.
  {
    const { alice, bob } = await session(false, false);
    const msgs = [];
    for (let i = 0; i <= layout.MAX_SKIPPED; i++) msgs.push(await alice.encrypt(enc.encode(`m${i}`)));
    check((await bob.decrypt(msgs[layout.MAX_SKIPPED])) !== null, 'exactly MAX_SKIPPED skipped accepted');
    check(openC(bob.blob).skipped.length === layout.MAX_SKIPPED, 'skipped keys capped');
    check(text(await bob.decrypt(msgs[3])) === 'm3', 'a skipped message decrypts later');
    // Trim: C against the reference.
    const pre = openC(bob.blob);
    const t = await call('ratchet_trim', BLOB, info, SLOT, bob.blob, u32le(20));
    check(t.rc === OK, 'trim ok');
    check(eq(layout.encodeRatchetState(core.trimSkipped(pre, 20)), layout.encodeRatchetState(openC(t.outs[0]))), 'trim matches the reference');
  }
  // Eviction ties: equal n on two chains, one slot left → the OLDER one goes.
  {
    const { alice, bob } = await session(false, false);
    const c1 = [];
    for (let i = 0; i <= 30; i++) c1.push(await alice.encrypt(enc.encode(`x${i}`)));
    check((await bob.decrypt(c1[30])) !== null, 'ties: chain 1 head'); // skips x0..x29 (30)
    check((await alice.decrypt(await bob.encrypt(enc.encode('turn')))) !== null, 'ties: turn');
    const c2 = [];
    for (let i = 0; i <= 31; i++) c2.push(await alice.encrypt(enc.encode(`y${i}`)));
    check((await bob.decrypt(c2[31])) !== null, 'ties: chain 2 head'); // skips y0..y30 (31) → 61, evict 11
    check((await bob.decrypt(c1[5])) === null, 'ties: the older n=5 was evicted');
    check(text(await bob.decrypt(c2[5])) === 'y5', 'ties: the newer n=5 was kept');
  }
  // Tampered, foreign, locked, type confusion.
  {
    const { alice } = await session(true, false);
    const bad = Uint8Array.from(alice.blob);
    bad[bad.length - 1] ^= 1;
    const r1 = await call('ratchet_encrypt', BLOB, info, hdrLen, 41, SLOT, bad, enc.encode('x'));
    check(r1.rc === E.STATE, `tampered state → STATE (${r1.rc})`);
    await call('vault_unlock', OTHER, OTHER_KEK);
    const r2 = await call('ratchet_encrypt', BLOB, info, hdrLen, 41, OTHER, alice.blob, enc.encode('x'));
    check(r2.rc === E.STATE, `another profile's state → STATE (${r2.rc})`);
    const relabel = Uint8Array.from(alice.blob);
    relabel[3] = 3; // claim to be a key blob
    const r3 = await call('ratchet_encrypt', BLOB, info, hdrLen, 41, SLOT, relabel, enc.encode('x'));
    check(r3.rc === E.STATE, `relabelled header → STATE (${r3.rc})`);
    const r4 = await call('vault_load', 4, 4, 0, SLOT, alice.blob);
    check(r4.rc === EBADLEN, `a ratchet state never loads as a key (${r4.rc})`);
    // A prekey of another profile cannot seed a session here.
    const spk = prims.x25519Keypair();
    const imp = await call('vault_import', 4, 28 + 16 + 2 + OTHER.length + 32, 32, OTHER, u32le(5), spk.secretKey);
    const h = new DataView(imp.outs[0].buffer).getUint32(0, true);
    const r5 = await call('ratchet_init_bob', BLOB, info, SLOT, rand(32), u32le(h), u32le(0));
    check(r5.rc === ENOKEY, `foreign SPK handle → ENOKEY (${r5.rc})`);
    // Locked profile.
    await call('vault_lock', SLOT);
    const r6 = await call('ratchet_encrypt', BLOB, info, hdrLen, 41, SLOT, alice.blob, enc.encode('x'));
    check(r6.rc === ENOKEY, `locked profile → ENOKEY (${r6.rc})`);
    await call('vault_unlock', SLOT, KEK);
    const r7 = await call('ratchet_encrypt', BLOB, info, hdrLen, 41, SLOT, alice.blob, enc.encode('x'));
    check(r7.rc === OK, 'unlocked again → OK');
    // Bad lengths.
    const r8 = await call('ratchet_encrypt', BLOB - 1, info, hdrLen, 41, SLOT, alice.blob, enc.encode('x'));
    check(r8.rc === EBADLEN, `short output blob → EBADLEN (${r8.rc})`);
  }
  // Pre-F-1b import: a reference state (with skipped keys) moves into the C core and keeps talking.
  {
    const rk = rand(32);
    const spk = prims.x25519Keypair();
    const pq = ml_kem768.keygen();
    const a = new RefParty(core.initAlice(prims, rk, spk.publicKey, pq.publicKey));
    const b = new RefParty(core.initBob(prims, rk, spk, pq));
    const m0 = await a.encrypt(enc.encode('m0'));
    const m1 = await a.encrypt(enc.encode('m1'));
    check(text(await b.decrypt(m1)) === 'm1', 'legacy: ref decrypts');
    const imp = await call('ratchet_import', BLOB, info, SLOT, layout.encodeRatchetState(b.state));
    check(imp.rc === OK, 'import ok');
    const cb = new CParty(imp.outs[0]);
    check(eq(layout.encodeRatchetState(openC(cb.blob)), layout.encodeRatchetState(b.state)), 'import keeps the state byte for byte');
    check(text(await cb.decrypt(m0)) === 'm0', 'imported state decrypts a skipped message');
    const reply = await cb.encrypt(enc.encode('r'));
    check(text(await a.decrypt(reply)) === 'r', 'imported state replies (chain turn)');
    const badRaw = layout.encodeRatchetState(b.state);
    badRaw[0] = 9;
    const bad = await call('ratchet_import', BLOB, info, SLOT, badRaw);
    check(bad.rc === E.STATE, `malformed import → STATE (${bad.rc})`);
  }
}

try {
  let r = await call('vault_unlock', SLOT, KEK);
  if (r.rc !== OK) throw new Error('unlock');
  for (let i = 0; i < CONVERSATIONS; i++) await conversation(i % 2 === 0, i % 4 < 2);
  await contract();
  r = await call('vault_live', );
  check(r.rc === 1, `no handle leaks (${r.rc} live: the foreign SPK only)`);
} catch (e) {
  failures.push(`threw: ${e.stack || e}`);
}
child.stdin.end();
if (failures.length) {
  console.error(`aegis-sodium ratchet interop: ${failures.length}/${checks} FAILED\n  ${failures.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
process.stdout.write(`aegis-sodium ratchet interop: ${checks} checks passed (C core ↔ TypeScript twin, ${CONVERSATIONS} conversations).\n`);
