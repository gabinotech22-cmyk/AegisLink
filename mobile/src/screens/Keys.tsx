import { useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Row } from '../components/Section';
import { useIdentity } from '../store/identity';
import { copySensitiveText } from '../utils/secureClipboard';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
}

function formatFingerprint(b64: string) {
  // First 20 chars, in groups of 4
  const stripped = b64.replace(/[^A-Za-z0-9]/g, '').substring(0, 20).toUpperCase();
  const groups = [];
  for (let i = 0; i < stripped.length; i += 4) {
    groups.push(stripped.substring(i, i + 4));
  }
  return groups.join(' ');
}

export function KeysScreen({ onBack }: Props) {
  const { t: i18nT } = useTranslation();
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();

  const handleCopy = async (text: string, label: string) => {
    await copySensitiveText(text);
    themedAlert(i18nT('keys.copied'), i18nT('keys.copiedDesc'));
  };

  if (!identity) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
        <TopBar 
          t={t} 
          title={i18nT('keys.title')} 
          left={
            <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
              <I.ChevronL size={22} color={t.textDim} />
            </Pressable>
          }
        />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: t.textDim, fontFamily: t.font }}>No identity</Text>
        </View>
      </View>
    );
  }

  const fingerprint = formatFingerprint(identity.publicKeyB64);
  const did = `did:key:z${identity.publicKeyB64.substring(0, 32).replace(/[^a-zA-Z0-9]/g, '')}`;
  const creationDate = new Date(identity.createdAt).toLocaleDateString();

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar 
        t={t} 
        title={i18nT('keys.title')} 
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />
      
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 40, gap: 24 }}>
        <Section t={t} label={i18nT('keys.identitySection')}>
          <Row
            t={t}
            icon={<I.Person size={20} color={t.textDim} />}
            label={i18nT('keys.aegisId')}
            sub={identity.aegisId}
            onPress={() => handleCopy(identity.aegisId, 'Aegis ID')}
          />
          <Row
            t={t}
            icon={<I.Fingerprint size={20} color={t.textDim} />}
            label={i18nT('keys.fingerprint')}
            sub={fingerprint}
            onPress={() => handleCopy(fingerprint, 'Fingerprint')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('keys.cryptoSection')}>
          <Row
            t={t}
            icon={<I.Key size={20} color={t.textDim} />}
            label={i18nT('keys.keyType')}
            sub={i18nT('keys.keyTypeValue')}
          />
          <Row
            t={t}
            icon={<I.Timer size={20} color={t.textDim} />}
            label={i18nT('keys.createdAt')}
            sub={creationDate}
          />
          <Row
            t={t}
            icon={<I.Shield size={20} color={t.textDim} />}
            label={i18nT('keys.keyStatus')}
            sub={i18nT('keys.keyStatusActive')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('keys.didSection')}>
          <Row
            t={t}
            icon={<I.Globe size={20} color={t.textDim} />}
            label={i18nT('keys.did')}
            sub={did}
            onPress={() => handleCopy(did, 'DID')}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('keys.safetySection')}>
          <View style={{ padding: 16, backgroundColor: t.surface2, borderRadius: t.radius, flexDirection: 'row', gap: 12 }}>
            <I.Lock size={24} color={t.text} style={{ marginTop: 2 }} />
            <Text style={{ flex: 1, fontFamily: t.font, fontSize: 13, lineHeight: 18, color: t.textDim }}>
              {i18nT('keys.safetyInfo')}
            </Text>
          </View>
        </Section>
      </ScrollView>
    </View>
  );
}
