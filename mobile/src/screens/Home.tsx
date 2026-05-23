import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, FlatList, Pressable, StyleSheet, Animated, Easing, Alert, PanResponder } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark, AegisWord } from '../components/AegisMark';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TabBar, type Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';
import { usePanicGesture } from '../hooks/usePanicGesture';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import { useTyping } from '../store/typing';
import type { StoredContact, StoredMessage } from '../db/local';

const WORK_ACCENT = '#6366f1';

interface Props {
  onOpenChat: (contact: StoredContact) => void;
  onAddContact: () => void;
  onSearch: () => void;
  onProfile: () => void;
  onContacts: () => void;
  onTab: (tab: Tab) => void;
  onDistribution?: () => void;
  onProfileSwitcher?: () => void;
}

export function HomeScreen({ onOpenChat, onAddContact, onSearch, onProfile, onContacts, onTab, onDistribution, onProfileSwitcher }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const {
    identity,
    activeProfile,
    displayName,
    avatarColor,
    avatarImage,
    workDisplayName,
    workAvatarColor,
    workAvatarImage,
  } = useIdentity();
  const isWork = activeProfile === 'work';
  const activeDisplayName = isWork ? workDisplayName : displayName;
  const activeAvatarColor = isWork ? workAvatarColor : avatarColor;
  const activeAvatarImage = isWork ? workAvatarImage : avatarImage;
  const contacts = useContacts((s) => s.contacts);
  const hydrate = useContacts((s) => s.hydrate);
  const archiveContact = useContacts((s) => s.archiveContact);
  const pinContact = useContacts((s) => s.pinContact);
  const removeContact = useContacts((s) => s.removeContact);
  const previews = useMessages((s) => s.previews);
  const loadChat = useMessages((s) => s.loadChat);
  const unreadCounts = useMessages((s) => s.unreadCounts);
  const loadAllUnreads = useMessages((s) => s.loadAllUnreads);
  const clearChat = useMessages((s) => s.clearChat);
  const [showArchived, setShowArchived] = useState(false);

  // ── Panic gesture ─────────────────────────────────────────────────────────
  const handlePanicTrigger = useCallback(async () => {
    try {
      await wipeDatabase();
      await useIdentity.getState().reset();
    } catch { /* non-recoverable */ }
  }, []);
  const { registerTap } = usePanicGesture(handlePanicTrigger);

  useEffect(() => {
    void hydrate();
    void loadAllUnreads();
  }, []);

  useEffect(() => {
    for (const c of contacts) void loadChat(c.aegisId);
  }, [contacts, loadChat]);

  const allSorted = useMemo(() => {
    return [...contacts].sort((a, b) => {
      // Pinned chats always first
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      // Then by last message time
      const aTs = previews[a.aegisId]?.createdAt ?? a.addedAt;
      const bTs = previews[b.aegisId]?.createdAt ?? b.addedAt;
      return bTs - aTs;
    });
  }, [contacts, previews]);

  const sorted = allSorted.filter((c) => !c.archived);
  const archived = allSorted.filter((c) => c.archived);
  const displayed = showArchived ? archived : sorted;
  const empty = sorted.length === 0 && !showArchived;

  function handleLongPressContact(contact: StoredContact) {
    const isArchived = contact.archived ?? false;
    const isPinned = contact.pinned ?? false;
    Alert.alert(
      contact.name,
      undefined,
      [
        {
          text: isPinned ? i18nT('home.unpin', 'Desfijar') : i18nT('home.pin', 'Fijar'),
          onPress: () => void pinContact(contact.aegisId, !isPinned),
        },
        {
          text: isArchived ? i18nT('home.archive') : i18nT('home.archive'),
          onPress: () => void archiveContact(contact.aegisId, !isArchived),
        },
        {
          text: i18nT('home.deleteMessages'),
          onPress: () =>
            Alert.alert(
              i18nT('home.deleteMessages'),
              i18nT('home.deleteMessagesConfirm', { name: contact.name }),
              [
                { text: i18nT('common.cancel'), style: 'cancel' },
                { text: i18nT('common.delete'), style: 'destructive', onPress: () => void clearChat(contact.aegisId) },
              ]
            ),
        },
        {
          text: i18nT('home.deleteContact'),
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              i18nT('home.deleteContact'),
              i18nT('home.deleteContactConfirm', { name: contact.name }),
              [
                { text: i18nT('common.cancel'), style: 'cancel' },
                { text: i18nT('common.delete'), style: 'destructive', onPress: () => void removeContact(contact.aegisId) },
              ]
            ),
        },
        { text: i18nT('common.cancel'), style: 'cancel' },
      ]
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      {/* Top bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 18,
          paddingTop: 14,
          paddingBottom: 12,
          minHeight: 52,
        }}
      >
        <Pressable
          onPress={() => { registerTap(); onProfile(); }}
          onLongPress={onProfileSwitcher}
          accessibilityLabel="AegisLink home — mantén pulsado para cambiar de perfil"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          <AegisMark t={t} size={26} />
          <AegisWord t={t} size={24} />
          {isWork ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: `${WORK_ACCENT}22`,
                borderWidth: 1,
                borderColor: `${WORK_ACCENT}55`,
                borderRadius: 99,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <Avatar
                t={t}
                name={activeAvatarImage ?? activeDisplayName}
                color={activeAvatarColor}
                size={18}
                photoUri={activeAvatarImage ?? undefined}
              />
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 10,
                  color: WORK_ACCENT,
                  letterSpacing: 0.5,
                  maxWidth: 100,
                }}
              >
                {activeDisplayName}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: WORK_ACCENT, fontWeight: '700' }}>
                W
              </Text>
            </View>
          ) : null}
        </Pressable>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <Pressable onPress={onSearch} hitSlop={8} style={{ padding: 8 }} accessibilityLabel="Search">
            <I.Search size={20} color={t.textDim} />
          </Pressable>
          <Pressable onPress={onContacts} hitSlop={8} style={{ padding: 8 }} accessibilityLabel="Contacts">
            <I.Person size={20} color={t.textDim} />
          </Pressable>
          {onDistribution ? (
            <Pressable onPress={onDistribution} hitSlop={8} style={{ padding: 8 }} accessibilityLabel="Distribution lists">
              <I.Broadcast size={20} color={t.textDim} />
            </Pressable>
          ) : null}
          <Pressable onPress={onAddContact} hitSlop={8} style={{ padding: 8 }} accessibilityLabel="Add contact">
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        </View>
      </View>

      {/* Welcome / identity banner */}
      {empty ? (
        <Pressable
          onPress={onProfile}
          style={({ pressed }) => ({
            marginHorizontal: 18,
            marginTop: 4,
            marginBottom: 14,
            padding: 14,
            borderWidth: 1,
            borderColor: isWork ? `${WORK_ACCENT}44` : `${t.accent}33`,
            backgroundColor: isWork
              ? 'rgba(99,102,241,0.07)'
              : t.dark ? 'rgba(91,242,185,0.06)' : 'rgba(13,143,95,0.06)',
            borderRadius: t.radius,
            flexDirection: 'row',
            gap: 12,
            alignItems: 'flex-start',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: t.radiusS,
              backgroundColor: isWork ? `${WORK_ACCENT}22` : `${t.accent}22`,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Check size={16} color={isWork ? WORK_ACCENT : t.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.text }}>
              {isWork ? i18nT('home.workProfileActive') : i18nT('home.identityCreated')}
            </Text>
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 11,
                color: isWork ? WORK_ACCENT : t.accent,
                letterSpacing: 0.5,
                marginTop: 2,
              }}
            >
              {isWork ? activeDisplayName : (identity?.aegisId ?? '— — —')}
            </Text>
          </View>
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: isWork ? WORK_ACCENT : t.accent,
              letterSpacing: 0.5,
            }}
          >
            {i18nT('home.view')}
          </Text>
        </Pressable>
      ) : (
        <View
          style={{
            marginHorizontal: 18,
            marginTop: 4,
            marginBottom: 8,
            paddingVertical: 10,
            paddingHorizontal: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: isWork ? `${WORK_ACCENT}44` : t.border,
            borderRadius: t.radius,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <I.Lock size={12} color={isWork ? WORK_ACCENT : t.accent} />
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontFamily: t.fontMono,
              fontSize: 11,
              color: t.textDim,
              letterSpacing: 0.5,
            }}
          >
            {isWork
              ? `${activeDisplayName} · ${i18nT('home.workStatus')}`
              : `${identity?.aegisId ?? '— — —'} · ${i18nT('home.e2eeStatus')}`}
          </Text>
          {isWork ? (
            <View
              style={{
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 99,
                backgroundColor: `${WORK_ACCENT}22`,
              }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: WORK_ACCENT, fontWeight: '700' }}>
                WORK
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {/* Archived header when showing archived */}
      {showArchived && (
        <Pressable
          onPress={() => setShowArchived(false)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 10 }}
        >
          <I.ChevronL size={16} color={t.accent} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>
            {i18nT('home.archived')} ({archived.length})
          </Text>
        </Pressable>
      )}

      {empty && !showArchived ? (
        <EmptyHero t={t} onAdd={onAddContact} isWork={isWork} />
      ) : (
        <FlatList
          data={displayed}
          keyExtractor={(c) => c.aegisId}
          renderItem={({ item }) => (
            <ContactRow
              t={t}
              contact={item}
              preview={previews[item.aegisId]}
              unread={unreadCounts[item.aegisId] ?? 0}
              onPress={() => onOpenChat(item)}
              onLongPress={() => handleLongPressContact(item)}
              onArchive={() => void archiveContact(item.aegisId, true)}
              onPin={() => void pinContact(item.aegisId, !(item.pinned ?? false))}
            />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.divider, marginLeft: 72 }} />}
          ListFooterComponent={
            !showArchived && archived.length > 0 ? (
              <Pressable
                onPress={() => setShowArchived(true)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 14,
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                  opacity: pressed ? 0.7 : 1,
                  borderTopWidth: 1,
                  borderTopColor: t.divider,
                })}
              >
                <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
                  <I.Archive size={20} color={t.textDim} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '500', color: t.text }}>{i18nT('home.archived')}</Text>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, marginTop: 2 }}>
                    {i18nT(archived.length === 1 ? 'home.archivedCount_one' : 'home.archivedCount_other', { count: archived.length })}
                  </Text>
                </View>
                <I.Chevron size={14} color={t.textFaint} />
              </Pressable>
            ) : null
          }
        />
      )}

      <TabBar t={t} current="home" onChange={onTab} />
    </View>
  );
}

