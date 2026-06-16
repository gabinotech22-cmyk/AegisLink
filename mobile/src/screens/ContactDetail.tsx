import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Modal, Animated, Easing } from 'react-native';
import { WallpaperPicker, loadWallpaper, type WallpaperOption } from '../components/WallpaperPicker';
import { decodeBase64 } from 'tweetnacl-util';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { fingerprintHex } from '../crypto/fingerprint';
import { useContacts } from '../store/contacts';
import { usePreferences } from '../store/preferences';
import type { StoredContact } from '../db/local';
import { themedAlert } from '../components/AlertHost';

interface Props {
  contact: StoredContact;
  keyChanged?: boolean;
  onBack: () => void;
  onChat: () => void;
  onCall: (media: 'audio' | 'video') => void;
  onVerify?: () => void;
  onEphemeral: () => void;
}

export function ContactDetailScreen({
  contact: contactProp,
  keyChanged = false,
  onBack,
  onChat,
  onCall,
  onVerify,
  onEphemeral,
}: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [fp, setFp] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);
  const [wallpaper, setWallpaper] = useState<WallpaperOption>(0);
  const [wallpaperPickerOpen, setWallpaperPickerOpen] = useState(false);

  // Use live contact from store so muted/zeroTrust updates reflect instantly
  const { muteContact, setZeroTrust, setBlocked, removeContact, confirmKeyChange, markVerified } = useContacts();
  const contact =
    useContacts((s) => s.contacts.find((c) => c.aegisId === contactProp.aegisId)) ?? contactProp;

  const now = Date.now();
  const effectiveMuted = (contact.muted ?? false) &&
    (contact.mutedUntil === 0 || contact.mutedUntil === null || (contact.mutedUntil ?? 0) > now);
  const muted = effectiveMuted;
  const zeroTrust = contact.zeroTrust ?? false;
  const blocked = contact.blocked ?? false;

  // ── Per-contact notification level ──────────────────────────────────────────
  const mentionsOnlyChats = usePreferences((s) => s.mentionsOnlyChats);
  const setPref = usePreferences((s) => s.set);
  const [notifSheet, setNotifSheet] = useState(false);
  const notifSheetProgress = useRef(new Animated.Value(0)).current;
  const isMentionsOnly = mentionsOnlyChats.includes(contact.aegisId);
  const notifLevel: 'all' | 'mentions' | 'none' =
    muted ? 'none' : isMentionsOnly ? 'mentions' : 'all';

  useEffect(() => {
    if (notifSheet) {
      notifSheetProgress.setValue(0);
      Animated.timing(notifSheetProgress, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [notifSheet, notifSheetProgress]);

  async function setNotifLevel(level: 'all' | 'mentions' | 'none') {
    const without = mentionsOnlyChats.filter((id) => id !== contact.aegisId);
    if (level === 'all') {
      await setPref('mentionsOnlyChats', without);
      if (muted) await muteContact(contact.aegisId, false);
    } else if (level === 'mentions') {
      await setPref('mentionsOnlyChats', [...without, contact.aegisId]);
      if (muted) await muteContact(contact.aegisId, false);
    } else {
      // none → silence entirely (forever) and drop any mentions-only flag
      await setPref('mentionsOnlyChats', without);
      await muteContact(contact.aegisId, true, 0);
    }
    setNotifSheet(false);
  }

  useEffect(() => {
    try {
      const pub = decodeBase64(contact.publicKeyB64);
      setFp(fingerprintHex(pub));
    } catch {
      setFp([]);
    }
  }, [contact.publicKeyB64]);

  useEffect(() => {
    void loadWallpaper(contact.aegisId).then(setWallpaper);
  }, [contact.aegisId]);

  function handleMute() {
    if (muted) {
      void muteContact(contact.aegisId, false);
      return;
    }
    themedAlert(i18nT('contactDetail.muteTitle'), i18nT('contactDetail.muteTimeQuestion'), [
      { text: i18nT('contactDetail.mute1h'), onPress: () => void muteContact(contact.aegisId, true, Date.now() + 3_600_000) },
      { text: i18nT('contactDetail.mute8h'), onPress: () => void muteContact(contact.aegisId, true, Date.now() + 28_800_000) },
      { text: i18nT('contactDetail.muteAlways'), onPress: () => void muteContact(contact.aegisId, true, 0) },
      { text: i18nT('common.cancel'), style: 'cancel' },
    ]);
  }

  function handleBlock() {
    if (blocked) {
      themedAlert(i18nT('contactDetail.unblock'), i18nT('contactDetail.blockConfirm', { name: contact.name }), [
        { text: i18nT('common.cancel'), style: 'cancel' },
        { text: i18nT('contactDetail.unblock'), onPress: () => void setBlocked(contact.aegisId, false) },
      ]);
    } else {
      themedAlert(i18nT('contactDetail.block'), i18nT('contactDetail.blockDesc'), [
        { text: i18nT('common.cancel'), style: 'cancel' },
        { text: i18nT('contactDetail.block'), style: 'destructive', onPress: () => void setBlocked(contact.aegisId, true) },
      ]);
    }
  }

  async function handleZeroTrust(enabled: boolean) {
    await setZeroTrust(contact.aegisId, enabled);
    if (enabled) {
      themedAlert(
        i18nT('contactDetail.zeroTrustActivated'),
        i18nT('contactDetail.zeroTrustActivatedDesc')
      );
    }
  }

  function handleNotifications() {
    setNotifSheet(true);
  }

  async function handleVaciarYBloquear() {
    themedAlert(
      i18nT('contactDetail.clearBlockTitle'),
      i18nT('contactDetail.clearBlockDesc', { name: contact.name }),
      [
        { text: i18nT('common.cancel'), style: 'cancel' },
        {
          text: i18nT('contactDetail.clearBlockBtn'),
          style: 'destructive',
          onPress: async () => {
            setRemoving(true);
            try {
              await removeContact(contact.aegisId);
              onBack();
            } catch (e) {
              setRemoving(false);
              themedAlert(i18nT('common.error'), (e as Error).message);
            }
          },
        },
      ]
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('contacts.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
        right={<I.More size={20} color={t.textDim} />}
      />

      {removing ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 22 }}>
          <View style={{ alignItems: 'center', paddingHorizontal: 22, paddingVertical: 14 }}>
            <Avatar t={t} name={contact.avatarImage || contact.name} color={contact.color ?? t.accent} size={88} seed={contact.publicKeyB64 || contact.aegisId} />
            <Text
              style={{
                fontFamily: /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name) ? t.fontMono : t.fontDisplay,
                fontSize: 24,
                fontWeight: '600',
                letterSpacing: -0.4,
                color: t.text,
                marginTop: 14,
              }}
            >
              {contact.name}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5, marginTop: 4 }}>
              {contact.aegisId} · {i18nT('contactDetail.addedAgo', { count: Math.max(1, Math.floor((Date.now() - contact.addedAt) / 86400000)) })}
            </Text>
            {contact.status ? (
              <Text
                style={{
                  fontFamily: t.font,
                  fontSize: 13,
                  color: t.textDim,
                  marginTop: 6,
                  fontStyle: 'italic',
                  textAlign: 'center',
                  paddingHorizontal: 16,
                }}
                numberOfLines={2}
              >
                "{contact.status}"
              </Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 18 }}>
              <ContactAction t={t} icon={<I.Chat size={20} color={t.accent} />} label={i18nT('contactDetail.sendMessage')} onPress={onChat} />
              <ContactAction t={t} icon={<I.Phone size={20} color={t.accent} />} label={i18nT('call.inCall')} onPress={() => onCall('audio')} />
              <ContactAction t={t} icon={<I.Video size={20} color={t.accent} />} label={i18nT('call.video')} onPress={() => onCall('video')} />
              <ContactAction
                t={t}
                icon={<I.Mute size={20} color={muted ? t.warn : t.accent} />}
                label={muted ? i18nT('contactDetail.unmute') : i18nT('contactDetail.mute')}
                active={muted}
                onPress={handleMute}
              />
            </View>
          </View>

          {keyChanged ? (
            <View
              style={{
                marginHorizontal: 18,
                marginBottom: 18,
                padding: 14,
                backgroundColor: t.dark ? 'rgba(255,107,107,0.08)' : 'rgba(184,68,42,0.06)',
                borderWidth: 1,
                borderColor: `${t.danger}55`,
                borderRadius: t.radius,
                flexDirection: 'row',
                gap: 12,
              }}
            >
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: t.danger,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontFamily: t.font, fontWeight: '700', fontSize: 16 }}>!</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.danger, marginBottom: 4 }}>
                  {i18nT('contactDetail.keyChangedTitle')}
                </Text>
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 17, marginBottom: 10 }}>
                  {i18nT('contactDetail.keyChangedDesc')}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    onPress={onVerify}
                    style={{
                      backgroundColor: t.danger,
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      borderRadius: t.radiusS,
                    }}
                  >
                    <Text style={{ color: '#fff', fontFamily: t.font, fontSize: 12, fontWeight: '600' }}>
                      {i18nT('contactDetail.reVerify')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      themedAlert(
                        i18nT('contactDetail.trustAnywayTitle'),
                        i18nT('contactDetail.trustAnywayDesc'),
                        [
                          { text: i18nT('common.cancel'), style: 'cancel' },
                          {
                            text: i18nT('contactDetail.trustBtn'),
                            onPress: () => void confirmKeyChange(contact.aegisId, contact.publicKeyB64),
                          },
                        ]
                      )
                    }
                    style={{
                      borderWidth: 1,
                      borderColor: t.borderStrong,
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      borderRadius: t.radiusS,
                    }}
                  >
                    <Text style={{ color: t.text, fontFamily: t.font, fontSize: 12 }}>{i18nT('contactDetail.trustAnyway')}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : null}

          <Section t={t} label={i18nT('contactDetail.publicKeySection').toUpperCase()}>
            <View style={{ padding: 14 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {fp.map((f, i) => (
                  <View
                    key={i}
                    style={{
                      width: '23.5%',
                      backgroundColor: t.surface2,
                      paddingVertical: 6,
                      borderRadius: t.radiusS,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text }}>{f}</Text>
                  </View>
                ))}
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                <Text
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 10,
                    color: keyChanged ? t.danger : contact.verified ? t.accent : t.warn,
                    letterSpacing: 0.5,
                  }}
                >
                  {keyChanged
                    ? i18nT('contactDetail.keyChanged').toUpperCase()
                    : contact.verified
                      ? i18nT('contactDetail.verified')
                      : i18nT('contactDetail.notVerified')}
                </Text>
                <Pressable
                  onPress={onVerify}
                  style={{
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: t.radiusS,
                  }}
                >
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, letterSpacing: 0.5 }}>
                    {i18nT('contactDetail.verifyIdentity').toUpperCase()}
                  </Text>
                </Pressable>
              </View>
              {!contact.verified && !keyChanged ? (
                <Pressable
                  onPress={() =>
                    themedAlert(
                      i18nT('contactDetail.markVerifiedTitle'),
                      i18nT('contactDetail.markVerifiedDesc'),
                      [
                        { text: i18nT('common.cancel'), style: 'cancel' },
                        {
                          text: i18nT('contactDetail.wordsMatch'),
                          onPress: () => void markVerified(contact.aegisId, true),
                        },
                      ]
                    )
                  }
                  style={{
                    marginTop: 10,
                    backgroundColor: t.accent,
                    paddingVertical: 10,
                    borderRadius: t.radiusS,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: '#000', letterSpacing: 0.3 }}>
                    {i18nT('contactDetail.verifiedCheck')}
                  </Text>
                </Pressable>
              ) : contact.verified ? (
                <Pressable
                  onPress={() =>
                    themedAlert(
                      i18nT('contactDetail.revokeVerifiedTitle'),
                      i18nT('contactDetail.revokeVerifiedDesc'),
                      [
                        { text: i18nT('common.cancel'), style: 'cancel' },
                        {
                          text: i18nT('contactDetail.revokeBtn'),
                          style: 'destructive',
                          onPress: () => void markVerified(contact.aegisId, false),
                        },
                      ]
                    )
                  }
                  style={{ marginTop: 8, alignSelf: 'flex-start' }}
                >
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.3 }}>
                    {i18nT('contactDetail.revokeVerified')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </Section>

          <Section t={t} label={i18nT('contactDetail.thisConversationSection').toUpperCase()}>
            <Row
              t={t}
              icon={<I.Image size={18} color={t.textDim} />}
              label="Chat wallpaper"
              sub={wallpaper === 0 ? 'None' : `Option ${wallpaper}`}
              onPress={() => setWallpaperPickerOpen(true)}
            />
            <Row
              t={t}
              icon={<I.Timer size={18} color={t.textDim} />}
              label={i18nT('contactDetail.burnMessages')}
              sub={i18nT('contactDetail.burnMessagesSub')}
              onPress={onEphemeral}
            />
            <Toggle
              t={t}
              label={i18nT('contactDetail.zeroTrustLabel')}
              sub={zeroTrust ? i18nT('contactDetail.zeroTrustSubOn') : i18nT('contactDetail.zeroTrustSubOff')}
              value={zeroTrust}
              onChange={handleZeroTrust}
            />
            <Row
              t={t}
              icon={<I.Bell size={18} color={t.textDim} />}
              label={i18nT('contactDetail.notificationsTitle')}
              sub={i18nT(`contactDetail.notifLevel_${notifLevel}`)}
              onPress={handleNotifications}
            />
            <Row
              t={t}
              icon={<I.X size={18} color={t.danger} />}
              label={blocked ? i18nT('contactDetail.unblock') : i18nT('contactDetail.block')}
              sub={blocked ? i18nT('contactDetail.unblock') : i18nT('contactDetail.blockDesc')}
              danger
              onPress={handleBlock}
            />
            <Row
              t={t}
              icon={<I.Trash size={18} color={t.danger} />}
              label={i18nT('contactDetail.removeContact')}
              danger
              noBorder
              onPress={handleVaciarYBloquear}
            />
          </Section>
        </ScrollView>
      )}

      <WallpaperPicker
        visible={wallpaperPickerOpen}
        contactAegisId={contact.aegisId}
        current={wallpaper}
        onClose={() => setWallpaperPickerOpen(false)}
        onSelect={(opt) => { setWallpaper(opt); setWallpaperPickerOpen(false); }}
      />

      {/* Per-contact notification level — floating menu */}
      <Modal visible={notifSheet} transparent animationType="fade" onRequestClose={() => setNotifSheet(false)}>
        <Pressable
          onPress={() => setNotifSheet(false)}
          accessibilityRole="button"
          accessibilityLabel={i18nT('common.close', 'Close')}
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.55)',
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 28,
          }}
        >
          <Animated.View
            style={[
              {
                width: '100%',
                maxWidth: 340,
                alignSelf: 'center',
                backgroundColor: t.surface,
                borderRadius: t.radiusL,
                borderWidth: 1,
                borderColor: t.border,
                overflow: 'hidden',
                paddingVertical: 8,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.3,
                shadowRadius: 24,
                elevation: 16,
              },
              {
                opacity: notifSheetProgress,
                transform: [
                  {
                    scale: notifSheetProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.92, 1],
                    }),
                  },
                ],
              },
            ]}
          >
            <Pressable onPress={(e) => e.stopPropagation?.()}>
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 10,
                  color: t.textDim,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  paddingHorizontal: 18,
                  paddingTop: 14,
                  paddingBottom: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: t.divider,
                }}
              >
                {i18nT('contactDetail.notificationsTitle')}
              </Text>
              <View style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 6 }}>
                {([
                  { level: 'all' as const, icon: <I.Bell size={20} color={t.accent} /> },
                  { level: 'mentions' as const, icon: <I.Hash size={20} color={t.accent} /> },
                  { level: 'none' as const, icon: <I.BellOff size={20} color={t.warn} /> },
                ]).map(({ level, icon }) => {
                  const selected = notifLevel === level;
                  return (
                    <Pressable
                      key={level}
                      onPress={() => void setNotifLevel(level)}
                      accessibilityRole="button"
                      accessibilityLabel={i18nT(`contactDetail.notifLevel_${level}`)}
                      style={({ pressed }) => ({
                        flexDirection: 'row', alignItems: 'center', gap: 14,
                        paddingVertical: 14, paddingHorizontal: 12,
                        borderRadius: t.radiusS,
                        backgroundColor: selected ? `${t.accent}14` : (pressed ? t.surface2 : 'transparent'),
                        borderWidth: 1, borderColor: selected ? `${t.accent}55` : 'transparent',
                      })}
                    >
                      {icon}
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>
                          {i18nT(`contactDetail.notifLevel_${level}`)}
                        </Text>
                        <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                          {i18nT(`contactDetail.notifLevel_${level}_desc`)}
                        </Text>
                      </View>
                      {selected ? <I.Check size={18} color={t.accent} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </View>
  );
}

function ContactAction({
  t,
  icon,
  label,
  onPress,
  active,
}: {
  t: Theme;
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
  active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        width: 64,
        paddingVertical: 10,
        backgroundColor: active ? `${t.warn}18` : t.surface,
        borderWidth: 1,
        borderColor: active ? `${t.warn}55` : t.border,
        borderRadius: t.radius,
        alignItems: 'center',
        gap: 4,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {icon}
      <Text
        style={{
          fontFamily: t.fontMono,
          fontSize: 9,
          color: active ? t.warn : t.text,
          letterSpacing: 0.5,
        }}
      >
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}
