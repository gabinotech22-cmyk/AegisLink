import { create } from 'zustand';

/**
 * Active voice-channel awareness (Discord-style banners) — SEPARATE from
 * useGroupCall (the call I'm actually in). This tracks, per group, that a voice
 * channel is open so the chat/list can show a "join" banner.
 *
 * Zero-metadata: there is no server-side record of who's in a call. Awareness
 * is purely P2P — participants periodically re-broadcast a `group_call:channel`
 * heartbeat carrying the current roster, and an entry is considered STALE (the
 * call ended / everyone left / we lost the peers) once no heartbeat has arrived
 * for STALE_MS. Banners therefore self-heal without any teardown signal.
 */

export interface ActiveCall {
  callId: string;
  groupId: string;
  /** aegisId of whoever opened the channel. */
  initiator: string;
  /** aegisIds currently reported as in the call (from the latest heartbeat). */
  participants: string[];
  /** ms epoch of the most recent heartbeat for this channel. */
  lastHeartbeat: number;
}

/** A channel with no heartbeat for this long is treated as ended. */
export const STALE_MS = 45_000;

interface ActiveCallsState {
  calls: Record<string, ActiveCall>;
  /** Insert or refresh a channel (called on every heartbeat). */
  upsert: (call: ActiveCall) => void;
  /** Drop a channel immediately (e.g. we joined it, or it ended). */
  remove: (groupId: string) => void;
  /** Drop every channel whose last heartbeat is older than STALE_MS. */
  prune: (now: number) => void;
  /** The channel for a group IF it is still fresh, else null. */
  getFresh: (groupId: string, now: number) => ActiveCall | null;
}

export const useActiveCalls = create<ActiveCallsState>((set, get) => ({
  calls: {},

  upsert: (call) =>
    set((s) => ({ calls: { ...s.calls, [call.groupId]: call } })),

  remove: (groupId) =>
    set((s) => {
      if (!s.calls[groupId]) return s;
      const next = { ...s.calls };
      delete next[groupId];
      return { calls: next };
    }),

  prune: (now) =>
    set((s) => {
      let changed = false;
      const next: Record<string, ActiveCall> = {};
      for (const [gid, c] of Object.entries(s.calls)) {
        if (now - c.lastHeartbeat < STALE_MS) next[gid] = c;
        else changed = true;
      }
      return changed ? { calls: next } : s;
    }),

  getFresh: (groupId, now) => {
    const c = get().calls[groupId];
    if (!c) return null;
    return now - c.lastHeartbeat < STALE_MS ? c : null;
  },
}));
