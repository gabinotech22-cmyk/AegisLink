import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { parseIdentityQR } from '../crypto/qr';
import type { StoredContact } from '../db/local';

interface Props {
  onCancel: () => void;
  onAdded: (contact: StoredContact) => void;
}

export function ScanQRScreen({ onCancel, onAdded }: Props) {
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
    setError('QR scanning from file is not supported in this build. Please use the text field below to paste the Aegis ID or JSON payload.');
    e.target.value = '';
  }

  async function handleManualSubmit() {
    const raw = manualInput.trim();
    if (!raw) { setError('Enter an Aegis ID or JSON payload.'); return; }
    setBusy(true);
    setError('');
    try {
      const parsed = parseIdentityQR(raw);
      if (!parsed) {
        setError('Not a valid AegisLink ID. Try the full JSON from a QR code.');
        setBusy(false);
        return;
      }
      const outcome = await addFromQR(parsed.aegisId, parsed.publicKeyB64);
      if (outcome.kind === 'mitm_detected') {
        const accept = window.confirm(
          `Key changed for this contact.\n\nOld key: …${outcome.oldKey.slice(-8)}\nNew key: …${outcome.newKey.slice(-8)}\n\nAccept new key?`
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
      setError(`Could not add contact: ${(e as Error).message}`);
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
      <TopBar t={t} title="Scan QR / Add contact" left={
        <button onClick={onCancel} aria-label="Cancel" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.X size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 32px', boxSizing: 'border-box' }}>
        {/* Desktop note */}
        <div style={{ padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <I.Monitor size={16} color={t.accent} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>
            Camera QR scanning is not available on desktop. Use the mobile app to scan in-person, or paste the Aegis ID / JSON payload below.
          </span>
        </div>

        {/* File upload stub */}
        <div style={{ marginBottom: 20 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
            QR FROM IMAGE FILE (stub)
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, cursor: 'pointer' }}>
            <I.Attach size={20} color={t.textDim} />
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>Upload QR image</span>
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileQR} />
          </label>
        </div>

        {/* Manual input */}
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
          PASTE AEGIS ID OR JSON
        </span>
        <textarea
          value={manualInput}
          onChange={(e) => { setManualInput(e.target.value); setError(''); }}
          placeholder={'ABC-1234-5678 or { "aegisId": "...", "publicKeyB64": "..." }'}
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
          aria-label="Add contact"
          style={{
            width: '100%', padding: '13px 0', backgroundColor: t.accent, border: 'none',
            borderRadius: t.radius, cursor: busy || !manualInput.trim() ? 'not-allowed' : 'pointer',
            fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk,
            opacity: busy || !manualInput.trim() ? 0.6 : 1,
          }}
        >
          {busy ? 'Adding…' : 'Add contact'}
        </button>
      </div>
    </div>
  );
}
