import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { useGroups } from '../store/groups';
import { usePreferences } from '../store/preferences';
import { loadMessagesByChat } from '../db/local';
import { buildExportPayload } from '../utils/dataExport';

interface Props {
  onBack: () => void;
}

export function DataExportScreen({ onBack }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const [pick, setPick] = useState({ messages: true, media: true, contacts: true, settings: false });
  const set = (k: keyof typeof pick, v: boolean) => setPick((p) => ({ ...p, [k]: v }));
  const [exporting, setExporting] = useState(false);

  const { identity, reset } = useIdentity();
  const { contacts } = useContacts();
  const groups = useGroups((st) => st.groups);
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typingIndicator = usePreferences((s) => s.typingIndicator);
  const blockScreenshots = usePreferences((s) => s.blockScreenshots);

  async function handleExport() {
    setExporting(true);
    try {
      // Messages used to be an empty object whatever the toggle said.
      const dbData = await buildExportPayload({
        aegisId: identity?.aegisId ?? null,
        contacts,
        groups,
        pick,
        settings: { readReceipts, typingIndicator, blockScreenshots },
        loadMessages: loadMessagesByChat,
      });

      const json = JSON.stringify(dbData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'aegis_export.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(i18n.t('dataExport.exportErrorV0', { v0: (e as Error).message }));
    } finally {
      setExporting(false);
    }
  }

  async function handleDeleteAccount() {
    const first = window.confirm(
      i18n.t('dataExport.deleteAccountThisWill')
    );
    if (!first) return;
    await reset();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('dataExport.title')} left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 32 }}>
        <div style={{ margin: '12px 18px 16px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>{i18n.t('dataExport.infoDesc')}</span>
        </div>

        <Section t={t} label={i18n.t('dataExport.exportEncryptedFile')}>
          <Toggle t={t} label={i18n.t('common.messages')} sub={i18n.t('dataExport.messagesSub')} value={pick.messages} onChange={(v) => set('messages', v)} />
          <Toggle t={t} label={i18n.t('dataExport.media')} sub={i18n.t('dataExport.exportPhotosVideos')} value={pick.media} onChange={(v) => set('media', v)} />
          <Toggle t={t} label={i18n.t('common.contacts')} sub={i18n.t('dataExport.contactsSub')} value={pick.contacts} onChange={(v) => set('contacts', v)} />
          <Toggle t={t} label={i18n.t('common.settings')} sub={i18n.t('dataExport.settingsSub')} value={pick.settings} onChange={(v) => set('settings', v)} noBorder />
        </Section>

        <div style={{ margin: '0 18px 18px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>{i18n.t('dataExport.format')}</span>
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>JSON</span>
        </div>

        <div style={{ padding: '0 18px 24px' }}>
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            aria-label={i18n.t('dataExport.generateExportFile')}
            style={{
              width: '100%', padding: '13px 0', backgroundColor: t.accent, border: 'none',
              borderRadius: t.radius, cursor: exporting ? 'not-allowed' : 'pointer',
              fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.accentInk,
              opacity: exporting ? 0.7 : 1,
            }}
          >
            {exporting ? i18n.t('dataExport.generating') : i18n.t('dataExport.generateBtn')}
          </button>
        </div>

        <div style={{ margin: '0 18px 14px', height: 1, backgroundColor: t.divider }} />

        <Section t={t} label={i18n.t('dataExport.deleteAccountCaps')} hint={i18n.t('dataExport.irreversible')}>
          <div style={{ padding: 14 }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>{i18n.t('dataExport.deletingYourAccountWipes')}</span>
          </div>
        </Section>

        <div style={{ padding: '0 18px' }}>
          <button
            onClick={() => void handleDeleteAccount()}
            aria-label={i18n.t('dataExport.deleteBtn')}
            style={{
              width: '100%', padding: '14px 0', backgroundColor: 'transparent',
              border: `1px solid ${t.danger}66`, borderRadius: t.radius,
              cursor: 'pointer', fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.danger,
            }}
          >{i18n.t('dataExport.deleteBtn')}</button>
        </div>
      </div>
    </div>
  );
}
