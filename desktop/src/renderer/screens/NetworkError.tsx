import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { SERVER_URL } from '../config';

interface Props {
  onRetry: () => void;
}

type RelayState = 'up' | 'down' | 'probing';
interface RelayStatus { label: string; state: RelayState; detail: string }

const RELAY_LABELS = ['zurich-1', 'berlin-1', 'ny-1', 'sg-1'];

export function NetworkErrorScreen({ onRetry }: Props) {
  const { t } = useTheme();

  const [relays, setRelays] = useState<RelayStatus[]>(
    RELAY_LABELS.map((label, i) => ({
      label,
      state: (i === 2 ? 'probing' : 'down') as RelayState,
      detail: i === 2 ? 're-handshake…' : `timeout · ${10 + i * 2}s`,
    }))
  );

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    fetch(`${SERVER_URL}/health`, { signal: ctrl.signal })
      .then(() => {
        if (!cancelled) {
          setRelays(RELAY_LABELS.map((label) => ({ label, state: 'up' as RelayState, detail: 'ok' })));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRelays(RELAY_LABELS.map((label, i) => ({
            label,
            state: (i === 2 ? 'probing' : 'down') as RelayState,
            detail: i === 2 ? 're-handshake…' : `timeout · ${10 + i * 2}s`,
          })));
        }
      })
      .finally(() => clearTimeout(timer));
    return () => { cancelled = true; };
  }, []);

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        backgroundColor: t.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 28px 32px',
        boxSizing: 'border-box',
      }}
    >
      {/* Status pill */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginBottom: 'auto',
          alignSelf: 'flex-start',
        }}
      >
        <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.warn }} />
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.warn, letterSpacing: 1.1 }}>
          RELAY UNREACHABLE
        </span>
      </div>

      {/* Hexagon SVG graphic */}
      <div style={{ width: 140, height: 140, marginBottom: 30, marginTop: 16, flexShrink: 0 }}>
        <svg viewBox="0 0 140 140" width={140} height={140}>
          <circle cx={70} cy={70} r={60} fill="none" stroke={t.borderStrong} strokeWidth={1.5} strokeDasharray="4 6" opacity={0.5} />
          <path d="M70 18 L114 42 L114 92 L70 116 L26 92 L26 42 Z" fill="none" stroke={t.warn} strokeWidth={2.5} strokeLinejoin="round" />
          <line x1={36} y1={36} x2={104} y2={104} stroke={t.danger} strokeWidth={3} strokeLinecap="round" />
        </svg>
      </div>

      <span
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 26,
          fontWeight: '600',
          letterSpacing: -0.5,
          color: t.text,
          textAlign: 'center',
          marginBottom: 12,
          display: 'block',
        }}
      >
        Connection lost
      </span>
      <span
        style={{
          fontFamily: t.font,
          fontSize: 14,
          color: t.textDim,
          lineHeight: '21px',
          textAlign: 'center',
          maxWidth: 320,
          marginBottom: 20,
          display: 'block',
        }}
      >
        AegisLink could not reach the relay. Your messages are queued and will be delivered automatically when the connection is restored.
      </span>

      {/* Relay status list */}
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          padding: 14,
          backgroundColor: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          marginBottom: 22,
          boxSizing: 'border-box',
        }}
      >
        {relays.map((r, i) => (
          <RelayRow key={r.label} t={t} {...r} last={i === relays.length - 1} />
        ))}
      </div>

      <button
        onClick={onRetry}
        aria-label="Retry connection"
        style={{
          width: '100%',
          maxWidth: 380,
          padding: '14px 0',
          backgroundColor: t.accent,
          border: 'none',
          borderRadius: t.radius,
          cursor: 'pointer',
          fontFamily: t.font,
          fontWeight: '700',
          fontSize: 14,
          color: t.accentInk,
          marginBottom: 4,
        }}
      >
        Retry connection
      </button>

      <button
        onClick={() =>
          window.alert(
            'Emergency relay\n\nAn emergency relay can be activated by the AegisLink team during outages. Check the official status page or Nostr feed for updates.'
          )
        }
        aria-label="Emergency relay info"
        style={{
          padding: '12px 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5 }}>
          USE EMERGENCY RELAY
        </span>
      </button>
    </div>
  );
}

function RelayRow({
  t,
  label,
  state,
  detail,
  last,
}: {
  t: Theme;
  label: string;
  state: RelayState;
  detail: string;
  last: boolean;
}) {
  const c = state === 'down' ? t.danger : state === 'up' ? t.accent : t.warn;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingBottom: 8,
        borderBottom: last ? 'none' : `1px solid ${t.divider}`,
      }}
    >
      <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: c, flexShrink: 0 }} />
      <span style={{ flex: 1, fontFamily: t.fontMono, fontSize: 12, color: t.text }}>{label}</span>
      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: c, letterSpacing: 0.5 }}>
        {state.toUpperCase()} · {detail}
      </span>
    </div>
  );
}
