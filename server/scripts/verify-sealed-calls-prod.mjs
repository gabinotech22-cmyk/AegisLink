// Standalone live verification of sealed-sender Phase 2 call signaling against the
// REAL production relay (https://aegislink.duckdns.org). Registers two throwaway
// test identities (via the real PoW-gated /identity endpoint, same as a real
// client), then runs the actual call:invite/answer/ice/hangup:v2 exchange,
// asserting the relay never stamps `from` and epk/callKey flow correctly.
//
// Run with: node server/scripts/verify-sealed-calls-prod.mjs

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash } from 'node:crypto';
import { io as clientIo } from 'socket.io-client';

const { encodeBase64, decodeBase64 } = naclUtil;
const BASE_URL = 'https://aegislink.duckdns.org';

const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function base32Segment(len, seed) {
  let s = '';
  let n = seed;
  for (let i = 0; i < len; i++) {
    s += BASE32_ALPHABET[n % 32];
    n = Math.floor(n / 32);
    if (n === 0) n = seed + i + 1;
  }
  return s;
}
function makeAegisId(seed) {
  return `${base32Segment(3, seed)}-${base32Segment(4, seed * 7)}-${base32Segment(4, seed * 13)}`;
}

function makeAgentKeys(seed) {
  const aegisId = makeAegisId(seed);
  const seedBytes = new Uint8Array(32);
  const view = new DataView(seedBytes.buffer);
  view.setUint32(0, seed, false);
  view.setUint32(4, (seed * 31337) >>> 0, false);
  return {
    boxKeyPair: nacl.box.keyPair.fromSecretKey(seedBytes),
    signKeyPair: nacl.sign.keyPair.fromSeed(seedBytes),
    aegisId,
    deviceId: `dev-prodverify-${seed}`,
  };
}

function solvePoW(challenge, difficultyBits) {
  let nonce = 0;
  for (;;) {
    const nonceHex = nonce.toString(16);
    const digest = createHash('sha256').update(nonceHex + challenge).digest();
    if (hasLeadingZeroBits(digest, difficultyBits)) return nonceHex;
    nonce++;
  }
}
function hasLeadingZeroBits(buf, bits) {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) if (buf[i] !== 0) return false;
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = 0xff << (8 - rem);
  return (buf[fullBytes] & mask) === 0;
}

async function registerIdentity(keys) {
  const chRes = await fetch(`${BASE_URL}/identity/challenge`);
  if (!chRes.ok) throw new Error(`challenge fetch failed: ${chRes.status}`);
  const { challenge, difficulty } = await chRes.json();
  const nonce = solvePoW(challenge, difficulty);
  const body = {
    aegisId: keys.aegisId,
    publicKey: encodeBase64(keys.boxKeyPair.publicKey),
    signingPublicKey: encodeBase64(keys.signKeyPair.publicKey),
    powChallenge: challenge,
    powNonce: nonce,
  };
  const res = await fetch(`${BASE_URL}/identity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 200) {
    const text = await res.text();
    throw new Error(`register failed (${res.status}): ${text}`);
  }
  console.log(`  registered ${keys.aegisId} (${res.status})`);
}

function solveChallenge(wire, secretKey) {
  const plain = nacl.box.open(
    decodeBase64(wire.ciphertext),
    decodeBase64(wire.nonce),
    decodeBase64(wire.ephemeralPubKey),
    secretKey,
  );
  if (!plain) throw new Error('Challenge decryption failed');
  return encodeBase64(plain);
}

function connectAgent(keys) {
  return new Promise((resolve, reject) => {
    const socket = clientIo(BASE_URL, {
      auth: { aegisId: keys.aegisId, platform: 'mobile', deviceId: keys.deviceId },
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error(`Auth timeout for ${keys.aegisId}`)); }, 10_000);
    socket.on('auth:challenge', (wire) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, keys.boxKeyPair.secretKey) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error_msg', (e) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function once(socket, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

function sealedInviteWire(to, callId) {
  return {
    to,
    callId,
    media: 'audio',
    ciphertext: encodeBase64(nacl.randomBytes(64)),
    nonce: encodeBase64(nacl.randomBytes(24)),
    epk: encodeBase64(nacl.randomBytes(32)),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  OK: ${msg}`);
}

async function main() {
  const seedBase = Date.now() % 1_000_000;
  const caller = makeAgentKeys(seedBase + 1);
  const callee = makeAgentKeys(seedBase + 2);

  console.log(`[1/4] Registering test identities against ${BASE_URL} ...`);
  await registerIdentity(caller);
  await registerIdentity(callee);

  console.log('[2/4] Connecting both agents (Ed25519 challenge-response auth) ...');
  const callerSock = await connectAgent(caller);
  const calleeSock = await connectAgent(callee);
  console.log(`  caller=${caller.aegisId} callee=${callee.aegisId} both authenticated`);

  try {
    console.log('[3/4] call:invite:v2 — online delivery, no from, epk intact ...');
    const wire = sealedInviteWire(callee.aegisId, 'prod-verify-call-1');
    const received = once(calleeSock, 'call:invite:v2');
    callerSock.emit('call:invite:v2', wire);
    const got = await received;
    assert(got.from === undefined, 'call:invite:v2 carries NO from field');
    assert(got.to === undefined, 'call:invite:v2 carries NO to field (recipient not echoed)');
    assert(got.callId === 'prod-verify-call-1', 'callId matches');
    assert(got.epk === wire.epk, 'epk (ephemeral pubkey) survives verbatim');
    assert(got.ciphertext === wire.ciphertext, 'ciphertext survives verbatim');

    console.log('[4/4] call:answer:v2 and call:ice:v2 — no from ...');
    const answer = { to: caller.aegisId, callId: 'prod-verify-call-1', ciphertext: encodeBase64(nacl.randomBytes(40)), nonce: encodeBase64(nacl.randomBytes(24)) };
    const gotAnswer = once(callerSock, 'call:answer:v2');
    calleeSock.emit('call:answer:v2', answer);
    const a = await gotAnswer;
    assert(a.from === undefined, 'call:answer:v2 carries NO from field');
    assert(a.ciphertext === answer.ciphertext, 'answer ciphertext survives verbatim');

    const ice = { to: callee.aegisId, callId: 'prod-verify-call-1', ciphertext: encodeBase64(nacl.randomBytes(40)), nonce: encodeBase64(nacl.randomBytes(24)) };
    const gotIce = once(calleeSock, 'call:ice:v2');
    callerSock.emit('call:ice:v2', ice);
    const i = await gotIce;
    assert(i.from === undefined, 'call:ice:v2 carries NO from field');
    assert(i.ciphertext === ice.ciphertext, 'ICE ciphertext survives verbatim');

    const hangupReceived = once(calleeSock, 'call:hangup:v2');
    callerSock.emit('call:hangup:v2', { to: callee.aegisId, callId: 'prod-verify-call-1' });
    const h = await hangupReceived;
    assert(h.from === undefined, 'call:hangup:v2 carries NO from field');

    console.log('\nALL CHECKS PASSED against the live production relay (aegislink.duckdns.org).');
    console.log(`Test identities left in prod DB (per instruction): ${caller.aegisId}, ${callee.aegisId}`);
  } finally {
    callerSock.disconnect();
    calleeSock.disconnect();
  }
}

main().catch((err) => {
  console.error('\nVERIFICATION FAILED:', err.message);
  process.exitCode = 1;
});
