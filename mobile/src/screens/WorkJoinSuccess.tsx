import { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  FlatList,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import type { WorkChannel } from '../store/work';

// ─── Work accent colour (indigo, not the green app accent) ───────────────────
const WORK_ACCENT = '#6366f1';
const WORK_ACCENT_DEEP = 'rgba(99,102,241,0.15)';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  orgName: string;
  role: 'admin' | 'member';
  channels: WorkChannel[];
  onContinue: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function WorkJoinSuccess({ orgName, role, channels, onContinue }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();

  // Entry animation: scale + fade
  const scaleAnim = useRef(new Animated.Value(0.6)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          tension: 120,
          friction: 8,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim, contentOpacity]);

  const s = makeStyles(t);

  const channelsToShow = channels.slice(0, 5);

  return (
    <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Shield icon with animation */}
      <Animated.View
        style={[
          s.iconWrap,
          {
            transform: [{ scale: scaleAnim }],
            opacity: opacityAnim,
          },
        ]}
      >
        <I.Shield size={56} color={WORK_ACCENT} />
      </Animated.View>

      {/* Main content fade-in after icon */}
      <Animated.View style={[s.content, { opacity: contentOpacity }]}>
        {/* Welcome title */}
        <Text style={s.welcomeTitle} accessibilityRole="header">
          Bienvenido a
        </Text>
        <Text style={s.orgName} numberOfLines={2} accessibilityLabel={`Organización ${orgName}`}>
          {orgName}
        </Text>

        {/* Role badge */}
        <View
          style={[
            s.roleBadge,
            role === 'admin' ? s.roleBadgeAdmin : s.roleBadgeMember,
          ]}
          accessibilityLabel={`Rol: ${role === 'admin' ? 'Administrador' : 'Miembro'}`}
        >
          <Text style={[s.roleBadgeText, role === 'admin' ? s.roleBadgeTextAdmin : s.roleBadgeTextMember]}>
            {role === 'admin' ? 'ADMIN' : 'MIEMBRO'}
          </Text>
        </View>

        {/* Channels list */}
        {channelsToShow.length > 0 && (
          <View style={s.channelsCard}>
            <Text style={s.channelsLabel}>CANALES DISPONIBLES</Text>
            <FlatList
              data={channelsToShow}
              keyExtractor={(ch) => ch.channelId}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <View style={s.channelRow}>
                  <Text style={s.channelHash}>#</Text>
                  <Text style={s.channelName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.isAnnouncements && (
                    <View style={s.announceBadge}>
                      <Text style={s.announceBadgeText}>anuncios</Text>
                    </View>
                  )}
                </View>
              )}
            />
          </View>
        )}

        {/* CTA button */}
        <Pressable
          style={s.ctaButton}
          onPress={onContinue}
          accessibilityLabel="Entrar al workspace"
          accessibilityRole="button"
        >
          <Text style={s.ctaButtonText}>Entrar al workspace</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: import('../theme/vault').Theme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: t.bg,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    iconWrap: {
      width: 100,
      height: 100,
      borderRadius: 50,
      backgroundColor: WORK_ACCENT_DEEP,
      borderWidth: 1,
      borderColor: WORK_ACCENT,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 28,
    },
    content: {
      width: '100%',
      alignItems: 'center',
      gap: 16,
    },
    welcomeTitle: {
      fontFamily: t.font,
      fontSize: 16,
      color: t.textDim,
      fontWeight: '400',
    },
    orgName: {
      fontFamily: t.fontDisplay,
      fontSize: 26,
      fontWeight: '700',
      color: t.text,
      textAlign: 'center',
    },
    roleBadge: {
      borderRadius: 6,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderWidth: 1,
    },
    roleBadgeAdmin: {
      backgroundColor: WORK_ACCENT_DEEP,
      borderColor: WORK_ACCENT,
    },
    roleBadgeMember: {
      backgroundColor: 'rgba(0,255,136,0.1)',
      borderColor: t.accent,
    },
    roleBadgeText: {
      fontFamily: t.fontMono,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.5,
    },
    roleBadgeTextAdmin: {
      color: WORK_ACCENT,
    },
    roleBadgeTextMember: {
      color: t.accent,
    },
    channelsCard: {
      width: '100%',
      backgroundColor: t.surface,
      borderRadius: t.radius,
      borderWidth: 1,
      borderColor: t.border,
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 10,
      marginTop: 4,
    },
    channelsLabel: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: t.textFaint,
      letterSpacing: 1.5,
      marginBottom: 4,
    },
    channelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 5,
    },
    channelHash: {
      fontFamily: t.fontMono,
      fontSize: 14,
      color: WORK_ACCENT,
      fontWeight: '700',
    },
    channelName: {
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
      flex: 1,
    },
    announceBadge: {
      backgroundColor: WORK_ACCENT_DEEP,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    announceBadgeText: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: WORK_ACCENT,
      letterSpacing: 0.5,
    },
    ctaButton: {
      width: '100%',
      backgroundColor: WORK_ACCENT,
      borderRadius: t.radiusS,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 8,
    },
    ctaButtonText: {
      fontFamily: t.font,
      fontSize: 15,
      fontWeight: '700',
      color: '#ffffff',
    },
  });
}
