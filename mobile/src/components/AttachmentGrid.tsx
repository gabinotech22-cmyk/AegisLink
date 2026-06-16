import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { I } from './icons';
import { MediaImage } from './MediaImage';
import type { Attachment } from '../db/local';

interface Props {
  attachments: Attachment[];
  isMe: boolean;
  onImagePress: (uri: string, index: number) => void;
  onFilePress: (attachment: Attachment) => void;
  caption?: string;
}

/** Maximum images to show in the grid before collapsing with a +N overlay. */
const MAX_VISIBLE = 4;
/** Cell dimension for 2-column grid (fits in a ~240-wide bubble). */
const CELL = 108;
const SINGLE_W = 220;
const SINGLE_H = 180;

function GridImage({
  att,
  index,
  size,
  onPress,
  overlay,
  accentColor,
}: {
  att: Attachment;
  index: number;
  size: number;
  onPress: () => void;
  overlay?: string;
  accentColor: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={`Image ${index + 1}`}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: 6,
        overflow: 'hidden',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <MediaImage
        uri={att.uri}
        ext="jpg"
        accent={accentColor}
        style={{ width: size, height: size }}
        resizeMode="cover"
      />
      {!!overlay && (
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            backgroundColor: 'rgba(0,0,0,0.55)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 22, fontWeight: '700' }}>{overlay}</Text>
        </View>
      )}
    </Pressable>
  );
}

// Inline StyleSheet to avoid extra import
const StyleSheet = {
  absoluteFillObject: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
};

export function AttachmentGrid({ attachments, isMe, onImagePress, onFilePress, caption }: Props) {
  const { t } = useTheme();

  const images = attachments.filter((a) => a.type === 'image' || a.type === 'video');
  const files = attachments.filter((a) => a.type === 'file' || a.type === 'audio');

  const bubbleBg = isMe ? t.bubbleOut : t.bubbleIn;
  const textColor = isMe ? t.bubbleOutText : t.bubbleInText;
  const dimColor = isMe ? `${t.bubbleOutText}99` : `${t.bubbleInText}99`;

  return (
    <View
      style={{
        backgroundColor: bubbleBg,
        borderRadius: t.radius,
        borderTopRightRadius: isMe ? (t.radiusS ?? 4) : t.radius,
        borderTopLeftRadius: isMe ? t.radius : (t.radiusS ?? 4),
        overflow: 'hidden',
        maxWidth: SINGLE_W + 4,
      }}
    >
      {/* ── Image grid ── */}
      {images.length > 0 && (
        <View style={{ padding: images.length === 1 ? 0 : 3, gap: 3 }}>
          {images.length === 1 && (
            <Pressable
              onPress={() => onImagePress(images[0].uri, 0)}
              accessibilityLabel="Image 1"
              style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
            >
              <MediaImage
                uri={images[0].uri}
                ext="jpg"
                accent={t.accent}
                style={{ width: SINGLE_W, height: SINGLE_H }}
                resizeMode="cover"
              />
            </Pressable>
          )}

          {images.length === 2 && (
            <View style={{ flexDirection: 'row', gap: 3 }}>
              {images.map((img, idx) => (
                <GridImage
                  key={img.uri + idx}
                  att={img}
                  index={idx}
                  size={CELL}
                  onPress={() => onImagePress(img.uri, idx)}
                  accentColor={t.accent}
                />
              ))}
            </View>
          )}

          {images.length >= 3 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 3 }}>
              {images.slice(0, MAX_VISIBLE).map((img, idx) => {
                const isLast = idx === MAX_VISIBLE - 1;
                const remaining = images.length - MAX_VISIBLE;
                const overlay = isLast && remaining > 0 ? `+${remaining}` : undefined;
                return (
                  <GridImage
                    key={img.uri + idx}
                    att={img}
                    index={idx}
                    size={CELL}
                    onPress={() => onImagePress(img.uri, idx)}
                    overlay={overlay}
                    accentColor={t.accent}
                  />
                );
              })}
            </View>
          )}
        </View>
      )}

      {/* ── File / audio list ── */}
      {files.length > 0 && (
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
          {files.map((att, idx) => {
            const isAudio = att.type === 'audio';
            const label = att.fileName ?? (isAudio ? 'Audio' : 'File');
            const ext = label.includes('.') ? label.split('.').pop()?.toUpperCase() : undefined;
            return (
              <Pressable
                key={att.uri + idx}
                onPress={() => onFilePress(att)}
                accessibilityLabel={label}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                {isAudio ? (
                  <I.Mic size={18} color={textColor} />
                ) : (
                  <I.Attach size={18} color={textColor} />
                )}
                <View style={{ flex: 1 }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: textColor, fontFamily: t.font, fontSize: 13, fontWeight: '500' }}
                  >
                    {label}
                  </Text>
                  {ext && (
                    <Text style={{ color: dimColor, fontFamily: t.fontMono, fontSize: 10, letterSpacing: 0.4 }}>
                      {ext}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* ── Caption ── */}
      {!!caption && (
        <View style={{ paddingHorizontal: 12, paddingTop: images.length > 0 ? 6 : 0, paddingBottom: 8 }}>
          <Text style={{ color: textColor, fontFamily: t.font, fontSize: 14, lineHeight: 19 }}>
            {caption}
          </Text>
        </View>
      )}
    </View>
  );
}
