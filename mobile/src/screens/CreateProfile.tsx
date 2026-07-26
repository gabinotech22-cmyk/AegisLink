/**
 * CreateProfile screen — Section 11
 *
 * 3-step wizard:
 *   Step 1 — Generate new identity (spinner + AegisID reveal)
 *   Step 2 — Choose display name
 *   Step 3 — Choose avatar color
 *
 * On confirm: keys → SecureStore, profile → ProfilesStore, then switchProfile().
 */
import { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useProfiles, AVATAR_PALETTE } from '../store/profiles';
import { Avatar } from '../components/Avatar';
import type { Identity } from '../crypto/identity';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
  onCreated: () => void;
}

type Step = 'generating' | 'name' | 'color';

export function CreateProfileScreen({ onBack, onCreated }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const createProfile = useProfiles((s) => s.createProfile);
  const switchProfile = useProfiles((s) => s.switchProfile);

  const [step, setStep] = useState<Step>('generating');
  const [newAegisId, setNewAegisId] = useState('');
  // Captured so the color-step preview shows the SAME identicon (seeded by the
  // public key) the profile displays everywhere else in the app.
  const [newPublicKeyB64, setNewPublicKeyB64] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState(AVATAR_PALETTE[1]);
  const [busy, setBusy] = useState(false);

  // The identity generated during the 'generating' step. Held in a ref (not
  // state) so the secret key never drives a re-render, and passed verbatim to
  // createProfile so the persisted profile matches the previewed AegisID.
  const newIdentityRef = useRef<Identity | null>(null);

  // Spinner animation for the generating step
  const spinAnim = useRef(new Animated.Value(0)).current;
  const revealAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true })
    );
    loop.start();

    // Simulate key generation (createIdentity is synchronous and fast, but
    // we give the user a short beat so the step feels deliberate).
    const timer = setTimeout(() => {
      // Import lazily to avoid circular deps
      const { createIdentity } = require('../crypto/identity') as typeof import('../crypto/identity');
      const id = createIdentity();
      newIdentityRef.current = id;
      setNewAegisId(id.aegisId);
      setNewPublicKeyB64(id.publicKeyB64);
      setDisplayName(id.aegisId.slice(0, 8).toLowerCase().replace(/-/g, ''));

      loop.stop();
      Animated.timing(revealAnim, {
        toValue: 1, duration: 400, easing: Easing.out(Easing.ease), useNativeDriver: true,
      }).start(() => setStep('name'));
    }, 1600);

    return () => {
      clearTimeout(timer);
      loop.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      const profile = await createProfile(
        displayName.trim() || newAegisId.slice(0, 8).toLowerCase(),
        avatarColor,
        newIdentityRef.current ?? undefined,
      );
      await switchProfile(profile.slotId);
      onCreated();
    } catch (e) {
      themedAlert('Error', (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title="Nuevo perfil"
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      {/* Step indicator */}
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 24, paddingVertical: 16 }}>
        {(['generating', 'name', 'color'] as Step[]).map((s, i) => (
          <View
            key={s}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              backgroundColor:
                step === s
                  ? t.accent
                  : (['generating', 'name', 'color'] as Step[]).indexOf(step) > i
                  ? `${t.accent}66`
                  : t.border,
            }}
          />
        ))}
      </View>

      {step === 'generating' && (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Animated.View style={{ transform: [{ rotate: spin }], marginBottom: 32 }}>
            <I.Shield size={56} color={t.accent} stroke={1.5} />
          </Animated.View>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', color: t.text, textAlign: 'center' }}>
            Generando identidad
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center', marginTop: 10, lineHeight: 20 }}>
            Se están creando tus claves criptográficas X25519 y Ed25519 en este dispositivo.
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 1.2, marginTop: 28 }}>
            LAS CLAVES NUNCA SALEN DEL DISPOSITIVO
          </Text>
        </View>
      )}

      {step === 'name' && (
        <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 24 }}>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', color: t.text, marginBottom: 6 }}>
            Elige un nombre
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, marginBottom: 28, lineHeight: 20 }}>
            Solo visible para ti. Úsalo para identificar este perfil en el selector.
          </Text>

          {/* AegisID preview */}
          <View style={{
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: `${t.accent}44`,
            borderRadius: t.radius,
            padding: 14,
            marginBottom: 24,
          }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 1, marginBottom: 6 }}>AEGIS ID</Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 16, color: t.accent, letterSpacing: 1 }}>{newAegisId}</Text>
          </View>

          <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginBottom: 8 }}>Nombre del perfil</Text>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="ej. Personal, Trabajo, Anónimo…"
            placeholderTextColor={t.textFaint}
            maxLength={32}
            autoFocus
            style={{
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: t.radius,
              paddingHorizontal: 14,
              paddingVertical: 13,
              fontFamily: t.font,
              fontSize: 15,
              color: t.text,
              marginBottom: 32,
            }}
          />

          <Pressable
            onPress={() => setStep('color')}
            accessibilityLabel="Continuar al paso de color"
            style={({ pressed }) => ({
              backgroundColor: t.accent,
              borderRadius: t.radius,
              paddingVertical: 14,
              alignItems: 'center',
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ fontFamily: t.font, fontWeight: '700', fontSize: 15, color: t.accentInk }}>
              Continuar
            </Text>
          </Pressable>
        </View>
      )}

      {step === 'color' && (
        <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 24 }}>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', color: t.text, marginBottom: 6 }}>
            Color de avatar
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, marginBottom: 32, lineHeight: 20 }}>
            Identifica rápidamente este perfil por su color en el selector.
          </Text>

          {/* Avatar preview — the same identicon (seeded by the public key,
              tinted with the chosen color) the profile shows everywhere else. */}
          <View style={{ alignItems: 'center', marginBottom: 32 }}>
            <Avatar
              t={t}
              name={displayName || newAegisId}
              color={avatarColor}
              size={80}
              seed={newPublicKeyB64 || newAegisId}
            />
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 10 }}>
              {displayName || newAegisId.slice(0, 8)}
            </Text>
          </View>

          {/* Color palette */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center', marginBottom: 40 }}>
            {AVATAR_PALETTE.map((color) => (
              <Pressable
                key={color}
                onPress={() => setAvatarColor(color)}
                accessibilityLabel={`Color ${color}`}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  backgroundColor: color,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: avatarColor === color ? 3 : 0,
                  borderColor: t.text,
                }}
              >
                {avatarColor === color && (
                  <I.Check size={20} color="#fff" />
                )}
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={handleConfirm}
            disabled={busy}
            accessibilityLabel="Confirmar y crear perfil"
            style={({ pressed }) => ({
              backgroundColor: t.accent,
              borderRadius: t.radius,
              paddingVertical: 14,
              alignItems: 'center',
              opacity: pressed || busy ? 0.75 : 1,
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 8,
            })}
          >
            {busy ? (
              <ActivityIndicator color={t.accentInk} size="small" />
            ) : null}
            <Text style={{ fontFamily: t.font, fontWeight: '700', fontSize: 15, color: t.accentInk }}>
              {busy ? 'Creando…' : 'Crear perfil'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
