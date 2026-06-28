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
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { ShareLinkSheet } from '../components/ShareLinkSheet';
import { themedAlert } from '../components/AlertHost';
import { useChannels } from '../store/channels';
import { useIdentity } from '../store/identity';
import type { PublicChannelType } from '../api/publicChannels';

interface Props {
  onBack: () => void;
  onCreated: () => void;
}

const TYPES: Array<{ id: PublicChannelType; label: string; desc: string }> = [
  { id: 'open', label: 'Abierto', desc: 'Cualquiera publica' },
  { id: 'readonly', label: 'Solo lectura', desc: 'Solo admins publican' },
  { id: 'moderated', label: 'Moderado', desc: 'Posts en cola de aprobación' },
  { id: 'approval', label: 'Privado', desc: 'Join requiere aprobación' },
];

export function ChannelCreateScreen({ onBack, onCreated }: Props) {
  const { t } = useTheme();
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
        themedAlert('No se pudo crear', res.error ?? 'Error desconocido');
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
        title="New channel"
        left={<Pressable onPress={onBack} hitSlop={8}><I.ChevronL size={22} color={t.text} /></Pressable>}
      />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', marginBottom: 20 }}>
          <View style={{ width: 64, height: 64, borderRadius: t.radiusL, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
            <I.Globe size={30} color={t.accent} />
          </View>
        </View>

        <Text style={lbl}>NOMBRE</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Aegis Notes" placeholderTextColor={t.textFaint} style={inp} maxLength={64} />

        <Text style={[lbl, { marginTop: 16 }]}>DESCRIPCIÓN</Text>
        <TextInput value={description} onChangeText={setDescription} placeholder="Anuncios firmados del proyecto" placeholderTextColor={t.textFaint} style={inp} maxLength={140} />

        <Text style={[lbl, { marginTop: 16 }]}>TIPO DE CANAL</Text>
        <View style={{ gap: 8 }}>
          {TYPES.map((ty) => {
            const on = type === ty.id;
            return (
              <Pressable
                key={ty.id}
                onPress={() => setType(ty.id)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 13, borderWidth: 1, borderColor: on ? t.accent : t.border, borderRadius: t.radius, backgroundColor: on ? t.surface2 : t.surface }}
              >
                <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: on ? t.accent : t.borderStrong, backgroundColor: on ? t.accent : 'transparent' }} />
                <View>
                  <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>{ty.label}</Text>
                  <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 1 }}>{ty.desc}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 16 }}>
          <I.Lock size={12} color={t.textDim} />
          <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: t.textDim, lineHeight: 15 }}>
            Los posts se cifran siempre (CEK). El relay nunca ve el contenido ni quién publica.
          </Text>
        </View>

        <Pressable
          onPress={handleCreate}
          disabled={!canCreate}
          style={{ marginTop: 22, backgroundColor: canCreate ? t.accent : t.surface2, borderRadius: t.radius, paddingVertical: 15, alignItems: 'center' }}
        >
          {busy ? <ActivityIndicator color={t.accentInk} /> : (
            <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '700', color: canCreate ? t.accentInk : t.textFaint }}>Crear canal</Text>
          )}
        </Pressable>
      </ScrollView>

      <ShareLinkSheet
        visible={invite !== null}
        onClose={() => { setInvite(null); onCreated(); }}
        link={invite ?? ''}
        title="Comparte tu canal"
        shareMessage={`Únete a mi canal "${name.trim()}" en AegisLink`}
      />
    </View>
  );
}
