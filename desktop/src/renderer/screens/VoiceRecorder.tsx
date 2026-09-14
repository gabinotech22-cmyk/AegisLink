import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

interface Props {
  onBack: () => void;
  onSend: (url: string, durationMs: number) => void;
}

type Stage = 'idle' | 'recording' | 'recorded' | 'playing';

const BARS = Array.from({ length: 32 }, () => 0.15 + Math.random() * 0.85);

export function VoiceRecorderScreen({ onBack, onSend }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const [stage, setStage] = useState<Stage>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      clearInterval(intervalRef.current ?? undefined);
      mrRef.current?.stop();
      audioRef.current?.pause();
    };
  }, []);

  function clearTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach((t) => t.stop());
        const u = URL.createObjectURL(blob);
        setUrl(u);
        setDurationMs(elapsedMs);
        setStage('recorded');
        clearTimers();
      };
      mr.start(100);
      mrRef.current = mr;
      setElapsedMs(0);
      setStage('recording');
      const start = Date.now();
      intervalRef.current = setInterval(() => setElapsedMs(Date.now() - start), 100);
    } catch (e) {
      setError(i18n.t('voiceRecorder.microphoneErrorV0', { v0: (e as Error).message }));
    }
  }

  function stopRecording() {
    mrRef.current?.stop();
  }

  function playback() {
    if (!url) return;
    const audio = new Audio(url);
    audioRef.current = audio;
    setStage('playing');
    setPlaybackMs(0);
    const start = Date.now();
    intervalRef.current = setInterval(() => setPlaybackMs(Date.now() - start), 100);
    audio.onended = () => { clearTimers(); setStage('recorded'); setPlaybackMs(0); };
    audio.play().catch(() => {});
  }

  function stopPlayback() {
    clearTimers();
    audioRef.current?.pause();
    setPlaybackMs(0);
    setStage('recorded');
  }

  function discard() {
    setUrl(null); setElapsedMs(0); setDurationMs(0); setPlaybackMs(0); setStage('idle');
  }

  function fmt(ms: number) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  const isRecording = stage === 'recording';
  const hasRecording = stage === 'recorded' || stage === 'playing';
  const isPlaying = stage === 'playing';
  const progress = durationMs > 0 ? (isPlaying ? playbackMs / durationMs : 1) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('attachSheet.audio')} left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 32px', gap: 40 }}>
        {error && <span style={{ fontFamily: t.font, fontSize: 13, color: '#ef4444', textAlign: 'center' }}>{error}</span>}

        {/* Waveform */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 64 }}>
          {BARS.map((h, i) => {
            const barProgress = (i + 1) / BARS.length;
            const active = isRecording
              ? (i / BARS.length) < ((elapsedMs % 3000) / 3000)
              : hasRecording ? barProgress <= progress : false;
            return (
              <div
                key={i}
                style={{
                  width: 3,
                  height: Math.max(4, h * 56),
                  borderRadius: 2,
                  backgroundColor: active
                    ? (isPlaying ? t.accent : isRecording ? t.danger : t.accent)
                    : t.surface3 ?? t.surface2,
                }}
              />
            );
          })}
        </div>

        {/* Timer */}
        <span style={{ fontFamily: t.fontMono, fontSize: 42, fontWeight: '200', color: isRecording ? t.danger : t.text, letterSpacing: 2 }}>
          {isRecording ? fmt(elapsedMs) : isPlaying ? fmt(playbackMs) : hasRecording ? fmt(durationMs) : '00:00'}
        </span>

        {/* Controls */}
        {!hasRecording ? (
          <button
            onClick={isRecording ? stopRecording : startRecording}
            aria-label={isRecording ? i18n.t('voiceRecorder.stop') : i18n.t('viewOnce.startRecording')}
            style={{
              width: 80, height: 80, borderRadius: 40,
              backgroundColor: isRecording ? t.danger : t.accent,
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {isRecording
              ? <div style={{ width: 26, height: 26, borderRadius: 4, backgroundColor: '#fff' }} />
              : <I.Mic size={34} color={t.accentInk} />
            }
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <button
              onClick={discard}
              aria-label={i18n.t('voiceRecorder.discardRecording')}
              style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.surface2, border: `1px solid ${t.borderStrong}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <I.Trash size={20} color={t.danger} />
            </button>
            <button
              onClick={isPlaying ? stopPlayback : playback}
              aria-label={isPlaying ? i18n.t('voiceRecorder.stopPlayback') : i18n.t('voiceRecorder.playRecording')}
              style={{ width: 68, height: 68, borderRadius: 34, backgroundColor: t.accent, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {isPlaying
                ? <I.Pause size={26} color={t.accentInk} />
                : <I.Play size={26} color={t.accentInk} />
              }
            </button>
            <button
              onClick={() => url && onSend(url, durationMs)}
              aria-label={i18n.t('voiceRecorder.sendVoiceNote')}
              style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.accent, border: `1px solid ${t.accent}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <I.Send size={20} color={t.accentInk} />
            </button>
          </div>
        )}

        <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, textAlign: 'center' }}>
          {stage === 'idle' ? 'Tap to record' : isRecording ? 'Recording…' : isPlaying ? i18n.t('voiceRecorder.playing') : i18n.t('voiceRecorder.reviewAndSend')}
        </span>
      </div>
    </div>
  );
}
