/**
 * BlockedContacts — the list "Block" never had.
 *
 * Blocking a contact used to be reachable only from their card, and the only
 * way back was finding that card again. This screen (Privacy → Blocked
 * contacts) lists everyone blocked and unblocks in one tap. Nothing leaves the
 * device: `blocked` is a local flag.
 */
import { useMemo } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Avatar } from '../components/Avatar';
import { useContacts } from '../store/contacts';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
}

export function BlockedContactsScreen({ onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const contacts = useContacts((s) => s.contacts);
  const setBlocked = useContacts((s) => s.setBlocked);

  const blocked = useMemo(
    () => contacts.filter((c) => c.blocked).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [contacts],
  );

  function confirmUnblock(aegisId: string, name: string) {
    themedAlert(
      i18nT('blocked.unblockTitle', { name }),
      i18nT('blocked.unblockDesc'),
      [
        { text: i18nT('common.cancel'), style: 'cancel' },
        { text: i18nT('contactDetail.unblock'), onPress: () => void setBlocked(aegisId, false) },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title={i18nT('blocked.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }} accessibilityLabel={i18nT('common.back')}>
            <I.ChevronL size={22} color={t.text} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, paddingHorizontal: 18, paddingVertical: 12 }}>
          {i18nT('blocked.intro')}
        </Text>
        {blocked.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 48, paddingHorizontal: 32 }} testID="blocked-empty">
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 16, fontWeight: '600', color: t.text, textAlign: 'center' }}>
              {i18nT('blocked.emptyTitle')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', marginTop: 6, lineHeight: 19 }}>
              {i18nT('blocked.emptyDesc')}
            </Text>
          </View>
        ) : (
          blocked.map((c) => (
            <View
              key={c.aegisId}
              testID={`blocked-row-${c.aegisId}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.divider }}
            >
              <Avatar t={t} name={c.avatarImage || c.name} color={c.color ?? t.surface2} size={40} seed={c.publicKeyB64 || c.aegisId} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>{c.name}</Text>
                <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2 }}>{c.aegisId}</Text>
              </View>
              <Pressable
                testID={`unblock-${c.aegisId}`}
                onPress={() => confirmUnblock(c.aegisId, c.name)}
                hitSlop={6}
                style={({ pressed }) => ({ paddingVertical: 8, paddingHorizontal: 12, borderRadius: t.radiusS, borderWidth: 1, borderColor: t.borderStrong, opacity: pressed ? 0.7 : 1 })}
              >
                <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>{i18nT('contactDetail.unblock')}</Text>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
