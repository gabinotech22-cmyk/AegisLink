import type { ReactNode } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';

interface Props {
  onBack: () => void;
  onShowMyQR: () => void;
  onPasteId: () => void;
  onScanQR: () => void;
}

/**
 * "Add a contact" hub — 3 methods card per the prototype's `ScreenInviteAdd`.
 * QR recommended (in-person verification), invite link (TODO), or paste Aegis ID.
 */
export function InviteAddScreen({ onBack, onShowMyQR, onPasteId, onScanQR }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('addContact.title', 'Add contact')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 22 + insets.bottom }}>
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, textAlign: 'center', marginVertical: 18 }}>
          {i18nT('inviteAdd.hubDesc', 'AegisLink never reads your address book. Choose how to exchange identities.')}
        </Text>

        <View style={{ gap: 12 }}>
          <Method
            t={t}
            icon={<I.QR size={26} color={t.accent} />}
            label={i18nT('inviteAdd.scanLabel', "Scan peer's QR")}
            sub={i18nT('inviteAdd.scanDesc', 'Most secure. In-person verification in a single step.')}
            cta={i18nT('inviteAdd.scanCta', 'Scan QR')}
            badge={i18nT('inviteAdd.recommended', 'RECOMMENDED')}
            primary
            onPress={onScanQR}
          />
          <Method
            t={t}
            icon={<I.Eye size={24} color={t.text} />}
            label={i18nT('inviteAdd.showLabel', 'Show my QR')}
            sub={i18nT('inviteAdd.showDesc', 'For the peer to scan you — same security level.')}
            cta={i18nT('inviteAdd.showCta', 'Show')}
            onPress={onShowMyQR}
          />
          <Method
            t={t}
            icon={<I.Key size={24} color={t.text} />}
            label={i18nT('inviteAdd.pasteLabel', 'Paste Aegis ID')}
            sub={i18nT('inviteAdd.pasteDesc', "Paste the contact's 11-character ID. Verify the fingerprint later.")}
            cta={i18nT('inviteAdd.pasteCta', 'Enter ID')}
            onPress={onPasteId}
          />
        </View>

        <View
          style={{
            marginTop: 28,
            padding: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
            flexDirection: 'row',
            gap: 12,
          }}
        >
          <I.Shield size={18} color={t.warn} style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.text }}>
              {i18nT('inviteAdd.warnTitle', 'Verify before talking.')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17, marginTop: 4 }}>
              {i18nT('inviteAdd.warnDesc', 'Any method works to start — but compare the 8 safety words before sending anything sensitive.')}
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function Method({
  t,
  icon,
  label,
  sub,
  cta,
  badge,
  primary,
  onPress,
}: {
  t: Theme;
  icon: ReactNode;
  label: string;
  sub: string;
  cta: string;
  badge?: string;
  primary?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        padding: 16,
        backgroundColor: t.surface,
        borderWidth: 1,
        borderColor: primary ? `${t.accent}66` : t.border,
        borderRadius: t.radius,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: t.radius,
          backgroundColor: primary ? `${t.accent}22` : t.surface2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>{label}</Text>
          {badge ? (
            <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: t.accent, borderRadius: 99 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent, letterSpacing: 0.5 }}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17, marginTop: 3 }}>{sub}</Text>
      </View>
      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: primary ? t.accent : t.textDim, letterSpacing: 0.5, fontWeight: '600' }}>
        {cta.toUpperCase()} →
      </Text>
    </Pressable>
  );
}
