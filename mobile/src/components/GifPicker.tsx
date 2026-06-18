import { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  Image,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';
import { SERVER_URL, isSecureUrl } from '../config';
import { VAULT_PACK } from './stickers/VaultPack';
import { ErrorBoundary } from './ErrorBoundary';

// Tab type
type GifTab = 'gifs' | 'stickers';

interface TenorResult {
  id: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called when user selects a GIF — sends as image msg with isGif flag */
  onSelectGif: (url: string) => void;
  /** Called when user selects a sticker — sends as text */
  onSelectSticker: (text: string) => void;
}

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
// Keyboard-height docked panel (WhatsApp-style), not a full screen.
const PANEL_H = Math.max(300, Math.round(SCREEN_H * 0.46));
const GRID_PAD = 12;
const GRID_GAP = 6;
const TILE_SIZE = (SCREEN_W - GRID_PAD * 2 - GRID_GAP * 2) / 3; // 3 columns

export function GifPicker({ visible, onClose, onSelectGif, onSelectSticker }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<GifTab>('gifs');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TenorResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('Could not connect to the GIF service. Check your internet connection.');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchGifs = useCallback(async (q: string) => {
    setLoading(true);
    setError(false);
    setErrorMessage('Could not connect to the GIF service. Check your internet connection.');
    try {
      const endpoint = q.trim()
        ? `${SERVER_URL}/proxy/gif?q=${encodeURIComponent(q)}`
        : `${SERVER_URL}/proxy/gif`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let res: Response;
      try {
        res = await fetch(endpoint, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 503) {
        setError(true);
        setErrorMessage('GIFs no disponibles');
        setResults([]);
        return;
      }
      if (!res.ok) throw new Error('gif_proxy_error');
      const json = await res.json() as {
        results: Array<{
          id: string;
          media_formats: {
            gif?: { url: string; dims: [number, number] };
            tinygif?: { url: string; dims: [number, number] };
            nanogif?: { url: string; dims: [number, number] };
          };
        }>;
      };
      const mapped: TenorResult[] = (json.results ?? []).map((item) => {
        const fmts = item.media_formats ?? {};
        const preview = fmts.nanogif ?? fmts.tinygif;
        const full = fmts.tinygif ?? fmts.gif;
        return {
          id: item.id,
          url: full?.url ?? '',
          previewUrl: preview?.url ?? full?.url ?? '',
          width: preview?.dims?.[0] ?? 200,
          height: preview?.dims?.[1] ?? 200,
        };
      }).filter((r) => r.url && isSecureUrl(r.url) && isSecureUrl(r.previewUrl));
      setResults(mapped);
    } catch {
      setError(true);
      setErrorMessage('Could not connect to the GIF service. Check your internet connection.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleQueryChange(text: string) {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void fetchGifs(text);
    }, 400);
  }

  // Load featured GIFs when modal opens on GIF tab
  function handleTabPress(tab: GifTab) {
    setActiveTab(tab);
    if (tab === 'gifs' && results.length === 0 && !loading) {
      void fetchGifs(query);
    }
  }

  // Called when modal becomes visible
  function handleShow() {
    if (results.length === 0 && !loading && !error) {
      void fetchGifs('');
    }
  }

  const colCount = 3;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onShow={handleShow}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        {/* Dimmed backdrop — tap to dismiss; chat stays visible behind. */}
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close GIF picker"
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        >
          {/* Bottom-docked panel (keyboard height). */}
          <Pressable
            onPress={() => {}}
            style={{
              height: PANEL_H,
              backgroundColor: t.bg,
              borderTopLeftRadius: t.radiusL,
              borderTopRightRadius: t.radiusL,
              borderTopWidth: 1,
              borderColor: t.border,
              paddingBottom: insets.bottom,
              overflow: 'hidden',
            }}
          >
            {/* Grab handle */}
            <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
              <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: t.border }} />
            </View>

            {/* Tabs + inline search — single compact row */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 12,
                paddingTop: 4,
                paddingBottom: 10,
              }}
            >
              {(['gifs', 'stickers'] as GifTab[]).map((tab) => {
                const active = activeTab === tab;
                return (
                  <Pressable
                    key={tab}
                    onPress={() => handleTabPress(tab)}
                    accessibilityLabel={tab === 'gifs' ? 'GIFs tab' : 'Stickers tab'}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 6,
                      borderRadius: t.radiusL,
                      backgroundColor: active ? t.accent : t.surface,
                      borderWidth: 1,
                      borderColor: active ? t.accent : t.border,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: t.fontMono,
                        fontSize: 11,
                        letterSpacing: 0.6,
                        color: active ? t.accentInk : t.textDim,
                        fontWeight: active ? '700' : '400',
                      }}
                    >
                      {tab.toUpperCase()}
                    </Text>
                  </Pressable>
                );
              })}

              {activeTab === 'gifs' && (
                <View
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: t.surface,
                    borderWidth: 1,
                    borderColor: t.border,
                    borderRadius: t.radiusL,
                    paddingHorizontal: 10,
                    gap: 6,
                  }}
                >
                  <I.Search size={15} color={t.textDim} />
                  <TextInput
                    value={query}
                    onChangeText={handleQueryChange}
                    placeholder="Buscar GIFs…"
                    placeholderTextColor={t.textDim}
                    style={{
                      flex: 1,
                      fontFamily: t.font,
                      fontSize: 13,
                      color: t.text,
                      paddingVertical: 6,
                    }}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                    onSubmitEditing={() => void fetchGifs(query)}
                    accessibilityLabel="Search GIFs"
                  />
                  {query.length > 0 && (
                    <Pressable
                      onPress={() => { setQuery(''); void fetchGifs(''); }}
                      hitSlop={6}
                      accessibilityLabel="Clear search"
                    >
                      <I.X size={15} color={t.textDim} />
                    </Pressable>
                  )}
                </View>
              )}
            </View>

            {/* Content — wrapped so a render failure (e.g. remote GIF media)
                degrades to a local fallback instead of white-screening the whole
                app. key={activeTab} remounts a fresh boundary on tab switch, so a
                GIF-tab crash never blocks the stickers tab. */}
            <View style={{ flex: 1 }}>
        <ErrorBoundary key={activeTab}>
        {activeTab === 'gifs' ? (
          loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <ActivityIndicator color={t.accent} size="large" />
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8 }}>
                LOADING…
              </Text>
            </View>
          ) : error || results.length === 0 ? (
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                paddingHorizontal: 40,
              }}
            >
              <I.Globe size={36} color={t.textFaint} />
              <Text
                style={{
                  fontFamily: t.fontDisplay,
                  fontSize: 16,
                  fontWeight: '600',
                  color: t.text,
                  textAlign: 'center',
                }}
              >
                GIFs not available
              </Text>
              <Text
                style={{
                  fontFamily: t.font,
                  fontSize: 13,
                  color: t.textDim,
                  textAlign: 'center',
                  lineHeight: 19,
                }}
              >
                {error
                  ? errorMessage
                  : 'No results found. Try a different search term.'}
              </Text>
              {error && (
                <Pressable
                  onPress={() => void fetchGifs(query)}
                  style={{
                    paddingHorizontal: 20,
                    paddingVertical: 9,
                    backgroundColor: t.surface,
                    borderWidth: 1,
                    borderColor: t.border,
                    borderRadius: t.radius,
                  }}
                  accessibilityLabel="Retry loading GIFs"
                >
                  <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>Retry</Text>
                </Pressable>
              )}
            </View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              numColumns={colCount}
              contentContainerStyle={{ paddingHorizontal: GRID_PAD, paddingBottom: 12, gap: GRID_GAP }}
              columnWrapperStyle={{ gap: GRID_GAP }}
              /* removeClippedSubviews must stay FALSE here: with remote animated
                 GIFs, Android's view recycling can crash natively (Fresco) when
                 clipped tiles are torn down — e.g. on tab switch. */
              removeClippedSubviews={false}
              maxToRenderPerBatch={10}
              windowSize={8}
              renderItem={({ item }) => {
                const aspectRatio = item.width / Math.max(item.height, 1);
                const tileH = Math.max(80, Math.min(160, TILE_SIZE / aspectRatio));
                return (
                  <Pressable
                    onPress={() => onSelectGif(item.url)}
                    accessibilityLabel="Select GIF"
                    style={({ pressed }) => ({
                      width: TILE_SIZE,
                      height: tileH,
                      borderRadius: t.radiusS,
                      overflow: 'hidden',
                      backgroundColor: t.surface,
                      opacity: pressed ? 0.8 : 1,
                    })}
                  >
                    <Image
                      source={{ uri: item.previewUrl }}
                      style={{ width: TILE_SIZE, height: tileH }}
                      resizeMode="cover"
                    />
                  </Pressable>
                );
              }}
            />
          )
        ) : (
          /* Vault Pack sticker grid — 16 animated stickers */
          <FlatList
            data={VAULT_PACK as unknown as typeof VAULT_PACK[number][]}
            keyExtractor={(item) => item.key}
            numColumns={4}
            contentContainerStyle={{
              paddingHorizontal: 12,
              paddingBottom: insets.bottom + 12,
              gap: 8,
            }}
            columnWrapperStyle={{ gap: 8 }}
            renderItem={({ item }) => {
              const { Component } = item;
              return (
                <Pressable
                  onPress={() => onSelectSticker(`[sticker:${item.key}]`)}
                  accessibilityLabel={`Sticker: ${item.label}`}
                  style={({ pressed }) => ({
                    flex: 1,
                    aspectRatio: 1,
                    backgroundColor: '#0d1311',
                    borderWidth: 1,
                    borderColor: pressed ? 'rgba(91,242,185,0.35)' : t.border,
                    borderRadius: t.radius,
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <Component size={72} />
                </Pressable>
              );
            }}
          />
        )}
        </ErrorBoundary>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
