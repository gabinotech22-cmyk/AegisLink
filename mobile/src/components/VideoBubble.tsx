import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import type { Video as VideoRef } from 'expo-av';
import type { Theme } from '../theme/vault';
import type { StoredMessage } from '../db/local';
import { resolveMediaDetailed } from '../crypto/media';
import { I } from './icons';
import { FormattedText } from './FormattedText';

interface VideoBubbleProps {
  t: Theme;
  m: StoredMessage;
  me: boolean;
  /** Outbox state of an own message; null once settled. See chat/bubbles SendState. */
  sendState?: null | 'sending' | 'queued' | 'failed';
  time: string;
  onLongPress?: () => void;
  caption?: string;
}

export function VideoBubble({ t, m, me, sendState, time, onLongPress, caption }: VideoBubbleProps) {
  const { t: i18nT } = useTranslation();
  const queued = sendState != null;
  // This bubble renders its own footer instead of the shared TimestampRow, so it
  // has to surface the send state itself — otherwise a video stuck in the outbox
  // would show a plain timestamp exactly like a delivered one.
  const stamp =
    sendState === 'failed' ? i18nT('chat.sendFailed')
    : sendState === 'sending' ? i18nT('chat.sendingNow')
    : sendState === 'queued' ? i18nT('chat.queued')
    : time;
  const stampColor =
    sendState === 'failed' ? t.danger
    : sendState ? t.warn
    : (me ? `${t.bubbleOutText}99` : t.textFaint);
  const [loadError, setLoadError] = useState(false);
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<VideoRef>(null);
  // Decrypted local file path. `m.mediaUri` is a `blob:<id>:<key>:<nonce>` ref
  // after upload, which expo-av's <Video> cannot open — we must resolve+decrypt
  // it to a local file first (same as images via MediaImage). Plain file:// URIs
  // (a freshly-sent local clip, before the blob swap) are used as-is.
  const [localUri, setLocalUri] = useState<string | null>(
    m.mediaUri && !m.mediaUri.startsWith('blob:') ? m.mediaUri : null,
  );

  const isBlob = !!m.mediaUri && m.mediaUri.startsWith('blob:');
  const blobId = isBlob ? m.mediaUri!.split(':')[1] : null;

  // Determine the effective URI to play. If it's a blob and we haven't
  // resolved/decrypted it yet (or the resolved URI is for a different blob),
  // we treat it as not ready (null) to avoid state lag loading issues.
  const effectiveUri = (() => {
    if (!m.mediaUri) return null;
    if (!isBlob) return m.mediaUri;
    if (localUri && blobId && localUri.includes(`dec_${blobId}`)) {
      return localUri;
    }
    return null;
  })();

  useEffect(() => {
    setLoadError(false);
    setExpired(false);
    setLoading(true);
    setIsPlaying(false);
    let alive = true;
    if (!m.mediaUri) { setLocalUri(null); return; }
    if (!m.mediaUri.startsWith('blob:')) { setLocalUri(m.mediaUri); return; }
    setLocalUri(null);
    void resolveMediaDetailed(m.mediaUri, 'mp4').then((res) => {
      if (!alive) return;
      setLocalUri(res.path);
      if (!res.path) {
        setLoadError(true);
        setExpired(res.state === 'expired'); // B-7: distinguish expired from transient
      }
    });
    return () => { alive = false; };
  }, [m.mediaUri]);

  const bubbleBg = me ? t.bubbleOut : t.bubbleIn;
  const textColor = me ? t.bubbleOutText : t.bubbleInText;

  const renderCaption = () => {
    if (!caption) return null;
    return (
      <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 2 }}>
        <FormattedText
          body={caption}
          t={t}
          onAccent={me}
          style={{
            color: textColor,
            fontFamily: t.font,
            fontSize: 14,
            lineHeight: 18,
          }}
        />
      </View>
    );
  };

  function handlePlaybackStatus(status: AVPlaybackStatus) {
    if (status.isLoaded) {
      setLoading(false);
      setLoadError(false);
      setIsPlaying(status.isPlaying);
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
  if (!effectiveUri && !loadError) {
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
        {renderCaption()}
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
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: stampColor }}>
            {stamp}
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
        accessibilityLabel={expired ? 'Video message expired' : 'Video message failed to load'}
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
            {expired ? 'ADJUNTO EXPIRADO' : 'ERROR AL CARGAR'}
          </Text>
        </View>
        {renderCaption()}
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
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: stampColor }}>
            {stamp}
          </Text>
        </View>
      </Pressable>
    );
  }

  // Normal playback state
  return (
    <Pressable
      onPress={() => setIsPlaying(!isPlaying)}
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
          source={{ uri: effectiveUri! }}
          style={{ width: 220, height: 160, borderRadius: 0 }}
          resizeMode={ResizeMode.CONTAIN}
          useNativeControls
          onPlaybackStatusUpdate={handlePlaybackStatus}
          onLoadStart={handleLoadStart}
          onError={handleError}
          shouldPlay={isPlaying}
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
        {!isPlaying && !loading && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 220,
              height: 160,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.25)',
            }}
            pointerEvents="none"
          >
            <View
              style={{
                width: 46,
                height: 46,
                borderRadius: 23,
                backgroundColor: 'rgba(0,0,0,0.6)',
                alignItems: 'center',
                justifyContent: 'center',
                paddingLeft: 3,
              }}
            >
              <I.Play size={20} color="#fff" />
            </View>
          </View>
        )}
      </View>
      {renderCaption()}
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
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: stampColor }}>
          {stamp}
        </Text>
      </View>
    </Pressable>
  );
}
