import { useEffect, useRef } from 'react';
;
import { ss } from '../utils/secureStore';
import { themedAlert } from '../components/AlertHost';

const PANIC_KEY = 'aegis.panic.v1';
const SHAKE_THRESHOLD = 2.8; // g-force magnitude
const SHAKE_DEBOUNCE_MS = 1000; // prevent repeated triggers within 1s
const TAP_WINDOW_MS = 800; // window in which 3 taps must occur
const TAP_COUNT_REQUIRED = 3;

interface PanicConfig {
  gesture?: string; // 'off' | 'shake' | 'tap' | 'hold' | 'volume' (legacy)
}

interface AccelerometerMeasurement {
  x: number;
  y: number;
  z: number;
}

interface SensorSubscription {
  remove: () => void;
}

interface AccelerometerModule {
  setUpdateInterval: (ms: number) => void;
  addListener: (
    listener: (measurement: AccelerometerMeasurement) => void
  ) => SensorSubscription;
}

export interface UsePanicGestureReturn {
  /** Call this on every tap of the trigger element when gesture === 'tap' */
  registerTap: () => void;
  /**
   * Wire to `onLongPress` with `delayLongPress={3000}` on the trigger element.
   * Only fires when gesture === 'hold'. Triggers directly — a 3-second
   * intentional press is unambiguous enough to skip the confirmation dialog.
   */
  registerLongPress: () => void;
}

/**
 * Reads panic configuration from SecureStore and wires up the appropriate
 * gesture listener. When the gesture fires, `onTrigger` is called.
 *
 * Supported gestures:
 *   - 'shake'  → Accelerometer magnitude > SHAKE_THRESHOLD (shows confirmation)
 *   - 'tap'    → call registerTap() 3 times within 800ms (shows confirmation)
 *   - 'hold'   → call registerLongPress() after onLongPress fires (3s, no dialog)
 *   - 'volume' → legacy value; silently no-op (removed from UI in v2)
 *   - 'off'    → no listeners registered
 *
 * IMPORTANT: wrap `onTrigger` in useCallback at the call site to keep the
 * ref stable and avoid unnecessary re-registrations.
 */
export function usePanicGesture(onTrigger: () => void): UsePanicGestureReturn {
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShakeRef = useRef(0);
  const gestureRef = useRef<string>('off');
  // Capture onTrigger in a ref so the Accelerometer listener always calls the
  // latest version without needing to re-subscribe.
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  useEffect(() => {
    let subAccel: SensorSubscription | null = null;

    async function setup(): Promise<void> {
      try {
        const raw = await ss.get(PANIC_KEY);
        if (!raw) return;
        const config = JSON.parse(raw) as PanicConfig;
        gestureRef.current = config.gesture ?? 'off';
      } catch {
        if (__DEV__) console.warn('[usePanicGesture] Failed to read panic config');
        return;
      }

      if (gestureRef.current === 'hold') {
        // Nothing to set up — hold is handled entirely via registerLongPress()
        // which is wired to onLongPress on the trigger element in the component.
      } else if (gestureRef.current === 'shake') {
        try {
          // require at runtime to avoid a hard dependency on expo-sensors at
          // module load — allows Expo Go environments without the package to
          // still run the app (shake gesture simply won't fire).
          const sensors = require('expo-sensors') as { Accelerometer: AccelerometerModule };
          sensors.Accelerometer.setUpdateInterval(100);
          subAccel = sensors.Accelerometer.addListener(
            ({ x, y, z }: AccelerometerMeasurement) => {
              const magnitude = Math.sqrt(x * x + y * y + z * z);
              const now = Date.now();
              if (
                magnitude > SHAKE_THRESHOLD &&
                now - lastShakeRef.current > SHAKE_DEBOUNCE_MS
              ) {
                lastShakeRef.current = now;
                themedAlert(
                  '¿Borrar todo?',
                  'Esta acción es irreversible. Todos los mensajes, contactos y claves serán eliminados.',
                  [
                    { text: 'Cancelar', style: 'cancel' },
                    {
                      text: 'Borrar',
                      style: 'destructive',
                      onPress: () => onTriggerRef.current(),
                    },
                  ],
                );
              }
            }
          );
        } catch {
          if (__DEV__) console.warn('[usePanicGesture] expo-sensors not available — shake gesture disabled');
        }
      }
      // 'hold' is handled via registerLongPress() — no listener needed here.
      // 'volume' key is no longer offered in the UI; kept as a silent no-op for
      //   any configs persisted from older builds.
      // 'tap' is handled via registerTap() below.
      // 'off' — nothing to register.
    }

    void setup();

    return () => {
      subAccel?.remove();
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
    };
    // onTrigger is intentionally excluded — we use onTriggerRef to avoid
    // re-registering the Accelerometer listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function registerTap(): void {
    if (gestureRef.current !== 'tap') return;

    tapCountRef.current += 1;

    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
      tapTimerRef.current = null;
    }, TAP_WINDOW_MS);

    if (tapCountRef.current >= TAP_COUNT_REQUIRED) {
      tapCountRef.current = 0;
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      themedAlert(
        '¿Borrar todo?',
        'Esta acción es irreversible. Todos los mensajes, contactos y claves serán eliminados.',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Borrar',
            style: 'destructive',
            onPress: () => onTriggerRef.current(),
          },
        ],
      );
    }
  }

  function registerLongPress(): void {
    if (gestureRef.current !== 'hold') return;
    // A 3-second intentional long press is deliberate — fire directly.
    onTriggerRef.current();
  }

  return { registerTap, registerLongPress };
}
