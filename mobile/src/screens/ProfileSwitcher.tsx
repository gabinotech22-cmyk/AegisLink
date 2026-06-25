/**
 * ProfileSwitcher screen — Section 11
 *
 * Bottom-sheet-style screen listing all profiles.  Designed to be pushed from
 * HomeScreen (long-press avatar) or ProfileScreen.
 *
 *   - Active profile has a checkmark.
 *   - Tap  → confirmation alert → switchProfile()
 *   - "+"  → CreateProfile screen.
 *   - Long-press → delete confirmation (cannot delete last or primary).
 */
import { useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Avatar } from '../components/Avatar';
import { useProfiles, type Profile } from '../store/profiles';
import { useIdentity } from '../store/identity';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
  onCreateProfile: () => void;
}

export function ProfileSwitcherScreen({ onBack, onCreateProfile }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const profiles = useProfiles((s) => s.profiles);
  const activeSlotId = useProfiles((s) => s.activeSlotId);
  const hydrate = useProfiles((s) => s.hydrate);
  const switchProfile = useProfiles((s) => s.switchProfile);
  const removeProfile = useProfiles((s) => s.removeProfile);
  // The active profile's key/photo live in the identity store; inactive
  // profiles only carry metadata (no keys loaded), so they seed by aegisId.
  // Seeding the active row by publicKeyB64 keeps its identicon identical to
  // the one shown in Profile / Privacy / Home for the same identity.
  const activePublicKeyB64 = useIdentity((s) => s.identity?.publicKeyB64);
  const activeAvatarImage = useIdentity((s) => s.avatarImage);

  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  function handleSwitch(profile: Profile) {
    if (profile.slotId === activeSlotId) return;
    themedAlert(
      'Cambiar de perfil',
      'Cambiar de perfil cerrará todos los chats activos y cargará la base de datos del nuevo perfil.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Cambiar',
          onPress: async () => {
            setSwitching(profile.slotId);
            try {
              await switchProfile(profile.slotId);
              onBack();
            } catch (e) {
              themedAlert('Error', (e as Error).message);
            } finally {
              setSwitching(null);
            }
          },
        },
      ]
    );
  }

  function handleDelete(profile: Profile) {
    if (profiles.length <= 1) {
      themedAlert('No se puede eliminar', 'Debes tener al menos un perfil.');
      return;
    }
    if (profile.slotId === 'self') {
      themedAlert('No se puede eliminar', 'El perfil primario no se puede eliminar. Usa "Eliminar identidad" en Perfil → Ajustes.');
      return;
    }
    themedAlert(
      `Eliminar "${profile.displayName}"`,
      'Se borrarán permanentemente todas las claves, mensajes y contactos de este perfil. Esta acción es irreversible.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeProfile(profile.slotId);
            } catch (e) {
              themedAlert('Error', (e as Error).message);
            }
          },
        },
      ]
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title="Perfiles"
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
        right={
          <Pressable
            onPress={onCreateProfile}
            hitSlop={8}
            style={{ padding: 8 }}
            accessibilityLabel="Crear nuevo perfil"
          >
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        }
      />

      {profiles.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text style={{ fontFamily: t.font, fontSize: 15, color: t.textDim, textAlign: 'center' }}>
            No se encontraron perfiles. Reinicia la app para que se inicialicen.
          </Text>
        </View>
      ) : (
        <FlatList
          data={profiles}
          keyExtractor={(p) => p.slotId}
          contentContainerStyle={{ paddingVertical: 8 }}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: t.divider, marginLeft: 72 }} />
          )}
          renderItem={({ item }) => (
            <ProfileRow
              t={t}
              profile={item}
              isSwitching={switching === item.slotId}
              activeSeed={item.isActive ? activePublicKeyB64 : undefined}
              activePhoto={item.isActive ? activeAvatarImage : null}
              onPress={() => handleSwitch(item)}
              onLongPress={() => handleDelete(item)}
            />
          )}
          ListFooterComponent={
            <Pressable
              onPress={onCreateProfile}
              accessibilityLabel="Crear nuevo perfil"
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                paddingHorizontal: 18,
                paddingVertical: 16,
                marginTop: 8,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <I.Plus size={22} color={t.accent} />
              </View>
              <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.accent }}>
                Nuevo perfil
              </Text>
            </Pressable>
          }
        />
      )}

      <View style={{
        paddingHorizontal: 18,
        paddingBottom: insets.bottom + 16,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: t.divider,
      }}>
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.8, textAlign: 'center' }}>
          CADA PERFIL TIENE SUS PROPIAS CLAVES E2EE Y BASE DE DATOS
        </Text>
      </View>
    </View>
  );
}

function ProfileRow({
  t,
  profile,
  isSwitching,
  activeSeed,
  activePhoto,
  onPress,
  onLongPress,
}: {
  t: import('../theme/vault').Theme;
  profile: Profile;
  isSwitching: boolean;
  /** Active profile's publicKeyB64 (matches its identicon elsewhere); undefined for inactive rows. */
  activeSeed?: string;
  /** Active profile's uploaded avatar photo; null for inactive rows. */
  activePhoto?: string | null;
  onPress: () => void;
  onLongPress: () => void;
}) {
  // Seed the identicon by publicKeyB64 when this is the active profile (so it
  // matches Profile/Privacy/Home), otherwise by the only stable id we have for
  // an inactive profile: its aegisId. Avatar shows the photo when present.
  const seed = activeSeed ?? profile.aegisId;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={`Perfil ${profile.displayName}${profile.isActive ? ', activo' : ''}`}
      android_ripple={{ color: t.surface2 }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingVertical: 13,
        gap: 14,
        backgroundColor: pressed ? t.surface2 : t.bg,
      })}
    >
      {/* Identity avatar (identicon/photo) — matches the rest of the app.
          Active profile gets a ring; the inner Avatar shrinks to leave the gap. */}
      <View style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: profile.isActive ? 2 : 0,
        borderColor: t.text,
      }}>
        <Avatar
          t={t}
          name={profile.displayName || profile.aegisId}
          color={profile.avatarColor}
          size={profile.isActive ? 42 : 48}
          photoUri={activePhoto}
          seed={seed}
        />
      </View>

      {/* Info */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>
          {profile.displayName}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5, marginTop: 2 }}>
          {profile.aegisId}
        </Text>
        {profile.isActive && (
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.8, marginTop: 3 }}>
            ACTIVO
          </Text>
        )}
      </View>

      {/* Right: spinner or checkmark */}
      {isSwitching ? (
        <ActivityIndicator color={t.accent} size="small" />
      ) : profile.isActive ? (
        <I.Check size={18} color={t.accent} />
      ) : (
        <I.Chevron size={14} color={t.textFaint} />
      )}
    </Pressable>
  );
}
