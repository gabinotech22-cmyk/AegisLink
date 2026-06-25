import { useId, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  FlatList,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, {
  Defs,
  Rect,
  Circle,
  Path,
  G,
  RadialGradient,
  Pattern,
  Stop,
} from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ss } from '../utils/secureStore';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';

export type WallpaperOption = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

interface Props {
  visible: boolean;
  contactAegisId: string;
  current: WallpaperOption;
  onClose: () => void;
  onSelect: (option: WallpaperOption) => void;
}

// ─── Brand wallpapers (Vault palette) ─────────────────────────────────────────
// Dark, low-saturation backgrounds so the mint accent bubbles always pop. The
// designs use only brand colours and are intentionally theme-independent — a
// chosen wallpaper is an aesthetic override, like Telegram/Signal wallpapers.

const MINT = '#5bf2b9';
// The vault hexagon mark (matches assets/icon.svg), in a 40×40 box.
const HEX = 'M20 2 L35 10 L35 30 L20 38 L5 30 L5 10 Z';

export const WALLPAPER_NAMES: Record<WallpaperOption, string> = {
  0: 'None',
  1: 'Vault',
  2: 'Forest',
  3: 'Hex',
  4: 'Dots',
  5: 'Aurora',
  6: 'Circuit',
  7: 'Mark',
};

const OPTIONS: WallpaperOption[] = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Dominant solid colour for a wallpaper — used as the base behind the SVG layer
 * and anywhere a single colour is enough (e.g. the chat list base).
 */
export function wallpaperBg(option: WallpaperOption, t: { bg: string }): string | undefined {
  return option === 0 ? undefined : '#0a0e0d';
}

function renderWallpaper(option: WallpaperOption, uid: string) {
  switch (option) {
    case 1: // Vault — deep black
      return <Rect width={400} height={800} fill="#0a0e0d" />;
    case 2: // Forest — green-whisper radial
      return (
        <>
          <Defs>
            <RadialGradient id={`df${uid}`} cx="50%" cy="0%" r="100%">
              <Stop offset="0" stopColor="#10201a" />
              <Stop offset="0.58" stopColor="#0a0e0d" />
              <Stop offset="1" stopColor="#06090a" />
            </RadialGradient>
          </Defs>
          <Rect width={400} height={800} fill={`url(#df${uid})`} />
        </>
      );
    case 3: // Hex — brand hexagon mesh
      return (
        <>
          <Defs>
            <Pattern id={`hx${uid}`} width={46} height={52} patternUnits="userSpaceOnUse">
              <Path
                d="M23 3 L43 14 L43 38 L23 49 L3 38 L3 14 Z"
                fill="none"
                stroke={MINT}
                strokeOpacity={0.11}
                strokeWidth={1.1}
              />
            </Pattern>
          </Defs>
          <Rect width={400} height={800} fill="#0a0e0d" />
          <Rect width={400} height={800} fill={`url(#hx${uid})`} />
        </>
      );
    case 4: // Dots — fine carbon dot grid
      return (
        <>
          <Defs>
            <Pattern id={`dt${uid}`} width={15} height={15} patternUnits="userSpaceOnUse">
              <Circle cx={2} cy={2} r={1.1} fill={MINT} fillOpacity={0.13} />
            </Pattern>
          </Defs>
          <Rect width={400} height={800} fill="#0b1110" />
          <Rect width={400} height={800} fill={`url(#dt${uid})`} />
        </>
      );
    case 5: // Aurora — mint glow in a corner
      return (
        <>
          <Defs>
            <RadialGradient id={`au${uid}`} cx="86%" cy="90%" r="60%">
              <Stop offset="0" stopColor={MINT} stopOpacity={0.18} />
              <Stop offset="0.62" stopColor={MINT} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width={400} height={800} fill="#0a0e0d" />
          <Rect width={400} height={800} fill={`url(#au${uid})`} />
        </>
      );
    case 6: // Circuit — faint crypto lattice
      return (
        <>
          <Rect width={400} height={800} fill="#090d0c" />
          <G stroke={MINT} strokeOpacity={0.13} strokeWidth={1} fill="none">
            <Path d="M0 120 H160 V300 H320" />
            <Path d="M400 60 V220 H300 V420" />
            <Path d="M40 520 H220 V640" />
            <Path d="M360 700 V560 H260" />
            <Path d="M120 770 V620 H40" />
          </G>
          <G fill={MINT} fillOpacity={0.22}>
            <Circle cx={160} cy={120} r={3} />
            <Circle cx={320} cy={300} r={3} />
            <Circle cx={300} cy={220} r={3} />
            <Circle cx={220} cy={520} r={3} />
            <Circle cx={260} cy={560} r={3} />
          </G>
        </>
      );
    case 7: // Mark — ghosted vault logo watermark
      return (
        <>
          <Rect width={400} height={800} fill="#0a0e0d" />
          <G transform="translate(120,320) scale(4)" opacity={0.1}>
            <Path d={HEX} fill="none" stroke={MINT} strokeWidth={2.4} strokeLinejoin="round" />
            <Rect x={13} y={15} width={14} height={3.2} rx={0.4} fill={MINT} />
            <Rect x={13} y={21.8} width={14} height={3.2} rx={0.4} fill={MINT} opacity={0.55} />
          </G>
        </>
      );
    default:
      return null;
  }
}

