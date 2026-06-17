// Decisive server test: does the production relay STORE + SERVE a pqSignedPreKey?
// Registers a throwaway identity, uploads prekeys WITH a pqSpk, then fetches the
// bundle and reports whether pqSignedPreKey comes back.
//
// Run from mobile/:  node scripts/test-pq-bundle.mjs
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { encodeBase64 } = naclUtil;
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

const BASE = process.env.RELAY || 'https://aegislink.duckdns.org';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes, charsOut) {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const totalBits = BigInt(bytes.length * 8);
  const needed = BigInt(charsOut * 5);
  if (totalBits > needed) bits = bits >> (totalBits - needed);
  else if (totalBits < needed) bits = bits << (needed - totalBits);
  let out = '';
  for (let i = charsOut - 1; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 0x1fn)];
  return out;
}
function deriveAegisId(pub) {
  const raw = encodeBase32(pub.slice(0, 7), 11);
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 11)}`;
}
function leadingZeroBits(digest, bits) {
  const full = Math.floor(bits / 8), rem = bits % 8;
  for (let i = 0; i < full; i++) if (digest[i] !== 0) return false;
  if (rem === 0) return true;
  return (digest[full] & (0xff << (8 - rem))) === 0;
}
function solvePoW(challenge, difficulty) {
  const cb = utf8ToBytes(challenge);
  for (let counter = 0; ; counter++) {
    const nb = utf8ToBytes(counter.toString(16));
    const input = new Uint8Array(nb.length + cb.length);
    input.set(nb, 0); input.set(cb, nb.length);
    if (leadingZeroBits(sha256(input), difficulty)) return counter.toString(16);
  }
}

const box = nacl.box.keyPair();
const sign = nacl.sign.keyPair();
const aegisId = deriveAegisId(box.publicKey);
const publicKeyB64 = encodeBase64(box.publicKey);
const signingPublicKeyB64 = encodeBase64(sign.publicKey);
console.log('aegisId:', aegisId);

// 1) PoW
const chalRes = await fetch(`${BASE}/identity/challenge`);
const { challenge, difficulty } = await chalRes.json();
console.log('challenge difficulty:', difficulty);
const powNonce = solvePoW(challenge, difficulty);

// 2) POST /identity
const idRes = await fetch(`${BASE}/identity`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aegisId, publicKey: publicKeyB64, signingPublicKey: signingPublicKeyB64, powChallenge: challenge, powNonce }),
});
console.log('POST /identity ->', idRes.status, (await idRes.text()).slice(0, 120));
if (idRes.status !== 201 && idRes.status !== 200) process.exit(1);

// 3) Build prekeys WITH pqSignedPreKey
const spk = nacl.box.keyPair();
const spkSig = nacl.sign.detached(spk.publicKey, sign.secretKey);
const pq = ml_kem768.keygen();
const pqSig = nacl.sign.detached(pq.publicKey, sign.secretKey);
const opk = nacl.box.keyPair();

const ts = Date.now();
const timeBucket = Math.floor(ts / 30000);
const sig = encodeBase64(nacl.sign.detached(utf8ToBytes(`${aegisId}:prekeys:${timeBucket}`), sign.secretKey));

const prekeysBody = {
  aegisId, sig, ts,
  signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(spkSig) },
  oneTimePreKeys: [{ keyId: 1, publicKeyB64: encodeBase64(opk.publicKey) }],
  pqSignedPreKey: { keyId: 1, publicKeyB64: encodeBase64(pq.publicKey), signatureB64: encodeBase64(pqSig) },
};
const pkRes = await fetch(`${BASE}/prekeys`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(prekeysBody),
});
console.log('POST /prekeys ->', pkRes.status, (await pkRes.text()).slice(0, 160));

// 4) GET bundle and inspect
const bRes = await fetch(`${BASE}/prekeys/bundle/${aegisId}`);
const bundle = await bRes.json();
const b = bundle.bundle || (bundle.bundles && bundle.bundles[0]) || {};
console.log('\n=== BUNDLE keys:', Object.keys(b));
console.log('=== pqSignedPreKey served:', JSON.stringify(b.pqSignedPreKey));
console.log(b.pqSignedPreKey ? '\n>>> SERVER OK: stores+serves PQSPK (client is the bug)' : '\n>>> SERVER OLD: pqSpk NOT served (relay deploy gap is the root cause)');
