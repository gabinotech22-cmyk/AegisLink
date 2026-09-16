import type { Socket } from 'socket.io';
import { DeviceLinkApprove, DeviceRevoke } from '../schemas.js';
import { devicesRepo } from '../../db/client.js';

// SocketMeta is a per-socket label attached by the auth flow. We only read
// `platform` and `deviceId` here (to find the one socket a revocation targets)
// without exposing socket identity or IP — metadata-free principle preserved.
interface SocketMetaRef {
  platform: 'mobile' | 'desktop' | 'unknown';
  deviceId: string | undefined;
}

export interface DevicesDeps {
  me: string;
  sockets: Map<string, Set<Socket>>;
  /** Link-pending desktop sockets awaiting mobile approval, keyed by desktopPubKey.
   *  `deviceId`/`deviceName` come from the desktop's own `device:link`. */
  linkingSockets: Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout>; deviceId: string; deviceName: string }>;
  /** WeakMap holding platform/deviceId meta per socket. */
  socketMeta: WeakMap<Socket, SocketMetaRef>;
}

type Ack = (res: { ok: boolean; error?: string }) => void;

/** Wire shape both clients (mobile Devices.tsx, desktop Devices.tsx) render. */
interface LinkedDeviceWire {
  id: string;
  name: string;
  platform: string;
  linkedAt: number;
}

export function attachDevices(socket: Socket, { me, sockets, linkingSockets, socketMeta }: DevicesDeps): void {
  // ─── Device linking (mobile side — approve) ────────────────────────────────
  // Mobile emits this after scanning the desktop QR code and approving.
  // The relay persists the link row, routes the encrypted response to the
  // waiting desktop socket and acks the mobile.
  //
  // Audit 2026-09-16 AL-01 — three regressions this handler used to have:
  //   1. it forwarded the identity's PERMANENT X25519 key instead of the
  //      ephemeral `mobilePubKey` the phone boxed with → desktop could never
  //      decrypt;
  //   2. it never persisted the device (`devicesRepo.upsert` had no caller), so
  //      `device:list` was always empty and `device:revoke` always `not_found`;
  //   3. it never called the ack the mobile waits on → every approval timed out
  //      client-side even when the desktop got the payload.
  socket.on('device:link:approve', (raw: unknown, ack?: Ack) => {
    const parsed = DeviceLinkApprove.safeParse(raw);
    if (!parsed.success) {
      socket.emit('error_msg', { code: 'invalid_device_link_approve' });
      ack?.({ ok: false, error: 'invalid_payload' });
      return;
    }
    const { desktopPubKey, encryptedPayload, nonceB64, mobilePubKey } = parsed.data;
    const entry = linkingSockets.get(desktopPubKey);
    if (!entry) {
      socket.emit('error_msg', { code: 'device_link_not_found' });
      ack?.({ ok: false, error: 'device_link_not_found' });
      return;
    }

    // Persist BEFORE delivering: once the desktop holds the identity it will
    // authenticate immediately, and the auth gate (handler.ts) requires this
    // row to exist. The relay stores only what the device list renders — it
    // never persists desktopPubKey usage, the payload, or the mobile's key.
    void devicesRepo.upsert({
      device_id: entry.deviceId,
      aegis_id: me,
      device_pub_key: desktopPubKey,
      device_name: entry.deviceName,
      platform: 'desktop',
      linked_at: Date.now(),
    }).then(() => {
      // Deliver approval to the waiting desktop and clean up the ephemeral map.
      entry.socket.emit('device:link:approved', { encryptedPayload, nonceB64, mobilePubKey });
      clearTimeout(entry.timer);
      linkingSockets.delete(desktopPubKey);
      ack?.({ ok: true });
    }).catch(() => {
      ack?.({ ok: false, error: 'db_error' });
    });
  });

  // ─── Device list ───────────────────────────────────────────────────────────
  // Returns the identity's ACTIVE linked devices from the persistent table —
  // the shape both clients render. Never exposes IPs or socket IDs.
  socket.on('device:list', (ack: unknown) => {
    if (typeof ack !== 'function') return;
    const reply = ack as (res: { ok: boolean; devices?: LinkedDeviceWire[]; error?: string }) => void;
    devicesRepo.listActive(me).then((rows) => {
      reply({
        ok: true,
        devices: rows.map((r) => ({
          id: r.device_id,
          name: r.device_name,
          platform: r.platform,
          linkedAt: r.linked_at,
        })),
      });
    }).catch(() => {
      reply({ ok: false, error: 'db_error' });
    });
  });

  // ─── Device revocation ─────────────────────────────────────────────────────
  // Mobile emits { deviceId } to revoke a linked device.
  // Server marks it revoked in DB and disconnects THAT device's socket if it is
  // online. The auth gate then refuses any further session under that deviceId.
  socket.on('device:revoke', (raw: unknown, ack?: Ack) => {
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
      const mySet = sockets.get(me);
      if (mySet) {
        for (const s of mySet) {
          const meta = socketMeta.get(s);
          if (s !== socket && meta?.deviceId === deviceId) {
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
