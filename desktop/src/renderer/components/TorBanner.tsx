import { useEffect } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { useTor } from '../net/tor';
import i18n from '../i18n';
import { useTranslation } from 'react-i18next';

/**
 * Thin status strip shown while the embedded Tor is not yet bootstrapped (or has
 * failed). Tor is always-on and there is no clearnet fallback, so this is the
 * honest explanation of "why am I not connected yet". Hidden once Tor is ON.
 */
export function TorBanner() {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const status = useTor((s) => s.status);
  const init = useTor((s) => s.init);
  useEffect(() => { init(); }, [init]);

  if (status.state === 'on') return null;

  const isError = status.state === 'error';
  const label = isError
    ? i18n.t('tor.failed', { v0: status.summary || i18n.t('tor.unknownError') })
    : i18n.t('tor.connecting', { v0: status.progress }) + (status.summary ? ` · ${status.summary}` : '');

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tor-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        fontFamily: t.fontMono,
        fontSize: 11,
        letterSpacing: 0.3,
        color: isError ? t.danger : t.text,
        backgroundColor: t.surface,
        borderBottom: `1px solid ${t.border}`,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8, height: 8, borderRadius: '50%',
          backgroundColor: isError ? t.danger : t.accent,
          opacity: isError ? 1 : 0.5 + status.progress / 200,
        }}
      />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {!isError && (
        <span style={{ width: 120, height: 4, borderRadius: 2, backgroundColor: t.border, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${status.progress}%`, backgroundColor: t.accent, transition: 'width 300ms ease' }} />
        </span>
      )}
    </div>
  );
}
