import type { Socket } from 'socket.io';

// Returns only the sockets in `set` whose transport is actually connected,
// pruning any zombie entries (transport dead, `disconnect` not fired yet) from
// the Set in place. A zombie socket that stays registered makes callers treat
// a message as "delivered" when nothing was ever received — silent loss.
// Shared by the messaging paths (handler.ts deliver/envelope:v2/envelope:mb)
// and ALL call-signaling delivery decisions (callSignaling.ts): any branch that
// gates "live delivery vs offline push wake-up" on a sockets-map entry MUST
// filter through this, or a zombie entry suppresses the wake-up and the callee
// never rings.
export function liveSockets(set: Set<Socket>): Socket[] {
  const live: Socket[] = [];
  for (const s of set) {
    if (s.connected) {
      live.push(s);
    } else {
      set.delete(s);
    }
  }
  return live;
}
