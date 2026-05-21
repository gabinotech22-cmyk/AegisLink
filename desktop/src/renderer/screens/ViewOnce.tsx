import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

interface Props {
  mediaUri?: string;
  contactName?: string;
  onBack: () => void;
}

export function ViewOnceScreen({ mediaUri, contactName, onBack }: Props) {
  const { t } = useTheme();
  const [opened, setOpened] = useState(false);
  const [progress, setProgress] = useState(1); // 1 = full, 0 = empty (counts down)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!opened) return;
    setProgress(1);
    const start = Date.now();
    const duration = 5000;
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 1 - elapsed / duration);
      setProgress(remaining);
      if (remaining <= 0) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        onBack();
      }
    }, 50);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [opened, onBack]);

  if (opened) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: '#000', position: 'relative' }}>
        {/* Header overlay */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 22px 16px' }}>
          <button
            onClick={onBack}
            aria-label="Close"
            style={{ backgroundColor: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.15)', padding: '6px 12px', borderRadius: 99, cursor: 'pointer' }}
          >
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: '#fff', letterSpacing: 0.5 }}>CLOSE</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', backgroundColor: 'rgba(230,57,70,0.25)', border: '1px solid rgba(230,57,70,0.5)', borderRadius: 99 }}>
            <I.Timer size={11} color="#ff8b95" />
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: '#ff8b95', letterSpacing: 0.5 }}>
              DELETES IN {Math.ceil(progress * 5)}s
            </span>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {mediaUri ? (
            <img src={mediaUri} alt="View once" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          ) : (
            <div style={{ textAlign: 'center' }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: 'rgba(255,255,255,0.4)', letterSpacing: 1.1 }}>
                [ VIEW ONCE ]
              </span>
              <br />
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.25)', letterSpacing: 0.5 }}>
                No capture · No saving
              </span>
            </div>
          )}
        </div>

        {/* Progress bar footer */}
        <div style={{ padding: '0 22px 36px' }}>
          <div style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress * 100}%`, backgroundColor: '#e63946', borderRadius: 99, transition: 'width 0.05s linear' }} />
          </div>
          <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: 0.8, marginTop: 8, textAlign: 'center', display: 'block' }}>
            Cannot forward · Not saved · Deletes automatically
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="View once" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />
      <div style={{ flex: 1, padding: '14px 22px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ alignSelf: 'center', maxWidth: 320, padding: 28, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', boxSizing: 'border-box' }}>
          <div style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: t.surface2, border: `1px solid ${t.borderStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
            <I.EyeOff size={36} color={t.accent} />
          </div>
          <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text, marginBottom: 8, textAlign: 'center', display: 'block' }}>
            {contactName ? `${contactName} sent a view-once` : 'View-once media'}
          </span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', textAlign: 'center', display: 'block' }}>
            This media can only be viewed once. It will be deleted 5 seconds after opening and cannot be saved or forwarded.
          </span>
        </div>
      </div>
      <div style={{ padding: '0 22px 24px' }}>
        <button
          onClick={() => setOpened(true)}
          aria-label="View now"
          style={{ width: '100%', padding: '13px 0', backgroundColor: t.accent, border: 'none', borderRadius: t.radius, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk }}
        >
          View now
        </button>
      </div>
    </div>
  );
}
