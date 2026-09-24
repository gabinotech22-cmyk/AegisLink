/**
 * TorConnection — Privacy → Network → "Tor connection" (bridges).
 *
 * Tor is always on and there is no clearnet fallback. This screen only
 * chooses HOW tor reaches the Tor network: automatic (direct, then built-in
 * bridges when the network blocks Tor), a fixed transport, or the user's own
 * bridge lines. Main validates everything (main/tor/bridges.ts); this screen only
 * proposes. Desktop twin of mobile/src/screens/TorConnection.tsx.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { useTor } from '../net/tor';

interface Props {
  onBack: () => void;
}

const MODES = ['auto', 'direct', 'snowflake', 'obfs4', 'meek', 'custom'] as const;
type Mode = (typeof MODES)[number];

interface Connection { mode: Mode; custom: string[]; transport: string }
type SaveResult = { ok: true; accepted: number; rejected: number } | { ok: false; error: string };

function isConnection(v: unknown): v is Connection {
  return !!v && typeof v === 'object' && typeof (v as Connection).mode === 'string' && Array.isArray((v as Connection).custom);
}

export function TorConnectionScreen({ onBack }: Props) {
  useTranslation();
  const { t } = useTheme();
  const status = useTor((s) => s.status);
  const [mode, setMode] = useState<Mode>('auto');
  const [customText, setCustomText] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    void window.aegis.tor.getConnection().then((c) => {
      if (!isConnection(c)) return;
      setMode((MODES as readonly string[]).includes(c.mode) ? c.mode : 'auto');
      setCustomText(c.custom.join('\n'));
    });
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setResult(null);
    try {
      const r = (await window.aegis.tor.setConnection(mode, mode === 'custom' ? customText : null)) as SaveResult;
      setResult(r);
    } finally {
      setSaving(false);
    }
  };

  const sectionLabel: CSSProperties = { display: 'block', fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 1, margin: '18px 0 8px' };
  const transportName = (x: string | undefined): string => i18n.t(`torConnection.transport.${x ?? 'direct'}`);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('torConnection.title')} big left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 32px' }}>
        <p style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', margin: '0 0 6px' }}>{i18n.t('torConnection.intro')}</p>

        <span style={sectionLabel}>{i18n.t('torConnection.nowSection')}</span>
        <div data-testid="tor-connection-status" style={{ padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <I.Shield size={20} color={status.state === 'on' ? t.accent : t.textDim} />
            <span style={{ fontFamily: t.font, fontSize: 15, color: t.text, fontWeight: 600 }}>{transportName(status.transport)}</span>
          </div>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 6 }}>
            {status.state === 'on'
              ? i18n.t('torConnection.connected')
              : status.state === 'error'
                ? i18n.t('tor.failed', { v0: status.summary || i18n.t('tor.unknownError') })
                : i18n.t('tor.connecting', { v0: status.progress })}
          </div>
        </div>

        <span style={sectionLabel}>{i18n.t('torConnection.modeSection')}</span>
        <div role="radiogroup" aria-label={i18n.t('torConnection.modeSection')}>
          {MODES.map((m) => (
            <label key={m} data-testid={`tor-mode-${m}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 4px', cursor: 'pointer', borderBottom: `1px solid ${t.divider}` }}>
              <input type="radio" name="tor-mode" checked={mode === m} onChange={() => { setMode(m); setResult(null); }} style={{ marginTop: 3 }} />
              <span>
                <span style={{ display: 'block', fontFamily: t.font, fontSize: 14, color: t.text }}>{i18n.t(`torConnection.mode.${m}`)}</span>
                <span style={{ display: 'block', fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, lineHeight: '17px' }}>{i18n.t(`torConnection.modeSub.${m}`)}</span>
              </span>
            </label>
          ))}
        </div>

        {mode === 'custom' && (
          <>
            <span style={sectionLabel}>{i18n.t('torConnection.customSection')}</span>
            <p style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '17px', margin: '0 0 8px' }}>{i18n.t('torConnection.customHelp')}</p>
            <textarea
              data-testid="tor-custom-bridges"
              value={customText}
              onChange={(e) => { setCustomText(e.target.value); setResult(null); }}
              placeholder="obfs4 192.0.2.1:443 FINGERPRINT cert=… iat-mode=0"
              aria-label={i18n.t('torConnection.customSection')}
              spellCheck={false}
              rows={6}
              style={{ width: '100%', boxSizing: 'border-box', fontFamily: t.fontMono, fontSize: 12, color: t.text, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 12, outline: 'none', resize: 'vertical' }}
            />
          </>
        )}

        <div style={{ height: 16 }} />
        <PrimaryButton t={t} label={saving ? i18n.t('torConnection.applying') : i18n.t('torConnection.apply')} onPress={() => void save()} disabled={saving} />

        {result && result.ok && (
          <p data-testid="tor-connection-applied" style={{ fontFamily: t.font, fontSize: 13, color: t.accent, marginTop: 12, lineHeight: '18px' }}>
            {i18n.t('torConnection.applied')}
            {mode === 'custom' && result.rejected > 0 ? ` ${i18n.t('torConnection.someRejected', { n: result.rejected })}` : ''}
          </p>
        )}
        {result && !result.ok && (
          <p data-testid="tor-connection-error" style={{ fontFamily: t.font, fontSize: 13, color: t.danger, marginTop: 12, lineHeight: '18px' }}>
            {result.error === 'no_valid_bridges' ? i18n.t('torConnection.noValidBridges') : i18n.t('torConnection.invalid')}
          </p>
        )}
      </div>
    </div>
  );
}
