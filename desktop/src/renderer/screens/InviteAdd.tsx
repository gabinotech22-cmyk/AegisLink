import type { ReactNode } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

interface Props {
  onBack: () => void;
  onShowMyQR: () => void;
  onPasteId: () => void;
  onScanQR: () => void;
}

export function InviteAddScreen({ onBack, onShowMyQR, onPasteId, onScanQR }: Props) {
  const { t } = useTheme();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title="Add contact"
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

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 22px', boxSizing: 'border-box' }}>
        <span
          style={{
            fontFamily: t.font,
            fontSize: 13,
            color: t.textDim,
            lineHeight: '19px',
            textAlign: 'center',
            display: 'block',
            margin: '18px 0',
          }}
        >
          AegisLink never reads your address book. Choose how to exchange identities.
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Method
            t={t}
            icon={<I.QR size={26} color={t.accent} />}
            label="Scan peer's QR"
            sub="Most secure. In-person verification in a single step."
            cta="Scan QR"
            badge="RECOMMENDED"
            primary
            onPress={onScanQR}
          />
          <Method
            t={t}
            icon={<I.Eye size={24} color={t.text} />}
            label="Show my QR"
            sub="For the peer to scan you — same security level."
            cta="Show"
            onPress={onShowMyQR}
          />
          <Method
            t={t}
            icon={<I.Key size={24} color={t.text} />}
            label="Paste Aegis ID"
            sub="Paste the contact's 11-character ID. Verify the fingerprint later."
            cta="Enter ID"
            onPress={onPasteId}
          />
        </div>

        <div
          style={{
            marginTop: 28,
            padding: 14,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radius,
            display: 'flex',
            flexDirection: 'row',
            gap: 12,
          }}
        >
          <I.Shield size={18} color={t.warn} style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.text, display: 'block' }}>
              Verify before talking.
            </span>
            <span
              style={{
                fontFamily: t.font,
                fontSize: 12,
                color: t.textDim,
                lineHeight: '17px',
                marginTop: 4,
                display: 'block',
              }}
            >
              Any method works to start — but compare the 8 safety words before sending anything sensitive.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Method({
  t,
  icon,
  label,
  sub,
  cta,
  badge,
  primary,
  onPress,
}: {
  t: Theme;
  icon: ReactNode;
  label: string;
  sub: string;
  cta: string;
  badge?: string;
  primary?: boolean;
  onPress?: () => void;
}) {
  return (
    <button
      onClick={onPress}
      aria-label={label}
      style={{
        padding: 16,
        backgroundColor: t.surface,
        border: `1px solid ${primary ? t.accent + '66' : t.border}`,
        borderRadius: t.radius,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        cursor: 'pointer',
        width: '100%',
        boxSizing: 'border-box',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: t.radius,
          backgroundColor: primary ? t.accent + '22' : t.surface2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>{label}</span>
          {badge ? (
            <span
              style={{
                fontFamily: t.fontMono,
                fontSize: 8,
                color: t.accent,
                letterSpacing: 0.5,
                border: `1px solid ${t.accent}`,
                borderRadius: 99,
                padding: '1px 5px',
              }}
            >
              {badge}
            </span>
          ) : null}
        </div>
        <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '17px', display: 'block' }}>
          {sub}
        </span>
      </div>
      <span
        style={{
          fontFamily: t.fontMono,
          fontSize: 10,
          color: primary ? t.accent : t.textDim,
          letterSpacing: 0.5,
          fontWeight: '600',
          flexShrink: 0,
        }}
      >
        {cta.toUpperCase()} →
      </span>
    </button>
  );
}
