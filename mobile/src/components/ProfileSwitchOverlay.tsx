/**
 * ProfileSwitchOverlay — Section 11 quick profile switcher.
 *
 * Opened by a long-press on the Privacy tab (see TabBar). A non-invasive anchored
 * popover lists the isolated profiles; tapping one switches to it directly and
 * plays a short "splash" (the new profile's identicon + name) that also covers
 * the brief DB reload switchProfile performs underneath, so the change is felt
 * rather than flickering.
 *
 * All user-facing copy goes through i18n (`profileSwitch.*`) — never hardcoded.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Modal, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';
import { Avatar } from './Avatar';
import { useProfiles, type Profile } from '../store/profiles';
import { useIdentity } from '../store/identity';
import { themedAlert } from './AlertHost';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Opens the create-profile wizard (navigation is owned by the app shell). */
  onCreateProfile: () => void;
}

/** Minimum time the switch splash stays up, so it reads as deliberate and hides
 *  the DB reload flicker even when switchProfile resolves almost instantly. */
const SPLASH_MIN_MS = 850;

export function ProfileSwitchOverlay({ visible, onClose, onCreateProfile }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  const profiles = useProfiles((s) => s.profiles);
  const activeSlotId = useProfiles((s) => s.activeSlotId);
  const hydrate = useProfiles((s) => s.hydrate);
  const switchProfile = useProfiles((s) => s.switchProfile);
  const activePublicKeyB64 = useIdentity((s) => s.identity?.publicKeyB64);

  // The profile currently being switched TO (drives the splash). Null = popover.
  const [switching, setSwitching] = useState<Profile | null>(null);

  const splashOpacity = useRef(new Animated.Value(0)).current;
  const splashScale = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (visible) void hydrate();
  }, [visible, hydrate]);

  useEffect(() => {
    if (switching) {
      splashOpacity.setValue(0);
      splashScale.setValue(0.5);
      Animated.parallel([
        Animated.timing(splashOpacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.spring(splashScale, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }),
      ]).start();
    }
  }, [switching, splashOpacity, splashScale]);

  async function handleSwitch(p: Profile) {
    if (switching) return;
    if (p.slotId === activeSlotId) {
      onClose();
      return;
    }
    setSwitching(p);
    const start = Date.now();
    try {
      await switchProfile(p.slotId);
    } catch (e) {
      setSwitching(null);
      themedAlert(i18nT('common.error'), (e as Error).message);
      return;
    }
    const elapsed = Date.now() - start;
    if (elapsed < SPLASH_MIN_MS) {
      await new Promise<void>((r) => setTimeout(r, SPLASH_MIN_MS - elapsed));
    }
    setSwitching(null);
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      {switching ? (
        <View style={{ flex: 1, backgroundColor: `${t.bg}dc`, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Animated.View style={{ opacity: splashOpacity, transform: [{ scale: splashScale }], marginBottom: 18 }}>
            <Avatar
              t={t}
              name={switching.displayName || switching.aegisId}
              color={switching.avatarColor}
              size={96}
              seed={switching.aegisId}
            />
          </Animated.View>
          <Animated.View style={{ opacity: splashOpacity, alignItems: 'center' }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', color: t.text }}>
              {switching.displayName || switching.aegisId.slice(0, 8)}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, letterSpacing: 0.6, marginTop: 4 }}>
              {switching.aegisId}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 1.4, marginTop: 12 }}>
              {i18nT('profileSwitch.activeLabel').toUpperCase()}
            </Text>
          </Animated.View>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {/* Scrim — tap outside to dismiss. */}
          <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.42)' }} onPress={onClose} accessibilityRole="button" accessibilityLabel={i18nT('common.cancel')} />

          {/* Anchored popover above the Privacy tab (bottom-right). */}
          <View
            style={{
              position: 'absolute',
              right: 12,
              bottom: insets.bottom + 74,
              width: 244,
              backgroundColor: t.surface2,
              borderWidth: 1,
              borderColor: t.borderStrong,
              borderRadius: 14,
              padding: 8,
            }}
          >
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, letterSpacing: 1, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8 }}>
              {i18nT('profileSwitch.title').toUpperCase()}
            </Text>

            {profiles.map((p) => {
              const isActive = p.slotId === activeSlotId;
              const seed = isActive ? activePublicKeyB64 ?? p.aegisId : p.aegisId;
              return (
                <Pressable
                  key={p.slotId}
                  onPress={() => handleSwitch(p)}
                  accessibilityLabel={i18nT('profileSwitch.switchTo', { name: p.displayName || p.aegisId })}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    padding: 8,
                    borderRadius: 10,
                    backgroundColor: isActive ? `${t.accent}14` : pressed ? t.surface3 : 'transparent',
                  })}
                >
                  <Avatar t={t} name={p.displayName || p.aegisId} color={p.avatarColor} size={30} seed={seed} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>
                      {p.displayName || p.aegisId.slice(0, 8)}
                    </Text>
                    <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, letterSpacing: 0.4, marginTop: 1 }}>
                      {p.aegisId}
                    </Text>
                  </View>
                  {isActive && <I.Check size={16} color={t.accent} />}
                </Pressable>
              );
            })}

            <View style={{ height: 1, backgroundColor: t.border, marginVertical: 6, marginHorizontal: 4 }} />

            <Pressable
              onPress={() => {
                onClose();
                onCreateProfile();
              }}
              accessibilityLabel={i18nT('profileSwitch.newProfile')}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                padding: 8,
                borderRadius: 10,
                backgroundColor: pressed ? t.surface3 : 'transparent',
              })}
            >
              <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: t.surface3, alignItems: 'center', justifyContent: 'center' }}>
                <I.Plus size={16} color={t.accent} />
              </View>
              <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.accent }}>
                {i18nT('profileSwitch.newProfile')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </Modal>
  );
}
