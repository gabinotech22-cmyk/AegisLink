/**
 * MultiPreviewScreen — preview before sending N images or files.
 *
 * Shown between AttachSheet (selection) and the actual send. The user sees a
 * grid of the selected items, can type an optional caption, and taps Send to
 * confirm. Tapping Back cancels without sending anything.
 *
 * Mirrors the UX of MediaEditorModal (single-image preview + caption) but for
 * multiple assets. Replaces the previous "send silently on select" behaviour
 * (Bug C fix) and eliminates the double-pop that sent the user to the home
 * screen (Bug B fix — this screen is pushed instead of calling pop() twice).
 */

import { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

export type MultiPreviewAsset =
  | { kind: 'image'; asset: ImagePickerAsset }
  | { kind: 'file'; asset: DocumentPickerAsset };

interface Props {
  assets: MultiPreviewAsset[];
  /** Display name of the recipient (contact or group). */
  recipientName: string;
  onBack: () => void;
  /** Called when the user confirms. caption may be empty string. */
  onSend: (assets: MultiPreviewAsset[], caption: string) => void;
}

export function MultiPreviewScreen({ assets, recipientName, onBack, onSend }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (sending) return;
    setSending(true);
    try {
      onSend(assets, caption.trim());
    } finally {
      setSending(false);
    }
  }

  const imageAssets = assets.filter((a): a is Extract<MultiPreviewAsset, { kind: 'image' }> => a.kind === 'image');
  const fileAssets = assets.filter((a): a is Extract<MultiPreviewAsset, { kind: 'file' }> => a.kind === 'file');

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <TopBar
          t={t}
          title={`${assets.length} ${i18nT('multiPreview.title', 'adjuntos')}`}
          left={
            <Pressable
              onPress={onBack}
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityLabel={i18nT('common.back', 'Volver')}
            >
              <I.ChevronL size={22} color={t.textDim} />
            </Pressable>
          }
        />

        {/* Recipient label */}
        <View style={[styles.recipientRow, { borderBottomColor: t.divider }]}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.8 }}>
            {i18nT('multiPreview.sendTo', 'ENVIAR A')}
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.text, marginTop: 2, fontWeight: '600' }} numberOfLines={1}>
            {recipientName}
          </Text>
        </View>

        {/* Image grid */}
        {imageAssets.length > 0 && (
          <FlatList
            data={imageAssets}
            keyExtractor={(_, i) => String(i)}
            numColumns={3}
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ padding: 2 }}
            renderItem={({ item }) => (
              <View style={styles.thumbContainer}>
                <Image
                  source={{ uri: item.asset.uri }}
                  style={styles.thumb}
                  resizeMode="cover"
                />
              </View>
            )}
          />
        )}

        {/* File list */}
        {fileAssets.length > 0 && (
          <View style={[styles.fileList, { borderTopColor: t.divider, borderBottomColor: t.divider }]}>
            {fileAssets.map((item, i) => (
              <View
                key={i}
                style={[
                  styles.fileRow,
                  {
                    backgroundColor: t.surface,
                    borderColor: t.border,
                    borderRadius: t.radiusS,
                  },
                ]}
              >
                <I.Attach size={16} color={t.accent} />
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, fontFamily: t.font, fontSize: 13, color: t.text }}
                >
                  {item.asset.name ?? i18nT('multiPreview.file', 'archivo')}
                </Text>
                {item.asset.size != null && (
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>
                    {formatSize(item.asset.size)}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}

        <View style={{ flex: 1 }} />

        {/* Caption input */}
        <View
          style={[
            styles.captionRow,
            {
              borderTopColor: t.divider,
              backgroundColor: t.surface,
              paddingBottom: insets.bottom > 0 ? insets.bottom : 12,
            },
          ]}
        >
          <TextInput
            style={[
              styles.captionInput,
              {
                fontFamily: t.font,
                color: t.text,
                backgroundColor: t.surface2,
                borderColor: t.border,
                borderRadius: t.radiusS,
              },
            ]}
            placeholder={i18nT('multiPreview.captionPlaceholder', 'Añadir un mensaje… (opcional)')}
            placeholderTextColor={t.textFaint}
            value={caption}
            onChangeText={setCaption}
            multiline
            maxLength={500}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={() => { void handleSend(); }}
          />
          <Pressable
            onPress={() => { void handleSend(); }}
            disabled={sending}
            accessibilityLabel={i18nT('multiPreview.send', 'Enviar')}
            style={({ pressed }) => [
              styles.sendBtn,
              {
                backgroundColor: t.accent,
                opacity: (pressed || sending) ? 0.75 : 1,
              },
            ]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={t.bg} />
            ) : (
              <I.Send size={20} color={t.bg} />
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  recipientRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumbContainer: {
    flex: 1,
    aspectRatio: 1,
    margin: 2,
    maxWidth: '33.33%',
    overflow: 'hidden',
    borderRadius: 4,
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  fileList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 6,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  captionInput: {
    flex: 1,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    minHeight: 40,
    maxHeight: 120,
    lineHeight: 20,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
