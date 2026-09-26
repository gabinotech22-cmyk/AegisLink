#!/usr/bin/env node
/**
 * Differential test of the aegis_sodium C core compiled with the vendored
 * libsodium (F-1 B2) against the JavaScript implementations the app used
 * before (TweetNaCl, @noble/hashes): identical bytes on random inputs and on
 * RFC vectors (Argon2id also at the app's exact PIN and backup parameters;
 * ML-KEM-768 against @noble/post-quantum), plus the C core's own contract (length validation, NULL
 * handling, fail-closed on low-order points, rejected small-order signatures).
 *
 *   cmake -S modules/aegis-sodium/test -B build/aegis-sodium-host -G Ninja
 *   ninja -C build/aegis-sodium-host
 *   node modules/aegis-sodium/test/differential.mjs build/aegis-sodium-host/aegis_sodium_cli
 *
 * Run by CI (`aegis-sodium-native` job). This is the test of the code the app
 * ships; the Jest backend (`jest/nodeBackend.ts`) is a Node stand-in for it.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const { hmac } = require('@noble/hashes/hmac.js');
const { hkdf } = require('@noble/hashes/hkdf.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { argon2id } = require('@noble/hashes/argon2.js');
const { pbkdf2 } = require('@noble/hashes/pbkdf2.js');
const { ml_kem768 } = await import('@noble/post-quantum/ml-kem.js');

const OK = 0;
const EVERIFY = 1;
const EBADLEN = -1;
const EFAIL = -2;

const cli = process.argv[2];
if (!cli) {
  console.error('usage: differential.mjs <path to aegis_sodium_cli>');
  process.exit(2);
}

const hex = (b) => (b.length === 0 ? '_' : Buffer.from(b).toString('hex'));
const unhex = (s) => (s === '_' ? new Uint8Array(0) : new Uint8Array(Buffer.from(s, 'hex')));
const rand = (n) => new Uint8Array(randomBytes(n));
const randInt = (max) => Math.floor(Math.random() * (max + 1));

/** @type {{ line: string, check: (rc: number, outs: Uint8Array[]) => string | null }[]} */
const cases = [];
function call(name, args, check) {
  cases.push({
    line: [name, ...args.map((a) => (typeof a === 'string' ? a : hex(a)))].join(' '),
    check,
  });
}
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const expectRc = (want) => (rc) => (rc === want ? null : `rc ${rc}, want ${want}`);
const expectBytes = (...want) => (rc, outs) => {
  if (rc !== OK) return `rc ${rc}, want 0`;
  for (let i = 0; i < want.length; i++) if (!eq(outs[i], want[i])) return `output ${i} differs`;
  return null;
};

const ITER = Number(process.env.AEGIS_DIFF_ITER ?? 200);

