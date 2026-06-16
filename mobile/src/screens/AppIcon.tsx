import { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Dimensions } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as AlternateAppIcons from 'expo-alternate-app-icons';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { themedAlert } from '../components/AlertHost';

const ALL_VARIANTS = [
  { id: 'default', bg: '#06090a', mark: '#5bf2b9', workOnly: false },
  { id: 'light',   bg: '#efece4', mark: '#0d8f5f', workOnly: false },
  { id: 'tinted',  bg: '#14161c', mark: '#bdbdbd', workOnly: false },
  { id: 'work',    bg: '#1c1f55', mark: '#ffffff', workOnly: true  },
] as const;

type IconId = (typeof ALL_VARIANTS)[number]['id'];

interface Props {
  onBack: () => void;
}

export function AppIconScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState<IconId>('default');
  const [loading, setLoading] = useState(false);

  const VARIANTS = ALL_VARIANTS.filter((v) => !v.workOnly);

  const { width } = Dimensions.get('window');
  const COLS = 2;
  const cellSize = Math.floor((width - 40 - (COLS - 1) * 16) / COLS);
  const iconSize = Math.min(Math.floor(cellSize * 0.55), 80);

  const getLabel = (id: IconId) => {
    switch (id) {
      case 'default': return i18nT('appIcon.dark');
      case 'light':   return i18nT('appIcon.light');
      case 'tinted':  return i18nT('appIcon.tinted');
      case 'work':    return i18nT('appIcon.work');
    }
  };

  const getDesc = (id: IconId) => {
    switch (id) {
      case 'default': return i18nT('appIcon.darkDesc');
      case 'light':   return i18nT('appIcon.lightDesc');
      case 'tinted':  return i18nT('appIcon.tintedDesc');
      case 'work':    return i18nT('appIcon.workDesc');
    }
  };

  // Load which icon is currently active — getAppIconName() is synchronous
  useEffect(() => {
    try {
      const name = AlternateAppIcons.getAppIconName();
      // null means the default icon is active
      const active = (name ?? 'default') as IconId;
      if (ALL_VARIANTS.some((v) => v.id === active)) {
        setCurrent(active);
      }
    } catch {
      // API unavailable in Expo Go / dev builds without native module — stay on default
    }
  }, []);

  async function selectIcon(id: IconId) {
    if (loading || id === current) return;
    // Gracefully skip if the device doesn't support alternate icons
    if (!AlternateAppIcons.supportsAlternateIcons && id !== 'default') {
      themedAlert(i18nT('common.error'), i18nT('appIcon.changeError'));
      return;
    }
    setLoading(true);
    try {
      // null resets to the primary app icon; any other string activates the alternate
      await AlternateAppIcons.setAlternateAppIcon(id === 'default' ? null : id);
      setCurrent(id);
    } catch {
      themedAlert(i18nT('common.error'), i18nT('appIcon.changeError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingTop: insets.top + 10,
          paddingBottom: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: t.divider,
        }}
      >
        <Pressable onPress={onBack} hitSlop={12}>
          <I.ChevronL size={22} color={t.text} />
        </Pressable>
        <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 17, color: t.text, flex: 1 }}>
          {i18nT('appIcon.title')}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}>
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 16 }}>
          {i18nT('appIcon.variantsSection')}
        </Text>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
          {VARIANTS.map((v) => {
            const isActive = current === v.id;
            return (
              <Pressable
                key={v.id}
                onPress={() => void selectIcon(v.id)}
                disabled={loading}
                style={({ pressed }) => ({
                  width: cellSize,
                  alignItems: 'center',
                  gap: 8,
                  opacity: pressed || loading ? 0.65 : 1,
                })}
              >
                <View
                  style={{
                    width: cellSize,
                    height: cellSize,
                    borderRadius: cellSize * 0.222,
                    backgroundColor: v.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: isActive ? 3 : 1.5,
                    borderColor: isActive ? t.accent : `${t.accent}33`,
                  }}
                >
                  <HexMark color={v.mark} size={iconSize} />
                  {isActive && (
                    <View
                      style={{
                        position: 'absolute',
                        bottom: -6,
                        right: -6,
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        backgroundColor: t.accent,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 2,
                        borderColor: t.bg,
                      }}
                    >
                      <I.Check size={12} color={t.bg} stroke={3} />
                    </View>
                  )}
                </View>
                <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.text }}>
                  {getLabel(v.id)}
                </Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4 }}>
                  {getDesc(v.id)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View
          style={{
            marginTop: 32,
            padding: 13,
            backgroundColor: t.surface,
            borderRadius: t.radiusS,
            borderWidth: 1,
            borderColor: t.border,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 9,
          }}
        >
          <I.Lock size={13} color={t.textDim} style={{ marginTop: 1 }} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.4, flex: 1, lineHeight: 17 }}>
            {i18nT('appIcon.requiresNative')}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function HexMark({ color, size }: { color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <Path
        d="M20 2 L35 10 L35 30 L20 38 L5 30 L5 10 Z"
        stroke={color}
        strokeWidth={2.4}
        strokeLinejoin="round"
      />
      <Rect x={13} y={15} width={14} height={3.2} rx={0.4} fill={color} />
      <Rect x={13} y={21.8} width={14} height={3.2} rx={0.4} fill={color} opacity={0.55} />
    </Svg>
  );
}
