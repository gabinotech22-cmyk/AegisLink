#!/usr/bin/env node
/**
 * Differential test of the aegis_sodium C core compiled with the vendored
 * libsodium (F-1 B2) against the JavaScript implementations the app used
 * before (TweetNaCl, @noble/hashes): identical bytes on random inputs and on
 * RFC vectors, plus the C core's own contract (length validation, NULL
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
const { hmac } = require('@noble/hashes/hmac');
const { hkdf } = require('@noble/hashes/hkdf');
const { sha256 } = require('@noble/hashes/sha2');

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
