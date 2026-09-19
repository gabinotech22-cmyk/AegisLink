/**
 * LockConfirm — "prove it's you" before a sensitive setting change
 * (federation F5b: changing the home relay, docs/FEDERATION-DESIGN.md D4).
 * Desktop twin of mobile/src/components/LockConfirm.tsx: with the app lock on
 * and a PIN stored, `confirm()` shows the PIN dialog (there are no OS
 * biometrics in the desktop lock) and resolves true only on the right PIN;
 * without a lock it resolves true at once. Deliberately NOT the LockScreen:
 * that one owns the wipe-on-attempts counter and the duress path, which a
 * settings confirmation must never trigger.
 */
import { useCallback, useRef, useState, type ReactElement } from 'react';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { PrimaryButton } from './Button';
import { usePreferences } from '../store/preferences';
import { hasStoredPIN, verifyPIN } from '../lock/pin';

export function useLockConfirm(): { confirm: () => Promise<boolean>; element: ReactElement | null } {
  const { t } = useTheme();
  const appLockEnabled = usePreferences((s) => s.appLockEnabled);
  const [visible, setVisible] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    setVisible(false);
    setPin('');
    setError(false);
    const r = resolver.current;
    resolver.current = null;
    r?.(ok);
  }, []);

  const confirm = useCallback(async (): Promise<boolean> => {
    if (!appLockEnabled || !(await hasStoredPIN())) return true;
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setVisible(true);
    });
  }, [appLockEnabled]);

  const submit = useCallback(async () => {
    if (busy || pin.length < 4) return;
    setBusy(true);
    try {
      if (await verifyPIN(pin)) finish(true);
      else { setError(true); setPin(''); }
    } finally {
      setBusy(false);
    }
  }, [busy, pin, finish]);

  const element = visible ? (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 20 }}>
      <div style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, border: `1px solid ${t.border}`, maxWidth: 380, width: '100%' }}>
        <div style={{ fontFamily: t.font, fontSize: 17, fontWeight: 700, color: t.text }}>{i18n.t('lockConfirm.title')}</div>
        <p style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 8 }}>{i18n.t('lockConfirm.body')}</p>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          maxLength={6}
          data-testid="lock-confirm-pin"
          aria-label={i18n.t('lockConfirm.title')}
          onChange={(e) => { setError(false); setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') finish(false); }}
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 14, fontFamily: t.fontMono, fontSize: 22, letterSpacing: 8, textAlign: 'center', color: t.text, backgroundColor: t.bg, padding: '12px 0', border: `1px solid ${error ? t.danger : t.border}`, borderRadius: t.radiusS, outline: 'none' }}
        />
        {error && <div data-testid="lock-confirm-error" style={{ fontFamily: t.font, fontSize: 12, color: t.danger, marginTop: 8 }}>{i18n.t('lockConfirm.wrongPin')}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button data-testid="lock-confirm-cancel" onClick={() => finish(false)} style={{ flex: 1, padding: 13, borderRadius: t.radius, border: `1px solid ${t.border}`, background: 'none', cursor: 'pointer', fontFamily: t.font, fontSize: 14, color: t.text }}>
            {i18n.t('common.cancel')}
          </button>
          <div style={{ flex: 1 }}>
            <PrimaryButton t={t} label={i18n.t('lockConfirm.confirm')} onPress={() => void submit()} disabled={pin.length < 4 || busy} />
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, element };
}
