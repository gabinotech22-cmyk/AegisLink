import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Share, ActivityIndicator, Alert } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { decodeBase64 } from 'tweetnacl-util';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { PrimaryButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { fingerprintWords, fingerprintHex } from '../crypto/fingerprint';
import { encodeIdentityQR } from '../crypto/qr';
import type { Theme } from '../theme/vault';

interface Props {
  onBack: () => void;
  onScan: () => void;
  /** If provided, show a side-by-side comparison with this contact's key words. */
  contactId?: string;
}

/**
 * "Show my identity" screen.
 *
 * Without contactId — shows own QR + 8 words to share with a peer.
 * With contactId — shows own words vs contact words side-by-side so either
 * party can confirm both match out-of-band (defeats directory MITM).
 */
export function VerifyScreen({ onBack, onScan, contactId }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const contact = useContacts((s) => (contactId ? s.get(contactId) : undefined));
  const markVerified = useContacts((s) => s.markVerified);

  const [myWords, setMyWords] = useState<string[]>([]);
  const [hex, setHex] = useState<string[]>([]);
  const [theirWords, setTheirWords] = useState<string[]>([]);

  useEffect(() => {
    if (identity) {
      setMyWords(fingerprintWords(identity.publicKey));
      setHex(fingerprintHex(identity.publicKey));
    }
  }, [identity]);

  useEffect(() => {
    if (contact?.publicKeyB64) {
      try {
        setTheirWords(fingerprintWords(decodeBase64(contact.publicKeyB64)));
      } catch {
        setTheirWords([]);
      }
    } else {
      setTheirWords([]);
    }
  }, [contact?.publicKeyB64]);

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
  const screenTitle = contactId && contact
    ? `Verificar — ${contact.name}`
    : i18nT('verify.title', 'Verify');

  // ── Comparison mode (contactId provided) ─────────────────────────────────
  if (contactId) {
    if (!contact) {
      return (
        <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
          <View style={styles.top}>
            <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }} accessibilityLabel="Volver">
              <I.ChevronL size={22} color={t.text} />
            </Pressable>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text, letterSpacing: -0.4 }}>
              Verificar
            </Text>
            <View style={{ width: 22 }} />
          </View>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 }}>
            <I.Shield size={32} color={t.textDim} />
            <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, marginTop: 12, textAlign: 'center' }}>
              Contacto no encontrado.
            </Text>
          </View>
        </View>
      );
    }

    return (
      <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
        <View style={styles.top}>
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }} accessibilityLabel="Volver">
            <I.ChevronL size={22} color={t.text} />
          </Pressable>
          <Text
            style={{ fontFamily: t.fontDisplay, fontSize: 16, fontWeight: '600', color: t.text, letterSpacing: -0.4, flex: 1, textAlign: 'center' }}
            numberOfLines={1}
          >
            {screenTitle}
          </Text>
          <View style={{ width: 22 }} />
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 40 }}>
          {/* Instruction banner */}
          <View style={{
            backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
            borderRadius: t.radius, padding: 14, flexDirection: 'row', gap: 10,
            alignItems: 'flex-start', marginVertical: 14,
          }}>
            <I.Shield size={16} color={t.accent} style={{ marginTop: 2 }} />
            <Text style={{ flex: 1, fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
              Lean las palabras en voz alta. Si coinciden, pulsen Verificar.
            </Text>
          </View>

          {/* Side-by-side word comparison */}
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
            {/* My words */}
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginBottom: 8, letterSpacing: 0.8 }}>
                YO
              </Text>
              {myWords.map((w, i) => (
                <WordChip key={i} word={w} n={i + 1} t={t} />
              ))}
            </View>

            {/* Divider */}
            <View style={{ width: 1, backgroundColor: t.border, marginVertical: 4 }} />

            {/* Their words */}
            <View style={{ flex: 1 }}>
              <Text
                style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginBottom: 8, letterSpacing: 0.8 }}
                numberOfLines={1}
              >
                {contact.name.toUpperCase()}
              </Text>
              {theirWords.length > 0 ? (
                theirWords.map((w, i) => (
                  <WordChip key={i} word={w} n={i + 1} t={t} />
                ))
              ) : (
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 4 }}>
                  Clave no disponible
                </Text>
              )}
            </View>
          </View>

          {/* Verify action */}
          {theirWords.length > 0 && (
            <PrimaryButton
              t={t}
              label="Confirmar — palabras coinciden"
              onPress={async () => {
                await markVerified(contactId, true);
                Alert.alert(
                  'Verificado',
                  `${contact.name} está verificado. Tus mensajes están protegidos contra ataques de intermediario.`,
                  [{ text: 'OK', onPress: onBack }]
                );
              }}
            />
          )}

          {contact.verified && (
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              gap: 6, marginTop: 14,
            }}>
              <I.Shield size={14} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.8 }}>
                IDENTIDAD YA VERIFICADA
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  // ── Own identity view (no contactId) ─────────────────────────────────────
  return (
    <View style={[styles.screen, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <View style={styles.top}>
        <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }} accessibilityLabel="Volver">
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
            {myWords.map((w, i) => (
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

// ── WordChip ─────────────────────────────────────────────────────────────────
function WordChip({ word, n, t }: { word: string; n: number; t: Theme }) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 8, paddingVertical: 5,
      backgroundColor: t.surface2, borderRadius: t.radiusS,
      marginBottom: 4,
    }}>
      <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, width: 14 }}>
        {n.toString().padStart(2, '0')}
      </Text>
      <Text style={{ fontFamily: t.fontMono, fontSize: 13, color: t.text, fontWeight: '500' }}>
        {word}
      </Text>
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
