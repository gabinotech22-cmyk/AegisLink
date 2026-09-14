import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Row } from '../components/Section';
import { useIdentity } from '../store/identity';

interface Props {
  onBack: () => void;
}

// First 20 alphanumeric chars of the public key, grouped in 4s — the same
// human-comparable fingerprint shown on mobile (Keys.tsx).
function formatFingerprint(b64: string): string {
  const stripped = b64.replace(/[^A-Za-z0-9]/g, '').substring(0, 20).toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < stripped.length; i += 4) groups.push(stripped.substring(i, i + 4));
  return groups.join(' ');
}

export function KeysScreen({ onBack }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  // Which row was just copied — drives the transient checkmark (desktop has no
  // toast, so feedback lives inline on the row, replacing mobile's Alert).
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };

  const backButton = (
    <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
      <I.ChevronL size={22} color={t.textDim} />
    </button>
  );

  if (!identity) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
        <TopBar t={t} title={i18n.t('keys.yourKeys')} left={backButton} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: t.font, color: t.textDim }}>{i18n.t('backup.noIdentity')}</span>
        </div>
      </div>
    );
  }

  const fingerprint = formatFingerprint(identity.publicKeyB64);
  const did = `did:key:z${identity.publicKeyB64.substring(0, 32).replace(/[^a-zA-Z0-9]/g, '')}`;
  const creationDate = new Date(identity.createdAt).toLocaleDateString();

  const copyTrailing = (key: string) =>
    copied === key
      ? <I.Check size={16} color={t.accent} />
      : <I.Copy size={16} color={t.textFaint} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('keys.yourKeys')} left={backButton} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 0 40px' }}>
        <Section t={t} label={i18n.t('keys.identitySection')}>
          <Row
            t={t}
            icon={<I.Person size={20} color={t.textDim} />}
            label={i18n.t('keys.aegisId')}
            sub={identity.aegisId}
            onPress={() => copy('aegisId', identity.aegisId)}
            trailing={copyTrailing('aegisId')}
          />
          <Row
            t={t}
            icon={<I.Fingerprint size={20} color={t.textDim} />}
            label={i18n.t('keys.fingerprint2')}
            sub={fingerprint}
            onPress={() => copy('fingerprint', fingerprint)}
            trailing={copyTrailing('fingerprint')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18n.t('keys.cryptoSection')}>
          <Row
            t={t}
            icon={<I.Key size={20} color={t.textDim} />}
            label={i18n.t('keys.keyType')}
            sub={i18n.t('keys.x25519Ed25519Tweetnacl')}
          />
          <Row
            t={t}
            icon={<I.Timer size={20} color={t.textDim} />}
            label={i18n.t('keys.createdAt')}
            sub={creationDate}
          />
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label={i18n.t('keys.keyStatus')}
            sub={i18n.t('keys.active')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18n.t('keys.didSection')}>
          <Row
            t={t}
            icon={<I.Globe size={20} color={t.textDim} />}
            label="DID"
            sub={did}
            onPress={() => copy('did', did)}
            trailing={copyTrailing('did')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18n.t('keys.safety')}>
          <div style={{ padding: 16, backgroundColor: t.surface2, borderRadius: t.radius, display: 'flex', flexDirection: 'row', gap: 12 }}>
            <I.Lock size={24} color={t.text} style={{ marginTop: 2, flexShrink: 0 }} />
            <span style={{ flex: 1, fontFamily: t.font, fontSize: 13, lineHeight: '18px', color: t.textDim }}>{i18n.t('keys.yourPrivateKeysNever')}</span>
          </div>
        </Section>
      </div>
    </div>
  );
}
