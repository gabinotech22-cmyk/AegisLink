import { useState, useRef, useEffect } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import type { Video as VideoRef } from 'expo-av';
import type { Theme } from '../theme/vault';
import type { StoredMessage } from '../db/local';
import { resolveMedia } from '../crypto/media';
import { I } from './icons';

interface VideoBubbleProps {
  t: Theme;
  m: StoredMessage;
  me: boolean;
  queued?: boolean;
  time: string;
  onLongPress?: () => void;
}

export function VideoBubble({ t, m, me, queued, time, onLongPress }: VideoBubbleProps) {
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const videoRef = useRef<VideoRef>(null);
  // Decrypted local file path. `m.mediaUri` is a `blob:<id>:<key>:<nonce>` ref
  // after upload, which expo-av's <Video> cannot open — we must resolve+decrypt
  // it to a local file first (same as images via MediaImage). Plain file:// URIs
  // (a freshly-sent local clip, before the blob swap) are used as-is.
  const [localUri, setLocalUri] = useState<string | null>(
    m.mediaUri && !m.mediaUri.startsWith('blob:') ? m.mediaUri : null,
  );

  useEffect(() => {
    setLoadError(false);
    setLoading(true);
    let alive = true;
    if (!m.mediaUri) { setLocalUri(null); return; }
    if (!m.mediaUri.startsWith('blob:')) { setLocalUri(m.mediaUri); return; }
    setLocalUri(null);
    void resolveMedia(m.mediaUri, 'mp4').then((p) => {
      if (!alive) return;
      setLocalUri(p);
      if (!p) setLoadError(true);
    });
    return () => { alive = false; };
  }, [m.mediaUri]);

  const bubbleBg = me ? t.bubbleOut : t.bubbleIn;
  const textColor = me ? t.bubbleOutText : t.bubbleInText;

  function handlePlaybackStatus(status: AVPlaybackStatus) {
    if (status.isLoaded) {
      setLoading(false);
      setLoadError(false);
    } else if (status.error) {
      setLoading(false);
      setLoadError(true);
    }
  }

  function handleLoadStart() {
    setLoading(true);
    setLoadError(false);
  }

  function handleError() {
    setLoading(false);
    setLoadError(true);
  }

  // Downloading / decrypting / not yet available
  if (!localUri && !loadError) {
    return (
      <Pressable
        onLongPress={onLongPress}
        accessibilityLabel="Video message downloading"
        style={({ pressed }) => ({
          alignSelf: me ? 'flex-end' : 'flex-start',
          width: 220,
          backgroundColor: bubbleBg,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          overflow: 'hidden',
          opacity: queued ? 0.55 : pressed ? 0.88 : 1,
        })}
      >
        <View
          style={{
            width: 220,
            height: 160,
            backgroundColor: t.surface3,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <ActivityIndicator color={t.accent} size="small" />
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.textFaint,
              letterSpacing: 0.5,
            }}
          >
            DESCARGANDO…
          </Text>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 10,
            paddingVertical: 6,
            gap: 6,
          }}
        >
          <I.Video size={13} color={textColor} />
          <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: textColor, letterSpacing: 0.3 }}>
            Video · E2EE
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: me ? `${t.bubbleOutText}99` : t.textFaint }}>
            {time}
          </Text>
        </View>
      </Pressable>
    );
  }

  // Load error state
  if (loadError) {
    return (
      <Pressable
        onLongPress={onLongPress}
        accessibilityLabel="Video message failed to load"
        style={({ pressed }) => ({
          alignSelf: me ? 'flex-end' : 'flex-start',
          width: 220,
          backgroundColor: bubbleBg,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          overflow: 'hidden',
          opacity: pressed ? 0.88 : 1,
        })}
      >
        <View
          style={{
            width: 220,
            height: 160,
            backgroundColor: t.surface3,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <I.Video size={28} color={t.textFaint} />
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.textFaint,
              letterSpacing: 0.5,
            }}
          >
            ERROR AL CARGAR
          </Text>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 10,
            paddingVertical: 6,
            gap: 6,
          }}
        >
          <I.Video size={13} color={textColor} />
          <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: textColor, letterSpacing: 0.3 }}>
            Video · E2EE
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: me ? `${t.bubbleOutText}99` : t.textFaint }}>
            {time}
          </Text>
        </View>
      </Pressable>
    );
  }

  // Normal playback state
  return (
    <Pressable
      onLongPress={onLongPress}
      accessibilityLabel="Video message — tap to play"
      style={({ pressed }) => ({
        alignSelf: me ? 'flex-end' : 'flex-start',
        width: 220,
        backgroundColor: bubbleBg,
        borderRadius: t.radius,
        borderTopRightRadius: me ? t.radiusS : t.radius,
        borderTopLeftRadius: me ? t.radius : t.radiusS,
        overflow: 'hidden',
        opacity: queued ? 0.55 : pressed ? 0.88 : 1,
      })}
    >
      <View style={{ width: 220, height: 160, backgroundColor: t.surface3 }}>
        <Video
          ref={videoRef}
          source={{ uri: localUri ?? m.mediaUri }}
          style={{ width: 220, height: 160, borderRadius: 0 }}
          resizeMode={ResizeMode.CONTAIN}
          useNativeControls
          onPlaybackStatusUpdate={handlePlaybackStatus}
          onLoadStart={handleLoadStart}
          onError={handleError}
          shouldPlay={false}
        />
        {loading && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 220,
              height: 160,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: t.surface3,
            }}
          >
            <ActivityIndicator color={t.accent} size="small" />
          </View>
        )}
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 10,
          paddingVertical: 6,
          gap: 6,
        }}
      >
        <I.Video size={13} color={textColor} />
        <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: textColor, letterSpacing: 0.3 }}>
          Video · E2EE
        </Text>
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: me ? `${t.bubbleOutText}99` : t.textFaint }}>
          {time}
        </Text>
      </View>
    </Pressable>
  );
}
