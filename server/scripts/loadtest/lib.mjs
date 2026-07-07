/**
 * loadtest/lib.mjs — shared helpers for the AegisLink relay load-test harness.
 *
 * Extracted from the original single-file scripts/loadtest.mjs so every scenario
 * (messaging, offline-drain, reconnect-storm, …) reuses the SAME real protocol
 * path: PoW registration → NaCl challenge-response socket auth → sealed
 * envelopes. Nothing here is scenario-specific; scenarios live in ./scenarios/.
 *
 * LOCAL TARGETS ONLY by default. Pointing at production is refused unless the
 * caller passes --i-understand-this-is-prod (pre-launch window only). See guardUrl().
 */

import { io } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash, randomBytes } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const { encodeBase64, decodeBase64 } = naclUtil;

// ── CLI args ──────────────────────────────────────────────────────────────────
export function makeArgReader(argv = process.argv.slice(2)) {
  return (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
}

export function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

// ── Production guard ────────────────────────────────────────────────────────
// The harness spoofs X-Forwarded-For to give every virtual client its own IP
// for the registration rate limiter. That only works against a directly-exposed
// server OR behind a proxy with `trust proxy > 0` (prod runs TRUST_PROXY=1 after
// PR #269, so XFF spoofing DOES reach the real per-IP buckets). Even so, running
// real load against prod is a deliberate, loud act — never a silent default.
const PROD_HOST_RE = /aegislink\.duckdns\.org|aegis-link\.it|aegis\.link/;

export function guardUrl(url, allowProd) {
  if (PROD_HOST_RE.test(url)) {
    if (!allowProd) {
      console.error(
        `\nRefusing to run against a production host (${url}).\n` +
        `If this is the pre-launch window and you REALLY mean it, re-run with ` +
        `--i-understand-this-is-prod\n`
      );
      process.exit(1);
    }
    console.warn(
      '\n' +
      '╔══════════════════════════════════════════════════════════════════════╗\n' +
      '║  ⚠  RUNNING LOAD AGAINST A PRODUCTION HOST                            ║\n' +
      `║     ${url.padEnd(64)}║\n` +
      '║     This registers real identities and drives real traffic. Only do  ║\n' +
      '║     this pre-launch. Watch `pm2 monit` on the box.                    ║\n' +
      '╚══════════════════════════════════════════════════════════════════════╝\n'
    );
  }
}

// ── Identity / PoW helpers ──────────────────────────────────────────────────
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // matches AEGIS_ID_RE

export function randomAegisId() {
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

export function solvePoW(challenge, difficulty) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(16);
    const digest = createHash('sha256').update(nonce + challenge).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return nonce;
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function fmt(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return `p50 ${percentile(s, 50).toFixed(1)}ms · p95 ${percentile(s, 95).toFixed(1)}ms · p99 ${percentile(s, 99).toFixed(1)}ms · max ${(s[s.length - 1] ?? NaN).toFixed(1)}ms`;
}

// ── Event-loop lag sampler ───────────────────────────────────────────────────
// Measures how starved THIS harness's own event loop is while it drives load —
// a proxy for whether the client is the bottleneck. Server-side event-loop lag
// (the interesting one, since prod SQLite is synchronous) must be read on the box
// via `pm2 monit` / process metrics; note this in every report.
export function startEventLoopMonitor() {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  return {
    stop() {
      h.disable();
      return {
        meanMs: h.mean / 1e6,
        p99Ms: h.percentile(99) / 1e6,
        maxMs: h.max / 1e6,
      };
    },
  };
}

// ── Client factory ───────────────────────────────────────────────────────────
// Each virtual client gets its own box + signing keypair and a distinct fake IP
// so the per-IP registration limiter treats it as a unique client.
export function makeClients(count) {
  return Array.from({ length: count }, (_, i) => ({
    aegisId: randomAegisId(),
    box: nacl.box.keyPair(),
    sign: nacl.sign.keyPair(),
    socket: null,
    fakeIp: `10.${(i >> 8) & 255}.${i & 255}.7`,
  }));
}

// ── Registration (HTTP: PoW challenge → identity POST) ───────────────────────
export async function registerIdentity(baseUrl, client, fakeIp) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp };
  const chRes = await fetch(`${baseUrl}/identity/challenge`, { headers });
  if (!chRes.ok) throw new Error(`challenge HTTP ${chRes.status}`);
  const { challenge, difficulty } = await chRes.json();
  const nonce = solvePoW(challenge, difficulty);
  const res = await fetch(`${baseUrl}/identity`, {
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

// Register `clients` in batches to keep PoW CPU bursts civil. Returns errors[].
export async function registerAll(baseUrl, clients, { batch = 10 } = {}) {
  const errors = [];
  for (let i = 0; i < clients.length; i += batch) {
    await Promise.all(
      clients.slice(i, i + batch).map((c) =>
        registerIdentity(baseUrl, c, c.fakeIp).catch((e) =>
          errors.push(`register ${c.aegisId}: ${e.message}`)
        )
      )
    );
  }
  return errors;
}

// ── Connect + challenge-response auth ────────────────────────────────────────
// Resolves with the connected socket and pushes the auth latency into authMs[].
// A per-client deviceId keeps the server's per-device drain accounting correct.
export function connectAndAuth(baseUrl, client, authMs, { timeoutMs = 15_000, onEnvelope } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const socket = io(baseUrl, {
      transports: ['websocket'],
      auth: { aegisId: client.aegisId, platform: 'android', deviceId: client.aegisId },
      reconnection: false,
      timeout: 10_000,
    });
    // The offline queue drains (emits every queued `envelope`/`envelope:v2`)
    // BEFORE the server emits `auth:ok`. To count drained messages the listener
    // MUST be attached at socket-creation time, not after auth resolves —
    // otherwise the drain burst arrives with no listener and is lost.
    if (onEnvelope) {
      socket.on('envelope', (env) => onEnvelope(env, 'v1'));
      socket.on('envelope:v2', (env) => onEnvelope(env, 'v2'));
    }
    const fail = (why) => { socket.disconnect(); reject(new Error(why)); };
    const guard = setTimeout(() => fail(`auth timeout (${client.aegisId})`), timeoutMs);

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
      authMs.push(performance.now() - t0);
      client.socket = socket;
      resolve(socket);
    });
    socket.on('error_msg', (e) => fail(`error_msg: ${e?.code}`));
    socket.on('connect_error', (e) => fail(`connect_error: ${e.message}`));
  });
}

export { encodeBase64, decodeBase64 };
