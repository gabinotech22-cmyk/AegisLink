import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section } from '../components/Section';

const AUTO_LOCK_OPTIONS = [1, 5, 30];

interface Props {
  onBack: () => void;
}

export function LockSettingsScreen({ onBack }: Props) {
  useTranslation(); // re-render on language change
  const { t } = useTheme();
  const [biometrics, setBiometrics] = useState(false);
  const [autoLockMinutes, setAutoLockMinutes] = useState(5);
  const [lockOnBackground, setLockOnBackground] = useState(true);

  function handleBiometrics(v: boolean) {
    setBiometrics(v);
    if (v) {
      window.alert(i18n.t('lockSettings.faceIdFingerprintWill'));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title={i18n.t('lockConfig.lockSettings')} left={
        <button onClick={onBack} aria-label={i18n.t('distLists.backA11y')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 8, paddingBottom: 32 }}>
        <Section t={t} label={i18n.t('lockSettings.security')}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, borderBottom: `1px solid ${t.divider}` }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, display: 'block' }}>{i18n.t('lockSettings.requireBiometrics')}</span>
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, display: 'block' }}>{i18n.t('lockSettings.bioUnlockDesc')}</span>
            </div>
            <input
              type="checkbox"
              checked={biometrics}
              onChange={(e) => handleBiometrics(e.target.checked)}
              aria-label={i18n.t('lockSettings.requireBiometrics')}
              style={{ width: 40, height: 24, cursor: 'pointer', accentColor: t.accent }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, display: 'block' }}>{i18n.t('lockSettings.lockOnBackground')}</span>
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, display: 'block' }}>{i18n.t('lockSettings.lockWhenAppGoes')}</span>
            </div>
            <input
              type="checkbox"
              checked={lockOnBackground}
              onChange={(e) => setLockOnBackground(e.target.checked)}
              aria-label={i18n.t('lockSettings.lockOnBackground')}
              style={{ width: 40, height: 24, cursor: 'pointer', accentColor: t.accent }}
            />
          </div>
        </Section>

        <Section t={t} label={i18n.t('lockSettings.autoLockTimer')}>
          {AUTO_LOCK_OPTIONS.map((opt, i) => {
            const selected = autoLockMinutes === opt;
            return (
              <button
                key={opt}
                onClick={() => setAutoLockMinutes(opt)}
                aria-label={i18n.t('lockSettings.autoLockAfterV0', { v0: opt })}
                style={{
                  display: 'flex', flexDirection: 'row', alignItems: 'center',
                  paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12,
                  borderBottom: i < AUTO_LOCK_OPTIONS.length - 1 ? `1px solid ${t.divider}` : 'none',
                  backgroundColor: 'transparent', width: '100%', cursor: 'pointer',
                  border: 'none', borderBottomWidth: i < AUTO_LOCK_OPTIONS.length - 1 ? 1 : 0, borderBottomStyle: 'solid', borderBottomColor: t.divider,
                  boxSizing: 'border-box',
                }}
              >
                <div style={{
                  width: 18, height: 18, borderRadius: 9,
                  border: `2px solid ${selected ? t.accent : t.borderStrong}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  marginRight: 12, flexShrink: 0, boxSizing: 'border-box',
                }}>
                  {selected && <div style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.accent }} />}
                </div>
                <span style={{
                  fontFamily: t.font, fontSize: 14, color: t.text,
                  fontWeight: selected ? '600' : '400', flex: 1, textAlign: 'left',
                }}>
                  After {opt} min
                </span>
                {selected && <I.Check size={14} color={t.accent} />}
              </button>
            );
          })}
        </Section>
      </div>
    </div>
  );
}
