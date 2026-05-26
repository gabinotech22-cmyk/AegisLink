import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Share, ActivityIndicator } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useIdentity } from '../store/identity';
import { fingerprintWords, fingerprintHex } from '../crypto/fingerprint';
import { encodeIdentityQR } from '../crypto/qr';

interface Props {
  onBack: () => void;
  onScan: () => void;
}

/**
 * "Show my identity" screen. Peers scan this QR or compare 8 words side-by-side
 * to verify they got the right pubkey out-of-band (defeats directory MITM).
 */
export function VerifyScreen({ onBack, onScan }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const [words, setWords] = useState<string[]>([]);
  const [hex, setHex] = useState<string[]>([]);

  useEffect(() => {
    if (identity) {
      setWords(fingerprintWords(identity.publicKey));
      setHex(fingerprintHex(identity.publicKey));
    }
  }, [identity]);

  if (!identity) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={t.accent} />
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 12 }}>
          {i18nT('verify.loading', 'Loading identity…')}
        </Text>
      </View>
    );
  }

  const qrPayload = encodeIdentityQR(identity.aegisId, identity.publicKeyB64);

  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.top}>
        <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text, letterSpacing: -0.4 }}>
          {i18nT('verify.title', 'Verify')}
        </Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 40, alignItems: 'center' }}>
        <Text
          style={{
            fontFamily: t.font,
            fontSize: 14,
            color: t.textDim,
            textAlign: 'center',
            lineHeight: 21,
            marginVertical: 12,
            maxWidth: 320,
          }}
        >
          {i18nT('verify.desc', "Show this QR to your peer in person, or read the 8 safety words aloud. Matching = no one's in the middle.")}
        </Text>

        <View
          style={{
            padding: 20,
            backgroundColor: t.surface,
            borderRadius: t.radius,
            borderWidth: 1,
            borderColor: t.borderStrong,
            marginTop: 6,
          }}
        >
          <QRCode
            value={qrPayload}
            size={220}
            color={t.dark ? t.accent : t.text}
            backgroundColor={t.surface}
          />
        </View>

        <Text style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text, marginTop: 18, letterSpacing: 0.6 }}>
          {identity.aegisId}
        </Text>

        <Text
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textDim,
            letterSpacing: 1.2,
            marginTop: 24,
            marginBottom: 10,
          }}
        >
          {i18nT('verify.orWords', 'OR — 8 SAFETY WORDS')}
        </Text>

        <View
          style={{
            width: '100%',
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
            padding: 14,
            backgroundColor: t.surface,
          }}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {words.map((w, i) => (
              <View
                key={i}
                style={{
                  width: '48%',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  backgroundColor: t.surface2,
                  borderRadius: t.radiusS,
                }}
              >
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, width: 14 }}>
                  {(i + 1).toString().padStart(2, '0')}
                </Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text, fontWeight: '500' }}>
                  {w}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <Text
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textDim,
            letterSpacing: 1.2,
            marginTop: 24,
            marginBottom: 8,
          }}
        >
          {i18nT('verify.keyFingerprint', 'KEY FINGERPRINT (HEX)')}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
          {hex.map((g, i) => (
            <Text
              key={i}
              style={{
                fontFamily: t.fontMono,
                fontSize: 13,
                color: t.text,
                paddingHorizontal: 8,
                paddingVertical: 4,
                backgroundColor: t.surface2,
                borderRadius: t.radiusS,
              }}
            >
              {g}
            </Text>
          ))}
        </View>

        <Pressable
          onPress={onScan}
          style={({ pressed }) => ({
            marginTop: 28,
            backgroundColor: pressed ? t.surface2 : 'transparent',
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
            paddingVertical: 14,
            paddingHorizontal: 22,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          })}
          accessibilityLabel={i18nT('verify.scanPeer', "Scan a peer's QR")}
        >
          <I.QR size={18} color={t.text} />
          <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text, fontWeight: '500' }}>
            {i18nT('verify.scanPeer', "Scan a peer's QR")}
          </Text>
        </Pressable>

        <Pressable
          onPress={async () => {
            await Share.share({
              title: i18nT('verify.shareTitle', 'Mi contacto AegisLink'),
              message: `${i18nT('verify.shareMessage', 'Add me on AegisLink:')}\naegislink://v1/${identity.aegisId}/${encodeURIComponent(identity.publicKeyB64)}\n\n${i18nT('verify.shareId', 'Or use my ID:')} ${identity.aegisId}`,
            });
          }}
          style={({ pressed }) => ({
            marginTop: 12,
            backgroundColor: pressed ? t.surface2 : 'transparent',
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
            paddingVertical: 14,
            paddingHorizontal: 22,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          })}
          accessibilityLabel={i18nT('verify.shareContactLabel', 'Compartir mi contacto')}
        >
          <I.Forward size={18} color={t.text} />
          <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text, fontWeight: '500' }}>
            {i18nT('verify.shareContact', 'Compartir mi contacto')}
          </Text>
        </Pressable>
      </ScrollView>

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
  },
});
