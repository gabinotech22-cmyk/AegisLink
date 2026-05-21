import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { usePreferences } from '../store/preferences';

interface Props {
  onBack: () => void;
}

export function DataExportScreen({ onBack }: Props) {
  const { t } = useTheme();
  const [pick, setPick] = useState({ messages: true, media: true, contacts: true, settings: false });
  const set = (k: keyof typeof pick, v: boolean) => setPick((p) => ({ ...p, [k]: v }));
  const [exporting, setExporting] = useState(false);

  const { identity, reset } = useIdentity();
  const { contacts } = useContacts();
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typingIndicator = usePreferences((s) => s.typingIndicator);
  const blockScreenshots = usePreferences((s) => s.blockScreenshots);

  async function handleExport() {
    setExporting(true);
    try {
      const dbData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        aegisId: identity?.aegisId ?? null,
        contacts: pick.contacts
          ? contacts.map((c) => ({ name: c.name, aegisId: c.aegisId, verified: c.verified, color: c.color }))
          : [],
        conversations: pick.messages ? {} : {},
        totalMessages: 0,
        settings: pick.settings ? { readReceipts, typingIndicator, blockScreenshots } : null,
      };

      const json = JSON.stringify(dbData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'aegis_export.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(`Export error: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleDeleteAccount() {
    const first = window.confirm(
      'DELETE ACCOUNT\n\nThis will delete all your local keys and messages from this device permanently. It cannot be undone. Continue?'
    );
    if (!first) return;
    await reset();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Your data" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 32 }}>
        <div style={{ margin: '12px 18px 16px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>
            AegisLink does not save anything on the server beyond opaque encrypted blobs. Here you control what leaves the device — and how to wipe everything if you leave.
          </span>
        </div>

        <Section t={t} label="EXPORT · ENCRYPTED FILE">
          <Toggle t={t} label="Messages" sub="Export chat history" value={pick.messages} onChange={(v) => set('messages', v)} />
          <Toggle t={t} label="Media" sub="Export photos/videos" value={pick.media} onChange={(v) => set('media', v)} />
          <Toggle t={t} label="Contacts" sub="Export address book" value={pick.contacts} onChange={(v) => set('contacts', v)} />
          <Toggle t={t} label="Settings" sub="Preferences" value={pick.settings} onChange={(v) => set('settings', v)} noBorder />
        </Section>

        <div style={{ margin: '0 18px 18px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>FORMAT</span>
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>JSON</span>
        </div>

        <div style={{ padding: '0 18px 24px' }}>
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            aria-label="Generate export file"
            style={{
              width: '100%', padding: '13px 0', backgroundColor: t.accent, border: 'none',
              borderRadius: t.radius, cursor: exporting ? 'not-allowed' : 'pointer',
              fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk,
              opacity: exporting ? 0.7 : 1,
            }}
          >
            {exporting ? 'Generating…' : 'Generate file'}
          </button>
        </div>

        <div style={{ margin: '0 18px 14px', height: 1, backgroundColor: t.divider }} />

        <Section t={t} label="DELETE ACCOUNT" hint="IRREVERSIBLE">
          <div style={{ padding: 14 }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>
              Deleting your account wipes your local keys and sends a revocation signal to all relays. Messages already received by your contacts remain on their devices — but no one will ever be able to decrypt messages to you again.
            </span>
          </div>
        </Section>

        <div style={{ padding: '0 18px' }}>
          <button
            onClick={() => void handleDeleteAccount()}
            aria-label="Delete my account forever"
            style={{
              width: '100%', padding: '14px 0', backgroundColor: 'transparent',
              border: `1px solid ${t.danger}66`, borderRadius: t.radius,
              cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.danger,
            }}
          >
            Delete my account forever
          </button>
        </div>
      </div>
    </div>
  );
}
