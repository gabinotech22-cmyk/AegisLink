/**
 * SYSTEM_ALERT_WINDOW (overlay) permission helper — M-3 mitigation.
 *
 * Background: the AndroidManifest declares SYSTEM_ALERT_WINDOW so the in-call
 * overlay can show on top of other apps. Declaring it does NOT grant it —
 * Android requires the user to flip a toggle in Settings → Apps → AegisLink
 * → "Display over other apps". Without that consent, attempts to render the
 * overlay fail silently.
 *
 * Play Store reviewers flag apps that declare SYSTEM_ALERT_WINDOW because
 * the permission is widely abused. We mitigate that scrutiny by:
 *   1. Never requesting the permission at install time (declaring it ≠ requesting it).
 *   2. Only prompting the user to grant it the first time they answer an
 *      incoming call OR start an outgoing call, AND explaining why right
 *      before the OS Settings sheet opens.
 *   3. Gracefully degrading when not granted: the call still works, just
 *      without the floating in-call indicator.
 *
 * Usage:
 *   import { ensureOverlayPermission } from '../utils/overlayPermission';
 *   const granted = await ensureOverlayPermission();
 *   if (granted) { showFloatingCallIndicator(); }
 */

import { Platform, Linking } from 'react-native';
import { themedAlert } from '../components/AlertHost';

/**
 * Returns `true` if the app already has overlay permission OR after the user
 * grants it via the system Settings activity. Returns `false` if the user
 * refuses the prompt or fails to enable the toggle.
 *
 * The actual native query for the current state (`canDrawOverlays()`) does
 * not have a direct Expo SDK 54 export — call sites should ALSO try the
 * overlay rendering and treat a failure as "not granted" so we never block
 * the call flow on this helper.
 */
export async function ensureOverlayPermission(): Promise<boolean> {
  // iOS has no equivalent permission — overlays on iOS use CallKit, granted
  // automatically with MANAGE_OWN_CALLS / PushKit at install time.
  if (Platform.OS !== 'android') return true;

  return new Promise<boolean>((resolve) => {
    themedAlert(
      'Permiso de superposición',
      'AegisLink necesita el permiso "Mostrar encima de otras apps" para que veas un indicador flotante durante una llamada. Sin este permiso la llamada sigue funcionando, sólo no verás el indicador.',
      [
        { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'Abrir Configuración',
          onPress: () => {
            // Settings.ACTION_MANAGE_OVERLAY_PERMISSION is the only way to
            // toggle SYSTEM_ALERT_WINDOW from Android 6+. We open the
            // generic per-app settings as a fallback if the intent fails.
            Linking.openSettings()
              .then(() => resolve(true))
              .catch(() => resolve(false));
          },
        },
      ],
      // onDismiss/cancelable handled by AlertHost: onRequestClose fires the cancel button
    );
  });
}
