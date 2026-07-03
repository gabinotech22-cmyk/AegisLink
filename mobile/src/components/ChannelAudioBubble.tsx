import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { I } from './icons';
import type { Theme } from '../theme/vault';
import { resolveMedia } from '../crypto/media';

interface Props {
  t: Theme;
  /** E2EE `blob:` reference sealed inside the post body. */
  uri: string;
  /** Duration hint from the sealed media ref (ms), for the idle label. */
  durationMs?: number;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Compact voice-note player for a channel feed post. Decrypts the E2EE blob on
 * demand (resolveMedia) the first time it plays, then drives an expo-av sound.
 * Self-contained — it does not depend on the chat message shape.
 */
export function ChannelAudioBubble({ t, uri, durationMs }: Props) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [posMs, setPosMs] = useState(0);
  type AudioSound = import('expo-av').Audio.Sound;
  type AVPlaybackStatus = import('expo-av').AVPlaybackStatus;
  const soundRef = useRef<AudioSound | null>(null);

  useEffect(() => {
    return () => { void soundRef.current?.unloadAsync().catch(() => {}); };
  }, []);

  const durSec = durationMs ? Math.round(durationMs / 1000) : 0;

  async function toggle() {
    if (playing) {
      await soundRef.current?.stopAsync().catch(() => {});
      await soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
      setPosMs(0);
      setPlaying(false);
      return;
    }
    setLoading(true);
    try {
      const local = uri.startsWith('blob:') ? await resolveMedia(uri, 'm4a') : uri;
      if (!local) { setLoading(false); return; }
      const { Audio } = require('expo-av') as typeof import('expo-av');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: local },
        { shouldPlay: true },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded) return;
          setPosMs(status.positionMillis ?? 0);
          if (status.didJustFinish) {
            setPlaying(false);
            setPosMs(0);
            soundRef.current = null;
          }
        },
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch { setPlaying(false); }
    finally { setLoading(false); }
  }

  const label = playing ? fmt(posMs / 1000) : fmt(durSec);

  return (
    <View
      accessibilityLabel="Voice note"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 10, width: 220,
        backgroundColor: t.surface2, borderRadius: t.radius, paddingHorizontal: 10, paddingVertical: 8,
      }}
    >
      <Pressable
        onPress={() => void toggle()}
        accessibilityLabel={playing ? 'Pause' : 'Play'}
        style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: t.surface3, alignItems: 'center', justifyContent: 'center' }}
      >
        {loading
          ? <ActivityIndicator size="small" color={t.accent} />
          : playing
            ? <I.Pause size={15} color={t.text} />
            : <I.Play size={15} color={t.text} />}
      </Pressable>
      <I.Mic size={15} color={t.textDim} />
      <View style={{ flex: 1 }} />
      <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim }}>{label}</Text>
    </View>
  );
}
