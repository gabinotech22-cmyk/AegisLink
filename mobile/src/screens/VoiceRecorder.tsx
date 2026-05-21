import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { Audio } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

interface Props {
  onBack: () => void;
  onSend: (uri: string, durationMs: number) => void;
}

type Stage = 'idle' | 'recording' | 'recorded' | 'playing';

export function VoiceRecorderScreen({ onBack, onSend }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<Stage>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [uri, setUri] = useState<string | null>(null);
  // Real-time waveform bars — 30 normalized amplitude values from metering
  const [waveformBars, setWaveformBars] = useState<number[]>(Array(30).fill(0.15));

  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const meteringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      clearTimers();
      void recordingRef.current?.stopAndUnloadAsync().catch(() => {});
      void soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  function clearTimers() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (meteringIntervalRef.current) {
      clearInterval(meteringIntervalRef.current);
      meteringIntervalRef.current = null;
    }
  }

  async function startRecording() {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert(i18nT('voiceRecorder.permissionTitle'), i18nT('voiceRecorder.permissionMessage'));
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const rec = new Audio.Recording();
      // Enable metering so getStatusAsync() returns dB amplitude values
      const recordingOptions: Audio.RecordingOptions = {
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      };
      await rec.prepareToRecordAsync(recordingOptions);
      await rec.startAsync();
      recordingRef.current = rec;
      setElapsedMs(0);
      setWaveformBars(Array(30).fill(0.15));
      setStage('recording');
      intervalRef.current = setInterval(() => setElapsedMs((p) => p + 100), 100);
      // Poll metering every 80ms to update waveform bars with real mic amplitude
      meteringIntervalRef.current = setInterval(() => {
        void (async () => {
          try {
            const status = await rec.getStatusAsync();
            if (!status.isRecording) return;
            const metering: number = (status as Record<string, unknown>).metering as number ?? -60;
            // Normalize dB (-60 to 0) to [0, 1]; clamp to valid range
            const normalized = Math.max(0, Math.min(1, (metering + 60) / 60));
            setWaveformBars((prev) => {
              const next = [...prev.slice(1), normalized];
              return next;
            });
          } catch {
            // Ignore transient errors during metering poll
          }
        })();
      }, 80);
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
    }
  }

  async function stopRecording() {
    clearTimers();
    try {
      await recordingRef.current?.stopAndUnloadAsync();
      const status = await recordingRef.current?.getStatusAsync();
      const fileUri = recordingRef.current?.getURI() ?? null;
      recordingRef.current = null;
      if (fileUri) {
        setUri(fileUri);
        setDurationMs(status?.durationMillis ?? elapsedMs);
        setStage('recorded');
      }
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
      setStage('idle');
    }
  }

  async function playback() {
    if (!uri) return;
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        (status) => {
          if (!status.isLoaded) return;
          setPlaybackMs(status.positionMillis ?? 0);
          if (status.didJustFinish) {
            setStage('recorded');
            setPlaybackMs(0);
            clearTimers();
          }
        }
      );
      soundRef.current = sound;
      setStage('playing');
    } catch (e) {
      Alert.alert(i18nT('common.error'), (e as Error).message);
    }
  }

  async function stopPlayback() {
    clearTimers();
    await soundRef.current?.stopAsync().catch(() => {});
    await soundRef.current?.unloadAsync().catch(() => {});
    soundRef.current = null;
    setPlaybackMs(0);
    setStage('recorded');
  }

  function discard() {
    void soundRef.current?.unloadAsync().catch(() => {});
    setUri(null);
    setElapsedMs(0);
    setDurationMs(0);
    setPlaybackMs(0);
    setStage('idle');
  }

  function formatMs(ms: number) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const isRecording = stage === 'recording';
  const hasRecording = stage === 'recorded' || stage === 'playing';
  const isPlaying = stage === 'playing';
  const progress = durationMs > 0 ? (isPlaying ? playbackMs / durationMs : 1) : 0;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('attachSheet.audio')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 40 }}>
        {/* Waveform — real mic amplitude during recording, static seed during playback */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 64 }}>
          {waveformBars.map((h, i) => {
            // During playback, use a deterministic height based on bar index and duration
            const displayH = isRecording
              ? h
              : hasRecording
                ? Math.max(0.18, Math.abs(Math.sin(durationMs * 9301 + i * 49297 + 233280) * 233280) % 1)
                : 0.15;
            const barProgress = (i + 1) / waveformBars.length;
            const active = isRecording
              ? h > 0.18
              : hasRecording
                ? barProgress <= progress
                : false;
            return (
              <View
                key={i}
                style={{
                  width: 3,
                  height: Math.max(4, displayH * 56),
                  borderRadius: 2,
                  backgroundColor: active
                    ? (isPlaying ? t.accent : (isRecording ? t.danger : t.accent))
                    : t.surface3,
                }}
              />
            );
          })}
        </View>

        {/* Timer */}
        <Text style={{
          fontFamily: t.fontMono,
          fontSize: 42,
          fontWeight: '200',
          color: isRecording ? t.danger : t.text,
          letterSpacing: 2,
        }}>
          {isRecording ? formatMs(elapsedMs) :
           isPlaying ? formatMs(playbackMs) :
           hasRecording ? formatMs(durationMs) : '00:00'}
        </Text>

        {/* Controls */}
        {!hasRecording ? (
          <Pressable
            onPress={isRecording ? stopRecording : startRecording}
            style={({ pressed }) => ({
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: isRecording ? t.danger : t.accent,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.8 : 1,
            })}
          >
            {isRecording
              ? <View style={{ width: 26, height: 26, borderRadius: 4, backgroundColor: '#fff' }} />
              : <I.Mic size={34} color={t.accentInk} />
            }
          </Pressable>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 24 }}>
            {/* Discard */}
            <Pressable
              onPress={discard}
              style={({ pressed }) => ({
                width: 52,
                height: 52,
                borderRadius: 26,
                backgroundColor: t.surface2,
                borderWidth: 1,
                borderColor: t.borderStrong,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.Trash size={20} color={t.danger} />
            </Pressable>

            {/* Play / Stop */}
            <Pressable
              onPress={isPlaying ? stopPlayback : playback}
              style={({ pressed }) => ({
                width: 68,
                height: 68,
                borderRadius: 34,
                backgroundColor: t.accent,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.8 : 1,
              })}
            >
              {isPlaying
                ? <I.Pause size={26} color={t.accentInk} />
                : <I.Play size={26} color={t.accentInk} />
              }
            </Pressable>

            {/* Send */}
            <Pressable
              onPress={() => uri && onSend(uri, durationMs)}
              style={({ pressed }) => ({
                width: 52,
                height: 52,
                borderRadius: 26,
                backgroundColor: t.accent,
                borderWidth: 1,
                borderColor: t.accent,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.Send size={20} color={t.accentInk} />
            </Pressable>
          </View>
        )}

        <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, textAlign: 'center' }}>
          {stage === 'idle' ? i18nT('voiceRecorder.tap') :
           isRecording ? i18nT('voiceRecorder.recording') :
           isPlaying ? i18nT('voiceRecorder.playing') :
           i18nT('voiceRecorder.send')}
        </Text>
      </View>
    </View>
  );
}
