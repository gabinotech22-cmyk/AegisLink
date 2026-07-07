/**
 * socketIoRedisAdapter.test.ts
 *
 * Regression coverage for the horizontal-scaling follow-up to A-1
 * (docs/SECURITY-ROADMAP-2026-06.md, OLA 9 — see docs/RELAY-HORIZONTAL-SCALING.md
 * for the full rollout story). Two behaviors must hold:
 *
 *   1. No REDIS_URL (today's mono-instance deployment) -> the Socket.IO
 *      server keeps its default in-memory adapter untouched. This must NEVER
 *      regress: it is what keeps `npm run dev` / the single-VM prod
 *      deployment working with zero Redis dependency.
 *   2. REDIS_URL configured -> the Redis adapter is attached via
 *      `io.adapter(...)`, using two DEDICATED duplicated clients (never the
 *      raw rate-limit client, since a subscriber connection can't also issue
 *      regular commands).
 *
 * A fake ioredis-shaped client is injected directly (via
 * `attachSocketIoRedisAdapterWithClient`) rather than mocking the `ioredis`
 * module or setting `process.env.REDIS_URL` + importing the real
 * `redisClient.ts` singleton — that would open a real (doomed-to-fail) TCP
 * connection attempt with reconnect timers, which is exactly the kind of
 * flaky/slow-teardown test this repo's Jest config (maxWorkers: 1, real
 * server integration suites) tries to avoid.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Server as SocketServer } from 'socket.io';
import type { Redis } from 'ioredis';
import {
  attachSocketIoRedisAdapter,
  attachSocketIoRedisAdapterWithClient,
} from '../relay/socketIoRedisAdapter.js';

function makeFakeIo(): { adapter: ReturnType<typeof jest.fn> } & Partial<SocketServer> {
  return { adapter: jest.fn() };
}

function makeFakeRedisClient(): { duplicate: ReturnType<typeof jest.fn>; on: ReturnType<typeof jest.fn> } {
  const duplicate = jest.fn(() => ({ on: jest.fn() }));
  return { duplicate, on: jest.fn() };
}

describe('attachSocketIoRedisAdapter / attachSocketIoRedisAdapterWithClient', () => {
  it('leaves the default in-memory adapter untouched when no client is configured (REDIS_URL unset)', () => {
    const io = makeFakeIo();

    expect(() =>
      attachSocketIoRedisAdapterWithClient(io as unknown as SocketServer, null),
    ).not.toThrow();

    expect(io.adapter).not.toHaveBeenCalled();
  });

  it('attaches the Redis adapter using two dedicated duplicated clients when a client is configured', () => {
    const io = makeFakeIo();
    const fakeClient = makeFakeRedisClient();

    attachSocketIoRedisAdapterWithClient(
      io as unknown as SocketServer,
      fakeClient as unknown as Redis,
    );

    // Two DEDICATED connections: one to publish, one to subscribe. Never the
    // raw client itself (it stays free for rate-limit INCR/EXPIRE traffic).
    expect(fakeClient.duplicate).toHaveBeenCalledTimes(2);
    expect(io.adapter).toHaveBeenCalledTimes(1);
    // io.adapter() is called with the factory function createAdapter() returns.
    expect(typeof io.adapter.mock.calls[0]?.[0]).toBe('function');
  });

  it('does not throw and does not attach when duplicate() itself throws (zero silent degradation still fails closed to in-memory)', () => {
    const io = makeFakeIo();
    const fakeClient = {
      duplicate: jest.fn(() => {
        throw new Error('boom');
      }),
      on: jest.fn(),
    };

    expect(() =>
      attachSocketIoRedisAdapterWithClient(io as unknown as SocketServer, fakeClient as unknown as Redis),
    ).not.toThrow();

    expect(io.adapter).not.toHaveBeenCalled();
  });

  it('exposes attachSocketIoRedisAdapter (the production entry point) reading the redisClient.ts singleton', () => {
    // Smoke test only: in this test process REDIS_URL is unset (see
    // jest.setup.ts / no .env loaded), so the singleton `redis` is null and
    // this must behave exactly like the "unset" case above with zero throw.
    const io = makeFakeIo();
    expect(() => attachSocketIoRedisAdapter(io as unknown as SocketServer)).not.toThrow();
    expect(io.adapter).not.toHaveBeenCalled();
  });
});
