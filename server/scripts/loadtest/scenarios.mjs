/**
 * loadtest/scenarios.mjs — individual load scenarios.
 *
 * Each scenario drives one critical relay path and returns a small result object
 * the runner prints. All reuse the real protocol helpers in ./lib.mjs.
 *
 * Implemented:
 *   messaging       1:1 sealed messaging (ack + end-to-end delivery latency)
 *   offline-drain   send to OFFLINE recipients, then connect them and time the
 *                   queue drain — stresses messages-table write+read (SQLite).
 *   reconnect-storm N clients connect+auth SIMULTANEOUSLY — thundering-herd auth,
 *                   stresses the event loop + challenge store.
 *
 * Stubs / TODO (documented in the coverage map, not yet wired):
 *   group-fanout    SenderKey distribution to M recipients (group:rekey_dist)
 *   work-channel    Work channel msg burst (work_messages + FTS5 write amp)
 *   public-channel  pubchannel:apply + post
 *   prekey-fanout   prekeys:fetch / upload under load
 *   blob-throughput /blob/upload PoW-gated attachment upload
 *   soak            sustained low rate for N minutes, sample RSS + loop lag
 *   call-signaling  WebRTC offer/answer/ICE relay (sealed, no `from`)
 */

import { randomUUID, randomBytes } from 'node:crypto';
import {
  makeClients, registerAll, connectAndAuth, fmt, encodeBase64,
} from './lib.mjs';

const payload = (bytes) => ({
  ciphertext: encodeBase64(randomBytes(bytes)),
  nonce: encodeBase64(randomBytes(24)),
});

