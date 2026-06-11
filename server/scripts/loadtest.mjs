#!/usr/bin/env node
/**
 * loadtest.mjs — AegisLink relay load test. LOCAL TARGETS ONLY.
 *
 * Exercises the full real protocol: PoW registration, NaCl challenge-response
 * socket auth, then paired senders/receivers exchanging sealed envelopes while
 * we measure ack and end-to-end delivery latency.
 *
 * Usage (from server/):
 *   node scripts/loadtest.mjs [--url http://127.0.0.1:3101] [--clients 50] [--msgs 15]
 *
 * NEVER point this at production:
 *  - the registration limiter is bypassed via X-Forwarded-For spoofing, which
 *    only works against a directly-exposed server (behind nginx the trusted
 *    proxy hop overwrites the client IP — see TRUST_PROXY in index.ts);
 *  - --msgs must stay ≤ 20 (the per-socket envelope burst); beyond that you
 *    are measuring the rate limiter, not the relay.
 */

import { io } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash, randomUUID, randomBytes } from 'node:crypto';

const { encodeBase64, decodeBase64 } = naclUtil;

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const BASE_URL = arg('url', 'http://127.0.0.1:3101');
const CLIENTS = Number(arg('clients', '50')); // must be even (sender/receiver pairs)
const MSGS = Math.min(Number(arg('msgs', '15')), 20);
const PAYLOAD_BYTES = Number(arg('payload', '1024'));

