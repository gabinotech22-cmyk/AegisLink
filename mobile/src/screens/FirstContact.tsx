import { View, Text, Pressable } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { StoredContact } from '../db/local';
import { Avatar } from '../components/Avatar';
import { I } from '../components/icons';
import { PrimaryButton, GhostButton } from '../components/Button';

interface Props {
  contact: StoredContact;
  onOpenChat: () => void;
  onAddAnother: () => void;
}

export function FirstContactScreen({ contact, onOpenChat, onAddAnother }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.bg,
        paddingTop: insets.top + 48,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 28,
        alignItems: 'center',
      }}
    >
      {/* Success ring animation placeholder */}
      <View style={{ width: 130, height: 130, alignItems: 'center', justifyContent: 'center', marginBottom: 32 }}>
        <Svg viewBox="0 0 130 130" width={130} height={130} style={{ position: 'absolute' }}>
          <Circle cx={65} cy={65} r={60} fill={`${t.accent}1A`} />
          <Circle cx={65} cy={65} r={48} fill={t.accent} />
        </Svg>
        <I.Check size={56} color={t.accentInk} />
      </View>

      <Text
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 30,
          fontWeight: '700',
          letterSpacing: -0.5,
          color: t.text,
          textAlign: 'center',
          marginBottom: 20,
          maxWidth: 280,
        }}
      >
        {i18nT('firstContact.verifiedTitle', 'First contact verified')}
      </Text>

      {/* Contact card */}
      <View
        style={{
          width: '100%',
          maxWidth: 320,
          backgroundColor: t.surface,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: t.radius,
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          marginBottom: 20,
        }}
      >
        <Avatar t={t} name={contact.avatarImage || contact.name} color={contact.color} size={42} photoUri={contact.avatarImage} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 14, fontWeight: '600', color: t.text }}>
            {contact.name}
          </Text>
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.accent,
              letterSpacing: 0.6,
              marginTop: 2,
            }}
          >
            {i18nT('firstContact.verifiedSub', '◆ KEY {{part1}}-{{part2}} · VERIFIED', { part1: contact.publicKeyB64.slice(0, 4), part2: contact.publicKeyB64.slice(4, 8) })}
          </Text>
        </View>
      </View>

      <Text
        style={{
          fontFamily: t.font,
          fontSize: 14,
          color: t.textDim,
          lineHeight: 21,
          textAlign: 'center',
          maxWidth: 320,
          marginBottom: 'auto' as any,
        }}
      >
        {i18nT('firstContact.verifiedDesc', "Their key fingerprints match. What is sent in this chat will only be decrypted by the owner of that key — neither AegisLink nor anyone else.")}
      </Text>

      <View style={{ width: '100%', gap: 10, marginTop: 24 }}>
        <PrimaryButton t={t} label={i18nT('firstContact.openChat', 'Open chat')} onPress={onOpenChat} />
        <GhostButton t={t} label={i18nT('firstContact.addAnother', 'Add another contact')} onPress={onAddAnother} />
      </View>
    </View>
  );
}
