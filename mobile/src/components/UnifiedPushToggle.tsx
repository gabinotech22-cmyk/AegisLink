/**
 * Privacy → "alerts with the app closed, without Google" (UnifiedPush, Android;
 * src/notifications/unifiedPush.ts). ON = a distributor is chosen; the choice
 * lives in the connector (its saved distributor), not in our preferences.
 * Renders nothing where the connector is absent (iOS, Expo Go).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from './Section';
import { themedAlert } from './AlertHost';
import type { Theme } from '../theme/vault';
import {
  currentDistributor,
  disableUnifiedPush,
  enableUnifiedPush,
  isUnifiedPushAvailable,
  listDistributors,
} from '../notifications/unifiedPush';

/** Readable names for the common distributors; anything else shows its package. */
const KNOWN: Record<string, string> = {
  'io.heckel.ntfy': 'ntfy',
  'org.unifiedpush.distributor.sunup': 'Sunup',
  'org.unifiedpush.distributor.nextpush': 'NextPush',
  'org.unifiedpush.distributor.fcm': 'FCM',
};
export const distributorName = (pkg: string): string => KNOWN[pkg] ?? pkg;

export function UnifiedPushToggle({ t, noBorder }: { t: Theme; noBorder?: boolean }) {
  const { t: i18nT } = useTranslation();
  const [current, setCurrent] = useState<string | null>(null);
  const available = isUnifiedPushAvailable();

  const refresh = useCallback(() => {
    void currentDistributor().then(setCurrent);
  }, []);
  useEffect(() => {
    if (available) refresh();
  }, [available, refresh]);

  const use = useCallback(
    async (pkg: string) => {
      try {
        await enableUnifiedPush(pkg);
        // Bind right away on the live mailbox socket (else at its next auth).
        const { rebindUnifiedPush } = require('../socket/mailboxSocket') as typeof import('../socket/mailboxSocket');
        rebindUnifiedPush();
      } catch {
        themedAlert(i18nT('privacy.upError'));
      }
      refresh();
    },
    [i18nT, refresh],
  );

  const onChange = useCallback(
    async (on: boolean) => {
      if (!on) {
        await disableUnifiedPush();
        refresh();
        return;
      }
      const pkgs = await listDistributors();
      if (pkgs.length === 0) {
        themedAlert(i18nT('privacy.upNoneTitle'), i18nT('privacy.upNoneBody'));
      } else if (pkgs.length === 1) {
        await use(pkgs[0]);
      } else {
        themedAlert(
          i18nT('privacy.upPickTitle'),
          i18nT('privacy.upPickBody'),
          pkgs.map((pkg) => ({ text: distributorName(pkg), onPress: () => void use(pkg) })),
        );
      }
    },
    [i18nT, refresh, use],
  );

  if (!available) return null;
  return (
    <Toggle
      t={t}
      label={i18nT('privacy.upLabel')}
      sub={current ? i18nT('privacy.upSubOn', { name: distributorName(current) }) : i18nT('privacy.upSubOff')}
      value={current !== null}
      onChange={(v) => void onChange(v)}
      noBorder={noBorder}
    />
  );
}
