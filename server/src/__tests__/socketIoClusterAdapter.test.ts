/**
 * socketIoClusterAdapter.test.ts
 *
 * Regression coverage for the same-machine (Node `cluster` module) Socket.IO
 * broadcast adapter — the counterpart to socketIoRedisAdapter.test.ts. See
 * docs/RELAY-HORIZONTAL-SCALING.md for the full architecture writeup (why
 * PM2's own `exec_mode: 'cluster'` was replaced by src/clusterMaster.ts +
 * `@socket.io/sticky` + `@socket.io/cluster-adapter`).
 *
 * `attachSocketIoClusterAdapter` is only ever called from `src/index.ts`
 * inside an actual `cluster.isWorker` process (where `process.send` exists,
 * which `@socket.io/cluster-adapter`'s `NodeClusterAdapter` relies on
 * internally) — this test never runs in that context, so it uses a fake
 * `io` object whose `adapter()` method just records the call without ever
 * invoking the returned per-namespace factory. That means the real
 * `NodeClusterAdapter` is never actually constructed here (no `process.send`
 * calls, no real cluster/IPC involvement, deterministic and network-free).
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Server as SocketServer } from 'socket.io';
import { attachSocketIoClusterAdapter } from '../relay/socketIoClusterAdapter.js';

function makeFakeIo(): { adapter: ReturnType<typeof jest.fn> } & Partial<SocketServer> {
  return { adapter: jest.fn() };
}

describe('attachSocketIoClusterAdapter', () => {
  it('attaches the cluster adapter via io.adapter(...) without throwing', () => {
    const io = makeFakeIo();

    expect(() => attachSocketIoClusterAdapter(io as unknown as SocketServer)).not.toThrow();

    expect(io.adapter).toHaveBeenCalledTimes(1);
    // io.adapter() is called with the per-namespace factory function
    // createAdapter() returns — never invoked here, just recorded.
    expect(typeof io.adapter.mock.calls[0]?.[0]).toBe('function');
  });

  it('does not throw and logs instead if io.adapter(...) itself throws', () => {
    const io = {
      adapter: jest.fn(() => {
        throw new Error('boom');
      }),
    };

    expect(() => attachSocketIoClusterAdapter(io as unknown as SocketServer)).not.toThrow();
    expect(io.adapter).toHaveBeenCalledTimes(1);
  });
});