function EmptyHero({ t, onAdd, isWork }: { t: Theme; onAdd: () => void; isWork: boolean }) {
  const { t: i18nT } = useTranslation();
  const [scale1] = useState(new Animated.Value(0));
  const [scale2] = useState(new Animated.Value(0));
  const [scale3] = useState(new Animated.Value(0));

  useEffect(() => {
    const loop = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 2400, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const l1 = loop(scale1, 0);
    const l2 = loop(scale2, 400);
    const l3 = loop(scale3, 800);
    l1.start();
    l2.start();
    l3.start();
    return () => {
      l1.stop();
      l2.stop();
      l3.stop();
    };
  }, [scale1, scale2, scale3]);

  const ring = (v: Animated.Value) => ({
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.3] }) }],
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
  });

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
      <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
        {[scale1, scale2, scale3].map((s, i) => (
          <Animated.View
            key={i}
            style={[
              StyleSheet.absoluteFillObject,
              { borderRadius: 70, borderWidth: 1, borderColor: isWork ? WORK_ACCENT : t.accent },
              ring(s),
            ]}
          />
        ))}
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.borderStrong,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AegisMark t={t} size={36} mono />
        </View>
      </View>

      <Text
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 24,
          fontWeight: '600',
          letterSpacing: -0.4,
          color: t.text,
          textAlign: 'center',
          marginTop: 26,
          marginBottom: 12,
          maxWidth: 280,
        }}
      >
        {isWork ? i18nT('home.emptyWorkTitle') : i18nT('home.emptyPersonalTitle')}
      </Text>
      <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: 21, textAlign: 'center', maxWidth: 300, marginBottom: 24 }}>
        {isWork ? i18nT('home.emptyWorkDesc') : i18nT('home.emptyPersonalDesc')}
      </Text>
      <Pressable
        onPress={onAdd}
        style={({ pressed }) => ({
          backgroundColor: isWork ? WORK_ACCENT : t.accent,
          paddingHorizontal: 24,
          paddingVertical: 13,
          borderRadius: t.radius,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <I.Plus size={18} color={isWork ? '#fff' : t.accentInk} />
        <Text style={{ color: isWork ? '#fff' : t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
          {isWork ? i18nT('home.addCoworker') : i18nT('home.addFirstContact')}
        </Text>
      </Pressable>
      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.8, marginTop: 22 }}>
        QR · ENLACE · ID
      </Text>
    </View>
  );
}

function ContactRow({
  t,
  contact,
  preview,
  unread,
  onPress,
  onLongPress,
  onArchive,
  onPin,
}: {
  t: Theme;
  contact: StoredContact;
  preview: StoredMessage | undefined;
  unread: number;
  onPress: () => void;
  onLongPress?: () => void;
  onArchive?: () => void;
  onPin?: () => void;
}) {
  const { t: i18nT } = useTranslation();
  const isTyping = useTyping((s) => s.typing[contact.aegisId] ?? false);
  const translateX = useRef(new Animated.Value(0)).current;
  const [swipeOpen, setSwipeOpen] = useState(false);
  const isPinned = contact.pinned ?? false;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 8 && Math.abs(gs.dy) < 20,
      onPanResponderMove: (_, gs) => {
        if (gs.dx < 0) translateX.setValue(Math.max(gs.dx, -144));
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx < -80) {
          Animated.timing(translateX, { toValue: -144, duration: 150, useNativeDriver: true }).start(() => setSwipeOpen(true));
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start(() => setSwipeOpen(false));
        }
      },
    })
  ).current;

  function closeSwipe() {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start(() => setSwipeOpen(false));
  }

  let previewText: string;
  if (isTyping) {
    previewText = i18nT('home.typing');
  } else if (preview) {
    if (preview.direction === 'out') previewText = `${i18nT('home.you')}${preview.body || (preview.type === 'image' ? '📷 ' + i18nT('attachSheet.image') : preview.type === 'audio' ? '🎙 ' + i18nT('attachSheet.audio') : preview.type === 'file' ? '📎 ' + i18nT('attachSheet.file') : '...')}`;
    else previewText = preview.body || (preview.type === 'image' ? '📷 ' + i18nT('attachSheet.image') : preview.type === 'audio' ? '🎙 ' + i18nT('attachSheet.audio') : preview.type === 'file' ? '📎 ' + i18nT('attachSheet.file') : '...');
  } else {
    previewText = i18nT('home.noMessages');
  }

  const time = preview ? new Date(preview.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const bold = unread > 0;
  const isMuted = contact.muted ?? false;
  const hasEphemeral = preview?.expiresAt != null && (preview.expiresAt > Date.now());

  return (
    <View style={{ overflow: 'hidden' }}>
      {/* Swipe actions behind the row: Pin + Archive */}
      {swipeOpen && (
        <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row' }}>
          <Pressable
            onPress={() => { closeSwipe(); onPin?.(); }}
            accessibilityLabel={isPinned ? 'Desfijar conversación' : 'Fijar conversación'}
            style={{
              width: 72,
              backgroundColor: t.accent,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 18 }}>📌</Text>
            <Text style={{ color: t.accentInk, fontFamily: t.fontMono, fontSize: 9, letterSpacing: 0.4, marginTop: 3 }}>
              {isPinned ? i18nT('home.unpin', 'Desfijar') : i18nT('home.pin', 'Fijar')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => { closeSwipe(); onArchive?.(); }}
            accessibilityLabel="Archivar conversación"
            style={{
              width: 72,
              backgroundColor: '#ef4444',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Archive size={18} color="#fff" />
            <Text style={{ color: '#fff', fontFamily: t.fontMono, fontSize: 9, letterSpacing: 0.4, marginTop: 3 }}>{i18nT('home.archiveAction')}</Text>
          </Pressable>
        </View>
      )}
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <Pressable
          onPress={() => { if (swipeOpen) { closeSwipe(); } else { onPress(); } }}
          onLongPress={onLongPress}
          android_ripple={{ color: t.surface2 }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 18,
            paddingVertical: 12,
            gap: 12,
            backgroundColor: pressed ? t.surface2 : t.bg,
          })}
        >
          <Avatar t={t} name={contact.avatarImage || contact.name} color={contact.color ?? t.surface2} size={44} photoUri={contact.avatarImage} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name) ? t.fontMono : t.font,
                  fontSize: 15,
                  fontWeight: bold ? '700' : '600',
                  color: t.text,
                  flex: 1,
                }}
              >
                {contact.name}
              </Text>
              {isPinned ? <Text style={{ fontSize: 11 }}>📌</Text> : null}
              {contact.verified ? <I.Check size={12} color={t.accent} /> : null}
              {isMuted ? <I.BellOff size={13} color={t.textFaint} /> : null}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: t.font,
                  fontSize: 13,
                  color: isTyping ? t.accent : bold ? t.text : t.textDim,
                  fontStyle: isTyping ? 'italic' : 'normal',
                  fontWeight: bold ? '500' : 'normal',
                  flex: 1,
                }}
              >
                {previewText}
              </Text>
              {hasEphemeral && (
                <View style={{
                  backgroundColor: `${t.accent}22`,
                  borderRadius: 4,
                  paddingHorizontal: 4,
                  paddingVertical: 2,
                }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent }}>⏱ ephemeral</Text>
                </View>
              )}
            </View>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: bold ? t.accent : t.textFaint }}>{time}</Text>
            {unread > 0 ? (
              <View style={{
                minWidth: 20, height: 20, borderRadius: 10,
                backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center',
                paddingHorizontal: 4,
              }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '700', color: t.accentInk }}>
                  {unread > 99 ? '99+' : String(unread)}
                </Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

// `color` is optional on StoredContact for legacy data; declare locally.
declare module '../db/local' {
  interface StoredContact {
    color?: string;
  }
}
