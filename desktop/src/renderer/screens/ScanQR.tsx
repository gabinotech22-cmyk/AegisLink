import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { parseIdentityQR } from '../crypto/qr';
import { FEDERATION } from '../config';
import { isOfficialRelay } from '../net/officialRelay';
import type { StoredContact } from '../db/local';

interface Props {
  onCancel: () => void;
  onAdded: (contact: StoredContact) => void;
}

export function ScanQRScreen({ onCancel, onAdded }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const [manualInput, setManualInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const addFromQR = useContacts((s) => s.addFromQR);
  const confirmKeyChange = useContacts((s) => s.confirmKeyChange);
  const identity = useIdentity((s) => s.identity);

  async function handleFileQR(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(i18n.t('scanQR.qrScanningFromFile'));
    e.target.value = '';
  }

  async function handleManualSubmit() {
    const raw = manualInput.trim();
    if (!raw) { setError(i18n.t('scanQR.enterAnAegisId')); return; }
    setBusy(true);
    setError('');
    try {
      const parsed = parseIdentityQR(raw);
      if (!parsed) {
        setError(i18n.t('scanQR.notAValidAegislink'));
        setBusy(false);
        return;
      }
      // v2 link naming another relay — unreachable until federation ships (F7).
      if (!FEDERATION && !isOfficialRelay(parsed.relay)) {
        setError(i18n.t('addContact.relayUnsupportedDesc'));
        setBusy(false);
        return;
      }
      const outcome = await addFromQR(parsed.aegisId, parsed.publicKeyB64, undefined, parsed.relay, parsed.mailboxRootB64);
      if (outcome.kind === 'mitm_detected') {
        const accept = window.confirm(
          i18n.t('scanQR.keyChangedForThis', { v0: outcome.oldKey.slice(-8), v1: outcome.newKey.slice(-8) })
        );
        if (accept) {
          const updated = await confirmKeyChange(outcome.contact.aegisId, outcome.newKey);
          if (updated) onAdded(updated);
        }
        return;
      }
      if (identity) {
        try {
          const { sendProfileTo } = await import('../socket/client');
          void sendProfileTo(outcome.contact, identity);
        } catch { /* best effort */ }
      }
      onAdded(outcome.contact);
    } catch (e) {
      setError(i18n.t('scanQR.couldNotAddContact', { v0: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    width: '100%', padding: '12px', fontFamily: t.fontMono, fontSize: 13,
    color: t.text, backgroundColor: t.bg, border: `1px solid ${t.borderStrong}`,
    borderRadius: t.radiusS, boxSizing: 'border-box' as const, marginBottom: 12,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('scanQR.scanQrAddContact')} left={
        <button onClick={onCancel} aria-label={i18n.t('common.cancel')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.X size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 32px', boxSizing: 'border-box' }}>
        {/* Desktop note */}
        <div style={{ padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <I.Monitor size={16} color={t.accent} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>{i18n.t('scanQR.cameraQrScanningIs')}</span>
        </div>

        {/* File upload stub */}
        <div style={{ marginBottom: 20 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>{i18n.t('scanQR.qrFromImageFile')}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, cursor: 'pointer' }}>
            <I.Attach size={20} color={t.textDim} />
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{i18n.t('scanQR.uploadQrImage')}</span>
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileQR} />
          </label>
        </div>

        {/* Manual input */}
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>{i18n.t('scanQR.pasteAegisIdOr')}</span>
        <textarea
          value={manualInput}
          onChange={(e) => { setManualInput(e.target.value); setError(''); }}
          placeholder={i18n.t('scanQR.abc12345678Or')}
          rows={4}
          style={{ ...inputStyle, resize: 'vertical' }}
        />

        {error && (
          <div style={{ padding: 12, backgroundColor: `${t.danger}22`, border: `1px solid ${t.danger}66`, borderRadius: t.radiusS, marginBottom: 12 }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.danger }}>{error}</span>
          </div>
        )}

        <button
          onClick={() => void handleManualSubmit()}
          disabled={busy || !manualInput.trim()}
          aria-label={i18n.t('contacts.addContact')}
          style={{
            width: '100%', padding: '13px 0', backgroundColor: t.accent, border: 'none',
            borderRadius: t.radius, cursor: busy || !manualInput.trim() ? 'not-allowed' : 'pointer',
            fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk,
            opacity: busy || !manualInput.trim() ? 0.6 : 1,
          }}
        >
          {busy ? i18n.t('scanQR.adding') : i18n.t('contacts.addContact')}
        </button>
      </div>
    </div>
  );
}
