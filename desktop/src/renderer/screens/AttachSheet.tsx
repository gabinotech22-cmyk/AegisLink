import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useMessages } from '../store/messages';

type AttachKind = 'scheduled' | 'location' | 'viewoncesend' | 'photo' | 'camera' | 'file' | 'voice' | 'contact';

interface Props {
  onBack: () => void;
  onPick: (kind: AttachKind) => void;
}

export function AttachSheetScreen({ onBack, onPick }: Props) {
  const { t } = useTheme();
  const setPendingMedia = useMessages((s) => s.setPendingMedia);
  const [picking, setPicking] = useState(false);

  async function stripExifAndSet(file: File) {
    return new Promise<void>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const max = 1280;
          let { width, height } = img;
          if (width > max || height > max) {
            const ratio = Math.min(max / width, max / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(); return; }
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => {
            if (!blob) { resolve(); return; }
            const url = URL.createObjectURL(blob);
            setPendingMedia(url);
            resolve();
          }, 'image/jpeg', 0.85);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  function handlePhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPicking(true);
    stripExifAndSet(file).then(() => { setPicking(false); onBack(); }).catch(() => setPicking(false));
    e.target.value = '';
  }

  function handleGenericFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPendingMedia(url);
    onBack();
    e.target.value = '';
  }

  if (picking) {
    return (
      <div style={{ display: 'flex', flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, backgroundColor: t.bg }}>
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8 }}>PROCESSING…</span>
      </div>
    );
  }

  const opts: { id: AttachKind; icon: React.ReactNode; label: string; sub: string; accent?: boolean }[] = [
    { id: 'photo', icon: <I.Eye size={22} color={t.textDim} />, label: 'Photo', sub: 'From files' },
    { id: 'camera', icon: <I.Video size={22} color={t.textDim} />, label: 'File', sub: 'Any type' },
    { id: 'voice', icon: <I.Mic size={22} color={t.accent} />, label: 'Voice note', sub: 'Ephemeral', accent: true },
    { id: 'viewoncesend', icon: <I.EyeOff size={22} color={t.accent} />, label: 'View once', sub: 'Non-savable', accent: true },
    { id: 'scheduled', icon: <I.Timer size={22} color={t.textDim} />, label: 'Scheduled', sub: 'Delayed send' },
    { id: 'location', icon: <I.Globe size={22} color={t.textDim} />, label: 'Location', sub: 'Temporary' },
    { id: 'contact', icon: <I.Users size={22} color={t.textDim} />, label: 'Contact', sub: 'Share ID' },
  ];

  const cardStyle = (accent?: boolean): CSSProperties => ({
    padding: 14, backgroundColor: t.surface, border: `1px solid ${accent ? `${t.accent}44` : t.border}`,
    borderRadius: t.radius, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10,
    width: 'calc(50% - 5px)', boxSizing: 'border-box', background: 'none',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Attach" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 18px 22px', boxSizing: 'border-box' }}>
        <div style={{ padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, marginBottom: 18 }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>
            Everything is encrypted before leaving the device. File EXIF and metadata are automatically removed.
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {/* Photo — file input */}
          <label style={{ ...cardStyle(false), cursor: 'pointer' }}>
            <I.Eye size={22} color={t.textDim} />
            <div>
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>Photo</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, display: 'block', marginTop: 3 }}>FROM FILES</span>
            </div>
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoFile} />
          </label>

          {/* Generic file */}
          <label style={{ ...cardStyle(false), cursor: 'pointer' }}>
            <I.Attach size={22} color={t.textDim} />
            <div>
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>File</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, display: 'block', marginTop: 3 }}>ANY TYPE</span>
            </div>
            <input type="file" style={{ display: 'none' }} onChange={handleGenericFile} />
          </label>

          {opts.filter((o) => o.id !== 'photo' && o.id !== 'camera').map((o) => (
            <button
              key={o.id}
              onClick={() => onPick(o.id)}
              aria-label={o.label}
              style={cardStyle(o.accent)}
            >
              {o.icon}
              <div>
                <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>{o.label}</span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, display: 'block', marginTop: 3 }}>
                  {o.sub.toUpperCase()}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
