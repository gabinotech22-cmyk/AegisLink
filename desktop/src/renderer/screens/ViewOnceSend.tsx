import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

interface Props {
  onBack: () => void;
  onSend: (dataUrl: string) => void;
}

type Mode = 'select' | 'preview' | 'audio';

export function ViewOnceSendScreen({ onBack, onSend }: Props) {
  const { t } = useTheme();
  const [mode, setMode] = useState<Mode>('select');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImageUrl(ev.target?.result as string);
      setMode('preview');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
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
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (e) {
      setAudioError(`Microphone error: ${(e as Error).message}`);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  function handleSendImage() {
    if (imageUrl) onSend(imageUrl);
  }

  function handleSendAudio() {
    if (audioUrl) onSend(audioUrl);
  }

  const btnStyle = (primary = false): CSSProperties => ({
    flex: 1, padding: '13px 0', fontFamily: t.font, fontWeight: '600', fontSize: 14,
    color: primary ? t.accentInk : t.text,
    backgroundColor: primary ? t.accent : 'transparent',
    border: primary ? 'none' : `1px solid ${t.borderStrong}`,
    borderRadius: t.radiusS, cursor: 'pointer',
  });

  if (mode === 'preview' && imageUrl) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: '#000' }}>
        <div style={{ position: 'absolute', top: 16, left: 0, right: 0, zIndex: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 16px' }}>
          <button onClick={() => { setMode('select'); setImageUrl(null); }} aria-label="Go back" style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 99, padding: '6px 12px', cursor: 'pointer' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: '#fff', letterSpacing: 0.5 }}>BACK</span>
          </button>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1, backgroundColor: `${t.accent}22`, border: `1px solid ${t.accent}44`, borderRadius: 99, padding: '4px 10px' }}>
            VIEW ONCE
          </span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={imageUrl} alt="Preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
        <div style={{ padding: '16px 22px 32px', display: 'flex', gap: 10 }}>
          <button onClick={() => { setMode('select'); setImageUrl(null); }} style={btnStyle()}>Discard</button>
          <button onClick={handleSendImage} style={btnStyle(true)}>Send view-once</button>
        </div>
      </div>
    );
  }

  if (mode === 'audio') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
        <TopBar t={t} title="Voice view-once" left={
          <button onClick={() => { setMode('select'); setAudioUrl(null); setRecording(false); mediaRecorderRef.current?.stop(); }} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        } />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 32, padding: '0 32px' }}>
          {audioError && (
            <span style={{ fontFamily: t.font, fontSize: 13, color: '#ef4444', textAlign: 'center' }}>{audioError}</span>
          )}
          {audioUrl && !recording && (
            <audio src={audioUrl} controls style={{ width: '100%' }} />
          )}
          {!audioUrl && (
            <button
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? 'Stop recording' : 'Start recording'}
              style={{
                width: 80, height: 80, borderRadius: 40, border: 'none', cursor: 'pointer',
                backgroundColor: recording ? t.danger : t.accent,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {recording
                ? <div style={{ width: 26, height: 26, borderRadius: 4, backgroundColor: '#fff' }} />
                : <I.Mic size={34} color={t.accentInk} />
              }
            </button>
          )}
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, textAlign: 'center' }}>
            {recording ? 'Recording… tap to stop' : audioUrl ? 'Review your voice note' : 'Tap to record'}
          </span>
        </div>
        {audioUrl && !recording && (
          <div style={{ padding: '0 22px 32px', display: 'flex', gap: 10 }}>
            <button onClick={() => setAudioUrl(null)} style={btnStyle()}>Re-record</button>
            <button onClick={handleSendAudio} style={btnStyle(true)}>Send view-once</button>
          </div>
        )}
      </div>
    );
  }

  // Select mode
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Send view-once" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />
      <div style={{ flex: 1, padding: '24px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>
            View-once media cannot be saved, forwarded or replayed. It auto-deletes 5 seconds after opening.
          </span>
        </div>

        <label style={{ display: 'block', cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, backgroundColor: t.surface, border: `1px solid ${t.accent}44`, borderRadius: t.radius, cursor: 'pointer' }}>
            <div style={{ width: 44, height: 44, borderRadius: t.radius, backgroundColor: `${t.accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <I.Eye size={22} color={t.accent} />
            </div>
            <div>
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>Photo / Image</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, display: 'block', marginTop: 3 }}>SELECT FROM FILES</span>
            </div>
          </div>
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileSelect} />
        </label>

        <button
          onClick={() => setMode('audio')}
          style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, backgroundColor: t.surface, border: `1px solid ${t.accent}44`, borderRadius: t.radius, cursor: 'pointer', textAlign: 'left', width: '100%', boxSizing: 'border-box' }}
          aria-label="Voice view-once"
        >
          <div style={{ width: 44, height: 44, borderRadius: t.radius, backgroundColor: `${t.accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I.Mic size={22} color={t.accent} />
          </div>
          <div>
            <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>Voice note</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, display: 'block', marginTop: 3 }}>RECORD AUDIO</span>
          </div>
        </button>
      </div>
    </div>
  );
}
