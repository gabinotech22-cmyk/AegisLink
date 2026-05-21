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

// Tab type
type GifTab = 'gifs' | 'stickers';

// Sticker definitions — static unicode/emoji, bundled with app, no CDN
const STICKERS = [
  { id: 's1', emoji: '😂', label: 'Laughing' },
  { id: 's2', emoji: '🔥', label: 'Fire' },
  { id: 's3', emoji: '❤️', label: 'Heart' },
  { id: 's4', emoji: '👍', label: 'Thumbs up' },
  { id: 's5', emoji: '😭', label: 'Sobbing' },
  { id: 's6', emoji: '🙏', label: 'Hands' },
  { id: 's7', emoji: '💀', label: 'Skull' },
  { id: 's8', emoji: '😍', label: 'Heart eyes' },
  { id: 's9', emoji: '🤣', label: 'ROFL' },
  { id: 's10', emoji: '😢', label: 'Cry' },
  { id: 's11', emoji: '🥺', label: 'Pleading' },
  { id: 's12', emoji: '😎', label: 'Cool' },
  { id: 's13', emoji: '🤔', label: 'Thinking' },
  { id: 's14', emoji: '👀', label: 'Eyes' },
  { id: 's15', emoji: '💯', label: '100' },
  { id: 's16', emoji: '🎉', label: 'Party' },
  { id: 's17', emoji: '😅', label: 'Sweat smile' },
  { id: 's18', emoji: '🤦', label: 'Facepalm' },
  { id: 's19', emoji: '💪', label: 'Muscle' },
  { id: 's20', emoji: '✨', label: 'Sparkles' },
];

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

const TENOR_KEY = 'AIzaSyAyimkuYQYF_FXVALexPzfiTPEHC2H18mk';
const SCREEN_W = Dimensions.get('window').width;
const TILE_SIZE = (SCREEN_W - 18 * 2 - 10) / 2; // 2 columns, 10px gap

export function GifPicker({ visible, onClose, onSelectGif, onSelectSticker }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<GifTab>('gifs');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TenorResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchGifs = useCallback(async (q: string) => {
    setLoading(true);
    setError(false);
    try {
      const endpoint = q.trim()
        ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=20&media_filter=gif`
        : `https://tenor.googleapis.com/v2/featured?key=${TENOR_KEY}&limit=20&media_filter=gif`;

      const res = await fetch(endpoint);
      if (!res.ok) throw new Error('tenor_error');
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
        const preview = item.media_formats.nanogif ?? item.media_formats.tinygif;
        const full = item.media_formats.tinygif ?? item.media_formats.gif;
        return {
          id: item.id,
          url: full?.url ?? '',
          previewUrl: preview?.url ?? full?.url ?? '',
          width: preview?.dims[0] ?? 200,
          height: preview?.dims[1] ?? 200,
        };
      }).filter((r) => r.url);
      setResults(mapped);
    } catch {
      setError(true);
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

  const colCount = 2;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onShow={handleShow}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, backgroundColor: t.bg }}
      >
        {/* Header */}
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 18,
            paddingBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            borderBottomWidth: 1,
            borderBottomColor: t.border,
          }}
        >
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel="Close GIF picker"
            style={{ padding: 4 }}
          >
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
          <Text
            style={{
              fontFamily: t.fontDisplay,
              fontSize: 17,
              fontWeight: '600',
              color: t.text,
              flex: 1,
            }}
          >
            {activeTab === 'gifs' ? 'GIFs' : 'Stickers'}
          </Text>
        </View>

        {/* Tabs */}
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: 18,
            paddingTop: 12,
            paddingBottom: 10,
            gap: 8,
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
                  paddingHorizontal: 18,
                  paddingVertical: 7,
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
        </View>

        {/* Search bar (only for GIFs) */}
        {activeTab === 'gifs' && (
          <View style={{ paddingHorizontal: 18, marginBottom: 12 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: t.radius,
                paddingHorizontal: 12,
                gap: 8,
              }}
            >
              <I.Search size={16} color={t.textDim} />
              <TextInput
                value={query}
                onChangeText={handleQueryChange}
                placeholder="Search GIFs…"
                placeholderTextColor={t.textDim}
                style={{
                  flex: 1,
                  fontFamily: t.font,
                  fontSize: 14,
                  color: t.text,
                  paddingVertical: 10,
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
                  <I.X size={16} color={t.textDim} />
                </Pressable>
              )}
            </View>
          </View>
        )}

        {/* Content */}
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
                  ? 'Could not connect to the GIF service. Check your internet connection.'
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
              contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 12, gap: 10 }}
              columnWrapperStyle={{ gap: 10 }}
              removeClippedSubviews
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
          /* Stickers grid */
          <FlatList
            data={STICKERS}
            keyExtractor={(item) => item.id}
            numColumns={4}
            contentContainerStyle={{
              paddingHorizontal: 18,
              paddingBottom: insets.bottom + 12,
              gap: 10,
            }}
            columnWrapperStyle={{ gap: 10 }}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onSelectSticker(item.emoji)}
                accessibilityLabel={`Sticker: ${item.label}`}
                style={({ pressed }) => ({
                  flex: 1,
                  aspectRatio: 1,
                  backgroundColor: t.surface,
                  borderWidth: 1,
                  borderColor: t.border,
                  borderRadius: t.radius,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <Text style={{ fontSize: 36 }}>{item.emoji}</Text>
              </Pressable>
            )}
          />
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}
