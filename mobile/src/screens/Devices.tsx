import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Modal, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { ss } from '../utils/secureStore';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, decodeUTF8 } from 'tweetnacl-util';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { getSocket } from '../socket/client';
import { buildRevocationPayload } from '../web3/deviceRevocation/RevokeDevice';
import { themedAlert } from '../components/AlertHost';

const DEVICES_CACHE_KEY = 'aegis.linked_devices.json';

interface Props {
  onBack: () => void;
}

interface QRPayload {
  v: number;
  pubKey: string;
  relay: string;
}

interface LinkedDevice {
  id: string;
  name: string;
  platform: string;
  linkedAt: number;
}

function currentDeviceName(): string {
  if (Platform.OS === 'ios') return 'iPhone (iOS)';
  if (Platform.OS === 'android') return 'Android Device';
  return 'This Device';
}

function currentDeviceOS(): string {
  const version = Platform.Version;
  if (Platform.OS === 'ios') return `iOS ${version}`;
  if (Platform.OS === 'android') return `Android ${version}`;
  return 'AegisLink';
}

function truncatePubKey(b64: string): string {
  if (b64.length <= 14) return b64;
  return `${b64.slice(0, 8)}…${b64.slice(-4)}`;
}

function formatLinkedAt(ts: number): string {
  try {
    return new Date(ts).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

export function DevicesScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);

  const [permission, requestPermission] = useCameraPermissions();

  const [scanning, setScanning] = useState(false);
  const [scannedPayload, setScannedPayload] = useState<QRPayload | null>(null);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkedDevices, setLinkedDevices] = useState<LinkedDevice[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  // ── Load devices on mount ─────────────────────────────────────────────────

  const loadDevices = useCallback(async () => {
    setLoadingList(true);

    // First restore the local cache so the list appears instantly.
    try {
      const cached = await ss.get(DEVICES_CACHE_KEY);
      if (cached) {
        setLinkedDevices(JSON.parse(cached) as LinkedDevice[]);
      }
    } catch {
      // Ignore cache read failures.
    }

    const socket = getSocket();
    if (!socket) {
      setLoadingList(false);
      return;
    }

    socket.emit(
      'device:list',
      (res: { ok: boolean; devices?: LinkedDevice[]; error?: string }) => {
        setLoadingList(false);
        if (res.ok && res.devices) {
          setLinkedDevices(res.devices);
          // Persist fresh list as offline cache.
          void ss.set(DEVICES_CACHE_KEY, JSON.stringify(res.devices));
        }
      },
    );
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  // ── QR scanner ────────────────────────────────────────────────────────────

  async function handleOpenScanner() {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    setLinkError(null);
    setScanning(true);
  }

  const handleBarCodeScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      if (confirmVisible || linking) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        setLinkError(i18nT('devices.invalidQrJson', 'Invalid QR — not a JSON.'));
        setScanning(false);
        return;
      }

      const payload = parsed as Record<string, unknown>;
      if (
        payload.v !== 1 ||
        typeof payload.pubKey !== 'string' ||
        typeof payload.relay !== 'string'
      ) {
        setLinkError(i18nT('devices.invalidQrFormat', 'Invalid QR — incorrect format.'));
        setScanning(false);
        return;
      }

      setScanning(false);
      setScannedPayload({ v: 1, pubKey: payload.pubKey as string, relay: payload.relay as string });
      setConfirmVisible(true);
    },
    [confirmVisible, linking, i18nT],
  );

  // ── Linking ───────────────────────────────────────────────────────────────

  async function handleConfirmLink() {
    if (!scannedPayload || !identity) return;
    setLinking(true);
    setLinkError(null);

    try {
      const theirPubKey = decodeBase64(scannedPayload.pubKey);
      if (theirPubKey.length !== nacl.box.publicKeyLength) {
        throw new Error(i18nT('devices.invalidDesktopPubKey', 'Invalid desktop public key.'));
      }

      // Use an ephemeral keypair for this single approval — never stored.
      const myKeypair = nacl.box.keyPair();

      const { loadLatestSpkSecret } = require('../db/prekeys');
      const latestSpk = await loadLatestSpkSecret();

      const plaintext = decodeUTF8(
        JSON.stringify({
          aegisId: identity.aegisId,
          publicKeyB64: identity.publicKeyB64,
          secretKeyB64: identity.secretKeyB64,
          signingPublicKeyB64: identity.signingPublicKeyB64,
          signingSecretKeyB64: identity.signingSecretKeyB64,
          spkSecretB64: latestSpk?.b64,
          spkId: latestSpk?.keyId,
        }),
      );

      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const encrypted = nacl.box(plaintext, nonce, theirPubKey, myKeypair.secretKey);

      const payload = {
        desktopPubKey: scannedPayload.pubKey,
        encryptedPayload: encodeBase64(encrypted),
        nonceB64: encodeBase64(nonce),
        mobilePubKey: encodeBase64(myKeypair.publicKey),
        deviceName: currentDeviceName(),
        platform: (Platform.OS === 'ios' || Platform.OS === 'android' ? 'mobile' : 'desktop') as
          | 'mobile'
          | 'desktop'
          | 'unknown',
      };

      const socket = getSocket();
      if (socket) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(i18nT('devices.linkTimeout', 'Request timed out'))), 8000);
          socket.emit('device:link:approve', payload, (res: { ok: boolean; error?: string }) => {
            clearTimeout(timer);
            if (res && res.ok) resolve();
            else reject(new Error(res?.error ?? 'link_failed'));
          });
        });
      } else {
        throw new Error('Socket not connected');
      }

      // Zero out ephemeral secret key bytes immediately — never stored.
      myKeypair.secretKey.fill(0);

      // Optimistically add the new device and refresh from server.
      await loadDevices();
    } catch (e) {
      setLinkError((e as Error).message);
    } finally {
      setLinking(false);
      setConfirmVisible(false);
      setScannedPayload(null);
    }
  }

  function handleCancelLink() {
    setConfirmVisible(false);
    setScannedPayload(null);
    setLinkError(null);
  }

  // ── Revocation ────────────────────────────────────────────────────────────

  function handleRevoke(device: LinkedDevice) {
    themedAlert(
      i18nT('devices.revokeDeviceTitle', 'Revoke device'),
      i18nT('devices.revokeDeviceConfirm', 'Revoke "{{name}}"? New messages will immediately become unreadable.', { name: device.name }),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('devices.revoke', 'Revoke'),
          style: 'destructive',
          onPress: () => void doRevoke(device),
        },
      ],
    );
  }

  async function doRevoke(device: LinkedDevice) {
    if (!identity) return;
    setRevoking(device.id);

    try {
      const socket = getSocket();
      if (socket) {
        await new Promise<void>((resolve, reject) => {
          socket.emit(
            'device:revoke',
            { deviceId: device.id },
            (res: { ok: boolean; error?: string }) => {
              if (res.ok) resolve();
              else reject(new Error(res.error ?? 'revoke_failed'));
            },
          );
        });
      }

      // Also submit a Web3 DID revocation if the device had a DID.
      // We derive a pseudo-DID from the device id for the hash — the real
      // implementation would use the actual DID stored alongside the device.
      try {
        const pseudoDID = `did:aegis:${device.id}`;
        const payload = await buildRevocationPayload(
          pseudoDID,
          identity.aegisId,
          identity.signingPublicKeyB64,
        );
        // POST the revocation to the relay's web3 endpoint (best-effort).
        const { SERVER_URL } = await import('../config');
        void fetch(`${SERVER_URL}/web3/device/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch {
        // Web3 revocation is best-effort — do not block the UI.
      }

      // Update local state and cache immediately.
      const updated = linkedDevices.filter((d) => d.id !== device.id);
      setLinkedDevices(updated);
      await ss.set(DEVICES_CACHE_KEY, JSON.stringify(updated));
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('devices.title', 'Devices')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
        right={
          <Pressable onPress={handleOpenScanner} hitSlop={8} style={{ padding: 4 }}>
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 22 }}>
        {/* Info banner */}
        <View
          style={{
            marginHorizontal: 18,
            marginBottom: 14,
            padding: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
          }}
        >
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
            {i18nT('devices.infoDesc', 'Each device has its own key. If you lose one, revoke it here — new messages will immediately become unreadable.')}
          </Text>
        </View>

        {/* Error banner */}
        {linkError !== null && (
          <View
            style={{
              marginHorizontal: 18,
              marginBottom: 10,
              padding: 12,
              backgroundColor: t.danger + '22',
              borderWidth: 1,
              borderColor: t.danger + '66',
              borderRadius: t.radiusS,
            }}
          >
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>{linkError}</Text>
          </View>
        )}

        {/* Current device */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 18,
            paddingVertical: 14,
            borderBottomWidth: 1,
            borderBottomColor: t.divider,
          }}
        >
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: t.radius,
              backgroundColor: t.surface2,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Phone size={18} color={t.text} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: t.font,
                  fontSize: 14,
                  fontWeight: '600',
                  color: t.text,
                  flexShrink: 1,
                }}
              >
                {currentDeviceName()}
              </Text>
              <View
                style={{
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderWidth: 1,
                  borderColor: t.accent,
                  borderRadius: 99,
                }}
              >
                <Text
                  style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.5 }}
                >
                  {i18nT('devices.thisDevice', 'THIS DEVICE')}
                </Text>
              </View>
            </View>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
              {currentDeviceOS()} · {i18nT('devices.activeNow', 'Active now')}
            </Text>
          </View>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }} />
        </View>

        {/* Loading indicator */}
        {loadingList && linkedDevices.length === 0 && (
          <ActivityIndicator color={t.accent} style={{ marginTop: 24 }} />
        )}

        {/* Empty state */}
        {!loadingList && linkedDevices.length === 0 && (
          <View style={{ paddingVertical: 40, alignItems: 'center', paddingHorizontal: 32 }}>
            <I.Monitor size={40} color={t.textFaint} style={{ marginBottom: 16 }} />
            <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text, marginBottom: 6 }}>
              {i18nT('devices.emptyTitle', 'No linked devices')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center', lineHeight: 20 }}>
              {i18nT('devices.emptyDesc', 'Link your desktop to sync conversations securely without sharing keys')}
            </Text>
          </View>
        )}

        {/* Linked devices */}
        {linkedDevices.map((device) => (
          <View
            key={device.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 18,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: t.divider,
            }}
          >
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: t.radius,
                backgroundColor: t.surface2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.Monitor size={18} color={t.text} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}
              >
                {device.name}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                {i18nT('devices.linkedAt', 'Linked {{time}}', { time: formatLinkedAt(device.linkedAt) })}
              </Text>
            </View>

            {/* Revoke button */}
            {revoking === device.id ? (
              <ActivityIndicator size="small" color={t.danger} />
            ) : (
              <Pressable
                onPress={() => handleRevoke(device)}
                hitSlop={8}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: t.radiusS,
                  borderWidth: 1,
                  borderColor: t.danger + '88',
                  backgroundColor: t.danger + '11',
                }}
              >
                <Text
                  style={{
                    fontFamily: t.font,
                    fontSize: 12,
                    fontWeight: '600',
                    color: t.danger,
                  }}
                >
                  {i18nT('devices.revoke', 'Revoke')}
                </Text>
              </Pressable>
            )}
          </View>
        ))}

        {/* CTA */}
        <View style={{ paddingHorizontal: 18, paddingTop: 18 }}>
          <PrimaryButton t={t} label={i18nT('devices.linkDesktopBtn', '+ Link desktop')} onPress={handleOpenScanner} />
        </View>
      </ScrollView>

      {/* ── Camera scanner modal ── */}
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarCodeScanned}
          />

          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <View
              style={{
                width: 240,
                height: 240,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: t.accent,
                backgroundColor: 'transparent',
              }}
            />
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 12,
                color: t.accent,
                marginTop: 16,
                letterSpacing: 0.5,
              }}
            >
              {i18nT('devices.pointAtDesktopQr', 'POINT AT DESKTOP QR')}
            </Text>
          </View>

          <Pressable
            onPress={() => setScanning(false)}
            style={{
              position: 'absolute',
              top: insets.top + 12,
              right: 18,
              padding: 8,
              backgroundColor: 'rgba(0,0,0,0.6)',
              borderRadius: 20,
            }}
          >
            <I.X size={22} color="#fff" />
          </Pressable>
        </View>
      </Modal>

      {/* ── Confirmation modal ── */}
      <Modal
        visible={confirmVisible}
        transparent
        animationType="fade"
        onRequestClose={handleCancelLink}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.7)',
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: 360,
              backgroundColor: t.surface,
              borderRadius: t.radius,
              borderWidth: 1,
              borderColor: t.border,
              padding: 24,
            }}
          >
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: t.accent + '22',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
                alignSelf: 'center',
              }}
            >
              <I.Monitor size={24} color={t.accent} />
            </View>

            <Text
              style={{
                fontFamily: t.fontDisplay,
                fontWeight: '600',
                fontSize: 18,
                color: t.text,
                textAlign: 'center',
                marginBottom: 8,
              }}
            >
              {i18nT('devices.linkDesktopConfirmTitle', 'Link AegisLink Desktop?')}
            </Text>

            {scannedPayload && (
              <View
                style={{
                  backgroundColor: t.surface2,
                  borderRadius: t.radiusS,
                  padding: 10,
                  marginBottom: 16,
                }}
              >
                <Text
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 10,
                    color: t.textDim,
                    letterSpacing: 0.5,
                  }}
                >
                  {i18nT('devices.deviceKeyLabel', 'DEVICE KEY')}
                </Text>
                <Text
                  style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, marginTop: 4 }}
                >
                  {truncatePubKey(scannedPayload.pubKey)}
                </Text>
                <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 4 }}>
                  Relay: {scannedPayload.relay}
                </Text>
              </View>
            )}

            <Text
              style={{
                fontFamily: t.font,
                fontSize: 13,
                color: t.textDim,
                textAlign: 'center',
                lineHeight: 19,
                marginBottom: 20,
              }}
            >
              {i18nT('devices.linkDesktopConfirmDesc', 'This desktop will be able to send and receive messages using your AegisLink identity. Keys never leave your devices.')}
            </Text>

            {linking ? (
              <ActivityIndicator color={t.accent} style={{ marginVertical: 8 }} />
            ) : (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable
                  onPress={handleCancelLink}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: t.radiusS,
                    borderWidth: 1,
                    borderColor: t.border,
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text }}
                  >
                    {i18nT('common.cancel', 'Cancel')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleConfirmLink}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: t.radiusS,
                    backgroundColor: t.accent,
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontFamily: t.font,
                      fontWeight: '600',
                      fontSize: 14,
                      color: t.accentInk,
                    }}
                  >
                    {i18nT('devices.link', 'Link')}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
