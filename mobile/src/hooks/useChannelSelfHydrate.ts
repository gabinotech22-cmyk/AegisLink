import { useEffect } from 'react';
import { logger } from '../utils/logger';

/**
 * Defense in depth: the app-level rehydrate (App.tsx) normally hydrates
 * `subscribed` from SecureStore-persisted channel secrets before any screen
 * can be reached, but a screen opened via a fast deep link/notification tap
 * could still land here before that effect resolves. Self-hydrate (once,
 * idempotent) rather than render a degraded header/compose bar — or falsely
 * render "channel not found" — off a possibly-still-empty `subscribed`.
 *
 * Shared by ChannelFeed.tsx and ChannelInfo.tsx (previously duplicated).
 */
let hydrationPromise: Promise<void> | null = null;

export function useChannelSelfHydrate<T>(
  hydrated: boolean,
  summary: T,
  hydrateSubscribed: () => Promise<void>,
): void {
  useEffect(() => {
    if (hydrated || summary) return;
    if (hydrationPromise) return;

    hydrationPromise = hydrateSubscribed()
      .catch((err: unknown) => {
        logger.warn('[useChannelSelfHydrate] hydrate failed:', err);
      })
      .finally(() => {
        hydrationPromise = null;
      });
  }, [hydrated, summary, hydrateSubscribed]);
}
