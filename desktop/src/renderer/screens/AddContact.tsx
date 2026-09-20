import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { PrimaryButton } from '../components/Button';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { parseIdentityQR } from '../crypto/qr';
import { FEDERATION } from '../config';
import { isOfficialRelay } from '../net/officialRelay';
import { decodeQrFromImage } from '../utils/qrImage';
import type { StoredContact } from '../db/local';

interface Props {
  onCancel: () => void;
  onAdded: (contact: StoredContact) => void;
}

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function AddContactScreen({ onCancel, onAdded }: Props) {
  useTranslation(); // re-render on language change
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
      setErrorMsg(i18n.t('addContact.clipboardAccessDeniedPaste'));
    }
  }

  // "Upload a screenshot of a QR": decode locally, then add through the QR
  // path (key from the QR = TOFU-verified; a v2 link keeps relay + mailbox
  // root), with the nickname typed above.
  async function handleQrImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const decoded = await decodeQrFromImage(file).catch(() => null);
      const parsed = decoded ? parseIdentityQR(decoded) : null;
      if (!parsed) {
        setErrorMsg(i18n.t('scanQR.noQrInImage'));
        return;
      }
      if (!FEDERATION && !isOfficialRelay(parsed.relay)) {
        setErrorMsg(i18n.t('addContact.relayUnsupportedDesc'));
        return;
      }
      const store = useContacts.getState();
      const outcome = await store.addFromQR(parsed.aegisId, parsed.publicKeyB64, name.trim() || undefined, parsed.relay, parsed.mailboxRootB64);
      if (outcome.kind === 'mitm_detected') {
        const accept = window.confirm(
          i18n.t('scanQR.keyChangedForThis', { v0: outcome.oldKey.slice(-8), v1: outcome.newKey.slice(-8) })
        );
        if (!accept) return;
        const updated = await store.confirmKeyChange(outcome.contact.aegisId, outcome.newKey);
        if (updated) onAdded(updated);
        return;
      }
      const identity = useIdentity.getState().identity;
      if (identity) {
        try {
          const { sendProfileTo } = await import('../socket/client');
          void sendProfileTo(outcome.contact, identity);
        } catch { /* best effort */ }
      }
      onAdded(outcome.contact);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdd() {
    if (!idValid) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      // Resolve against the identity directory, persist, and hydrate the store.
      const contact = await useContacts
        .getState()
        .addByAegisId(trimmedId, name.trim() || undefined);
      onAdded(contact);
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
        <button onClick={onCancel} aria-label={i18n.t('common.cancel')} style={iconBtn}>
          <I.ChevronL size={24} color={t.text} />
        </button>
        <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>{i18n.t('addContact.addContact')}</span>
        <div style={{ width: 24 }} />
      </div>

      <div style={{ paddingLeft: 22, paddingRight: 22, paddingTop: 18 }}>
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, display: 'block' }}>{i18n.t('addContact.aegislinkId')}</span>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface, border: `1px solid ${idValid || aegisId.length === 0 ? t.border : t.danger}`, borderRadius: t.radius, paddingLeft: 14, paddingRight: 4 }}>
          <input
            value={aegisId}
            onChange={(e) => setAegisId(e.target.value.toUpperCase())}
            placeholder={i18n.t('addContact.idPlaceholder')}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, fontFamily: t.fontMono, fontSize: 18, color: t.text, paddingTop: 14, paddingBottom: 14, letterSpacing: 1, background: 'none', border: 'none', outline: 'none' }}
          />
          <button onClick={() => void handlePaste()} aria-label={i18n.t('addContact.pasteFromClipboard')} style={iconBtn}>
            <I.Copy size={18} color={t.textDim} />
          </button>
        </div>
        {aegisId.length > 0 && !idValid && (
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger, marginTop: 6, display: 'block' }}>{i18n.t('addContact.invalidIdFormatExpected')}</span>
        )}

        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, marginTop: 24, display: 'block' }}>{i18n.t('addContact.nicknameLabel')}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alice"
          style={{ backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, paddingLeft: 14, paddingRight: 14, paddingTop: 14, paddingBottom: 14, fontFamily: t.font, fontSize: 15, color: t.text, outline: 'none', width: '100%', boxSizing: 'border-box' }}
        />

        <p style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 22, lineHeight: '19px', marginBottom: 0 }}>{i18n.t('addContact.yourContactSAegislink')}</p>

        {/* QR from an image file (no camera on desktop) */}
        <div style={{ marginTop: 16, padding: 14, backgroundColor: t.surface2, borderRadius: t.radius, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <I.QR size={20} color={t.textDim} />
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.text, fontWeight: '600', display: 'block' }}>{i18n.t('addContact.scanQrCode')}</span>
            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginTop: 2 }}>{i18n.t('addContact.uploadAScreenshotOf')}</span>
          </div>
          <label style={{ cursor: 'pointer' }}>
            <input data-testid="qr-image-input" type="file" accept="image/*" style={{ display: 'none' }} disabled={submitting} onChange={handleQrImage} />
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5 }}>{i18n.t('addContact.upload')}</span>
          </label>
        </div>

        <div style={{ marginTop: 28 }}>
          <PrimaryButton
            t={t}
            label={submitting ? i18n.t('addContact.adding') : i18n.t('addContact.addContact')}
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
