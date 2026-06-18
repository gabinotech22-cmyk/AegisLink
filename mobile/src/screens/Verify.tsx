import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { BrandedQR } from '../components/BrandedQR';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { decodeBase64 } from 'tweetnacl-util';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { fingerprintWords, fingerprintHex } from '../crypto/fingerprint';
import { encodeIdentityQR, encodeIdentityLink } from '../crypto/qr';
import { ShareLinkSheet } from '../components/ShareLinkSheet';
import type { Theme } from '../theme/vault';
import { themedAlert } from '../components/AlertHost';

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
  const [showShareLink, setShowShareLink] = useState(false);

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

        <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 40, alignItems: 'center' }}>
          {/* Faithful to the design prototype (screens.jsx ScreenVerify):
              subtitle → QR → "OR — 8 safety words" → words grid → Scan QR / Mark verified. */}
          <Text style={{
            fontFamily: t.font, fontSize: 13, color: t.textDim,
            textAlign: 'center', lineHeight: 21, marginVertical: 14, maxWidth: 300,
          }}>
            {i18nT('verify.compareDesc', 'Compare key fingerprints in person, by QR scan, or by reading 8 words.')}
          </Text>

          {/* My QR — the contact scans it (or I scan theirs via Scan QR) for a
              mutual out-of-band exchange. */}
          <BrandedQR
            value={qrPayload}
            size={200}
            color={t.dark ? t.accent : '#0a0a0a'}
            background={t.dark ? t.bg : '#ffffff'}
            accent={t.accent}
          />

          <Text style={{
            fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
            letterSpacing: 1.2, marginTop: 24, marginBottom: 10,
          }}>
            {i18nT('verify.orWords', 'OR — 8 SAFETY WORDS')}
          </Text>

          {/* Contact's 8 safety words — read them aloud together; if they match
              what the contact sees on their device, tap Mark verified. */}
          <View style={{
            width: '100%', borderWidth: 1, borderColor: t.borderStrong,
            borderRadius: t.radius, padding: 14, backgroundColor: t.surface,
          }}>
            {theirWords.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {theirWords.map((w, i) => (
                  <View
                    key={i}
                    style={{
                      width: '48%', flexDirection: 'row', alignItems: 'center', gap: 8,
                      paddingHorizontal: 8, paddingVertical: 6,
                      backgroundColor: t.surface2, borderRadius: t.radiusS,
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
            ) : (
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, textAlign: 'center' }}>
                {i18nT('verify.keyUnavailable', 'Contact key not available yet.')}
              </Text>
            )}
          </View>

          {contact.verified && (
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              gap: 6, marginTop: 16,
            }}>
              <I.Shield size={14} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.8 }}>
                {i18nT('verify.alreadyVerified', 'IDENTITY ALREADY VERIFIED')}
              </Text>
            </View>
          )}

          {/* Scan QR + Mark verified — the two design actions. */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 20, width: '100%' }}>
            <Pressable
              onPress={onScan}
              style={({ pressed }) => ({
                flex: 1,
                backgroundColor: pressed ? t.surface2 : 'transparent',
                borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radius,
                paddingVertical: 13, alignItems: 'center', justifyContent: 'center',
              })}
              accessibilityLabel={i18nT('verify.scanPeer', "Scan a peer's QR")}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, letterSpacing: 0.5 }}>
                {i18nT('verify.scanQR', 'SCAN QR')}
              </Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                await markVerified(contactId, true);
                themedAlert(
                  i18nT('verify.markedTitle', 'Verified'),
                  i18nT('verify.markedDesc', { name: contact.name, defaultValue: `${contact.name} is verified. Your messages are protected against man-in-the-middle attacks.` }),
                  [{ text: i18nT('common.ok', 'OK'), onPress: onBack }]
                );
              }}
              disabled={theirWords.length === 0}
              style={({ pressed }) => ({
                flex: 1,
                backgroundColor: theirWords.length === 0 ? t.surface2 : t.accent,
                opacity: pressed ? 0.85 : 1,
                borderRadius: t.radius, paddingVertical: 13,
                alignItems: 'center', justifyContent: 'center',
              })}
              accessibilityLabel={i18nT('verify.markVerified', 'Mark verified')}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: theirWords.length === 0 ? t.textDim : (t.accentInk ?? '#0a0e0d'), fontWeight: '600', letterSpacing: 0.5 }}>
                {i18nT('verify.markVerified', 'MARK VERIFIED')}
              </Text>
            </Pressable>
          </View>
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

        <View style={{ marginTop: 6 }}>
          <BrandedQR
            value={qrPayload}
            size={220}
            color={t.dark ? t.accent : '#0a0a0a'}
            background={t.dark ? t.bg : '#ffffff'}
            accent={t.accent}
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

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 20, width: '100%' }}>
          <Pressable
            onPress={onScan}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: pressed ? t.surface2 : 'transparent',
              borderWidth: 1,
              borderColor: t.borderStrong,
              borderRadius: t.radius,
              paddingVertical: 13,
              alignItems: 'center',
              justifyContent: 'center',
            })}
            accessibilityLabel={i18nT('verify.scanPeer', "Scan a peer's QR")}
          >
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, letterSpacing: 0.5 }}>
              {i18nT('verify.scanQR', 'SCAN QR')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setShowShareLink(true)}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: t.accent,
              borderRadius: t.radius,
              paddingVertical: 13,
              alignItems: 'center',
              justifyContent: 'center',
            })}
            accessibilityLabel={i18nT('verify.shareContactLabel', 'Compartir mi contacto')}
          >
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accentInk ?? '#0a0e0d', fontWeight: '600', letterSpacing: 0.5 }}>
              {i18nT('verify.shareContact', 'SHARE ID')}
            </Text>
          </Pressable>
        </View>

      </ScrollView>

      {/* Share my contact — in-app floating window (not the native OS sheet). */}
      <ShareLinkSheet
        visible={showShareLink}
        onClose={() => setShowShareLink(false)}
        title={i18nT('verify.shareTitle', 'Mi contacto AegisLink')}
        link={identity ? encodeIdentityLink(identity.aegisId, identity.publicKeyB64) : ''}
      />
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
