import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

interface Props {
  onBack: () => void;
}

export function AppIconScreen({ onBack }: Props) {
  const { t } = useTheme();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title="App icon"
        left={
          <button
            onClick={onBack}
            aria-label="Go back"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
          >
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
      />

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px 28px',
          boxSizing: 'border-box',
          gap: 20,
        }}
      >
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: t.radiusL,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I.Monitor size={36} color={t.textDim} />
        </div>

        <span
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 20,
            fontWeight: '600',
            color: t.text,
            textAlign: 'center',
          }}
        >
          App icon customization
        </span>

        <div
          style={{
            padding: 16,
            borderRadius: t.radius,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            maxWidth: 360,
            width: '100%',
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.warn,
              letterSpacing: 1.1,
              display: 'block',
              marginBottom: 8,
            }}
          >
            MOBILE ONLY
          </span>
          <span
            style={{
              fontFamily: t.font,
              fontSize: 13,
              color: t.textDim,
              lineHeight: '20px',
              display: 'block',
            }}
          >
            App icon customization is only available on mobile. Open AegisLink on your iOS or Android device to change the app icon.
          </span>
        </div>
      </div>
    </div>
  );
}
