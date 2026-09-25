/**
 * RelayQrScanner — full-screen camera modal used by "My relay" to read a
 * self-hosted relay's address from the QR that `infra/selfhost/up.sh` /
 * `print-onion.sh` print (`http://<56 chars>.onion`). Typing a 56-character
 * onion on a phone is where non-technical users gave up; this is the
 * "a friend runs the relay" path.
 *
 * Only a valid Tor v3 onion is accepted (net/relayRef.normalizeOnion) — a
 * contact or group QR is rejected with a hint, never interpreted. Nothing is
 * recorded or sent: the decoded onion is handed back to the screen, which
 * still requires Verify + confirmation before any switch.
 */
import React, { useRef, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';
import { PrimaryButton } from './Button';
import { normalizeOnion } from '../net/relayRef';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called once with the canonical `<56>.onion` host. */
  onOnion: (onion: string) => void;
}

export function RelayQrScanner({ visible, onClose, onOnion }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [rejected, setRejected] = useState(false);
  // The camera fires onBarcodeScanned many times per second for one code.
  const lastRef = useRef<string | null>(null);

  const handleScan = (result: BarcodeScanningResult) => {
    if (lastRef.current === result.data) return;
    lastRef.current = result.data;
    const onion = normalizeOnion(result.data);
    if (!onion) { setRejected(true); return; }
    setRejected(false);
    lastRef.current = null;
    onOnion(onion);
  };

  const close = () => { lastRef.current = null; setRejected(false); onClose(); };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.screen, { backgroundColor: '#000', paddingTop: insets.top }]} testID="relay-qr-scanner">
        <View style={[styles.top, { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
          <Pressable onPress={close} hitSlop={8} style={{ padding: 6 }} testID="relay-qr-close" accessibilityLabel={i18nT('common.cancel', 'Cancel')}>
            <I.X size={24} color="#fff" />
          </Pressable>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: '#fff' }}>
            {i18nT('relaySettings.scanTitle')}
          </Text>
          <View style={{ width: 24 }} />
        </View>

        {!permission ? null : !permission.granted ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, backgroundColor: t.bg }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 20, color: t.text, fontWeight: '600', marginBottom: 8, textAlign: 'center' }}>
              {i18nT('scanQR.permNeededTitle', 'Camera permission needed')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center', lineHeight: 20, marginBottom: 22 }}>
              {i18nT('relaySettings.scanPermDesc')}
            </Text>
            <PrimaryButton t={t} label={i18nT('scanQR.allowCameraBtn', 'Allow camera')} onPress={() => void requestPermission()} />
          </View>
        ) : (
          <>
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleScan}
            />
            <View style={styles.overlay} pointerEvents="none">
              <View style={[styles.viewfinder, { borderColor: rejected ? t.danger : t.accent }]} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: '#fff', letterSpacing: 1.1, marginTop: 18, textAlign: 'center', paddingHorizontal: 28 }} testID="relay-qr-hint">
                {rejected ? i18nT('relaySettings.scanNotRelay') : i18nT('relaySettings.scanHint').toUpperCase()}
              </Text>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, zIndex: 2 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  viewfinder: { width: 240, height: 240, borderWidth: 2, borderRadius: 12, backgroundColor: 'transparent' },
});
