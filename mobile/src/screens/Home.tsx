import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, View, Text, FlatList, Pressable, StyleSheet, Animated, Easing, PanResponder, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark, AegisWord } from '../components/AegisMark';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { FloatingMenu } from '../components/FloatingMenu';
import { TabBar, type Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { normalizeAegisId } from '../crypto/aegisId';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import { useTyping } from '../store/typing';
import type { StoredContact, StoredMessage } from '../db/local';
import { previewLabel } from '../utils/messagePreview';
import { themedAlert } from '../components/AlertHost';

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
    displayName,
    avatarColor,
    avatarImage,
    publishStatus,
    publishError,
    publishRetryAfterMs,
    retryPublish,
  } = useIdentity();
  const contacts = useContacts((s) => s.contacts);
  const hydrate = useContacts((s) => s.hydrate);
  const archiveContact = useContacts((s) => s.archiveContact);
  const pinContact = useContacts((s) => s.pinContact);
  const setChatHidden = useContacts((s) => s.setChatHidden);
  const previews = useMessages((s) => s.previews);
  const loadChat = useMessages((s) => s.loadChat);
  const unreadCounts = useMessages((s) => s.unreadCounts);
  const loadAllUnreads = useMessages((s) => s.loadAllUnreads);
  const clearChat = useMessages((s) => s.clearChat);
  const [showArchived, setShowArchived] = useState(false);
  const [menuContact, setMenuContact] = useState<StoredContact | null>(null);

  useEffect(() => {
    void hydrate();
    void loadAllUnreads();
  }, []);

  // ── Publish-status retry (AppState foreground + backoff) ───────────────────
  const publishRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishRetryCountRef = useRef(0);

  // Backoff schedule: 2s, 5s, 15s, 30s, 60s, then cap
  function nextBackoffMs(attempt: number): number {
    const schedule = [2000, 5000, 15000, 30000, 60000];
    return schedule[Math.min(attempt, schedule.length - 1)];
  }

  function schedulePublishRetry() {
    if (publishRetryTimerRef.current !== null) return; // already scheduled
    // Honor the relay's explicit cooldown (429 retryAfterMs) over our own
    // backoff — retrying inside a rate-limit window is wasted work and can
    // extend a sliding-window ban. setTimeout clamps to a 32-bit signed delay,
    // so cap at ~24h to avoid overflow wrapping to an immediate fire.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const delay = publishRetryAfterMs != null && publishRetryAfterMs > 0
      ? Math.min(publishRetryAfterMs, DAY_MS)
      : nextBackoffMs(publishRetryCountRef.current);
    publishRetryTimerRef.current = setTimeout(() => {
      publishRetryTimerRef.current = null;
      publishRetryCountRef.current += 1;
      void retryPublish();
    }, delay);
  }

  // Retry when publishStatus becomes failed/unknown
  useEffect(() => {
    if (publishStatus === 'failed' || publishStatus === 'unknown') {
      schedulePublishRetry();
    } else {
      // Success or in-flight — cancel any pending retry
      if (publishRetryTimerRef.current !== null) {
        clearTimeout(publishRetryTimerRef.current);
        publishRetryTimerRef.current = null;
      }
      if (publishStatus === 'published') {
        publishRetryCountRef.current = 0;
      }
    }
    return () => {
      if (publishRetryTimerRef.current !== null) {
        clearTimeout(publishRetryTimerRef.current);
        publishRetryTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishStatus]);

  // Also retry when app comes back to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void retryPublish();
      }
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const c of contacts) void loadChat(c.aegisId);
  }, [contacts, loadChat]);

  const allSorted = useMemo(() => {
    // Defensive filter: the local user's own aegisId must never appear as a
    // contact row. This is a belt-and-suspenders check against a bad row that
    // may already sit in a user's DB from before the store/socket guards were
    // added (see store/contacts.ts addByAegisId + socket/client.ts admin
    // resolution) — it hides the row immediately without requiring a DB
    // migration or a fresh contact-add attempt.
    const filtered = identity?.aegisId
      ? contacts.filter((c) => normalizeAegisId(c.aegisId) !== normalizeAegisId(identity.aegisId))
      : contacts;
    return [...filtered].sort((a, b) => {
      // Pinned chats always first
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      // Then by last message time
      const aTs = previews[a.aegisId]?.createdAt ?? a.addedAt;
      const bTs = previews[b.aegisId]?.createdAt ?? b.addedAt;
      return bTs - aTs;
    });
  }, [contacts, previews, identity?.aegisId]);

  // Hidden chats ("deleted from list" but contact kept) are excluded from both
  // the main and archived lists; they reappear when a new message arrives.
  const sorted = allSorted.filter((c) => !c.archived && !c.hidden);
  const archived = allSorted.filter((c) => c.archived && !c.hidden);
  const displayed = showArchived ? archived : sorted;
  const empty = sorted.length === 0 && !showArchived;

  // Open a bottom-sheet menu. We use a custom sheet (not Alert.alert) because
  // Android's native AlertDialog only renders up to 3 buttons, which silently
  // dropped the "Delete chat" / "Delete contact" options.
  function handleLongPressContact(contact: StoredContact) {
    setMenuContact(contact);
  }

  function confirmClearChat(contact: StoredContact) {
    setMenuContact(null);
    themedAlert(
      i18nT('home.deleteMessages'),
      i18nT('home.deleteMessagesConfirm', { name: contact.name }),
      [
        { text: i18nT('common.cancel'), style: 'cancel' },
        { text: i18nT('common.delete'), style: 'destructive', onPress: () => void clearChat(contact.aegisId) },
      ]
    );
  }

  // "Delete chat" = remove the conversation from the list but KEEP the contact
  // (contact deletion lives in the contact's profile). Clears messages + hides;
  // reappears on the next message.
  function confirmDeleteChat(contact: StoredContact) {
    setMenuContact(null);
    themedAlert(
      i18nT('home.deleteChat', 'Eliminar chat'),
      i18nT('home.deleteChatConfirm', {
        name: contact.name,
        defaultValue: '¿Eliminar el chat con {{name}} de la lista? Se borra la conversación pero el contacto se conserva (puedes eliminarlo desde su perfil). Reaparece si hay un nuevo mensaje.',
      }),
      [
        { text: i18nT('common.cancel'), style: 'cancel' },
        {
          text: i18nT('common.delete'),
          style: 'destructive',
          onPress: () => { void clearChat(contact.aegisId); void setChatHidden(contact.aegisId, true); },
        },
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
          onPress={onProfile}
          onLongPress={onProfileSwitcher}
          accessibilityLabel="AegisLink home — mantén pulsado para cambiar de perfil"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          <AegisMark t={t} size={26} />
          <AegisWord t={t} size={24} />
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
            borderColor: `${t.accent}33`,
            backgroundColor: t.dark ? 'rgba(91,242,185,0.06)' : 'rgba(13,143,95,0.06)',
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
              backgroundColor: `${t.accent}22`,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Check size={16} color={t.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.text }}>
              {i18nT('home.identityCreated')}
            </Text>
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 11,
                color: t.accent,
                letterSpacing: 0.5,
                marginTop: 2,
              }}
            >
              {identity?.aegisId ?? '— — —'}
            </Text>
          </View>
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.accent,
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
            borderColor: t.border,
            borderRadius: t.radius,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <I.Lock size={12} color={t.accent} />
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
            {`${identity?.aegisId ?? '— — —'} · ${i18nT('home.e2eeStatus')}`}
          </Text>
        </View>
      )}

      {/* Publish-status banner — shown when registration with the relay is in
          progress or has failed. Hidden when published. The `unknown` state is
          treated identically to `publishing`: it means we haven't received a
          confirmation yet (cold-start race) and the backoff logic in the effect
          above will resolve it shortly — showing a spinner here is less alarming
          than showing an error for a transient state. */}
      {(publishStatus === 'publishing' || publishStatus === 'unknown') && (
        <View
          style={{
            marginHorizontal: 18,
            marginBottom: 8,
            paddingVertical: 10,
            paddingHorizontal: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <ActivityIndicator size="small" color={t.accent} />
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 11,
              color: t.textDim,
              letterSpacing: 0.5,
              flex: 1,
            }}
          >
            {i18nT('home.registering')}
          </Text>
        </View>
      )}

      {publishStatus === 'failed' && (
        <View
          style={{
            marginHorizontal: 18,
            marginBottom: 8,
            paddingVertical: 10,
            paddingHorizontal: 14,
            // t.danger exists in Theme (used by FloatingMenu and swipe-archive above)
            backgroundColor: `${t.danger}18`,
            borderWidth: 1,
            borderColor: `${t.danger}55`,
            borderRadius: t.radius,
            gap: 8,
          }}
        >
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 11,
              color: t.danger,
              letterSpacing: 0.4,
            }}
          >
            {i18nT('home.registrationFailed')}
          </Text>
          {publishError ? (
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 10,
                color: t.textDim,
                letterSpacing: 0.3,
              }}
              numberOfLines={3}
            >
              {publishError}
            </Text>
          ) : null}
          <Pressable
            onPress={() => void retryPublish()}
            accessibilityLabel={i18nT('home.retry')}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              marginTop: 2,
              paddingVertical: 6,
              paddingHorizontal: 14,
              borderRadius: t.radiusS,
              backgroundColor: t.danger,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 11,
                fontWeight: '700',
                color: '#FFFFFF',
                letterSpacing: 0.5,
              }}
            >
              {i18nT('home.retry')}
            </Text>
          </Pressable>
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
        <EmptyHero t={t} onAdd={onAddContact} />
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

      {/* Chat actions floating menu — replaces a 5-button Alert (Android caps
          native alerts at 3 buttons, which hid the delete options). */}
      <FloatingMenu
        t={t}
        visible={menuContact !== null}
        onClose={() => setMenuContact(null)}
        title={menuContact?.name}
        subtitle={menuContact?.aegisId}
        items={
          menuContact
            ? [
                {
                  key: 'pin',
                  icon: <I.Pin size={20} color={t.textDim} />,
                  label: (menuContact.pinned ?? false) ? i18nT('home.unpin', 'Desfijar') : i18nT('home.pin', 'Fijar'),
                  onPress: () => void pinContact(menuContact.aegisId, !(menuContact.pinned ?? false)),
                },
                {
                  key: 'archive',
                  icon: <I.Archive size={20} color={t.textDim} />,
                  label: (menuContact.archived ?? false) ? i18nT('home.unarchive', 'Desarchivar') : i18nT('home.archive', 'Archivar'),
                  onPress: () => void archiveContact(menuContact.aegisId, !(menuContact.archived ?? false)),
                },
                {
                  key: 'clear',
                  icon: <I.Eraser size={20} color={t.textDim} />,
                  label: i18nT('home.deleteMessages', 'Eliminar mensajes'),
                  onPress: () => confirmClearChat(menuContact),
                },
                {
                  key: 'delete',
                  icon: <I.Trash size={20} color={t.danger} />,
                  label: i18nT('home.deleteChat', 'Eliminar chat'),
                  onPress: () => confirmDeleteChat(menuContact),
                  danger: true,
                },
              ]
            : []
        }
      />
    </View>
  );
}

