import { createAdapter } from '@socket.io/cluster-adapter';
import type { Server as SocketServer } from 'socket.io';
import { logger } from './logger.js';

/**
 * Attach the (zero-dependency, IPC-based) Socket.IO cluster adapter — the
 * SAME-MACHINE counterpart to `socketIoRedisAdapter.ts`.
 *
 * Broadcasting events between Socket.IO processes needs TWO independent
 * mechanisms depending on topology, and this project needs both:
 *
 *   - Multiple WORKERS on ONE machine (today's real Hetzner VM, 2 vCPUs,
 *     `src/clusterMaster.ts` forking N children via Node's native `cluster`
 *     module): this adapter. It broadcasts over `process.send`/IPC — no
 *     external service, no connection to secure, nothing to provision.
 *   - Multiple separate MACHINES (future horizontal scale-out behind a real
 *     load balancer): `socketIoRedisAdapter.ts` — IPC doesn't cross a
 *     network boundary, so that case needs Redis pub/sub instead.
 *
 * `attachSocketIoScalingAdapter` in `src/index.ts` picks exactly ONE of the
 * two (Redis wins when `REDIS_URL` is configured, since Redis also covers
 * the single-machine case and is the right choice once true multi-VM
 * scaling is live) — never both, and never this one outside of an actual
 * `cluster.isWorker` process (see the guard in `src/index.ts`), since
 * `@socket.io/cluster-adapter` calls `process.send` internally, which only
 * exists on processes forked via Node's `cluster` module.
 */
export function attachSocketIoClusterAdapter(io: SocketServer): void {
  try {
    io.adapter(createAdapter());
    logger.info('Socket.IO cluster adapter attached (same-machine IPC broadcast, no Redis needed).');
  } catch (err) {
    // Zero silent degradation: if this somehow fails, log it loudly. The
    // caller only reaches this function inside an actual cluster worker
    // (src/index.ts guards on `cluster.isWorker`), so a failure here means
    // cross-worker broadcast is broken and events emitted on this worker
    // will NOT reach sockets held by sibling workers — worth an operator's
    // immediate attention, not a silent fallback to the default in-memory
    // adapter (which would be equally broken for that purpose).
    logger.error('Failed to attach Socket.IO cluster adapter', {
      message: err instanceof Error ? err.message : String(err),
      code: (err as NodeJS.ErrnoException)?.code ?? '',
    });
  }
}
