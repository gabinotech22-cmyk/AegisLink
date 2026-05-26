import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  Pressable,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark } from '../components/AegisMark';
import { I } from '../components/icons';
import { PrimaryButton, GhostButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { fingerprintHex } from '../crypto/fingerprint';
import { getOrCreateDID } from '../web3/did/DIDManager';
import { fetchPowChallenge, solvePoW, uploadIdentityAndPrekeys } from '../crypto/registration';
import { generatePreKeys } from '../crypto/signal/x3dh';
import { RELAY_URL } from '../config';
import { useLocale } from '../i18n/useLocale';
import type { SupportedLocale } from '../i18n';

interface Props {
  onDone: () => void;
  onRestore: () => void;
}

type Step = 'welcome' | 'generating' | 'show';

export function OnboardingScreen({ onDone, onRestore }: Props) {
  const { t, dark, toggle } = useTheme();
  const { t: i18nT } = useTranslation();
  const { locale, setLocale } = useLocale();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('welcome');
  const { identity, generate } = useIdentity();
  const [fingerprint, setFingerprint] = useState<string[]>([]);
  const [did, setDid] = useState<string | null>(null);
  // Tracks when the 'generating' step started so we can enforce a minimum
  // animation duration of 2 s even on fast devices.
  const generatingStartRef = useRef<number>(0);

  type RegistrationState = 'idle' | 'registering' | 'error';
  const [regState, setRegState] = useState<RegistrationState>('idle');
  const [regError, setRegError] = useState<string | null>(null);
  // Track whether we already successfully registered so we don't re-attempt
  const registeredRef = useRef(false);

  async function handleGenerate() {
    if (step !== 'welcome') return;
    generatingStartRef.current = Date.now();
    setStep('generating');
    try {
      await generate();
    } catch (e) {
      Alert.alert(i18nT('onboarding.generateError'), (e as Error).message);
      setStep('welcome');
    }
  }

  // Advance to 'show' as soon as identity is ready AND at least 2 s of
  // animation have elapsed (so the spinner never flashes by on fast devices).
  useEffect(() => {
    if (step === 'generating' && identity) {
      const elapsed = Date.now() - generatingStartRef.current;
      const minDelay = Math.max(0, 2000 - elapsed);
      const t = setTimeout(() => setStep('show'), minDelay);
      return () => clearTimeout(t);
    }
  }, [step, identity]);

  // Hard fallback: if generate() takes longer than 10 s (very slow device),
  // advance anyway so the user is not stuck on the spinner indefinitely.
  useEffect(() => {
    if (step === 'generating') {
      const fallback = setTimeout(() => setStep('show'), 10000);
      return () => clearTimeout(fallback);
    }
  }, [step]);

  useEffect(() => {
    if (step === 'show' && identity) {
      setFingerprint(fingerprintHex(identity.publicKey));
      // Derive the DID locally — no network call, no wallet required.
      // This is opt-in: the DID is only shown here for user awareness.
      // It is never sent to the server automatically.
      getOrCreateDID(identity.aegisId, identity.signingPublicKey)
        .then((record) => setDid(record.did))
        .catch(() => { /* DID derivation is optional; silence errors */ });
    }
  }, [step, identity]);

  async function handleEnter() {
    if (!identity) return;
    if (registeredRef.current) {
      onDone();
      return;
    }
    setRegState('registering');
    setRegError(null);

    // Registration is best-effort. If the relay is unreachable, we proceed
    // to Home anyway — the app works offline and will retry on next launch.
    const TIMEOUT_MS = 12_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS),
    );

    try {
      const { challenge, difficulty } = await Promise.race([fetchPowChallenge(RELAY_URL), timeout]);
      const nonce = await solvePoW(challenge, difficulty);
      const preKeys = generatePreKeys(identity);
      const result = await uploadIdentityAndPrekeys(
        identity,
        {
          signedPreKey: { keyId: preKeys.signedPreKey.keyId, secretKey: preKeys.signedPreKey.secretKey },
          opkSecrets: preKeys.opkSecrets,
        },
        RELAY_URL,
        challenge,
        nonce,
        preKeys.oneTimePreKeys,
        {
          keyId: preKeys.signedPreKey.keyId,
          publicKeyB64: preKeys.signedPreKey.publicKeyB64,
          signatureB64: preKeys.signedPreKey.signatureB64,
        },
      );
      if (result.ok) {
        registeredRef.current = true;
      }
      // Proceed to Home regardless of server response — identity is local
      setRegState('idle');
      onDone();
    } catch {
      // Network unavailable or timed out — go Home and retry on next session
      setRegState('idle');
      onDone();
    }
  }

  const containerPad = { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 };

  // ── Step 0: Welcome ─────────────────────────────────────────────────────────
  if (step === 'welcome') {
    return (
      <View style={[styles.frame, { backgroundColor: t.bg }, containerPad]}>
        {/* Top-right controls: theme toggle + language toggle */}
        <View style={{ position: 'absolute', top: insets.top + 16, right: 24, zIndex: 10, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {/* Dark / light toggle */}
          <Pressable
            onPress={toggle}
            accessibilityLabel={dark ? i18nT('onboarding.switchLight', 'Switch to light mode') : i18nT('onboarding.switchDark', 'Switch to dark mode')}
            style={{
              width: 34,
              height: 34,
              borderRadius: 99,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface2,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {dark
              ? <I.Sun size={15} color={t.textDim} />
              : <I.Moon size={15} color={t.textDim} />}
          </Pressable>

          {/* Language toggle */}
          <Pressable
            onPress={() => {
              if (locale === 'en') {
                void setLocale('it');
              } else if (locale === 'it') {
                void setLocale('es');
              } else {
                void setLocale('en');
              }
            }}
            accessibilityLabel={i18nT('onboarding.langToggle')}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 99,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface2,
            }}
          >
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.8 }}>
              {locale === 'en' ? 'EN | IT | ES' : locale === 'it' ? 'IT | ES | EN' : 'ES | EN | IT'}
            </Text>
          </Pressable>
        </View>

        <View style={{ marginTop: 40, marginBottom: 28 }}>
          <AegisMark t={t} size={56} />
        </View>
        <Text style={[styles.h1, { color: t.text, fontFamily: t.fontDisplay }]}>
          {i18nT('onboarding.tagline')}
        </Text>
        <Text style={[styles.lead, { color: t.textDim, fontFamily: t.font, marginBottom: 'auto' as never }]}>
          {i18nT('onboarding.lead')}
        </Text>
        <View style={{ gap: 10 }}>
          <PrimaryButton t={t} label={i18nT('onboarding.generateBtn')} onPress={handleGenerate} />
          <GhostButton
            t={t}
            label={i18nT('onboarding.restoreBtn')}
            onPress={onRestore}
          />
        </View>
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, textAlign: 'center', marginTop: 18, letterSpacing: 0.6 }}>
          {i18nT('onboarding.footer')}
        </Text>
      </View>
    );
  }

  // ── Step 1: Generating ──────────────────────────────────────────────────────
  if (step === 'generating') {
    return (
      <View style={[styles.frame, { backgroundColor: t.bg, justifyContent: 'center', alignItems: 'center' }, containerPad]}>
        <KeySpinner t={t} />
        <Text style={{ fontFamily: t.fontDisplay, fontSize: 24, fontWeight: '600', letterSpacing: -0.48, color: t.text, marginTop: 36, textAlign: 'center' }}>
          {i18nT('onboarding.generatingTitle')}
        </Text>
        <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 12, letterSpacing: 0.4, textAlign: 'center' }}>
          {i18nT('onboarding.generatingSubtitle')}
        </Text>
        <View style={{ marginTop: 28, width: '100%' }}>
          <ProgressBar t={t} />
        </View>
        <Pressable onPress={() => setStep('show')} style={{ marginTop: 32 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 1.0 }}>
            {i18nT('onboarding.skipAnimation')}
          </Text>
        </Pressable>
      </View>
    );
  }

  // ── Step 2: Show identity ───────────────────────────────────────────────────
  return (
    <View style={[styles.frame, { backgroundColor: t.bg, paddingHorizontal: 24 }, containerPad]}>
      <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 1.1, marginBottom: 14 }}>
        {i18nT('onboarding.yourIdentityLabel')}
      </Text>
      <Text style={{ fontFamily: t.fontDisplay, fontSize: 28, color: t.text, fontWeight: '600', letterSpacing: -0.56, marginBottom: 24 }}>
        {i18nT('onboarding.identityTitle')}
      </Text>

      <View style={{ borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radius, padding: 20, marginBottom: 16, backgroundColor: t.surface }}>
        <Label t={t}>{i18nT('onboarding.aegisIdLabel')}</Label>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 22, color: t.text }}>
            {identity?.aegisId ?? '— — —'}
          </Text>
          {identity && (
            <Pressable
              onPress={async () => {
                try { await Clipboard.setStringAsync(identity.aegisId); } catch { /* clipboard unavailable */ }
              }}
              style={{ padding: 6 }}
              hitSlop={8}
            >
              <I.Copy size={16} color={t.textDim} />
            </Pressable>
          )}
        </View>
        <Label t={t}>{i18nT('onboarding.fingerprintLabel')}</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(fingerprint.length === 0 ? Array(8).fill('····') : fingerprint).map((f, i) => (
            <View
              key={i}
              style={{ width: '23.5%', backgroundColor: t.surface2, borderRadius: t.radiusS, paddingVertical: 6, alignItems: 'center' }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text }}>{f}</Text>
            </View>
          ))}
        </View>
      </View>

      {did !== null && (
        <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: t.radius, padding: 16, marginBottom: 16, backgroundColor: t.surface }}>
          <Label t={t}>{i18nT('onboarding.decentralizedIdLabel')}</Label>
          <Text
            style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, lineHeight: 15 }}
            selectable
            numberOfLines={2}
          >
            {did}
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textFaint, marginTop: 6, lineHeight: 16 }}>
            {i18nT('onboarding.didDescription')}
          </Text>
        </View>
      )}

      <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 20, marginBottom: 'auto' as never }}>
        {i18nT('onboarding.identityWarning')}
      </Text>

      {regState === 'error' && regError !== null && (
        <View style={{ backgroundColor: '#1a0000', borderWidth: 1, borderColor: '#ff4444', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: '#ff6666', lineHeight: 16 }}>
            {regError}
          </Text>
        </View>
      )}

      <PrimaryButton
        t={t}
        label={regState === 'registering' ? i18nT('onboarding.securingBtn') : regState === 'error' ? i18nT('onboarding.retryBtn') : i18nT('onboarding.enterBtn')}
        onPress={handleEnter}
        disabled={regState === 'registering'}
      />
    </View>
  );
}

function Label({ t, children }: { t: Theme; children: React.ReactNode }) {
  return (
    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.0, marginBottom: 8 }}>
      {children}
    </Text>
  );
}

function KeySpinner({ t }: { t: Theme }) {
  const [spin] = useState(new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View style={{ width: 96, height: 96, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          width: 96, height: 96, borderRadius: 48,
          borderWidth: 2, borderColor: t.surface3, borderTopColor: t.accent,
          transform: [{ rotate }], position: 'absolute',
        }}
      />
      <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' }}>
        <I.Key size={26} stroke={1.8} color={t.accent} />
      </View>
    </View>
  );
}

function ProgressBar({ t }: { t: Theme }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 10000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
  }, [anim]);
  return (
    <View style={{ height: 3, backgroundColor: t.surface3, borderRadius: 99, overflow: 'hidden' }}>
      <Animated.View
        style={{
          height: '100%',
          width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          backgroundColor: t.accent,
          borderRadius: 99,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, paddingHorizontal: 28 },
  h1: { fontSize: 40, lineHeight: 41, fontWeight: '600', letterSpacing: -1.2, marginBottom: 16 },
  lead: { fontSize: 16, lineHeight: 23 },
});
