import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const PANIC_KEY = 'aegis.panic.v1';
const SHAKE_THRESHOLD = 2.8; // g-force magnitude
const SHAKE_DEBOUNCE_MS = 1000; // prevent repeated triggers within 1s
const TAP_WINDOW_MS = 800; // window in which 3 taps must occur
const TAP_COUNT_REQUIRED = 3;

interface PanicConfig {
  gesture?: string; // 'off' | 'shake' | 'volume' | 'tap'
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
}

/**
 * Reads panic configuration from SecureStore and wires up the appropriate
 * gesture listener. When the gesture fires, `onTrigger` is called.
 *
 * Supported gestures:
 *   - 'shake'  → Accelerometer magnitude > SHAKE_THRESHOLD
 *   - 'tap'    → call registerTap() 3 times within 800ms
 *   - 'volume' → NOT available in Expo managed workflow; no-op
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
        const raw = await SecureStore.getItemAsync(PANIC_KEY);
        if (!raw) return;
        const config = JSON.parse(raw) as PanicConfig;
        gestureRef.current = config.gesture ?? 'off';
      } catch {
        if (__DEV__) console.warn('[usePanicGesture] Failed to read panic config');
        return;
      }

      if (gestureRef.current === 'shake') {
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
                Alert.alert(
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
                  { cancelable: true }
                );
              }
            }
          );
        } catch {
          if (__DEV__) console.warn('[usePanicGesture] expo-sensors not available — shake gesture disabled');
        }
      }
      // 'volume' is not available in Expo managed workflow — silently no-op.
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
      Alert.alert(
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
        { cancelable: true }
      );
    }
  }

  return { registerTap };
}
