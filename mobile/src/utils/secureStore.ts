/**
 * secureStore.ts — Unified SecureStore wrapper
 *
 * Fixes H-1 (Android 14 StrongBox NPE): all calls include
 * keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY so the
 * Keystore hardware binding works correctly on Android 14+. The
 * _THIS_DEVICE_ONLY class also blocks the iOS Keychain item from ever
 * being restored onto a *different* device via an encrypted iCloud/iTunes
 * backup — identity & DB-encryption keys must never leave this device.
 *
 * Fixes M-1 (Keystore hang): a 5 s timeout rejects any
 * operation that stalls due to a degraded Keystore, preventing
 * the app from hanging indefinitely.
 *
 * Usage:
 *   import { ss } from '../utils/secureStore';
 *   await ss.get('my-key');
 *   await ss.set('my-key', 'value');
 *   await ss.delete('my-key');
 */

import * as SecureStore from 'expo-secure-store';

const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SecureStore.${label} timed out`)),
      TIMEOUT_MS
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export const ss = {
  get: (key: string) =>
    withTimeout(SecureStore.getItemAsync(key, OPTS), 'get'),
  set: (key: string, value: string) =>
    withTimeout(SecureStore.setItemAsync(key, value, OPTS), 'set'),
  delete: (key: string) =>
    withTimeout(SecureStore.deleteItemAsync(key, OPTS), 'delete'),
};
