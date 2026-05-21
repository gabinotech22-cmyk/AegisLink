import { useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { PrimaryButton } from '../components/Button';
import { parseIdentityQR } from '../crypto/qr';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import type { StoredContact } from '../db/local';

interface Props {
  onCancel: () => void;
  onAdded: (contact: StoredContact) => void;
}

export function ScanQRScreen({ onCancel, onAdded }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  // Lock so a single QR doesn't fire onBarcodeScanned dozens of times in a row.
  const handledRef = useRef<string | null>(null);
  const addFromQR = useContacts((s) => s.addFromQR);
  const confirmKeyChange = useContacts((s) => s.confirmKeyChange);
  const identity = useIdentity((s) => s.identity);

  async function handleScan(result: BarcodeScanningResult) {
    if (busy) return;
    if (handledRef.current === result.data) return;
    const parsed = parseIdentityQR(result.data);
    if (!parsed) {
      handledRef.current = result.data;
      Alert.alert(
        i18nT('scanQR.invalidTitle', 'Not an AegisLink QR'),
        i18nT('scanQR.invalidDesc', 'Try again with a code generated inside AegisLink.'),
        [
          { text: i18nT('common.ok', 'OK'), onPress: () => (handledRef.current = null) },
        ]
      );
      return;
    }
    handledRef.current = result.data;
    setBusy(true);
    try {
      const outcome = await addFromQR(parsed.aegisId, parsed.publicKeyB64);
      if (outcome.kind === 'mitm_detected') {
        Alert.alert(
          i18nT('scanQR.mitmTitle', '⚠️ Key Changed'),
          i18nT('scanQR.mitmDesc', 'This contact had a different saved key. If you recognize them and they simply changed devices, accept. Otherwise, cancel to protect your privacy.\n\nOld key: ...{{oldKey}}\nNew key: ...{{newKey}}', {
            oldKey: outcome.oldKey.slice(-8),
            newKey: outcome.newKey.slice(-8),
          }),
          [
            {
              text: i18nT('scanQR.acceptNewKey', 'Accept new key'),
              style: 'default',
              onPress: async () => {
                const updated = await confirmKeyChange(outcome.contact.aegisId, outcome.newKey);
                if (updated) onAdded(updated);
              },
            },
            {
              text: i18nT('common.cancel', 'Cancel'),
              style: 'cancel',
              onPress: () => { handledRef.current = null; setBusy(false); },
            },
          ]
        );
        return;
      } else {
        // Send our profile (with avatar) to the new contact immediately
        if (identity) {
          const { sendProfileTo } = require('../socket/client') as typeof import('../socket/client');
          void sendProfileTo(outcome.contact, identity);
        }
        onAdded(outcome.contact);
      }
    } catch (e) {
      Alert.alert(
        i18nT('scanQR.addError', 'Could not add contact'),
        (e as Error).message,
        [
          { text: i18nT('common.ok', 'OK'), onPress: () => (handledRef.current = null) },
        ]
      );
    } finally {
      setBusy(false);
    }
  }

  if (!permission) {
    return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  }
  if (!permission.granted) {
    return (
      <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
        <View style={styles.top}>
          <Pressable onPress={onCancel} hitSlop={8} style={{ padding: 6 }}>
            <I.ChevronL size={22} color={t.text} />
          </Pressable>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
            {i18nT('scanQR.title', 'Scan QR')}
          </Text>
          <View style={{ width: 22 }} />
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text
            style={{
              fontFamily: t.fontDisplay,
              fontSize: 22,
              color: t.text,
              fontWeight: '600',
              marginBottom: 8,
              textAlign: 'center',
            }}
          >
            {i18nT('scanQR.permNeededTitle', 'Camera permission needed')}
          </Text>
          <Text
            style={{
              fontFamily: t.font,
              fontSize: 14,
              color: t.textDim,
              textAlign: 'center',
              lineHeight: 20,
              marginBottom: 22,
            }}
          >
            {i18nT('scanQR.permNeededDesc', "We only use the camera to read a peer's QR code. Nothing is recorded or sent anywhere.")}
          </Text>
          <PrimaryButton t={t} label={i18nT('scanQR.allowCameraBtn', 'Allow camera')} onPress={() => void requestPermission()} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: '#000', paddingTop: insets.top }]}>
      <View style={[styles.top, { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
        <Pressable onPress={onCancel} hitSlop={8} style={{ padding: 6 }}>
          <I.X size={24} color="#fff" />
        </Pressable>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: '#fff' }}>
          {i18nT('scanQR.title', 'Scan QR')}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleScan}
      />

      {/* Viewfinder overlay */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={[styles.viewfinder, { borderColor: t.accent }]} />
        <Text
          style={{
            fontFamily: t.fontMono,
            fontSize: 11,
            color: '#fff',
            letterSpacing: 1.1,
            marginTop: 18,
            textAlign: 'center',
          }}
        >
          {busy ? i18nT('common.loading', 'ADDING…').toUpperCase() : i18nT('scanQR.instruction', 'POINT AT A PEER’S QR').toUpperCase()}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    zIndex: 2,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewfinder: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
});
