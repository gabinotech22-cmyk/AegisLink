import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useGroups } from '../store/groups';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import type { StoredGroup } from '../db/local';
import { themedAlert } from '../components/AlertHost';

interface Props {
  groupId: string;
  groupName: string;
  adminId: string;
  onBack: () => void;
  /** Called when the user wants to open an existing group (already member). */
  onOpenGroup: (group: StoredGroup) => void;
  /** Called when the user needs to add the admin as a contact first. */
  onAddContact: () => void;
}

export function GroupJoinScreen({
  groupId,
  groupName,
  adminId,
  onBack,
  onOpenGroup,
  onAddContact,
}: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const groups = useGroups((s) => s.groups);
  const contacts = useContacts((s) => s.contacts);
  const identity = useIdentity((s) => s.identity);

  const [requesting, setRequesting] = useState(false);

  const existingGroup = groups.find((g) => g.id === groupId);
  const adminContact = contacts.find((c) => c.aegisId === adminId);
  const adminName = adminContact?.name ?? adminId.slice(0, 16) + '…';
  const alreadyMember = existingGroup !== undefined;

  async function handleRequestJoin() {
    if (!identity || !adminContact) return;
    setRequesting(true);
    try {
      const { sendMessage } = require('../socket/client') as typeof import('../socket/client');
      const { decodeBase64 } = require('tweetnacl-util') as typeof import('tweetnacl-util');
      await sendMessage({
        identity,
        recipientAegisId: adminContact.aegisId,
        recipientPublicKey: decodeBase64(adminContact.publicKeyB64),
        plaintext: `[join_request:${groupId}:${groupName}]`,
      });
      themedAlert(
        i18nT('groupJoin.requestSentTitle'),
        i18nT('groupJoin.requestSentDesc', { admin: adminName }),
        [{ text: i18nT('common.ok'), onPress: onBack }],
      );
    } catch {
      themedAlert(i18nT('groupJoin.requestErrorTitle'), i18nT('groupJoin.requestErrorDesc'));
    } finally {
      setRequesting(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('groupJoin.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 32, gap: 20 }}>
        {/* Group icon + name */}
        <View style={{ alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 76,
              height: 76,
              borderRadius: t.radiusL,
              backgroundColor: `${t.accent}22`,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Users size={34} color={t.accent} />
          </View>
          <Text
            style={{
              fontFamily: t.fontDisplay,
              fontSize: 22,
              fontWeight: '600',
              letterSpacing: -0.4,
              color: t.text,
              textAlign: 'center',
            }}
          >
            {groupName}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <I.Shield size={11} color={t.accent} />
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 11,
                color: t.accent,
                letterSpacing: 0.5,
              }}
            >
              {i18nT('groupJoin.e2eeBadge')}
            </Text>
          </View>
        </View>

        {/* Admin info card */}
        <View
          style={{
            backgroundColor: t.surface2,
            borderRadius: t.radius,
            padding: 14,
          }}
        >
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.textDim,
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            {i18nT('groupJoin.adminLabel').toUpperCase()}
          </Text>
          <Text
            style={{
              fontFamily: adminContact ? t.font : t.fontMono,
              fontSize: 14,
              color: t.text,
              fontWeight: '500',
              letterSpacing: adminContact ? 0 : 0.4,
            }}
          >
            {adminName}
          </Text>
        </View>

        {/* Action area — three cases */}
        {alreadyMember ? (
          <View style={{ gap: 12 }}>
            <View
              style={{
                backgroundColor: `${t.accent}14`,
                borderRadius: t.radius,
                padding: 14,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <I.Check size={16} color={t.accent} />
              <Text style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.accent }}>
                {i18nT('groupJoin.alreadyMember')}
              </Text>
            </View>
            <Pressable
              onPress={() => onOpenGroup(existingGroup!)}
              style={({ pressed }) => ({
                backgroundColor: t.accent,
                borderRadius: t.radius,
                paddingVertical: 14,
                alignItems: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text
                style={{
                  fontFamily: t.font,
                  fontSize: 15,
                  fontWeight: '600',
                  color: t.accentInk,
                }}
              >
                {i18nT('groupJoin.openGroup')}
              </Text>
            </Pressable>
          </View>
        ) : adminContact ? (
          <View style={{ gap: 12 }}>
            <Text
              style={{
                fontFamily: t.font,
                fontSize: 14,
                color: t.textDim,
                lineHeight: 20,
              }}
            >
              {i18nT('groupJoin.requestDesc', { admin: adminName })}
            </Text>
            <Pressable
              onPress={() => void handleRequestJoin()}
              disabled={requesting}
              style={({ pressed }) => ({
                backgroundColor: t.accent,
                borderRadius: t.radius,
                paddingVertical: 14,
                alignItems: 'center',
                opacity: pressed || requesting ? 0.7 : 1,
              })}
            >
              <Text
                style={{
                  fontFamily: t.font,
                  fontSize: 15,
                  fontWeight: '600',
                  color: t.accentInk,
                }}
              >
                {requesting
                  ? i18nT('groupJoin.requesting')
                  : i18nT('groupJoin.requestBtn')}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <Text
              style={{
                fontFamily: t.font,
                fontSize: 14,
                color: t.textDim,
                lineHeight: 20,
              }}
            >
              {i18nT('groupJoin.needAdminContact')}
            </Text>
            <View
              style={{
                backgroundColor: t.surface2,
                borderRadius: t.radius,
                padding: 14,
              }}
            >
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 10,
                  color: t.textDim,
                  letterSpacing: 0.6,
                  marginBottom: 6,
                }}
              >
                {i18nT('groupJoin.adminIdLabel').toUpperCase()}
              </Text>
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 13,
                  color: t.text,
                  letterSpacing: 0.4,
                }}
                selectable
              >
                {adminId}
              </Text>
            </View>
            <Pressable
              onPress={onAddContact}
              style={({ pressed }) => ({
                backgroundColor: t.accent,
                borderRadius: t.radius,
                paddingVertical: 14,
                alignItems: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text
                style={{
                  fontFamily: t.font,
                  fontSize: 15,
                  fontWeight: '600',
                  color: t.accentInk,
                }}
              >
                {i18nT('groupJoin.addAdminBtn')}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}
