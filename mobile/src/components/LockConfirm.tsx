/**
 * LockConfirm — "prove it's you" before a sensitive setting change
 * (federation F5b: changing the home relay, docs/FEDERATION-DESIGN.md D4).
 *
 * `useLockConfirm()` returns `confirm()` (resolves true when the user proved
 * possession of the app lock, false on cancel/failure) and the modal element
 * to mount. Gate: only when the app lock is enabled AND a PIN is stored —
 * without a lock there is nothing to prove, so `confirm()` resolves true at
 * once (same level as every other setting today).
 *
 * Biometrics first when the user enabled them and the device has them
 * (never the device passcode: `disableDeviceFallback` — it would bypass the
 * app PIN), then the app PIN via `verifyPIN`. Deliberately NOT the LockScreen:
 * that screen owns the duress/decoy activation and the wipe-on-attempts
 * counter, which a settings confirmation must never trigger — here a wrong
 * PIN (including the duress PIN) is simply a wrong PIN.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, Modal } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { PrimaryButton } from './Button';
import { usePreferences } from '../store/preferences';
import { hasStoredPIN, verifyPIN, getStoredPinLength } from '../lock/pin';
import { withPickingGuard } from '../utils/pickingGuard';

interface LA {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(o: { promptMessage: string; fallbackLabel: string; disableDeviceFallback: boolean }): Promise<{ success: boolean; error?: string }>;
}

async function tryBiometrics(prompt: string, fallbackLabel: string): Promise<'ok' | 'fallback' | 'unavailable'> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const la = require('expo-local-authentication') as LA;
    if (!(await la.hasHardwareAsync()) || !(await la.isEnrolledAsync())) return 'unavailable';
    const r = await withPickingGuard(() => la.authenticateAsync({ promptMessage: prompt, fallbackLabel, disableDeviceFallback: true }));
    return r.success ? 'ok' : 'fallback';
  } catch {
    return 'unavailable';
  }
}

export function useLockConfirm(): { confirm: () => Promise<boolean>; element: React.ReactElement } {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const appLockEnabled = usePreferences((s) => s.appLockEnabled);
  const biometricsEnabled = usePreferences((s) => s.biometricsEnabled);
  const [visible, setVisible] = useState(false);
  const [pin, setPin] = useState('');
  const [pinLen, setPinLen] = useState<4 | 6>(6);
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
    if (biometricsEnabled) {
      const bio = await tryBiometrics(i18nT('lockConfirm.prompt'), i18nT('lockConfirm.usePin'));
      if (bio === 'ok') return true;
      // 'fallback' / 'unavailable' → the app PIN
    }
    setPinLen((await getStoredPinLength()) ?? 6);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setVisible(true);
    });
  }, [appLockEnabled, biometricsEnabled, i18nT]);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await verifyPIN(pin);
      if (ok) finish(true);
      else { setError(true); setPin(''); }
    } finally {
      setBusy(false);
    }
  }, [busy, pin, finish]);

  const element = (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => finish(false)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 20, borderWidth: 1, borderColor: t.border }}>
          <Text style={{ fontFamily: t.font, fontSize: 17, fontWeight: '700', color: t.text }}>{i18nT('lockConfirm.title')}</Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 8 }}>{i18nT('lockConfirm.body')}</Text>
          <TextInput
            value={pin}
            onChangeText={(v) => { setError(false); setPin(v.replace(/\D/g, '').slice(0, pinLen)); }}
            onSubmitEditing={() => void submit()}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={pinLen}
            autoFocus
            testID="lock-confirm-pin"
            accessibilityLabel={i18nT('lockConfirm.title')}
            style={{ marginTop: 14, fontFamily: t.fontMono, fontSize: 22, letterSpacing: 8, color: t.text, textAlign: 'center', paddingVertical: 12, borderWidth: 1, borderColor: error ? t.danger : t.border, borderRadius: t.radiusS }}
          />
          {error && (
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.danger, marginTop: 8 }} testID="lock-confirm-error">{i18nT('lockConfirm.wrongPin')}</Text>
          )}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
            <Pressable onPress={() => finish(false)} testID="lock-confirm-cancel" style={{ flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: t.radius, borderWidth: 1, borderColor: t.border }}>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{i18nT('common.cancel', 'Cancel')}</Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <PrimaryButton t={t} label={i18nT('lockConfirm.confirm')} onPress={() => void submit()} disabled={pin.length < 4 || busy} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );

  return { confirm, element };
}
