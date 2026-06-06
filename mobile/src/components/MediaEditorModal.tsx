import { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, Pressable, TextInput, StyleSheet, Dimensions,
  ActivityIndicator, Image, Platform, Keyboard,
} from 'react-native';
import {
  Gesture, GestureDetector, GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { manipulateAsync, SaveFormat, FlipType } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import type { Theme } from '../theme/vault';

/**
 * WhatsApp-style media editor for chat/group images.
 *
 * Tools: crop (pan/zoom into a frame), rotate 90°, freehand draw (pen w/ colors),
 * draggable text overlays, and a caption. On send it flattens the drawings + text
 * onto the (cropped/rotated) image with react-native-view-shot and returns the
 * final JPEG URI plus the caption. The parent does the encrypt+upload+send.
 *
 * The app root has no GestureHandlerRootView, so this modal wraps its own.
 */

interface DrawPath { d: string; color: string; width: number; }
interface TextItem { id: string; text: string; x: number; y: number; color: string; }

interface Props {
  t: Theme;
  visible: boolean;
  imageUri: string | null;
  onCancel: () => void;
  onSend: (result: { uri: string; caption: string }) => void;
  sendLabel?: string;
  captionPlaceholder?: string;
}

const WIN = Dimensions.get('window');
const PEN_COLORS = ['#ffffff', '#000000', '#ff3b30', '#34c759', '#0a84ff', '#ffd60a', '#ff2d55'];
const PEN_WIDTH = 5;

type Mode = 'view' | 'draw' | 'text';

export function MediaEditorModal({
  t, visible, imageUri, onCancel, onSend,
  sendLabel = 'Send', captionPlaceholder = 'Add a caption…',
}: Props) {
  // Working copy of the image (crop/rotate are baked into this uri).
  const [baseUri, setBaseUri] = useState<string | null>(imageUri);
  const [mode, setMode] = useState<Mode>('view');
  const [paths, setPaths] = useState<DrawPath[]>([]);
  const [redoStack, setRedoStack] = useState<DrawPath[]>([]);
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [penColor, setPenColor] = useState(PEN_COLORS[2]);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  // Pristine picked image, so "reset" can undo crop/rotate.
  const origUriRef = useRef<string | null>(imageUri);
  // Stage (the flatten target) layout, measured on screen.
  const [stage, setStage] = useState({ width: WIN.width, height: WIN.width });
  const stageRef = useRef<View>(null);

  // current in-progress drawing path (string of SVG commands)
  const [curPath, setCurPath] = useState<string>('');
  const curPathRef = useRef('');

  // Track the keyboard so the caption + send bar rises above it (the Modal does
  // not get the window's adjustResize behaviour on Android).
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (visible) {
      setBaseUri(imageUri);
      origUriRef.current = imageUri;
      setMode('view'); setCropOpen(false);
      setPaths([]); setRedoStack([]); setTexts([]); setCaption('');
      setPenColor(PEN_COLORS[2]); setEditingTextId(null); setCurPath('');
    }
  }, [visible, imageUri]);

  function getSize(uri: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      Image.getSize(uri, (w, h) => resolve({ w, h }), reject);
    });
  }

  // Center-crop the current image to a target aspect ratio (WhatsApp-style quick crop).
  async function applyAspect(aw: number, ah: number) {
    if (!baseUri || busy) return;
    setBusy(true);
    try {
      const { w, h } = await getSize(baseUri);
      const target = aw / ah;
      let cw = w, ch = Math.round(w / target);
      if (ch > h) { ch = h; cw = Math.round(h * target); }
      const ox = Math.max(0, Math.round((w - cw) / 2));
      const oy = Math.max(0, Math.round((h - ch) / 2));
      const r = await manipulateAsync(
        baseUri,
        [{ crop: { originX: ox, originY: oy, width: Math.min(cw, w - ox), height: Math.min(ch, h - oy) } }],
        { compress: 1, format: SaveFormat.JPEG },
      );
      setBaseUri(r.uri);
      setPaths([]); setRedoStack([]); setTexts([]); setCurPath('');
    } catch { /* keep current */ }
    finally { setBusy(false); }
  }

  function resetCrop() {
    if (origUriRef.current) {
      setBaseUri(origUriRef.current);
      setPaths([]); setRedoStack([]); setTexts([]); setCurPath('');
    }
  }

  // ── Draw gesture (only active in draw mode) ────────────────────────────────
  const draw = Gesture.Pan()
    .enabled(mode === 'draw')
    .minDistance(0)
    .onStart((e) => { curPathRef.current = `M ${e.x.toFixed(1)} ${e.y.toFixed(1)}`; setCurPath(curPathRef.current); })
    .onUpdate((e) => { curPathRef.current = `${curPathRef.current} L ${e.x.toFixed(1)} ${e.y.toFixed(1)}`; setCurPath(curPathRef.current); })
    .onEnd(() => {
      const d = curPathRef.current;
      if (d) {
        setPaths((prev) => [...prev, { d, color: penColor, width: PEN_WIDTH }]);
        setRedoStack([]);
      }
      curPathRef.current = '';
      setCurPath('');
    })
    .runOnJS(true);

  function undo() {
    setPaths((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, last]);
      return prev.slice(0, -1);
    });
  }

  async function applyRotate() {
    if (!baseUri || busy) return;
    setBusy(true);
    try {
      const r = await manipulateAsync(baseUri, [{ rotate: 90 }], { compress: 1, format: SaveFormat.JPEG });
      setBaseUri(r.uri);
      // Rotating changes geometry → clear vector overlays (they'd no longer line up).
      setPaths([]); setRedoStack([]); setTexts([]); setCurPath('');
    } catch { /* keep current */ }
    finally { setBusy(false); }
  }

  async function applyFlip() {
    if (!baseUri || busy) return;
    setBusy(true);
    try {
      const r = await manipulateAsync(baseUri, [{ flip: FlipType.Horizontal }], { compress: 1, format: SaveFormat.JPEG });
      setBaseUri(r.uri);
    } catch { /* keep */ }
    finally { setBusy(false); }
  }

  function addText() {
    const id = `${Date.now()}`;
    setTexts((prev) => [...prev, { id, text: '', x: stage.width / 2 - 60, y: stage.height / 2 - 16, color: '#ffffff' }]);
    setEditingTextId(id);
    setMode('text');
  }

  function updateText(id: string, patch: Partial<TextItem>) {
    setTexts((prev) => prev.map((tx) => (tx.id === id ? { ...tx, ...patch } : tx)));
  }

  function makeTextPan(id: string) {
    const start = { x: 0, y: 0 };
    return Gesture.Pan()
      .enabled(mode !== 'draw')
      .onStart(() => {
        const it = texts.find((tx) => tx.id === id);
        start.x = it?.x ?? 0; start.y = it?.y ?? 0;
      })
      .onUpdate((e) => { updateText(id, { x: start.x + e.translationX, y: start.y + e.translationY }); })
      .runOnJS(true);
  }

  async function handleSend() {
    if (!baseUri || busy) return;
    setBusy(true);
    try {
      let finalUri = baseUri;
      const hasOverlay = paths.length > 0 || texts.some((tx) => tx.text.trim().length > 0);
      if (hasOverlay && stageRef.current) {
        // Flatten image + vector overlay + text into one bitmap.
        const shot = await captureRef(stageRef, { format: 'jpg', quality: 0.9, result: 'tmpfile' });
        finalUri = shot;
      }
      // Normalise/compress to keep wire size reasonable.
      const out = await manipulateAsync(finalUri, [{ resize: { width: 1080 } }], { compress: 0.7, format: SaveFormat.JPEG });
      // Copy to a stable cache path the OS won't evict mid-upload.
      const dest = `${FileSystem.cacheDirectory}edited_${Date.now()}.jpg`;
      try { await FileSystem.copyAsync({ from: out.uri, to: dest }); } catch { /* use out.uri */ }
      onSend({ uri: dest, caption: caption.trim() });
    } catch {
      // Fallback: send the base image with the caption so the user is never blocked.
      onSend({ uri: baseUri, caption: caption.trim() });
    } finally {
      setBusy(false);
    }
  }

  const toolBtn = (active: boolean) => [
    styles.tool,
    { backgroundColor: active ? t.accent : 'rgba(255,255,255,0.12)' },
  ];

  return (
    <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onCancel}>
      <GestureHandlerRootView style={[styles.root, { backgroundColor: '#000' }]}>
        {/* Top bar */}
        <View style={styles.topbar}>
          <Pressable onPress={onCancel} hitSlop={10} style={styles.topBtn}>
            <Text style={styles.topIcon}>✕</Text>
          </Pressable>
          <View style={styles.topTools}>
            <Pressable onPress={() => setCropOpen((v) => !v)} hitSlop={8} style={toolBtn(cropOpen)}>
              <Text style={styles.toolIcon}>⛶</Text>
            </Pressable>
            <Pressable onPress={applyRotate} hitSlop={8} style={toolBtn(false)}>
              <Text style={styles.toolIcon}>↻</Text>
            </Pressable>
            <Pressable onPress={applyFlip} hitSlop={8} style={toolBtn(false)}>
              <Text style={styles.toolIcon}>⇋</Text>
            </Pressable>
            <Pressable
              onPress={() => setMode((m) => (m === 'draw' ? 'view' : 'draw'))}
              hitSlop={8}
              style={toolBtn(mode === 'draw')}
            >
              <Text style={styles.toolIcon}>✎</Text>
            </Pressable>
            <Pressable onPress={addText} hitSlop={8} style={toolBtn(mode === 'text')}>
              <Text style={[styles.toolIcon, { fontWeight: '800' }]}>T</Text>
            </Pressable>
            {(paths.length > 0) && (
              <Pressable onPress={undo} hitSlop={8} style={toolBtn(false)}>
                <Text style={styles.toolIcon}>⟲</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Crop aspect row */}
        {cropOpen && (
          <View style={styles.cropRow}>
            {([['1:1', 1, 1], ['4:5', 4, 5], ['16:9', 16, 9], ['9:16', 9, 16]] as const).map(([label, aw, ah]) => (
              <Pressable key={label} onPress={() => applyAspect(aw, ah)} style={styles.cropBtn}>
                <Text style={styles.cropBtnText}>{label}</Text>
              </Pressable>
            ))}
            <Pressable onPress={resetCrop} style={styles.cropBtn}>
              <Text style={styles.cropBtnText}>⟲</Text>
            </Pressable>
          </View>
        )}

        {/* Color row in draw mode */}
        {mode === 'draw' && (
          <View style={styles.colorRow}>
            {PEN_COLORS.map((c) => (
              <Pressable
                key={c}
                onPress={() => setPenColor(c)}
                style={[
                  styles.swatch,
                  { backgroundColor: c, borderColor: penColor === c ? t.accent : 'rgba(255,255,255,0.4)', borderWidth: penColor === c ? 3 : 1 },
                ]}
              />
            ))}
          </View>
        )}

        {/* Stage (the area captured by view-shot) */}
        <View style={styles.stageWrap}>
          <View
            ref={stageRef}
            collapsable={false}
            style={styles.stage}
            onLayout={(e) => setStage({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
          >
            {baseUri && (
              <Image source={{ uri: baseUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            )}

            {/* Text overlays */}
            {texts.map((tx) => {
              const pan = makeTextPan(tx.id);
              return (
                <GestureDetector key={tx.id} gesture={pan}>
                  <View style={[styles.textItem, { left: tx.x, top: tx.y }]}>
                    {editingTextId === tx.id ? (
                      <TextInput
                        value={tx.text}
                        onChangeText={(v) => updateText(tx.id, { text: v })}
                        onBlur={() => setEditingTextId(null)}
                        autoFocus
                        multiline
                        placeholder="texto"
                        placeholderTextColor="rgba(255,255,255,0.5)"
                        style={[styles.textInputOverlay, { color: tx.color }]}
                      />
                    ) : (
                      <Pressable onPress={() => { setEditingTextId(tx.id); setMode('text'); }}>
                        <Text style={[styles.textOverlay, { color: tx.color }]}>{tx.text || ' '}</Text>
                      </Pressable>
                    )}
                  </View>
                </GestureDetector>
              );
            })}

            {/* Drawing layer */}
            <GestureDetector gesture={draw}>
              <View style={StyleSheet.absoluteFill} pointerEvents={mode === 'draw' ? 'auto' : 'box-none'}>
                <Svg style={StyleSheet.absoluteFill}>
                  {paths.map((p, i) => (
                    <Path key={i} d={p.d} stroke={p.color} strokeWidth={p.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  ))}
                  {curPath ? (
                    <Path d={curPath} stroke={penColor} strokeWidth={PEN_WIDTH} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  ) : null}
                </Svg>
              </View>
            </GestureDetector>
          </View>
        </View>

        {/* Caption + send */}
        <View style={[styles.bottom, { backgroundColor: 'rgba(0,0,0,0.6)', marginBottom: kbHeight }]}>
          <TextInput
            value={caption}
            onChangeText={setCaption}
            placeholder={captionPlaceholder}
            placeholderTextColor="rgba(255,255,255,0.5)"
            style={[styles.caption, { color: '#fff', backgroundColor: 'rgba(255,255,255,0.12)' }]}
            multiline
          />
          <Pressable onPress={handleSend} disabled={busy} style={[styles.send, { backgroundColor: t.accent, opacity: busy ? 0.6 : 1 }]}>
            {busy ? <ActivityIndicator color="#06281b" /> : <Text style={styles.sendIcon}>➤</Text>}
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 54 : 28, paddingHorizontal: 16, paddingBottom: 8,
  },
  topBtn: { padding: 8 },
  topIcon: { color: '#fff', fontSize: 22, fontWeight: '600' },
  topTools: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  tool: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  toolIcon: { color: '#fff', fontSize: 20 },
  colorRow: { flexDirection: 'row', gap: 12, justifyContent: 'center', paddingVertical: 8 },
  cropRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', paddingVertical: 8, flexWrap: 'wrap' },
  cropBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.14)' },
  cropBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  stageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stage: { width: WIN.width, flex: 1, alignSelf: 'stretch', overflow: 'hidden' },
  textItem: { position: 'absolute', maxWidth: WIN.width - 40 },
  textOverlay: { fontSize: 28, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
  textInputOverlay: { fontSize: 28, fontWeight: '700', minWidth: 120, padding: 0 },
  bottom: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 12, paddingBottom: Platform.OS === 'ios' ? 30 : 14 },
  caption: { flex: 1, minHeight: 46, maxHeight: 120, borderRadius: 23, paddingHorizontal: 18, paddingVertical: 12, fontSize: 16 },
  send: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  sendIcon: { color: '#06281b', fontSize: 22, fontWeight: '800' },
});