/**
 * Full-bleed chat wallpaper. Render as an absolute-fill layer behind a
 * transparent message list. Option 0 (None) renders nothing — the caller keeps
 * the theme background.
 */
export function ChatWallpaper({
  option,
  style,
}: {
  option: WallpaperOption;
  style?: StyleProp<ViewStyle>;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  if (option === 0) return null;
  return (
    <Svg
      style={style}
      width="100%"
      height="100%"
      viewBox="0 0 400 800"
      preserveAspectRatio="xMidYMid slice"
      pointerEvents="none"
    >
      {renderWallpaper(option, uid)}
    </Svg>
  );
}

const WALLPAPER_KEY = (aegisId: string) => `aegis.wallpaper.${aegisId}`;

export async function loadWallpaper(aegisId: string): Promise<WallpaperOption> {
  try {
    const raw = await ss.get(WALLPAPER_KEY(aegisId));
    if (raw === null) return 0;
    const n = parseInt(raw, 10);
    if (n >= 0 && n <= 7) return n as WallpaperOption;
    return 0;
  } catch {
    return 0;
  }
}

export async function saveWallpaper(aegisId: string, option: WallpaperOption): Promise<void> {
  await ss.set(WALLPAPER_KEY(aegisId), String(option));
}

// ─── Preview cells ────────────────────────────────────────────────────────────

function WallpaperPreviewCell({
  option,
  selected,
  onPress,
}: {
  option: WallpaperOption;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={`Wallpaper ${WALLPAPER_NAMES[option]}`}
      style={({ pressed }) => ({
        width: '100%',
        aspectRatio: 0.7,
        borderRadius: t.radiusS,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? t.accent : t.border,
        overflow: 'hidden',
        opacity: pressed ? 0.8 : 1,
        backgroundColor: option === 0 ? t.bg : '#0a0e0d',
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      {option === 0 ? (
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.8 }}>
          NONE
        </Text>
      ) : (
        <ChatWallpaper option={option} style={StyleSheet.absoluteFill} />
      )}
      {selected && (
        <View
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: t.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I.Check size={11} color={t.accentInk} />
        </View>
      )}
    </Pressable>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WallpaperPicker({ visible, contactAegisId, current, onClose, onSelect }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<WallpaperOption>(current);

  function handleSelect(option: WallpaperOption) {
    setSelected(option);
    void saveWallpaper(contactAegisId, option);
    onSelect(option);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + 8 }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 18,
            paddingBottom: 16,
            borderBottomWidth: 1,
            borderBottomColor: t.border,
          }}
        >
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={{ padding: 4 }}
            accessibilityLabel="Close wallpaper picker"
          >
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
          <Text
            style={{
              flex: 1,
              fontFamily: t.fontDisplay,
              fontSize: 17,
              fontWeight: '600',
              color: t.text,
            }}
          >
            Chat Wallpaper
          </Text>
        </View>

        {/* Grid 3 columns */}
        <FlatList
          data={OPTIONS}
          keyExtractor={(item) => String(item)}
          numColumns={3}
          contentContainerStyle={{
            padding: 18,
            paddingBottom: insets.bottom + 18,
            gap: 16,
          }}
          columnWrapperStyle={{ gap: 12, justifyContent: 'flex-start' }}
          renderItem={({ item }) => (
            <View style={{ width: '31%', gap: 6 }}>
              <WallpaperPreviewCell
                option={item}
                selected={selected === item}
                onPress={() => handleSelect(item)}
              />
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 9,
                  color: selected === item ? t.accent : t.textDim,
                  textAlign: 'center',
                  letterSpacing: 0.5,
                }}
              >
                {WALLPAPER_NAMES[item]}
              </Text>
            </View>
          )}
        />
      </View>
    </Modal>
  );
}