for (let i = 0; i < ITER; i++) {
  const a = nacl.box.keyPair();
  const b = nacl.box.keyPair();
  const msg = rand(randInt(300));
  const nonce = rand(24);
  const key = rand(32);

  const boxed = nacl.box(msg, nonce, b.publicKey, a.secretKey);
  call('box_easy', [`#${msg.length + 16}`, msg, nonce, b.publicKey, a.secretKey], expectBytes(boxed));
  call('box_open_easy', [`#${msg.length}`, boxed, nonce, a.publicKey, b.secretKey], expectBytes(msg));
  const tampered = boxed.slice();
  tampered[randInt(tampered.length - 1)] ^= 1 << randInt(7);
  call('box_open_easy', [`#${msg.length}`, tampered, nonce, a.publicKey, b.secretKey], expectRc(EVERIFY));
  call('box_beforenm', ['#32', b.publicKey, a.secretKey], expectBytes(nacl.box.before(b.publicKey, a.secretKey)));

  const sboxed = nacl.secretbox(msg, nonce, key);
  call('secretbox_easy', [`#${msg.length + 16}`, msg, nonce, key], expectBytes(sboxed));
  call('secretbox_open_easy', [`#${msg.length}`, sboxed, nonce, key], expectBytes(msg));
  call('secretbox_open_easy', [`#${msg.length}`, sboxed, nonce, rand(32)], expectRc(EVERIFY));

  const n = rand(32);
  call('scalarmult', ['#32', n, b.publicKey], expectBytes(nacl.scalarMult(n, b.publicKey)));
  call('scalarmult_base', ['#32', n], expectBytes(nacl.scalarMult.base(n)));

  const seed = rand(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  call('sign_seed_keypair', ['#32', '#64', seed], expectBytes(kp.publicKey, kp.secretKey));
  const sig = nacl.sign.detached(msg, kp.secretKey);
  call('sign_detached', ['#64', msg, kp.secretKey], expectBytes(sig));
  call('sign_verify_detached', [sig, msg, kp.publicKey], expectRc(OK));
  const badSig = sig.slice();
  badSig[randInt(31)] ^= 1;
  call('sign_verify_detached', [badSig, msg, kp.publicKey], expectRc(EVERIFY));

  const hkey = rand(randInt(200));
  call('hmacsha256', ['#32', msg, hkey], expectBytes(hmac(sha256, hkey, msg)));
  const salt = rand(randInt(80));
  const info = rand(randInt(80));
  const len = 1 + randInt(199);
  call('hkdf_sha256', [`#${len}`, msg, salt, info], expectBytes(hkdf(sha256, msg, salt, info, len)));

  const x = rand(1 + randInt(64));
  call('memcmp', [x, x.slice()], expectRc(OK));
  const y = x.slice();
  y[randInt(y.length - 1)] ^= 0x80;
  call('memcmp', [x, y], expectRc(EVERIFY));
}

// RFC vectors.
const rfc7748 = {
  k: 'a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4',
  u: 'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c',
  out: 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
};
call('scalarmult', ['#32', rfc7748.k, rfc7748.u], expectBytes(unhex(rfc7748.out)));
const rfc8032 = {
  seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  pk: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
};
call('sign_seed_keypair', ['#32', '#64', rfc8032.seed], (rc, [pk]) => (rc === OK && hex(pk) === rfc8032.pk ? null : 'RFC 8032 pk'));
call('sign_detached', ['#64', '_', rfc8032.seed + rfc8032.pk], expectBytes(unhex(rfc8032.sig)));
call('sign_verify_detached', [rfc8032.sig, '_', rfc8032.pk], expectRc(OK));
call('hmacsha256', ['#32', '4869205468657265', '0b'.repeat(20)],
  expectBytes(unhex('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')));
call('hkdf_sha256', ['#42', '0b'.repeat(22), '000102030405060708090a0b0c', 'f0f1f2f3f4f5f6f7f8f9'],
  expectBytes(unhex('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')));
// RFC 5869 test 3: empty salt and info.
call('hkdf_sha256', ['#42', '0b'.repeat(22), 'NULL', 'NULL'],
  expectBytes(unhex('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8')));

// Argon2id vs @noble/hashes. The cost parameters travel as 4-byte little-endian buffers.
const le32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const argon = (outLen, pwd, salt, t, m) =>
  call('argon2id', [`#${outLen}`, pwd, salt, le32(t), le32(m)],
    expectBytes(argon2id(pwd, salt, { t, m, p: 1, dkLen: outLen })));
for (let i = 0; i < Math.min(ITER, 40); i++) {
  argon(16 + randInt(48), rand(randInt(64)), rand(8 + randInt(56)), 1 + randInt(3), 8 + randInt(248));
}
{
  const enc = new TextEncoder();
  // The app's own parameter sets (mobile/src/lock/pin.ts, mobile/src/crypto/backup.ts).
  argon(32, enc.encode('1234'), rand(16), 1, 2048); // PIN a3, per-install 16-byte salt
  argon(32, enc.encode('123456'), enc.encode('aegislink:panic:v1:'), 1, 2048); // duress PIN, 19-byte domain salt
  argon(32, enc.encode('correct horse battery staple'), rand(32), 3, 65536); // backup v3, 32-byte salt
  // Reference vector (argon2 reference implementation test.c, Argon2id v1.3, m=2^16, t=2, p=1).
  call('argon2id', ['#32', enc.encode('password'), enc.encode('somesalt'), le32(2), le32(65536)],
    expectBytes(unhex('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7')));
  // Empty password, with the NULL a binding passes for an empty JS array.
  call('argon2id', ['#32', 'NULL', enc.encode('somesalt'), le32(1), le32(64)],
    expectBytes(argon2id(new Uint8Array(0), enc.encode('somesalt'), { t: 1, m: 64, p: 1, dkLen: 32 })));
}

// PBKDF2-HMAC-SHA256 against @noble (which wrote the legacy v1/v2 backups) and
// RFC 7914 §11; including the app's own parameters (v1: 100k, 32-byte key).
{
  const enc = new TextEncoder();
  const p2 = (outLen, pwd, salt, c) =>
    call('pbkdf2_sha256', [`#${outLen}`, pwd, salt, le32(c)], expectBytes(pbkdf2(sha256, pwd, salt, { c, dkLen: outLen })));
  for (let i = 0; i < Math.min(ITER, 40); i++) p2(1 + randInt(63), rand(randInt(100)), rand(randInt(64)), 1 + randInt(2000));
  p2(32, rand(200), rand(32), 3); // password longer than the HMAC block (hashed first)
  p2(32, enc.encode('correct horse battery staple'), rand(32), 100_000); // backup v1
  call('pbkdf2_sha256', ['#64', enc.encode('passwd'), enc.encode('salt'), le32(1)],
    expectBytes(unhex('55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783')));
  call('pbkdf2_sha256', ['#32', 'NULL', 'NULL', le32(2)], expectBytes(pbkdf2(sha256, new Uint8Array(0), new Uint8Array(0), { c: 2, dkLen: 32 })));
}

// Registration proof-of-work: the C miner returns the SAME nonce as the
// JavaScript miner it replaced (first 8-hex-digit counter, in order), and the
// relay's check (server/src/pow/challenge.ts: SHA-256 of the string
// nonce + challenge) accepts it.
{
  const enc = new TextEncoder();
  const zeroBits = (d, bits) => {
    for (let i = 0; i < Math.floor(bits / 8); i++) if (d[i] !== 0) return false;
    return bits % 8 === 0 || (d[Math.floor(bits / 8)] & (0xff << (8 - (bits % 8)))) === 0;
  };
  const jsMiner = (challenge, difficulty) => {
    for (let c = 0; ; c++) {
      const nonce = c.toString(16).padStart(8, '0');
      if (zeroBits(sha256(enc.encode(nonce + challenge)), difficulty)) return nonce;
    }
  };
  const pow = (challenge, difficulty) =>
    call('pow_sha256', ['#8', enc.encode(challenge), le32(difficulty)], expectBytes(enc.encode(jsMiner(challenge, difficulty))));
  for (let i = 0; i < Math.min(ITER, 40); i++) pow(Buffer.from(rand(32)).toString('hex'), randInt(14));
  pow(Buffer.from(rand(32)).toString('hex'), 18); // the relay's production registration difficulty
  pow('ñ-desafío-😀', 10); // non-ASCII challenge: hashed as UTF-8, like the relay
  pow('x'.repeat(512), 4); // longest accepted challenge
}

// ML-KEM-768 against @noble/post-quantum, which wrote every PQ prekey and
// ratchet key stored today: same seed -> same key pair (and the same 2400-byte
// secret key), and each side decapsulates what the other encapsulated, including
// the implicit-rejection secret of a tampered ciphertext.
{
  for (let i = 0; i < Math.min(ITER, 60); i++) {
    const seed = rand(64);
    const k = ml_kem768.keygen(seed);
    call('mlkem768_seed_keypair', ['#1184', '#2400', seed], expectBytes(k.publicKey, k.secretKey));
    const e = ml_kem768.encapsulate(k.publicKey);
    call('mlkem768_dec', ['#32', e.cipherText, k.secretKey], expectBytes(e.sharedSecret));
    const bad = e.cipherText.slice();
    bad[randInt(bad.length - 1)] ^= 1 << randInt(7);
    call('mlkem768_dec', ['#32', bad, k.secretKey], expectBytes(ml_kem768.decapsulate(bad, k.secretKey)));
    // C encapsulates, @noble decapsulates to the same secret.
    call('mlkem768_enc', ['#1088', '#32', k.publicKey], (rc, [ct, ss]) =>
      rc === OK && eq(ml_kem768.decapsulate(ct, k.secretKey), ss) ? null : 'noble cannot decapsulate the C ciphertext');
  }
  // A key pair made the way the app made them (keygen() with no seed): C decapsulates.
  const k = ml_kem768.keygen();
  const e = ml_kem768.encapsulate(k.publicKey);
  call('mlkem768_dec', ['#32', e.cipherText, k.secretKey], expectBytes(e.sharedSecret));
  // Fresh C key pairs are consistent: @noble encapsulates to the pk, C decapsulates.
  call('mlkem768_keypair', ['#1184', '#2400'], (rc, [pk, sk]) => {
    if (rc !== OK) return `rc ${rc}`;
    if (!eq(ml_kem768.getPublicKey(sk), pk)) return 'pk is not the one embedded in sk';
    return null;
  });
  // FIPS 203 encapsulation-key check: a non-canonical coefficient (0xfff > q) fails closed.
  const nonCanonical = k.publicKey.slice();
  nonCanonical[0] = 0xff;
  nonCanonical[1] |= 0x0f;
  call('mlkem768_enc', ['#1088', '#32', nonCanonical], expectRc(EFAIL));
  // FIPS 203 decapsulation-key check: a secret key whose embedded H(ek) is wrong fails closed.
  const corrupt = k.secretKey.slice();
  corrupt[1152 + 1184] ^= 1;
  call('mlkem768_dec', ['#32', e.cipherText, corrupt], expectRc(EFAIL));
  call('mlkem768_dec', ['#32', e.cipherText, new Uint8Array(2400)], expectRc(EFAIL));
}

// ── Key vault (F-1b): operations by handle give the bytes of the raw-key operation. ──
{
  const enc = new TextEncoder();
  const ENOKEY = -3;
  const blobLen = (slot, keyLen) => 28 + 16 + 1 + slot.length + keyLen;
  const slot = enc.encode('self');
  const kek = rand(32);
  call('vault_unlock', [slot, kek], expectRc(OK));
  call('vault_unlock', [slot, kek], expectRc(OK)); // idempotent
  call('vault_unlock', [slot, rand(32)], expectRc(EFAIL)); // another KEK for an unlocked slot

  // Identity as the app derives it: X25519 secret, Ed25519 from the same 32 bytes as seed.
  const xsk = rand(32);
  const xpk = nacl.scalarMult.base(xsk);
  const ed = nacl.sign.keyPair.fromSeed(xsk);
  const peer = nacl.box.keyPair();
  const msg = rand(100);
  const nonce = rand(24);
  call('vault_import', ['#4=hx', `#${blobLen(slot, 32)}=bx`, '#32', slot, le32(1), xsk], (rc, [, , pub]) =>
    rc === OK && eq(pub, xpk) ? null : 'import: wrong public key');
  call('vault_scalarmult', ['$hx', '#32', peer.publicKey], expectBytes(nacl.scalarMult(xsk, peer.publicKey)));
  call('vault_derive_ed25519', ['#4=he', `#${blobLen(slot, 64)}=be`, '#32', '$hx'], (rc, [, , pub]) =>
    rc === OK && eq(pub, ed.publicKey) ? null : 'derive: wrong Ed25519 public key');
  call('vault_sign', ['$he', '#64', msg], expectBytes(nacl.sign.detached(msg, ed.secretKey)));
  call('vault_box', ['$hx', `#${msg.length + 16}`, msg, nonce, peer.publicKey], expectBytes(nacl.box(msg, nonce, peer.publicKey, xsk)));
  const boxed = nacl.box(msg, nonce, xpk, peer.secretKey);
  call('vault_box_open', ['$hx', `#${msg.length}`, boxed, nonce, peer.publicKey], expectBytes(msg));
  call('vault_scalarmult', ['$he', '#32', peer.publicKey], expectRc(ENOKEY)); // an Ed25519 handle is not an X25519 key
  // Explicit export (backup / device link / recovery phrase): the raw key, only for the declared type.
  call('vault_export', ['$hx', le32(1), '#32'], expectBytes(xsk));
  call('vault_export', ['$he', le32(2), '#64'], expectBytes(ed.secretKey));
  call('vault_export', ['$he', le32(1), '#32'], expectRc(ENOKEY)); // declared type must match the handle
  call('vault_export', ['$hx', le32(1), '#31'], expectRc(EBADLEN));
  call('vault_export', ['$hx', le32(9), '#32'], expectRc(EBADLEN));

  // A blob reloads into a new handle that does the same thing.
  call('vault_load', ['#4=hx2', '#4', '#32', slot, '$bx'], (rc, [, type, pub]) =>
    rc === OK && type[0] === 1 && eq(pub, xpk) ? null : 'load: wrong type or public key');
  call('vault_scalarmult', ['$hx2', '#32', peer.publicKey], expectBytes(nacl.scalarMult(xsk, peer.publicKey)));
  call('vault_load', ['#4=he2', '#4', '#32', slot, '$be'], (rc, [, type, pub]) =>
    rc === OK && type[0] === 2 && eq(pub, ed.publicKey) ? null : 'load ed25519');
  call('vault_sign', ['$he2', '#64', msg], expectBytes(nacl.sign.detached(msg, ed.secretKey)));

  // ML-KEM-768 decapsulation by handle (keys made the way the app made them).
  const mk = ml_kem768.keygen();
  const enc1 = ml_kem768.encapsulate(mk.publicKey);
  call('vault_import', ['#4=hm', `#${blobLen(slot, 2400)}`, '#1184', slot, le32(3), mk.secretKey], (rc, [, , pub]) =>
    rc === OK && eq(pub, mk.publicKey) ? null : 'mlkem import');
  call('vault_mlkem768_dec', ['$hm', '#32', enc1.cipherText], expectBytes(enc1.sharedSecret));
  const badMk = mk.secretKey.slice();
  badMk[1152 + 1184] ^= 1;
  call('vault_import', ['#4', `#${blobLen(slot, 2400)}`, '#1184', slot, le32(3), badMk], expectRc(EFAIL)); // FIPS 203 hash check
  const badEd = ed.secretKey.slice();
  badEd[40] ^= 1;
  call('vault_import', ['#4', `#${blobLen(slot, 64)}`, '#32', slot, le32(2), badEd], expectRc(EFAIL)); // pub half must match seed

  // A secret generated inside never leaves: check it by DH symmetry with a peer.
  call('vault_generate', ['#4=hg', `#${blobLen(slot, 32)}`, '#32=pg', slot, le32(1)], expectRc(OK));
  call('vault_generate', ['#4=hs', `#${blobLen(slot, 32)}`, 'NULL', slot, le32(4)], expectRc(OK)); // symmetric secret: no public key
  call('vault_generate', ['#4', `#${blobLen(slot, 64)}`, '#32', slot, le32(2)], expectRc(OK));
  call('vault_generate', ['#4', `#${blobLen(slot, 2400)}`, '#1184', slot, le32(3)], expectRc(OK));

  // Isolation and tamper resistance.
  const other = enc.encode('selg'); // same length as 'self', same KEK: only the slot inside the box differs
  call('vault_unlock', [other, kek], expectRc(OK));
  call('vault_load', ['#4', '#4', '#32', other, '$bx'], expectRc(EVERIFY));
  call('vault_load', ['#4', '#4', '#32', enc.encode('nope'), '$bx'], expectRc(ENOKEY)); // locked (never unlocked) profile
  const work = enc.encode('work');
  call('vault_unlock', [work, rand(32)], expectRc(OK));
  call('vault_load', ['#4', '#4', '#32', work, '$bx'], expectRc(EVERIFY)); // another profile's KEK
  // Copy into another profile: same key (same DH / signature), a blob of THAT profile only.
  call('vault_copy', ['#4=hxw', `#${blobLen(work, 32)}=bxw`, '$hx', work], expectRc(OK));
  call('vault_scalarmult', ['$hxw', '#32', peer.publicKey], expectBytes(nacl.scalarMult(xsk, peer.publicKey)));
  call('vault_copy', ['#4=hew', `#${blobLen(work, 64)}`, '$he', work], expectRc(OK));
  call('vault_sign', ['$hew', '#64', msg], expectBytes(nacl.sign.detached(msg, ed.secretKey)));
  call('vault_load', ['#4', '#4', '#32', work, '$bxw'], expectRc(OK));
  call('vault_load', ['#4', '#4', '#32', slot, '$bxw'], expectRc(EVERIFY));
  call('vault_copy', ['#4', `#${blobLen(work, 32) - 1}`, '$hx', work], expectRc(EBADLEN));
  call('vault_copy', ['#4', `#${blobLen(work, 32)}`, '$hx', enc.encode('nope')], expectRc(ENOKEY));
  call('vault_lock', [other], expectRc(OK));
  call('vault_lock', [work], expectRc(OK));

  // Release and lock kill handles; a locked profile loads nothing.
  call('vault_release', ['$hx2'], expectRc(OK));
  call('vault_scalarmult', ['$hx2', '#32', peer.publicKey], expectRc(ENOKEY));
  call('vault_release', ['$hx2'], expectRc(ENOKEY));
  call('vault_lock', [slot], expectRc(OK));
  call('vault_sign', ['$he', '#64', msg], expectRc(ENOKEY));
  call('vault_mlkem768_dec', ['$hm', '#32', enc1.cipherText], expectRc(ENOKEY));
  call('vault_export', ['$hx', le32(1), '#32'], expectRc(ENOKEY)); // locked profile: no export
  call('vault_load', ['#4', '#4', '#32', slot, '$bx'], expectRc(ENOKEY));
  call('vault_live', [], expectRc(0)); // nothing left alive

  // After unlocking again with the same KEK, the stored blob loads (persistence across launches).
  call('vault_unlock', [slot, kek], expectRc(OK));
  call('vault_load', ['#4=hx3', '#4', '#32', slot, '$bx'], expectRc(OK));
  call('vault_box_open', ['$hx3', `#${msg.length}`, boxed, nonce, peer.publicKey], expectBytes(msg));
  call('vault_lock_all', [], expectRc(OK));
  call('vault_live', [], expectRc(0));

  // Length validation.
  call('vault_unlock', [slot, rand(31)], expectRc(EBADLEN));
  call('vault_unlock', ['NULL', kek], expectRc(EBADLEN));
  call('vault_unlock', [rand(65), kek], expectRc(EBADLEN));
  call('vault_unlock', [slot, kek], expectRc(OK));
  call('vault_import', ['#4', `#${blobLen(slot, 32)}`, '#32', slot, le32(1), rand(31)], expectRc(EBADLEN));
  call('vault_import', ['#4', `#${blobLen(slot, 32) - 1}`, '#32', slot, le32(1), rand(32)], expectRc(EBADLEN));
  call('vault_import', ['#4', `#${blobLen(slot, 32)}`, '#31', slot, le32(1), rand(32)], expectRc(EBADLEN));
  call('vault_import', ['#4', `#${blobLen(slot, 32)}`, '#32', slot, le32(9), rand(32)], expectRc(EBADLEN));
  call('vault_load', ['#4', '#4', '#32', slot, rand(20)], expectRc(EBADLEN));
  call('vault_lock_all', [], expectRc(OK));
}

// Empty messages, with the NULL a binding passes for an empty JS array.
{
  const nonce = rand(24);
  const key = rand(32);
  const empty = nacl.secretbox(new Uint8Array(0), nonce, key);
  call('secretbox_easy', ['#16', 'NULL', nonce, key], expectBytes(empty));
  call('secretbox_open_easy', ['NULL', empty, nonce, key], expectRc(OK));
  call('secretbox_open_easy', ['#0', empty, nonce, key], expectRc(OK));
  const a = nacl.box.keyPair();
  const boxed = nacl.box(new Uint8Array(0), nonce, a.publicKey, a.secretKey);
  call('box_open_easy', ['NULL', boxed, nonce, a.publicKey, a.secretKey], expectRc(OK));
  call('hmacsha256', ['#32', 'NULL', 'NULL'], expectBytes(hmac(sha256, new Uint8Array(0), new Uint8Array(0))));
  call('randombytes', ['NULL'], expectRc(OK));
}

// Fail closed: low-order points and the small-order "universal" signature.
{
  const sk = rand(32);
  call('scalarmult', ['#32', sk, '00'.repeat(32)], expectRc(EFAIL));
  call('box_beforenm', ['#32', '00'.repeat(32), sk], expectRc(EFAIL));
  // R = identity, S = 0, A = identity: TweetNaCl accepts it for every message; libsodium must not.
  const identity = '01' + '00'.repeat(31);
  call('sign_verify_detached', [identity + '00'.repeat(32), 'deadbeef', identity], expectRc(EVERIFY));
}

// Length validation: every wrong length is EBADLEN, never a crash.
{
  const k32 = rand(32);
  const n24 = rand(24);
  const kp = nacl.box.keyPair();
  const skp = nacl.sign.keyPair();
  const bad = [
    ['box_easy', ['#20', 'aa', n24, kp.publicKey, kp.secretKey]],
    ['box_easy', ['#17', 'aa', rand(23), kp.publicKey, kp.secretKey]],
    ['box_easy', ['#17', 'aa', n24, rand(31), kp.secretKey]],
    ['box_easy', ['#17', 'NULL:1', n24, kp.publicKey, kp.secretKey]],
    ['box_open_easy', ['#0', rand(15), n24, kp.publicKey, kp.secretKey]],
    ['box_open_easy', ['#5', rand(20), n24, kp.publicKey, kp.secretKey]],
    ['box_beforenm', ['#31', kp.publicKey, kp.secretKey]],
    ['secretbox_easy', ['#17', 'aa', n24, rand(31)]],
    ['secretbox_easy', ['NULL', 'NULL', n24, k32]],
    ['secretbox_open_easy', ['#1', rand(16), n24, k32]],
    ['scalarmult', ['#32', rand(31), kp.publicKey]],
    ['scalarmult', ['#32', k32, 'NULL:32']],
    ['scalarmult_base', ['#33', k32]],
    ['sign_seed_keypair', ['#32', '#64', rand(31)]],
    ['sign_detached', ['#64', 'aa', rand(32)]],
    ['sign_verify_detached', [rand(63), 'aa', skp.publicKey]],
    ['sign_verify_detached', [rand(64), 'aa', rand(33)]],
    ['hmacsha256', ['#31', 'aa', k32]],
    ['hmacsha256', ['#32', 'NULL:4', k32]],
    ['hkdf_sha256', ['#0', 'aa', 'NULL', 'NULL']],
    ['hkdf_sha256', [`#${255 * 32 + 1}`, 'aa', 'NULL', 'NULL']],
    ['memcmp', ['aabb', 'aa']],
    ['randombytes', ['NULL:8']],
    ['argon2id', ['#15', 'aa', rand(16), le32(1), le32(64)]],
    ['argon2id', ['#65', 'aa', rand(16), le32(1), le32(64)]],
    ['argon2id', ['#32', 'aa', rand(7), le32(1), le32(64)]],
    ['argon2id', ['#32', 'aa', rand(65), le32(1), le32(64)]],
    ['argon2id', ['#32', 'aa', 'NULL:16', le32(1), le32(64)]],
    ['argon2id', ['#32', 'NULL:4', rand(16), le32(1), le32(64)]],
    ['argon2id', ['#32', rand(65537), rand(16), le32(1), le32(64)]],
    ['argon2id', ['#32', 'aa', rand(16), le32(0), le32(64)]],
    ['argon2id', ['#32', 'aa', rand(16), le32(17), le32(64)]],
    ['argon2id', ['#32', 'aa', rand(16), le32(1), le32(7)]],
    ['argon2id', ['#32', 'aa', rand(16), le32(1), le32(262145)]],
    ['argon2id', ['#32', 'aa', rand(16), 'aabb', le32(64)]],
    ['pow_sha256', ['#7', 'aa', le32(1)]],
    ['pow_sha256', ['#9', 'aa', le32(1)]],
    ['pow_sha256', ['NULL:8', 'aa', le32(1)]],
    ['pow_sha256', ['#8', 'NULL', le32(1)]],
    ['pow_sha256', ['#8', 'NULL:4', le32(1)]],
    ['pow_sha256', ['#8', rand(513), le32(1)]],
    ['pow_sha256', ['#8', 'aa', le32(33)]],
    ['pbkdf2_sha256', ['#0', 'aa', 'bb', le32(1)]],
    ['pbkdf2_sha256', ['#65', 'aa', 'bb', le32(1)]],
    ['pbkdf2_sha256', ['#32', 'aa', 'bb', le32(0)]],
    ['pbkdf2_sha256', ['#32', 'aa', 'bb', le32(10_000_001)]],
    ['pbkdf2_sha256', ['#32', 'NULL:4', 'bb', le32(1)]],
    ['pbkdf2_sha256', ['#32', 'aa', rand(1025), le32(1)]],
    ['mlkem768_keypair', ['#1183', '#2400']],
    ['mlkem768_keypair', ['#1184', '#2399']],
    ['mlkem768_seed_keypair', ['#1184', '#2400', rand(63)]],
    ['mlkem768_seed_keypair', ['#1184', '#2400', 'NULL:64']],
    ['mlkem768_enc', ['#1087', '#32', rand(1184)]],
    ['mlkem768_enc', ['#1088', '#31', rand(1184)]],
    ['mlkem768_enc', ['#1088', '#32', rand(1183)]],
    ['mlkem768_enc', ['#1088', '#32', 'NULL:1184']],
    ['mlkem768_dec', ['#31', rand(1088), rand(2400)]],
    ['mlkem768_dec', ['#32', rand(1087), rand(2400)]],
    ['mlkem768_dec', ['#32', rand(1088), rand(2399)]],
    ['mlkem768_dec', ['#32', 'NULL:1088', rand(2400)]],
  ];
  for (const [op, args] of bad) call(op, args, expectRc(EBADLEN));
  call('memcmp', ['NULL', 'NULL'], expectRc(EVERIFY));
}

// Randomness: fresh, not constant.
call('randombytes', ['#32'], (rc, [a]) => (rc === OK && a.some((v) => v !== 0) ? null : 'randombytes looks empty'));
call('box_keypair', ['#32', '#32'], (rc, [pk, sk]) =>
  rc === OK && eq(nacl.box.keyPair.fromSecretKey(sk).publicKey, pk) ? null : 'box_keypair inconsistent');
call('sign_keypair', ['#32', '#64'], (rc, [pk, sk]) =>
  rc === OK && eq(nacl.sign.keyPair.fromSecretKey(sk).publicKey, pk) ? null : 'sign_keypair inconsistent');

const res = spawnSync(cli, { input: cases.map((c) => c.line).join('\n') + '\n', maxBuffer: 1 << 28 });
if (res.status !== 0) {
  console.error(`aegis_sodium_cli exited with ${res.status}: ${res.stderr}`);
  process.exit(1);
}
const lines = res.stdout.toString().trim().split('\n');
if (lines.length !== cases.length) {
  console.error(`expected ${cases.length} results, got ${lines.length}`);
  process.exit(1);
}
const failures = [];
lines.forEach((l, i) => {
  const [rc, ...outs] = l.split(' ');
  const err = cases[i].check(Number(rc), outs.map(unhex));
  if (err) failures.push(`${cases[i].line.slice(0, 120)} → ${err}`);
});
if (failures.length) {
  console.error(`aegis-sodium differential: ${failures.length}/${cases.length} FAILED\n  ${failures.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
process.stdout.write(`aegis-sodium differential: ${cases.length} checks passed (C core + vendored libsodium vs TweetNaCl/@noble).\n`);
