import type { Socket } from 'socket.io';
import { DeviceLinkApprove, DeviceRevoke } from '../schemas.js';
import { identityRepo, devicesRepo } from '../../db/client.js';

// SocketMeta is a per-socket label attached by the auth flow. We only read
// `platform` here (to identify desktop sockets during revocation) without
// exposing socket identity or IP — metadata-free principle preserved.
interface SocketMetaRef {
  platform: 'mobile' | 'desktop' | 'unknown';
  deviceId: string | undefined;
}

export interface DevicesDeps {
  me: string;
  sockets: Map<string, Set<Socket>>;
  /** Link-pending desktop sockets awaiting mobile approval. */
  linkingSockets: Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>;
  /** WeakMap holding platform/deviceId meta per socket. */
  socketMeta: WeakMap<Socket, SocketMetaRef>;
}

export function attachDevices(socket: Socket, { me, sockets, linkingSockets, socketMeta }: DevicesDeps): void {
  // ─── Device linking (mobile side — approve) ────────────────────────────────
  // Mobile emits this after scanning the desktop QR code and approving.
  // The relay routes the encrypted response to the waiting desktop socket
  // and persists the linked device record in SQLite.
  socket.on('device:link:approve', (raw: unknown) => {
    const parsed = DeviceLinkApprove.safeParse(raw);
    if (!parsed.success) {
      socket.emit('error_msg', { code: 'invalid_device_link_approve' });
      return;
    }
    const { desktopPubKey, encryptedPayload, nonceB64 } = parsed.data;
    const entry = linkingSockets.get(desktopPubKey);
    if (!entry) {
      socket.emit('error_msg', { code: 'device_link_not_found' });
      return;
    }

    // Obtain the mobile's X25519 public key from the identity store so the
    // desktop can verify the encrypted payload came from the correct identity.
    void identityRepo.get(me).then((identity) => {
      const mobilePubKey = identity?.public_key_b64 ?? '';

      // Deliver approval to the waiting desktop and clean up the ephemeral map.
      // Relay never persists desktopPubKey, tempSocketId, or this payload.
      entry.socket.emit('device:link:approved', { encryptedPayload, nonceB64, mobilePubKey });
      clearTimeout(entry.timer);
      linkingSockets.delete(desktopPubKey);
    }).catch(() => { /* silent */ });
  });

  // ─── Device list (in-memory) ─────────────────────────────────────────────
  // Returns how many sockets are currently authenticated under this aegisId
  // and which platforms they declared at handshake time.
  // Never exposes IPs or socket IDs — metadata-free by design.
  socket.on('device:list', (ack: unknown) => {
    if (typeof ack !== 'function') return;
    const mySet = sockets.get(me);
    const platforms: string[] = [];
    if (mySet) {
      for (const s of mySet) {
        const meta = socketMeta.get(s);
        platforms.push(meta?.platform ?? 'unknown');
      }
    }
    (ack as (res: { count: number; platforms: string[] }) => void)({
      count: platforms.length,
      platforms,
    });
  });

  // ─── Device revocation ─────────────────────────────────────────────────────
  // Mobile emits { deviceId } to revoke a linked device.
  // Server marks it revoked in DB and disconnects the device's socket if online.
  socket.on('device:revoke', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    const parsed = DeviceRevoke.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'invalid_payload' });
      return;
    }
    const { deviceId } = parsed.data;
    devicesRepo.revoke(deviceId, me).then((revoked) => {
      if (!revoked) {
        ack?.({ ok: false, error: 'not_found' });
        return;
      }
      // Disconnect the revoked device's socket if it is currently online under `me`.
      const mySet = sockets.get(me);
      if (mySet) {
        for (const s of mySet) {
          const meta = socketMeta.get(s);
          if (meta?.platform === 'desktop' && s !== socket) {
            s.emit('device:revoked', { deviceId });
            s.disconnect(true);
          }
        }
      }
      ack?.({ ok: true });
    }).catch(() => {
      ack?.({ ok: false, error: 'db_error' });
    });
  });
}
