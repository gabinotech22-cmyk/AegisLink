import { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Dimensions } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as AlternateAppIcons from 'expo-alternate-app-icons';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { themedAlert } from '../components/AlertHost';

// Native names must match the PascalCase entries of the expo-alternate-app-icons
// plugin in app.json (`Light`, `Tinted`): on Android they are the
// `MainActivity<Name>` activity-aliases, on iOS the alternate icon sets. `null`
// is the primary icon on both platforms.
export const ALL_VARIANTS = [
  { id: 'default', native: null,     bg: '#06090a', mark: '#5bf2b9' },
  { id: 'light',   native: 'Light',  bg: '#f5f3ed', mark: '#0d8f5f' },
  { id: 'tinted',  native: 'Tinted', bg: '#1b1e25', mark: '#bdbdbd' },
] as const;

type IconId = (typeof ALL_VARIANTS)[number]['id'];

/** Maps what the native module reports back to a variant id (default when unknown). */
export function variantFromNativeName(name: string | null | undefined): IconId {
  const v = ALL_VARIANTS.find((x) => x.native === (name ?? null));
  return v ? v.id : 'default';
}

interface Props {
  onBack: () => void;
}

export function AppIconScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState<IconId>('default');
  const [loading, setLoading] = useState(false);

  const VARIANTS = ALL_VARIANTS;

  const { width } = Dimensions.get('window');
  const COLS = 2;
  const cellSize = Math.floor((width - 40 - (COLS - 1) * 16) / COLS);
  const iconSize = Math.min(Math.floor(cellSize * 0.55), 80);

  const getLabel = (id: IconId) => {
    switch (id) {
      case 'default': return i18nT('appIcon.dark');
      case 'light':   return i18nT('appIcon.light');
      case 'tinted':  return i18nT('appIcon.tinted');
    }
  };

  const getDesc = (id: IconId) => {
    switch (id) {
      case 'default': return i18nT('appIcon.darkDesc');
      case 'light':   return i18nT('appIcon.lightDesc');
      case 'tinted':  return i18nT('appIcon.tintedDesc');
    }
  };

  // Load which icon is currently active — getAppIconName() is synchronous
  useEffect(() => {
    try {
      setCurrent(variantFromNativeName(AlternateAppIcons.getAppIconName()));
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
      const native = ALL_VARIANTS.find((v) => v.id === id)?.native ?? null;
      await AlternateAppIcons.setAlternateAppIcon(native);
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
