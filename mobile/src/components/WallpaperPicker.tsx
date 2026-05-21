import { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  FlatList,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';

export type WallpaperOption = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface Props {
  visible: boolean;
  contactAegisId: string;
  current: WallpaperOption;
  onClose: () => void;
  onSelect: (option: WallpaperOption) => void;
}

/**
 * Returns a backgroundColor string for a given wallpaper option,
 * using only theme tokens. Called from Chat.tsx to apply the bg.
 */
export function wallpaperBg(option: WallpaperOption, t: {
  bg: string; surface: string; surface2: string; accentDeep: string; accent: string;
}): string | undefined {
  switch (option) {
    case 0: return undefined;
    case 1: return t.accentDeep;
    case 2: return t.surface;
    case 3: return t.surface2;
    case 4: return t.bg;
    default: return t.surface;
  }
}

const WALLPAPER_KEY = (aegisId: string) => `aegis.wallpaper.${aegisId}`;

export async function loadWallpaper(aegisId: string): Promise<WallpaperOption> {
  try {
    const raw = await SecureStore.getItemAsync(WALLPAPER_KEY(aegisId));
    if (raw === null) return 0;
    const n = parseInt(raw, 10);
    if (n >= 0 && n <= 8) return n as WallpaperOption;
    return 0;
  } catch {
    return 0;
  }
}

export async function saveWallpaper(aegisId: string, option: WallpaperOption): Promise<void> {
  await SecureStore.setItemAsync(WALLPAPER_KEY(aegisId), String(option));
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

  function renderInner() {
    if (option === 0) {
      return (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: t.bg,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radiusS,
          }}
        >
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.textDim,
              letterSpacing: 0.8,
            }}
          >
            NONE
          </Text>
        </View>
      );
    }

    // Solid colour swatches (options 1–4)
    if (option <= 4) {
      const bg = wallpaperBg(option, t) ?? t.bg;
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: bg,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radiusS,
          }}
        />
      );
    }

    // Pattern options 5–8: dots, horizontal lines, vertical lines, grid
    const patternBg = t.surface;
    const dotColor = t.border;

    if (option === 5) {
      // Dots pattern
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: patternBg,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radiusS,
            overflow: 'hidden',
          }}
        >
          {[0, 1, 2, 3].map((row) => (
            <View key={row} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
              {[0, 1, 2, 3].map((col) => (
                <View
                  key={col}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <View
                    style={{
                      width: 3,
                      height: 3,
                      borderRadius: 1.5,
                      backgroundColor: dotColor,
                    }}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    }

    if (option === 6) {
      // Horizontal lines
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: patternBg,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radiusS,
            overflow: 'hidden',
            justifyContent: 'space-around',
            paddingVertical: 6,
          }}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <View
              key={i}
              style={{ height: 1, backgroundColor: dotColor, marginHorizontal: 4 }}
            />
          ))}
        </View>
      );
    }

    if (option === 7) {
      // Vertical lines
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: patternBg,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radiusS,
            overflow: 'hidden',
            flexDirection: 'row',
            justifyContent: 'space-around',
            paddingHorizontal: 6,
          }}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <View
              key={i}
              style={{ width: 1, backgroundColor: dotColor, marginVertical: 4 }}
            />
          ))}
        </View>
      );
    }

    // option === 8: grid
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: patternBg,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: t.radiusS,
          overflow: 'hidden',
        }}
      >
        {[0, 1, 2, 3].map((row) => (
          <View
            key={row}
            style={{ flex: 1, flexDirection: 'row', borderBottomWidth: row < 3 ? 1 : 0, borderBottomColor: dotColor }}
          >
            {[0, 1, 2, 3].map((col) => (
              <View
                key={col}
                style={{ flex: 1, borderRightWidth: col < 3 ? 1 : 0, borderRightColor: dotColor }}
              />
            ))}
          </View>
        ))}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={`Wallpaper option ${option}`}
      style={({ pressed }) => ({
        width: '30%',
        aspectRatio: 0.7,
        borderRadius: t.radiusS,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? t.accent : t.border,
        overflow: 'hidden',
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {renderInner()}
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

const OPTIONS: WallpaperOption[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

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
            gap: 12,
          }}
          columnWrapperStyle={{ gap: 12, justifyContent: 'flex-start' }}
          renderItem={({ item }) => (
            <WallpaperPreviewCell
              option={item}
              selected={selected === item}
              onPress={() => handleSelect(item)}
            />
          )}
        />
      </View>
    </Modal>
  );
}
