import { useEffect } from 'react';
import { DeviceEventEmitter, Platform } from 'react-native';

// expo-keep-awake is included in Expo SDK 54
let activateKeepAwakeAsync: ((tag: string) => Promise<void>) | null = null;
let deactivateKeepAwake: ((tag: string) => void) | null = null;
try {
  const kaw = require('expo-keep-awake') as {
    activateKeepAwakeAsync: (tag: string) => Promise<void>;
    deactivateKeepAwake: (tag: string) => void;
  };
  activateKeepAwakeAsync = kaw.activateKeepAwakeAsync;
  deactivateKeepAwake = kaw.deactivateKeepAwake;
} catch { /* expo-keep-awake not available */ }

export function useProximitySensor(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    // Keep screen awake during calls (prevents accidental sleep mid-call)
    void activateKeepAwakeAsync?.('aegis-call');

    // Android: listen to native proximity event
    let sub: ReturnType<typeof DeviceEventEmitter.addListener> | null = null;

    if (Platform.OS === 'android') {
      try {
        sub = DeviceEventEmitter.addListener('proximityDidChange', (data: { isNear: boolean }) => {
          if (data.isNear) {
            // Phone is near ear — dim screen brightness
            try {
              const Brightness = require('expo-brightness') as {
                setBrightnessAsync: (v: number) => Promise<void>;
              };
              void Brightness.setBrightnessAsync(0);
            } catch { /* expo-brightness not installed — no-op */ }
          } else {
            try {
              const Brightness = require('expo-brightness') as {
                restoreSystemBrightnessAsync: () => Promise<void>;
              };
              void Brightness.restoreSystemBrightnessAsync();
            } catch { /* no-op */ }
          }
        });
      } catch { /* proximity not available */ }
    }

    // iOS: proximity managed at native level when audioMode.allowsRecordingIOS = true
    // No JS-side handling needed on iOS

    return () => {
      sub?.remove();
      deactivateKeepAwake?.('aegis-call');
      try {
        const Brightness = require('expo-brightness') as {
          restoreSystemBrightnessAsync: () => Promise<void>;
        };
        void Brightness.restoreSystemBrightnessAsync();
      } catch { /* no-op */ }
    };
  }, [active]);
}
