import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { PrimaryButton } from '../components/Button';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

interface StoredContact {
  aegisId: string;
  name: string;
  publicKeyB64: string;
  verified: boolean;
  addedAt: number;
}

interface Props {
  onCancel: () => void;
  onAdded: (contact: StoredContact) => void;
}

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function AddContactScreen({ onCancel, onAdded }: Props) {
  const { t } = useTheme();
  const [aegisId, setAegisId] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const trimmedId = aegisId.trim().toUpperCase();
  const idValid = AEGIS_ID_RE.test(trimmedId);

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setAegisId(text.trim());
    } catch {
      setErrorMsg('Clipboard access denied. Paste manually.');
    }
  }

  async function handleAdd() {
    if (!idValid) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      // Stub — in real impl: addByAegisId(trimmedId, name)
      const stubContact: StoredContact = {
        aegisId: trimmedId,
        name: name.trim() || trimmedId,
        publicKeyB64: btoa(trimmedId),
        verified: false,
        addedAt: Date.now(),
      };
      onAdded(stubContact);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10 }}>
        <button onClick={onCancel} aria-label="Cancel" style={iconBtn}>
          <I.ChevronL size={24} color={t.text} />
        </button>
        <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>Add Contact</span>
        <div style={{ width: 24 }} />
      </div>

      <div style={{ paddingLeft: 22, paddingRight: 22, paddingTop: 18 }}>
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, display: 'block' }}>
          AEGISLINK ID
        </span>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface, border: `1px solid ${idValid || aegisId.length === 0 ? t.border : t.danger}`, borderRadius: t.radius, paddingLeft: 14, paddingRight: 4 }}>
          <input
            value={aegisId}
            onChange={(e) => setAegisId(e.target.value.toUpperCase())}
            placeholder="XXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, fontFamily: t.fontMono, fontSize: 18, color: t.text, paddingTop: 14, paddingBottom: 14, letterSpacing: 1, background: 'none', border: 'none', outline: 'none' }}
          />
          <button onClick={() => void handlePaste()} aria-label="Paste from clipboard" style={iconBtn}>
            <I.Copy size={18} color={t.textDim} />
          </button>
        </div>
        {aegisId.length > 0 && !idValid && (
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger, marginTop: 6, display: 'block' }}>
            Invalid ID format. Expected: XXX-XXXX-XXXX
          </span>
        )}

        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, marginTop: 24, display: 'block' }}>
          NICKNAME (OPTIONAL)
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alice"
          style={{ backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, paddingLeft: 14, paddingRight: 14, paddingTop: 14, paddingBottom: 14, fontFamily: t.font, fontSize: 15, color: t.text, outline: 'none', width: '100%', boxSizing: 'border-box' }}
        />

        <p style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 22, lineHeight: '19px', marginBottom: 0 }}>
          Your contact's AegisLink ID is their permanent address. Ask them to share it from their profile or scan their QR code.
        </p>

        {/* Scan QR stub */}
        <div style={{ marginTop: 16, padding: 14, backgroundColor: t.surface2, borderRadius: t.radius, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <I.QR size={20} color={t.textDim} />
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.text, fontWeight: '600', display: 'block' }}>Scan QR Code</span>
            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginTop: 2 }}>Upload a screenshot of a QR code</span>
          </div>
          <label style={{ cursor: 'pointer' }}>
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={() => {/* QR decode stub */}} />
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5 }}>UPLOAD</span>
          </label>
        </div>

        <div style={{ marginTop: 28 }}>
          <PrimaryButton
            t={t}
            label={submitting ? 'Adding…' : 'Add Contact'}
            disabled={!idValid || submitting}
            onPress={() => void handleAdd()}
          />
        </div>

        {errorMsg && (
          <div style={{ marginTop: 14, padding: 12, backgroundColor: `${t.danger}22`, borderRadius: t.radiusS }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger }}>{errorMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const iconBtn: CSSProperties = {
  padding: 6, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