function EmptyHero({ t, onAdd }: { t: Theme; onAdd: () => void }) {
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
              { borderRadius: 70, borderWidth: 1, borderColor: t.accent },
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
        {i18nT('home.emptyPersonalTitle')}
      </Text>
      <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: 21, textAlign: 'center', maxWidth: 300, marginBottom: 24 }}>
        {i18nT('home.emptyPersonalDesc')}
      </Text>
      <Pressable
        onPress={onAdd}
        style={({ pressed }) => ({
          backgroundColor: t.accent,
          paddingHorizontal: 24,
          paddingVertical: 13,
          borderRadius: t.radius,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <I.Plus size={18} color={t.accentInk} />
        <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
          {i18nT('home.addFirstContact')}
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
    const typeFallback = preview.type === 'image' ? '📷 ' + i18nT('attachSheet.image') : preview.type === 'audio' ? '🎙 ' + i18nT('attachSheet.audio') : preview.type === 'file' ? '📎 ' + i18nT('attachSheet.file') : '...';
    const label = previewLabel(preview.body, i18nT) || typeFallback;
    if (preview.direction === 'out') previewText = `${i18nT('home.you')}${label}`;
    else previewText = label;
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
            <I.Pin size={18} color={t.accentInk} />
            <Text style={{ color: t.accentInk, fontFamily: t.fontMono, fontSize: 9, letterSpacing: 0.4, marginTop: 3 }}>
              {isPinned ? i18nT('home.unpin', 'Desfijar') : i18nT('home.pin', 'Fijar')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => { closeSwipe(); onArchive?.(); }}
            accessibilityLabel="Archivar conversación"
            style={{
              width: 72,
              backgroundColor: t.danger,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.Archive size={18} color={t.accentInk} />
            <Text style={{ color: t.accentInk, fontFamily: t.fontMono, fontSize: 9, letterSpacing: 0.4, marginTop: 3 }}>{i18nT('home.archiveAction')}</Text>
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
          <Avatar t={t} name={contact.avatarImage || contact.name} color={contact.color ?? t.surface2} size={44} photoUri={contact.avatarImage} seed={contact.publicKeyB64 || contact.aegisId} />
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
