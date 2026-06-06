import { useEffect, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Dimensions, ActivityIndicator } from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import type { Theme } from '../theme/vault';

interface Props {
  t: Theme;
  visible: boolean;
  imageUri: string | null;
  imageWidth: number;
  imageHeight: number;
  /** Called with a persistent file:// URI of the 256px square avatar. */
  onConfirm: (uri: string) => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  title?: string;
}

const WIN = Dimensions.get('window');
// Square crop viewport side (logical px).
const VIEW = Math.min(WIN.width - 48, 320);
const MIN_S = 1;
const MAX_S = 4;

/**
 * In-app avatar cropper: pinch to zoom, drag to position, then Confirm.
 *
 * We crop in-app instead of relying on expo-image-picker's `allowsEditing`, whose
 * native crop activity (CanHub) renders an unlabeled confirm checkmark that users
 * could not find ("no way to confirm the selected image"). Here the confirm is an
 * explicit button and the result is a centered, user-framed 256px JPEG.
 */
export function AvatarCropModal({
  t, visible, imageUri, imageWidth, imageHeight,
  onConfirm, onCancel, confirmLabel = 'Confirm', cancelLabel = 'Cancel', title = 'Adjust photo',
}: Props) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const [busy, setBusy] = useState(false);

  const imgW = imageWidth > 0 ? imageWidth : 1;
  const imgH = imageHeight > 0 ? imageHeight : 1;
  // At scale=1 the image's SHORTER side exactly fills the viewport (cover-fit).
  const coverScale = VIEW / Math.min(imgW, imgH);
  const baseW = imgW * coverScale;
  const baseH = imgH * coverScale;

  // Reset transforms whenever a new image is opened.
  useEffect(() => {
    if (visible) {
      scale.value = 1; savedScale.value = 1;
      tx.value = 0; ty.value = 0; savedTx.value = 0; savedTy.value = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, imageUri]);

  function clamp() {
    'worklet';
    if (scale.value < MIN_S) scale.value = MIN_S;
    if (scale.value > MAX_S) scale.value = MAX_S;
    const maxX = Math.max(0, (baseW * scale.value - VIEW) / 2);
    const maxY = Math.max(0, (baseH * scale.value - VIEW) / 2);
    if (tx.value > maxX) tx.value = maxX;
    if (tx.value < -maxX) tx.value = -maxX;
    if (ty.value > maxY) ty.value = maxY;
    if (ty.value < -maxY) ty.value = -maxY;
  }

  const pan = Gesture.Pan()
    .onStart(() => { savedTx.value = tx.value; savedTy.value = ty.value; })
    .onUpdate((e) => { tx.value = savedTx.value + e.translationX; ty.value = savedTy.value + e.translationY; })
    .onEnd(() => { clamp(); });

  const pinch = Gesture.Pinch()
    .onStart(() => { savedScale.value = scale.value; })
    .onUpdate((e) => { scale.value = savedScale.value * e.scale; })
    .onEnd(() => { clamp(); });

  const composed = Gesture.Simultaneous(pan, pinch);

  const imgStyle = useAnimatedStyle(() => ({
    width: baseW,
    height: baseH,
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  async function handleConfirm() {
    if (!imageUri || busy) return;
    setBusy(true);
    try {
      const f = coverScale * scale.value; // source-px → screen-px
      const cropSide = VIEW / f;
      // Viewport (centered over the image) top-left in source pixels.
      let ox = imgW / 2 + (-VIEW / 2 - tx.value) / f;
      let oy = imgH / 2 + (-VIEW / 2 - ty.value) / f;
      ox = Math.max(0, Math.min(imgW - cropSide, ox));
      oy = Math.max(0, Math.min(imgH - cropSide, oy));
      const side = Math.max(1, Math.min(cropSide, imgW - ox, imgH - oy));
      const result = await manipulateAsync(
        imageUri,
        [
          { crop: { originX: Math.round(ox), originY: Math.round(oy), width: Math.round(side), height: Math.round(side) } },
          { resize: { width: 256 } },
        ],
        { compress: 0.7, format: SaveFormat.JPEG },
      );
      // Persist to documentDirectory so it survives cache eviction / restarts.
      const dir = `${FileSystem.documentDirectory}avatars/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
      const dest = `${dir}self.jpg`;
      try {
        await FileSystem.deleteAsync(dest, { idempotent: true });
      } catch { /* ignore */ }
      await FileSystem.copyAsync({ from: result.uri, to: dest });
      onConfirm(dest);
    } catch {
      // Fall back to the raw picked image so the user is never blocked.
      onConfirm(imageUri);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <GestureHandlerRootView style={styles.root}>
        <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
          <Text style={[styles.title, { color: t.text }]}>{title}</Text>
          <Text style={[styles.hint, { color: t.textDim }]}>
            {/* pinch + drag hint */}
            ⤢  zoom · ✣  arrastra
          </Text>

          {/* Crop viewport with circular mask overlay */}
          <View style={[styles.viewport, { width: VIEW, height: VIEW }]}>
            <GestureDetector gesture={composed}>
              <Animated.View style={styles.imgWrap}>
                {imageUri ? (
                  <Animated.Image source={{ uri: imageUri }} style={imgStyle} resizeMode="cover" />
                ) : null}
              </Animated.View>
            </GestureDetector>
            {/* Circular mask: 4 corners dimmed via a ring overlay */}
            <View pointerEvents="none" style={[styles.ring, { borderColor: 'rgba(0,0,0,0.55)' }]} />
            <View pointerEvents="none" style={[styles.circleOutline, { borderColor: t.accent }]} />
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              style={[styles.btn, { backgroundColor: t.surface2, borderColor: t.borderStrong }]}
            >
              <Text style={[styles.btnText, { color: t.text }]}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              onPress={handleConfirm}
              disabled={busy}
              style={[styles.btn, { backgroundColor: t.accent, opacity: busy ? 0.6 : 1 }]}
            >
              {busy
                ? <ActivityIndicator color="#06281b" />
                : <Text style={[styles.btnText, { color: '#06281b' }]}>{confirmLabel}</Text>}
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 6 },
  hint: { fontSize: 13, marginBottom: 20 },
  viewport: {
    borderRadius: VIEW / 2,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imgWrap: { alignItems: 'center', justifyContent: 'center', width: VIEW, height: VIEW },
  ring: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: VIEW / 2, borderWidth: 0,
  },
  circleOutline: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: VIEW / 2, borderWidth: 2,
  },
  actions: { flexDirection: 'row', gap: 12, marginTop: 28 },
  btn: {
    flex: 1, paddingVertical: 15, borderRadius: 14, alignItems: 'center',
    borderWidth: 1, borderColor: 'transparent', minWidth: 120,
  },
  btnText: { fontSize: 16, fontWeight: '600' },
});
