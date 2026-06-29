/**
 * ChannelCreate — create a sealed public channel (Phase 2d-2)
 *
 * Collects name/description/type and calls useChannels.createChannel, which does
 * ALL the crypto (identity, CEK, manifest sign, CEK wrap, register, invite). On
 * success the shareable invite link is surfaced via ShareLinkSheet. This screen
 * does no crypto. Design ref: prototype/screens-channels.jsx (ScreenChannelCreate).
 */

import { useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { ShareLinkSheet } from '../components/ShareLinkSheet';
import { themedAlert } from '../components/AlertHost';
import { useChannels } from '../store/channels';
import { useIdentity } from '../store/identity';
import type { PublicChannelType } from '../api/publicChannels';

interface Props {
  onBack: () => void;
  onCreated: () => void;
}

const TYPE_IDS: Array<{ id: PublicChannelType; labelKey: string; descKey: string }> = [
  { id: 'open', labelKey: 'channels.typeOpen', descKey: 'channels.typeOpenDesc' },
  { id: 'readonly', labelKey: 'channels.typeReadonly', descKey: 'channels.typeReadonlyDesc' },
  { id: 'moderated', labelKey: 'channels.typeModerated', descKey: 'channels.typeModeratedDesc' },
  { id: 'approval', labelKey: 'channels.typeApproval', descKey: 'channels.typeApprovalDesc' },
];

export function ChannelCreateScreen({ onBack, onCreated }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const createChannel = useChannels((s) => s.createChannel);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<PublicChannelType>('open');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);

  const canCreate = name.trim().length > 0 && !busy && identity;

  const handleCreate = async () => {
    if (!identity || !canCreate) return;
    setBusy(true);
    try {
      const res = await createChannel({ name: name.trim(), description: description.trim(), channelType: type }, identity);
      if (res.ok && res.invite) {
        setInvite(res.invite);
      } else {
        themedAlert(i18nT('channels.createFailed'), res.error ?? i18nT('channels.unknownError'));
      }
    } finally {
      setBusy(false);
    }
  };

  const lbl = { fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginBottom: 6, letterSpacing: 0.5 } as const;
  const inp = { backgroundColor: t.surface, color: t.text, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 12, paddingHorizontal: 14, fontFamily: t.font, fontSize: 15 } as const;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('channels.newChannel')}
        left={<Pressable onPress={onBack} hitSlop={8}><I.ChevronL size={22} color={t.text} /></Pressable>}
      />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', marginBottom: 20 }}>
          {/* No channelId exists yet; seed from current name so the identicon
              updates live as the user types. Once created, the real channelId
              becomes the stable seed everywhere else. */}
          <Avatar t={t} name={name.trim() || 'Channel'} seed={name.trim() || 'new-channel'} size={64} />
        </View>

        <Text style={lbl}>{i18nT('channels.nameLabel')}</Text>
        <TextInput value={name} onChangeText={setName} placeholder={i18nT('channels.namePlaceholder')} placeholderTextColor={t.textFaint} style={inp} maxLength={64} />

        <Text style={[lbl, { marginTop: 16 }]}>{i18nT('channels.descLabel')}</Text>
        <TextInput value={description} onChangeText={setDescription} placeholder={i18nT('channels.descPlaceholder')} placeholderTextColor={t.textFaint} style={inp} maxLength={140} />

        <Text style={[lbl, { marginTop: 16 }]}>{i18nT('channels.typeLabel')}</Text>
        <View style={{ gap: 8 }}>
          {TYPE_IDS.map((ty) => {
            const on = type === ty.id;
            return (
              <Pressable
                key={ty.id}
                onPress={() => setType(ty.id)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 13, borderWidth: 1, borderColor: on ? t.accent : t.border, borderRadius: t.radius, backgroundColor: on ? t.surface2 : t.surface }}
              >
                <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: on ? t.accent : t.borderStrong, backgroundColor: on ? t.accent : 'transparent' }} />
                <View>
                  <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>{i18nT(ty.labelKey)}</Text>
                  <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 1 }}>{i18nT(ty.descKey)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 16 }}>
          <I.Lock size={12} color={t.textDim} />
          <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: t.textDim, lineHeight: 15 }}>
            {i18nT('channels.encryptNote')}
          </Text>
        </View>

        <Pressable
          onPress={handleCreate}
          disabled={!canCreate}
          style={{ marginTop: 22, backgroundColor: canCreate ? t.accent : t.surface2, borderRadius: t.radius, paddingVertical: 15, alignItems: 'center' }}
        >
          {busy ? <ActivityIndicator color={t.accentInk} /> : (
            <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '700', color: canCreate ? t.accentInk : t.textFaint }}>{i18nT('channels.create')}</Text>
          )}
        </Pressable>
      </ScrollView>

      <ShareLinkSheet
        visible={invite !== null}
        onClose={() => { setInvite(null); onCreated(); }}
        link={invite ?? ''}
        title={i18nT('channels.shareTitle')}
        shareMessage={i18nT('channels.shareMessage', { name: name.trim() })}
      />
    </View>
  );
}