// ── messaging: 1:1 sealed envelopes, ack + delivery latency ──────────────────
export async function messaging(baseUrl, { clients: total = 50, msgs = 15, payloadBytes = 1024 }) {
  const MSGS = Math.min(msgs, 20); // per-socket burst cap (envelope limiter = 20)
  const pairs = Math.floor(total / 2);
  const clients = makeClients(pairs * 2);
  const authMs = [], ackMs = [], deliverMs = [];
  const errors = [];
  let rateLimited = 0;

  const regErrors = await registerAll(baseUrl, clients);
  if (regErrors.length) return { errors: regErrors, fatal: true };

  await Promise.all(clients.map((c) => connectAndAuth(baseUrl, c, authMs).catch((e) => errors.push(e.message))));
  if (errors.length) return { errors, fatal: true };

  const sentAt = new Map();
  let delivered = 0;
  const expected = pairs * MSGS;
  for (let i = 0; i < clients.length; i += 2) {
    clients[i + 1].socket.on('envelope', (env) => {
      const t = sentAt.get(env.id);
      if (t !== undefined) { deliverMs.push(performance.now() - t); delivered++; }
    });
  }

  const t0 = performance.now();
  await Promise.all(clients.filter((_, i) => i % 2 === 0).map(async (sender, idx) => {
    const receiver = clients[idx * 2 + 1];
    for (let m = 0; m < MSGS; m++) {
      const id = randomUUID();
      const start = performance.now();
      sentAt.set(id, start);
      await new Promise((resolve) => {
        sender.socket.emit('envelope', { id, to: receiver.aegisId, ...payload(payloadBytes) }, (ack) => {
          if (ack?.ok) ackMs.push(performance.now() - start);
          else if (ack?.error === 'rate_limited') rateLimited++;
          else errors.push(`ack error: ${ack?.error}`);
          resolve();
        });
      });
    }
  }));

  const deadline = Date.now() + 10_000;
  while (delivered < expected - rateLimited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const secs = (performance.now() - t0) / 1000;
  for (const c of clients) c.socket?.disconnect();

  return {
    lines: [
      `${ackMs.length} acks, ${delivered}/${expected} delivered in ${secs.toFixed(1)}s (${(delivered / secs).toFixed(0)} msg/s e2e)`,
      `auth         ${fmt(authMs)}`,
      `send→ack     ${fmt(ackMs)}`,
      `send→deliver ${fmt(deliverMs)}`,
      `rate-limited acks: ${rateLimited}`,
    ],
    errors,
    ok: delivered + rateLimited >= expected,
  };
}

// ── offline-drain: queue while offline, then time the drain on connect ───────
export async function offlineDrain(baseUrl, { clients: total = 50, msgs = 15, payloadBytes = 1024 }) {
  const MSGS = Math.min(msgs, 20);
  const pairs = Math.floor(total / 2);
  const clients = makeClients(pairs * 2); // even = sender, odd = (initially offline) receiver
  const authMs = [], ackMs = [], drainMs = [];
  const errors = [];
  let queued = 0, rateLimited = 0;

  const regErrors = await registerAll(baseUrl, clients);
  if (regErrors.length) return { errors: regErrors, fatal: true };

  // Connect senders only; receivers stay offline so envelopes hit the queue.
  const senders = clients.filter((_, i) => i % 2 === 0);
  await Promise.all(senders.map((c) => connectAndAuth(baseUrl, c, authMs).catch((e) => errors.push(e.message))));
  if (errors.length) return { errors, fatal: true };

  const expectedPerReceiver = MSGS;
  await Promise.all(senders.map(async (sender, idx) => {
    const receiver = clients[idx * 2 + 1];
    for (let m = 0; m < MSGS; m++) {
      const id = randomUUID();
      await new Promise((resolve) => {
        sender.socket.emit('envelope', { id, to: receiver.aegisId, ...payload(payloadBytes) }, (ack) => {
          if (ack?.ok && ack?.queued) queued++;
          else if (ack?.error === 'rate_limited') rateLimited++;
          else errors.push(`enqueue ack: ${JSON.stringify(ack)}`);
          resolve();
        });
      });
    }
  }));

  // Now bring the receivers online and time how long each takes to drain its
  // queued envelopes. The drain burst arrives BEFORE auth:ok, so the counting
  // listener is attached at socket-creation time via connectAndAuth's onEnvelope.
  const receivers = clients.filter((_, i) => i % 2 === 1);
  const received = new Map(receivers.map((r) => [r.aegisId, 0]));
  const tDrainStart = performance.now();
  await Promise.all(receivers.map((r) => {
    const start = performance.now();
    return connectAndAuth(baseUrl, r, authMs, {
      onEnvelope: () => {
        received.set(r.aegisId, received.get(r.aegisId) + 1);
        drainMs.push(performance.now() - start);
      },
    }).catch((e) => errors.push(e.message));
  }));

  // Allow a short tail for the last in-flight drained envelopes.
  const totalExpected = receivers.length * expectedPerReceiver - rateLimited;
  const deadline = Date.now() + 8_000;
  const totalReceived = () => [...received.values()].reduce((a, b) => a + b, 0);
  while (totalReceived() < totalExpected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const secs = (performance.now() - tDrainStart) / 1000;
  for (const c of clients) c.socket?.disconnect();

  const got = totalReceived();
  return {
    lines: [
      `queued ${queued} envelopes, drained ${got}/${totalExpected} in ${secs.toFixed(1)}s (${(got / secs).toFixed(0)} msg/s drain)`,
      `sender auth  ${fmt(authMs)}`,
      `connect→drained-envelope ${fmt(drainMs)}`,
      `rate-limited enqueues: ${rateLimited}`,
    ],
    errors,
    ok: got >= totalExpected,
  };
}

// ── reconnect-storm: N clients auth simultaneously (thundering herd) ─────────
export async function reconnectStorm(baseUrl, { clients: total = 100 }) {
  const clients = makeClients(total);
  const authMs = [];
  const errors = [];

  const regErrors = await registerAll(baseUrl, clients);
  if (regErrors.length) return { errors: regErrors, fatal: true };

  // Fire every connect+auth at once — no batching. This is the reconnection
  // thundering herd (e.g. after a relay restart or a network flap): every phone
  // races to re-establish its authenticated socket in the same instant.
  const t0 = performance.now();
  const results = await Promise.allSettled(
    clients.map((c) => connectAndAuth(baseUrl, c, authMs))
  );
  const secs = (performance.now() - t0) / 1000;
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed.slice(0, 10)) errors.push(f.reason?.message ?? String(f.reason));
  for (const c of clients) c.socket?.disconnect();

  return {
    lines: [
      `${authMs.length}/${total} authenticated in ${secs.toFixed(1)}s (${(authMs.length / secs).toFixed(0)} auth/s), ${failed.length} failed`,
      `auth         ${fmt(authMs)}`,
    ],
    errors,
    ok: failed.length === 0,
  };
}

export const SCENARIOS = {
  messaging,
  'offline-drain': offlineDrain,
  'reconnect-storm': reconnectStorm,
};
