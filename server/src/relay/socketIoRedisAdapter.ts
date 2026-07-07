import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as SocketServer } from 'socket.io';
import type { Redis } from 'ioredis';
import { redis } from './redisClient.js';
import { logger } from './logger.js';

/**
 * Attach the Redis pub/sub adapter to Socket.IO so events emitted from one
 * relay process (PM2 cluster worker, or a separate VM behind a load
 * balancer) reach sockets connected to any OTHER process. Without this,
 * `io.to(socketId).emit(...)` only ever reaches sockets held by the SAME
 * process — a message/call-signaling event delivered to the "wrong" worker
 * would silently vanish for that recipient under horizontal scaling.
 *
 * Gate: identical pattern to `redisClient.ts` — activates ONLY when
 * `REDIS_URL` is set. Unset (today's single-VM/no-cluster deployment):
 * Socket.IO keeps its built-in in-memory adapter, zero behavior change.
 *
 * The adapter needs two DEDICATED long-lived connections (pub + sub) beyond
 * the one `redisClient.ts` already opens for rate-limit `INCR`/`EXPIRE` —
 * a subscriber connection cannot also issue regular commands. We `duplicate()`
 * the existing client so both share the same host/port/TLS/retry options
 * without re-parsing `REDIS_URL`, and attach the same "log message/code only,
 * never the raw error object" discipline `redisClient.ts` uses (the raw error
 * can embed the connection string).
 */
export function attachSocketIoRedisAdapter(io: SocketServer): void {
  attachSocketIoRedisAdapterWithClient(io, redis);
}

/**
 * Same logic as `attachSocketIoRedisAdapter`, but takes the base ioredis
 * client explicitly instead of reading the `redisClient.ts` singleton.
 * Exported purely so tests can inject a fake ioredis-shaped client (no real
 * TCP connection, deterministic, no dangling reconnect timers) — production
 * code should always call `attachSocketIoRedisAdapter(io)` above.
 */
export function attachSocketIoRedisAdapterWithClient(io: SocketServer, redisClient: Redis | null): void {
  if (!redisClient) {
    logger.info('No REDIS_URL — Socket.IO using built-in in-memory adapter (single-instance only).');
    return;
  }

  const logClientError = (label: string) => (err: unknown) => {
    const e = err as NodeJS.ErrnoException;
    logger.error(`Socket.IO Redis adapter ${label} client error`, {
      message: e?.message ?? String(err),
      code: e?.code ?? '',
    });
  };

  let pubClient: Redis;
  let subClient: Redis;
  try {
    pubClient = redisClient.duplicate();
    subClient = redisClient.duplicate();
  } catch (err) {
    // Zero silent degradation: REDIS_URL is set but we could not even
    // construct the dedicated clients. Log loudly and keep the in-memory
    // adapter rather than crash the whole relay over a scaling feature.
    logClientError('setup')(err);
    return;
  }

  pubClient.on('error', logClientError('pub'));
  subClient.on('error', logClientError('sub'));

  try {
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.IO Redis adapter attached — cross-instance broadcast enabled.');
  } catch (err) {
    logger.error('Failed to attach Socket.IO Redis adapter — falling back to in-memory adapter (events will NOT cross process boundaries under >1 instance)', {
      message: err instanceof Error ? err.message : String(err),
      code: (err as NodeJS.ErrnoException)?.code ?? '',
    });
  }
}
