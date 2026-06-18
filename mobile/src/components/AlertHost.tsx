/**
 * AlertHost — themed imperative dialog replacing React Native's native Alert.alert.
 *
 * Usage (from any module, including non-React files):
 *   import { themedAlert } from '../components/AlertHost';
 *   themedAlert('Title', 'Message', [
 *     { text: 'Cancel', style: 'cancel' },
 *     { text: 'Delete', style: 'destructive', onPress: () => doDelete() },
 *   ]);
 *
 * Mount <AlertHost /> once near the root of the app (inside ThemeProvider).
 * Multiple concurrent calls are queued and shown sequentially.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { useTranslation } from 'react-i18next';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ThemedAlertButton {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

interface AlertRequest {
  title: string;
  message?: string;
  buttons: ThemedAlertButton[];
}

// ─── Module-level emitter ─────────────────────────────────────────────────────
// A simple callback bus: the mounted <AlertHost /> registers itself here.
// themedAlert() pushes requests and notifies the host to show the next one.

type Listener = (req: AlertRequest) => void;

let _listener: Listener | null = null;
const _queue: AlertRequest[] = [];

function _flush(): void {
  if (_listener && _queue.length > 0) {
    const next = _queue[0];
    // listener consumes the first item; it will call _dequeue() when dismissed.
    _listener(next);
  }
}

function _dequeue(): void {
  _queue.shift();
  _flush();
}

/**
 * Drop-in replacement for Alert.alert.
 * Can be called from any file, including non-React modules (socket handlers, etc.).
 * If no <AlertHost> is mounted yet, the request is queued and shown when it mounts.
 */
export function themedAlert(
  title: string,
  message?: string,
  buttons?: ThemedAlertButton[],
): void {
  const resolvedButtons: ThemedAlertButton[] =
    buttons && buttons.length > 0 ? buttons : [{ text: 'OK', style: 'default' }];

  _queue.push({ title, message, buttons: resolvedButtons });

  if (_queue.length === 1) {
    // Only flush immediately if this is the only pending item
    _flush();
  }
  // If there were already items, the host will call _dequeue() → _flush() on dismiss.
}

// ─── <AlertHost /> component ──────────────────────────────────────────────────

export function AlertHost(): React.ReactElement | null {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();

  const [current, setCurrent] = useState<AlertRequest | null>(null);
  const dismissRef = useRef<(() => void) | null>(null);

  // Register listener on mount, unregister on unmount.
  useEffect(() => {
    const listener: Listener = (req) => {
      // Resolve default "OK" button label via i18n now that we're in React context
      const buttons = req.buttons.map((b) =>
        b.text === 'OK' ? { ...b, text: i18nT('common.ok', 'OK') } : b,
      );
      setCurrent({ ...req, buttons });
    };
    _listener = listener;

    // Flush any requests that arrived before mount
    _flush();

    return () => {
      if (_listener === listener) _listener = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = (onPress?: () => void) => {
    setCurrent(null);
    // Small delay so the modal fade-out animation completes before onPress fires
    // and before we show the next queued dialog (avoids z-order flash).
    setTimeout(() => {
      _dequeue();
      if (onPress) onPress();
    }, 200);
  };

  dismissRef.current = () => dismiss();

  if (!current) return null;

  const { title, message, buttons } = current;
  const useColumn = buttons.length >= 3;

  // Find cancel button for Android back / onRequestClose
  const cancelBtn = buttons.find((b) => b.style === 'cancel');

  return (
    <Modal
      visible={!!current}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => dismiss(cancelBtn?.onPress)}
    >
      <View style={styles.overlay}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: t.surface,
              borderColor: t.border,
            },
          ]}
        >
          {/* Title */}
          <Text
            style={[
              styles.title,
              { fontFamily: t.fontDisplay, color: t.text },
            ]}
          >
            {title}
          </Text>

          {/* Message */}
          {!!message && (
            <Text
              style={[
                styles.message,
                { fontFamily: t.font, color: t.textDim },
              ]}
            >
              {message}
            </Text>
          )}

          {/* Buttons */}
          <View
            style={[
              styles.buttonRow,
              useColumn && styles.buttonColumn,
            ]}
          >
            {buttons.map((btn, idx) => {
              const isDestructive = btn.style === 'destructive';
              const isCancel = btn.style === 'cancel';

              const containerStyle: ViewStyle = isDestructive
                ? {
                    backgroundColor: t.danger,
                    borderWidth: 0,
                  }
                : isCancel
                  ? {
                      backgroundColor: 'transparent',
                      borderWidth: 1,
                      borderColor: t.borderStrong,
                    }
                  : {
                      backgroundColor: t.accent,
                      borderWidth: 0,
                    };

              const textColor = isDestructive
                ? '#ffffff'
                : isCancel
                  ? t.text
                  : t.accentInk;

              return (
                <Pressable
                  key={idx}
                  accessibilityRole="button"
                  accessibilityLabel={btn.text}
                  onPress={() => dismiss(btn.onPress)}
                  style={({ pressed }) => [
                    styles.button,
                    containerStyle,
                    !useColumn && { flex: 1 },
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  <Text
                    style={[
                      styles.buttonText,
                      { fontFamily: t.font, color: textColor },
                    ]}
                  >
                    {btn.text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'stretch',
    padding: 24,
  },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  message: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 20,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  buttonColumn: {
    flexDirection: 'column',
  },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
