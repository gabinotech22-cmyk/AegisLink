/**
 * pickingGuard — evita que el bloqueo de pantalla se active mientras
 * el sistema de selección de archivos / cámara tiene la app en segundo plano.
 *
 * Uso:
 *   await withPickingGuard(() => ImagePicker.launchImageLibraryAsync(...))
 *
 * App.tsx consulta isPicking() antes de activar el lock.
 */

import { AppState, type AppStateStatus } from 'react-native';

let _picking = false;

export function isPicking(): boolean {
  return _picking;
}

export async function withPickingGuard<T>(fn: () => Promise<T>): Promise<T> {
  _picking = true;
  try {
    return await fn();
  } finally {
    clearWhenActive();
  }
}

/**
 * Clear the guard only AFTER the app has returned to the foreground.
 *
 * The previous implementation cleared on a fixed 600 ms timeout, which races
 * the OS on slow devices: if the AppState 'active' transition (read by the
 * app-lock handler in App.tsx) lands after that window, the lock fires on a
 * legitimate return from the picker. Instead we wait for the 'active' event
 * (or use it immediately if we're already active), keep the flag up for one
 * extra tick so the lock handler still sees isPicking()=true, and fall back to
 * a hard timeout so the flag can never stick if no transition is observed.
 */
function clearWhenActive(): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    sub.remove();
    // One extra tick so App.tsx's AppState('active') handler reads the guard.
    setTimeout(() => { _picking = false; }, 250);
  };
  const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') finish();
  });
  // The picker promise can resolve after the app is already active again.
  if (AppState.currentState === 'active') finish();
  // Safety net: never leave the guard stuck if no 'active' transition arrives.
  const fallback = setTimeout(finish, 4000);
}