if (/aegislink\.duckdns\.org|aegis-link\.it/.test(BASE_URL)) {
  console.error('Refusing to run against production. Local targets only.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // matches AEGIS_ID_RE
function randomAegisId() {
  const pick = (n) =>
    Array.from(randomBytes(n)).map((b) => ID_ALPHABET[b % 32]).join('');
  return `${pick(3)}-${pick(4)}-${pick(4)}`;
}

function hasLeadingZeroBits(buf, bits) {
  let remaining = bits;
  for (const byte of buf) {
    if (remaining <= 0) return true;
    const check = remaining >= 8 ? 8 : remaining;
    if (byte >> (8 - check) !== 0) return false;
    remaining -= 8;
  }
  return remaining <= 0;
}

function solvePoW(challenge, difficulty) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(16);
    const digest = createHash('sha256').update(nonce + challenge).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return nonce;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ── Client lifecycle ──────────────────────────────────────────────────────────
async function registerIdentity(client, fakeIp) {
  // Spoofed XFF gives every virtual client its own IP for the rate limiters.
  // Works only against a direct dev server — see header comment.
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp };

  const chRes = await fetch(`${BASE_URL}/identity/challenge`, { headers });
  if (!chRes.ok) throw new Error(`challenge HTTP ${chRes.status}`);
  const { challenge, difficulty } = await chRes.json();

  const nonce = solvePoW(challenge, difficulty);
  const res = await fetch(`${BASE_URL}/identity`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      aegisId: client.aegisId,
      publicKey: encodeBase64(client.box.publicKey),
      signingPublicKey: encodeBase64(client.sign.publicKey),
      powChallenge: challenge,
      powNonce: nonce,
    }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register HTTP ${res.status}: ${await res.text()}`);
  }
}

function connectAndAuth(client, timings) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const socket = io(BASE_URL, {
      transports: ['websocket'],
      auth: { aegisId: client.aegisId, platform: 'android' },
      reconnection: false,
      timeout: 10_000,
    });
    const fail = (why) => { socket.disconnect(); reject(new Error(why)); };
    const guard = setTimeout(() => fail(`auth timeout (${client.aegisId})`), 15_000);

    socket.on('auth:challenge', (wire) => {
      const plain = nacl.box.open(
        decodeBase64(wire.ciphertext),
        decodeBase64(wire.nonce),
        decodeBase64(wire.ephemeralPubKey),
        client.box.secretKey,
      );
      if (!plain) return fail('challenge box.open failed');
      socket.emit('auth:response', { plain: encodeBase64(plain) });
    });
    socket.on('auth:ok', () => {
      clearTimeout(guard);
      timings.authMs.push(performance.now() - t0);
      client.socket = socket;
      resolve(socket);
    });
    socket.on('error_msg', (e) => fail(`error_msg: ${e?.code}`));
    socket.on('connect_error', (e) => fail(`connect_error: ${e.message}`));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
const pairs = Math.floor(CLIENTS / 2);
console.log(`AegisLink loadtest → ${BASE_URL}`);
console.log(`${CLIENTS} clients (${pairs} pairs), ${MSGS} msgs/sender, ${PAYLOAD_BYTES} B payloads\n`);

const clients = Array.from({ length: pairs * 2 }, (_, i) => ({
  aegisId: randomAegisId(),
  box: nacl.box.keyPair(),
  sign: nacl.sign.keyPair(),
  socket: null,
  fakeIp: `10.${(i >> 8) & 255}.${i & 255}.7`,
}));

const timings = { authMs: [], ackMs: [], deliverMs: [] };
const errors = [];
let rateLimited = 0;

// Phase 1: register (batches of 10 to keep PoW CPU bursts civil)
let tPhase = performance.now();
for (let i = 0; i < clients.length; i += 10) {
  await Promise.all(
    clients.slice(i, i + 10).map((c) =>
      registerIdentity(c, c.fakeIp).catch((e) => errors.push(`register ${c.aegisId}: ${e.message}`)),
    ),
  );
}
const registerSecs = (performance.now() - tPhase) / 1000;
console.log(`Phase 1 — registered ${clients.length - errors.length}/${clients.length} identities in ${registerSecs.toFixed(1)}s (PoW included)`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

// Phase 2: connect + authenticate everyone
tPhase = performance.now();
await Promise.all(
  clients.map((c) => connectAndAuth(c, timings).catch((e) => errors.push(e.message))),
);
const connectSecs = (performance.now() - tPhase) / 1000;
console.log(`Phase 2 — ${timings.authMs.length}/${clients.length} sockets authenticated in ${connectSecs.toFixed(1)}s`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

// Phase 3: paired messaging. Even index = sender, odd = its receiver.
const sentAt = new Map(); // envelope id -> hrtime ms
let delivered = 0;
const expected = pairs * MSGS;

for (let i = 0; i < clients.length; i += 2) {
  clients[i + 1].socket.on('envelope', (env) => {
    const t = sentAt.get(env.id);
    if (t !== undefined) {
      timings.deliverMs.push(performance.now() - t);
      delivered++;
    }
  });
}

tPhase = performance.now();
await Promise.all(
  clients.filter((_, i) => i % 2 === 0).map(async (sender, idx) => {
    const receiver = clients[idx * 2 + 1];
    for (let m = 0; m < MSGS; m++) {
      const id = randomUUID();
      const t0 = performance.now();
      sentAt.set(id, t0);
      await new Promise((resolve) => {
        sender.socket.emit(
          'envelope',
          {
            id,
            to: receiver.aegisId,
            ciphertext: encodeBase64(randomBytes(PAYLOAD_BYTES)),
            nonce: encodeBase64(randomBytes(24)),
          },
          (ack) => {
            if (ack?.ok) timings.ackMs.push(performance.now() - t0);
            else if (ack?.error === 'rate_limited') rateLimited++;
            else errors.push(`ack error: ${ack?.error}`);
            resolve();
          },
        );
      });
    }
  }),
);

// Drain: wait up to 10 s for any in-flight deliveries
const drainDeadline = Date.now() + 10_000;
while (delivered < expected - rateLimited && Date.now() < drainDeadline) {
  await new Promise((r) => setTimeout(r, 200));
}
const sendSecs = (performance.now() - tPhase) / 1000;

for (const c of clients) c.socket?.disconnect();

// ── Report ────────────────────────────────────────────────────────────────────
const fmt = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return `p50 ${percentile(s, 50).toFixed(1)}ms · p95 ${percentile(s, 95).toFixed(1)}ms · p99 ${percentile(s, 99).toFixed(1)}ms · max ${s[s.length - 1]?.toFixed(1)}ms`;
};

console.log(`Phase 3 — ${timings.ackMs.length} acks, ${delivered}/${expected} delivered in ${sendSecs.toFixed(1)}s (${(delivered / sendSecs).toFixed(0)} msg/s end-to-end)`);
console.log('\n══ RESULTS ═══════════════════════════════════');
console.log(`auth        ${fmt(timings.authMs)}`);
console.log(`send→ack    ${fmt(timings.ackMs)}`);
console.log(`send→deliver ${fmt(timings.deliverMs)}`);
console.log(`rate-limited acks: ${rateLimited}`);
console.log(`errors: ${errors.length}${errors.length ? '\n' + errors.slice(0, 10).join('\n') : ''}`);
process.exit(errors.length || delivered + rateLimited < expected ? 1 : 0);
