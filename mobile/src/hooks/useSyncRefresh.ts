import { useCallback, useEffect, useRef, useState } from 'react';
import type { Identity } from '../crypto/identity';
import { syncNow } from '../socket/client';

/**
 * How long the spinner may stay up. A Tor drain that has not answered by then
 * is still running in the background (syncNow is fail-soft and single-flight
 * per leg); the gesture just stops pretending to wait for it.
 */
export const SYNC_REFRESH_MAX_MS = 15_000;

/**
 * Pull-to-refresh = "sync now". The list screens hand the result straight to
 * a RefreshControl. `extra` is the screen's own reload (a channel feed pull,
 * for instance) and runs alongside the mailbox/outbox sync.
 *
 * Without an identity the gesture is inert (nothing to sync as).
 */
export function useSyncRefresh(
  identity: Identity | null | undefined,
  extra?: () => Promise<unknown>,
): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const onRefresh = useCallback(() => {
    if (!identity || inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    const work = Promise.all([
      syncNow(identity),
      extra ? extra().catch(() => undefined) : Promise.resolve(),
    ]);
    const cap = new Promise<void>((r) => setTimeout(r, SYNC_REFRESH_MAX_MS));
    void Promise.race([work, cap]).finally(() => {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    });
  }, [identity, extra]);

  return { refreshing, onRefresh };
}
