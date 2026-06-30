import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, Linking } from 'react-native';
import { FormattedText } from '../../components/FormattedText';
import { VideoBubble } from '../../components/VideoBubble';
import { AudioWaveform } from '../../components/AudioWaveform';
import { LinkPreview } from '../../components/LinkPreview';
import { MediaImage } from '../../components/MediaImage';
import { AttachmentGrid } from '../../components/AttachmentGrid';
import Svg, { Path, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import type { Theme } from '../../theme/vault';
import { I } from '../../components/icons';
import { useIdentity } from '../../store/identity';
import { useContacts } from '../../store/contacts';
import { useGroups } from '../../store/groups';
import type { StoredMessage } from '../../db/local';
import { parseLocationMessage } from '../../utils/parseLocationMessage';
import { themedAlert } from '../../components/AlertHost';

function ViewOnceAudioBubble({
  t, m, me, isReceived, durSec, queued, time, onLongPress,
}: {
  t: Theme;
  m: StoredMessage;
  me: boolean;
  isReceived: boolean;
  durSec: number;
  queued: boolean;
  time: string;
  onLongPress: () => void;
}) {
  const [played, setPlayed] = useState(false);
  const [playing, setPlaying] = useState(false);
  type AudioSound = import('expo-av').Audio.Sound;
  type AVPlaybackStatus = import('expo-av').AVPlaybackStatus;
  const soundRef = useRef<AudioSound | null>(null);

  useEffect(() => {
    return () => { void soundRef.current?.unloadAsync().catch(() => {}); };
  }, []);

  async function playOnce() {
    if (!m.mediaUri || playing || played) return;
    try {
      const { Audio } = require('expo-av');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: m.mediaUri },
        { shouldPlay: true },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded) return;
          if (status.didJustFinish) {
            setPlaying(false);
            setPlayed(true);
            void soundRef.current?.unloadAsync().catch(() => {});
            soundRef.current = null;
            // Ephemeral: destroy the cached audio after the single playback
            // (received side only — the sender keeps their local copy bubble).
            if (isReceived && m.mediaUri) {
              try {
                const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
                void FileSystem.deleteAsync(m.mediaUri, { idempotent: true }).catch(() => {});
              } catch { /* ignore */ }
              // Persist consumption so it doesn't reappear as playable after an
              // app reload — mirrors the view-once image which soft-deletes once
              // viewed. Without this the local `played` flag was lost on reload.
              try {
                const { useMessages } = require('../../store/messages');
                void useMessages.getState().softDelete(m.chatId, m.id).catch(() => {});
              } catch { /* ignore */ }
            }
          }
        }
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }

  const canPlay = isReceived && !!m.mediaUri && !played;

  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
      <Pressable
        onLongPress={onLongPress}
        onPress={() => { if (canPlay) void playOnce(); }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: me ? t.bubbleOut : t.bubbleIn,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          borderWidth: 1,
          borderColor: `${t.accent}44`,
          opacity: pressed ? 0.85 : played ? 0.6 : 1,
          maxWidth: 240,
        })}
      >
        <I.Mic size={22} color={me ? t.bubbleOutText : t.accent} stroke={1.6} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: me ? t.bubbleOutText : t.text }}>
            {isReceived ? 'Audio efímero' : 'Audio enviado'}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.accent, letterSpacing: 0.5, marginTop: 2 }}>
            {played
              ? 'ya escuchado'
              : playing
                ? 'reproduciendo…'
                : isReceived
                  ? (durSec > 0 ? `${durSec}s · toca para escuchar una vez` : 'toca para escuchar una vez')
                  : (durSec > 0 ? `${durSec}s · escuchar una vez` : 'escuchar una vez')}
          </Text>
        </View>
      </Pressable>
      <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
    </View>
  );
}

// ─── Bubble ──────────────────────────────────────────────────────────────────

// ── Group join-request card ───────────────────────────────────────────────────
// Wire format: [join_request:<groupId>:<groupName>], sent 1:1 to the group
// admin by GroupJoinScreen when someone opens an invite link. The requester is
// the chat peer (m.chatId). Accepting adds them to the group and broadcasts
// the re-signed membership, which creates the group on the requester's device
// through the authenticated group_msg metadata path.
function JoinRequestBubble({ t, m, me, time }: { t: Theme; m: StoredMessage; me: boolean; time: string }) {
  const { t: i18nT } = useTranslation();
  const groups = useGroups((s) => s.groups);
  const addMember = useGroups((s) => s.addMember);
  const contacts = useContacts((s) => s.contacts);
  const identity = useIdentity((s) => s.identity);
  const [busy, setBusy] = useState(false);

  // [join_request:<groupId>:<groupName>] — groupName is display-only.
  const inner = m.body.slice('[join_request:'.length, -1);
  const sep = inner.indexOf(':');
  const groupId = sep >= 0 ? inner.slice(0, sep) : inner;
  const wireGroupName = sep >= 0 ? inner.slice(sep + 1) : '';

  const group = groups.find((g) => g.id === groupId);
  // Prefer the locally-trusted name; the wire name is attacker-controlled.
  const groupName = group?.name ?? wireGroupName;
  const requesterId = m.chatId;
  const requesterName = contacts.find((c) => c.aegisId === requesterId)?.name ?? requesterId;
  const isAdmin = !!group && !!identity && group.adminId === identity.aegisId;
  const alreadyMember = !!group && group.members.includes(requesterId);

  async function handleAccept() {
    if (!group || !identity || busy) return;
    setBusy(true);
    try {
      await addMember(group.id, requesterId);
      // Push the re-signed member list to everyone NOW — this is what makes
      // the group appear on the requester's device.
      const client = require('../../socket/client') as typeof import('../../socket/client');
      await client.broadcastGroupMetadata(identity, group.id);
    } catch {
      themedAlert(
        i18nT('chat.joinRequestErrorTitle', 'Could not add member'),
        i18nT('chat.joinRequestErrorDesc', 'Check your connection and try again.'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (me) {
    // Requester side: confirmation that the request went out.
    return (
      <View style={{ alignItems: 'center', marginVertical: 4 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: t.surface2,
            paddingHorizontal: 14,
            paddingVertical: 9,
            borderRadius: 99,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <I.Users size={14} color={t.accent} />
          <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>
            {i18nT('chat.joinRequestSentCard', 'Join request sent · {{group}}', { group: groupName })}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ alignItems: 'flex-start' }}>
      <View
        style={{
          width: 260,
          backgroundColor: t.bubbleIn,
          borderRadius: t.radius,
          borderTopLeftRadius: t.radiusS,
          borderWidth: 1,
          borderColor: `${t.accent}33`,
          overflow: 'hidden',
        }}
      >
        <View style={{ padding: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: t.radiusS,
                backgroundColor: `${t.accent}22`,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.Users size={17} color={t.accent} />
            </View>
            <Text
              style={{
                flex: 1,
                fontFamily: t.fontMono,
                fontSize: 10,
                color: t.textDim,
                letterSpacing: 0.6,
              }}
            >
              {i18nT('chat.joinRequestLabel', 'GROUP JOIN REQUEST').toUpperCase()}
            </Text>
          </View>
          <Text style={{ fontFamily: t.font, fontSize: 14, color: t.bubbleInText, lineHeight: 20 }}>
            {i18nT('chat.joinRequestIncoming', '{{name}} wants to join "{{group}}"', {
              name: requesterName,
              group: groupName,
            })}
          </Text>

          {alreadyMember ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 2 }}>
              <I.Check size={15} color={t.accent} />
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.accent }}>
                {i18nT('chat.joinRequestAdded', 'Added to the group')}
              </Text>
            </View>
          ) : isAdmin ? (
            <Pressable
              onPress={() => void handleAccept()}
              disabled={busy}
              style={({ pressed }) => ({
                backgroundColor: t.accent,
                borderRadius: t.radiusS,
                paddingVertical: 10,
                alignItems: 'center',
                opacity: pressed || busy ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.accentInk }}>
                {busy
                  ? i18nT('chat.joinRequestAdding', 'Adding…')
                  : i18nT('chat.joinRequestAdd', 'Add to group')}
              </Text>
            </Pressable>
          ) : (
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim }}>
              {group
                ? i18nT('chat.joinRequestNotAdmin', 'Only the group admin can approve this request')
                : i18nT('chat.joinRequestUnknownGroup', 'Group not available on this device')}
            </Text>
          )}
        </View>
      </View>
      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 3, paddingHorizontal: 4 }}>
        {time}
      </Text>
    </View>
  );
}

interface BubbleProps {
  t: Theme;
  m: StoredMessage;
  online: boolean;
  quotedMsg?: StoredMessage;
  onLongPress: () => void;
  onViewOnce?: (mediaUri: string, messageId: string) => void;
  onImagePress?: (images: string[], index: number) => void;
}

export function Bubble({ t, m, online, quotedMsg, onLongPress, onViewOnce, onImagePress }: BubbleProps) {
  const { t: i18nT } = useTranslation();
  const me = m.direction === 'out';
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const queued = me && !online;
  const loc = !m.deleted ? parseLocationMessage(m.body) : null;
  const reactions = m.reactions ? Object.entries(m.reactions).filter(([, ids]) => ids.length > 0) : [];

  if (m.deleted) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <View
          style={{
            backgroundColor: t.surface2,
            paddingHorizontal: 13,
            paddingVertical: 8,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <I.Trash size={13} color={t.textFaint} />
          <Text style={{ color: t.textFaint, fontFamily: t.font, fontSize: 13, fontStyle: 'italic' }}>
            {i18nT('chat.deletedMessage')}
          </Text>
        </View>
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  if (loc) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          onPress={() => {
            if (loc.latitude && loc.longitude) {
              const url = `https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`;
              Linking.openURL(url).catch(() => {});
            }
          }}
          style={({ pressed }) => ({
            width: 250,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            backgroundColor: t.surface2,
            borderWidth: 1,
            borderColor: t.border,
            overflow: 'hidden',
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
            elevation: 2,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.1,
            shadowRadius: 2,
          })}
        >
          <View
            style={{
              height: 110,
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Map mock mirrors ScreenLocation (screens-phase2.jsx): gradient
                base, 32px grid, faint roads and the accent pin with the Shield
                mark — kept faithful to the original prototype. */}
            <Svg viewBox="0 0 250 110" width="100%" height="100%" style={{ position: 'absolute' }}>
              <Defs>
                <LinearGradient id="locMapBg" x1="0" y1="0" x2="1" y2="1">
                  {(t.dark ? ['#1a2326', '#243033'] : ['#e8e5dc', '#d8d4c6']).map((c, i) => (
                    <Stop key={i} offset={i} stopColor={c} />
                  ))}
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width="250" height="110" fill="url(#locMapBg)" />
              {[28, 56, 84, 112, 140, 168, 196, 224].map((x) => (
                <Path key={`v${x}`} d={`M${x} 0 L${x} 110`} stroke={t.borderStrong} strokeWidth={1} opacity={0.25} />
              ))}
              {[28, 56, 84].map((y) => (
                <Path key={`h${y}`} d={`M0 ${y} L250 ${y}`} stroke={t.borderStrong} strokeWidth={1} opacity={0.25} />
              ))}
              <Path d="M0 44 Q125 33 250 55" stroke={t.borderStrong} strokeWidth={4} fill="none" opacity={0.5} />
              <Path d="M107 0 L143 110" stroke={t.borderStrong} strokeWidth={4} fill="none" opacity={0.5} />
              <Path d="M0 83 L250 77" stroke={t.borderStrong} strokeWidth={2} fill="none" opacity={0.4} />
            </Svg>
            {/* accent halo behind the pin (the prototype's pulse, static here) */}
            <View style={{ position: 'absolute', width: 64, height: 64, borderRadius: 32, backgroundColor: `${t.accent}22` }} />
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: t.accent,
                borderWidth: 3,
                borderColor: t.bg,
                alignItems: 'center',
                justifyContent: 'center',
                shadowColor: t.accent,
                shadowOffset: { width: 0, height: 3 },
                shadowOpacity: 0.4,
                shadowRadius: 6,
                elevation: 3,
              }}
            >
              <I.Shield size={16} color={t.accentInk} />
            </View>
          </View>
          <View style={{ padding: 10, backgroundColor: t.surface }}>
            <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text, marginBottom: 2 }}>
              {loc.address}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim }}>
              📍 {i18nT('chat.locationShared')} {loc.precision} · {loc.duration}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: t.divider }}>
              <I.Globe size={11} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, fontWeight: '600', color: t.accent, letterSpacing: 0.3 }}>
                {i18nT('chat.openMaps')}
              </Text>
            </View>
          </View>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Multi-attachment bubble
  if (m.attachments && m.attachments.length > 0) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start', opacity: queued ? 0.55 : 1 }}>
        <Pressable onLongPress={onLongPress} accessibilityLabel="Attachment message">
          <AttachmentGrid
            attachments={m.attachments}
            isMe={me}
            caption={m.body || undefined}
            onImagePress={(uri, index) => {
              const imageUris = (m.attachments ?? [])
                .filter((a) => a.type === 'image' || a.type === 'video')
                .map((a) => a.uri);
              onImagePress?.(imageUris, index);
            }}
            onFilePress={(att) => {
              if (att.uri) void Linking.openURL(att.uri).catch(() => {});
            }}
          />
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Video bubble
  if (m.type === 'video') {
    return <VideoBubble t={t} m={m} me={me} queued={queued} time={time} onLongPress={onLongPress} caption={m.body ?? undefined} />;
  }

  // Audio bubble
  if (m.type === 'audio' && m.mediaUri) {
    return <AudioBubble t={t} m={m} me={me} queued={queued} time={time} reactions={reactions} onLongPress={onLongPress} />;
  }

  // File bubble
  if (m.type === 'file') {
    const fileName = m.body || 'archivo';
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            maxWidth: '80%',
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            paddingHorizontal: 13,
            paddingVertical: 10,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
          })}
        >
          <I.Attach size={20} color={me ? t.bubbleOutText : t.bubbleInText} />
          <Text numberOfLines={2} style={{ flex: 1, color: me ? t.bubbleOutText : t.bubbleInText, fontFamily: t.font, fontSize: 14 }}>
            {fileName}
          </Text>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // View-once bubble (image or audio)
  if (m.body === '[viewonce]' || (m.body && m.body.startsWith('[viewonce:'))) {
    const hasMedia = !!m.mediaUri;
    const isReceived = m.direction === 'in';
    const isAudio = m.body.startsWith('[viewonce:audio:');
    // Parse duration from body "[viewonce:audio:NNs]"
    const audioDurSec = isAudio
      ? parseInt(m.body.match(/\[viewonce:audio:(\d+)s/)?.[1] ?? '0', 10)
      : 0;

    // Ephemeral audio gets its own playable bubble — the generic view-once
    // Pressable below only opens the image viewer and had no audio handler,
    // which left received ephemeral audio impossible to play.
    if (isAudio) {
      return (
        <ViewOnceAudioBubble
          t={t}
          m={m}
          me={me}
          isReceived={isReceived}
          durSec={audioDurSec}
          queued={queued}
          time={time}
          onLongPress={onLongPress}
        />
      );
    }

    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          onPress={() => { if (!isAudio && hasMedia && m.mediaUri && onViewOnce) onViewOnce(m.mediaUri, m.id); }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            borderWidth: 1,
            borderColor: `${t.accent}44`,
            opacity: pressed ? 0.85 : 1,
            maxWidth: 240,
          })}
        >
          {isAudio
            ? <I.Mic size={22} color={me ? t.bubbleOutText : t.accent} stroke={1.6} />
            : <I.EyeOff size={22} color={me ? t.bubbleOutText : t.accent} stroke={1.6} />}
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: me ? t.bubbleOutText : t.text }}>
              {isAudio
                ? (isReceived ? 'Audio efímero' : 'Audio enviado')
                : (isReceived ? i18nT('chat.viewOnceReceived') : i18nT('chat.viewOnceSent'))}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.accent, letterSpacing: 0.5, marginTop: 2 }}>
              {isAudio
                ? (audioDurSec > 0 ? `${audioDurSec}s · escuchar una vez` : 'escuchar una vez')
                : (isReceived ? (hasMedia ? i18nT('chat.viewOnceTap') : i18nT('chat.viewOnceSeen')) : i18nT('chat.viewOnceSentLabel'))}
            </Text>
          </View>
        </Pressable>
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Image bubble
  if (m.type === 'image' && m.mediaUri) {
    const bubbleBg = me ? t.bubbleOut : t.bubbleIn;
    const textColor = me ? t.bubbleOutText : t.bubbleInText;
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onPress={() => onImagePress?.([m.mediaUri!], 0)}
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            width: 220,
            backgroundColor: bubbleBg,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            overflow: 'hidden',
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
          })}
        >
          <MediaImage
            uri={m.mediaUri}
            accent={t.accent}
            style={{ width: 220, height: 180, backgroundColor: t.surface2 }}
          />
          {m.body ? (
            <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 }}>
              <FormattedText
                body={m.body}
                t={t}
                onAccent={me}
                style={{
                  color: textColor,
                  fontFamily: t.font,
                  fontSize: 14,
                  lineHeight: 18,
                }}
              />
            </View>
          ) : null}
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Call event bubble
  if (m.body?.startsWith('[call:')) {
    const parts = m.body.slice(1, -1).split(':');
    const callStatus = parts[1] ?? 'missed';
    const callMedia = parts[2] ?? 'audio';
    const callDuration = parts[3] ?? '0s';
    const isMissed = callStatus === 'missed' || callStatus === 'declined';
    const wasOutgoing = m.direction === 'out';

    // Direction-aware label: differentiate "you called" vs "they called"
    // so outgoing unanswered calls show "Sin respuesta" instead of "Llamada perdida".
    const statusLabel = (() => {
      if (wasOutgoing) {
        if (callStatus === 'missed') return i18nT('chat.callNoAnswer', 'Sin respuesta');
        if (callStatus === 'declined') return i18nT('chat.callDeclinedByThem', 'Llamada rechazada');
        return callMedia === 'video' ? i18nT('chat.videoCallMade', 'Videollamada') : i18nT('chat.voiceCallMade', 'Llamada de voz');
      } else {
        if (callStatus === 'missed') return i18nT('chat.missedCall', 'Llamada perdida');
        if (callStatus === 'declined') return i18nT('chat.declinedCall', 'Llamada rechazada');
        return callMedia === 'video' ? i18nT('chat.videoCall', 'Videollamada') : i18nT('chat.voiceCall', 'Llamada de voz');
      }
    })();

    // Only highlight in warn color for incoming missed calls — those are the
    // most actionable (you missed something). Outgoing unanswered calls use
    // a dimmer treatment since you were the initiator.
    const showAsAlert = isMissed && !wasOutgoing;

    const CallIcon = callMedia === 'video' ? I.Video : I.Phone;
    return (
      <View style={{ alignItems: 'center', marginVertical: 4 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: t.surface2,
            paddingHorizontal: 14,
            paddingVertical: 9,
            borderRadius: 99,
            borderWidth: 1,
            borderColor: showAsAlert ? `${t.warn}55` : t.border,
          }}
        >
          <CallIcon size={14} color={showAsAlert ? t.warn : (wasOutgoing ? t.textDim : t.accent)} />
          <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: showAsAlert ? t.warn : t.text }}>
            {statusLabel}
          </Text>
          {!isMissed && callDuration !== '0s' && (
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>
              · {callDuration}
            </Text>
          )}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</Text>
        </View>
      </View>
    );
  }

  // Group join-request card — [join_request:<groupId>:<groupName>]
  if (m.body?.startsWith('[join_request:') && m.body.endsWith(']')) {
    return <JoinRequestBubble t={t} m={m} me={me} time={time} />;
  }

  // Contact card bubble
  const contactMatch = m.body?.match(/^\[contact:([^:]+):([^\]]+)\]$/);
  if (contactMatch) {
    const cardName = contactMatch[1];
    const cardAegisId = contactMatch[2];
    const shortId = cardAegisId.length > 20 ? `${cardAegisId.slice(0, 10)}…${cardAegisId.slice(-6)}` : cardAegisId;
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            width: 240,
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            overflow: 'hidden',
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
            borderWidth: 1,
            borderColor: `${t.accent}33`,
          })}
        >
          {/* Header strip */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
            <View style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: `${t.accent}22`,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <I.Users size={20} color={t.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: me ? t.bubbleOutText : t.text }}>
                {cardName}
              </Text>
              <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.3, marginTop: 1 }}>
                {shortId}
              </Text>
            </View>
          </View>
          {/* Divider + action */}
          <View style={{ borderTopWidth: 1, borderTopColor: me ? 'rgba(255,255,255,0.12)' : t.divider }}>
            <Pressable
              onPress={async () => {
                try {
                  await useContacts.getState().addByAegisId(cardAegisId);
                  themedAlert(i18nT('chat.contactAdded', 'Contacto añadido'), cardName);
                } catch {
                  // Fallback: copy ID to clipboard
                  const Clipboard = require('expo-clipboard');
                  await Clipboard.setStringAsync(cardAegisId).catch(() => {});
                  themedAlert(i18nT('chat.contactAddFailed', 'No se pudo añadir'), i18nT('chat.idCopied', 'ID copiado al portapapeles'));
                }
              }}
              style={({ pressed }) => ({
                paddingVertical: 9,
                alignItems: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '600', color: t.accent, letterSpacing: 0.5 }}>
                {i18nT('chat.addContact')}
              </Text>
            </Pressable>
          </View>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Vault sticker bubble — [sticker:vault_<key>]
  const stickerMatch = m.body?.match(/^\[sticker:(vault_\w+)\]$/);
  if (stickerMatch) {
    const { VaultSticker } = require('../../components/stickers/VaultPack') as typeof import('../../components/stickers/VaultPack');
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            width: 130,
            height: 130,
            borderRadius: t.radius,
            overflow: 'hidden',
            backgroundColor: '#0d1311',
            borderWidth: 1,
            borderColor: pressed ? 'rgba(91,242,185,0.35)' : t.border,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: queued ? 0.55 : 1,
          })}
        >
          <VaultSticker stickerKey={stickerMatch[1]} size={120} />
        </Pressable>
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // GIF bubble — legacy format [gif:url] kept for historical messages only.
  // New GIFs are sent as [image:...] after being downloaded and encrypted.
  // DO NOT load from the remote URL here — that would reveal IP to Giphy.
  const gifMatch = m.body?.match(/^\[gif:(.+)\]$/);
  if (gifMatch) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            borderWidth: 1,
            borderColor: `${t.border}`,
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
            maxWidth: 260,
          })}
        >
          <I.Globe size={18} color={t.textDim} />
          <Text style={{ flex: 1, fontFamily: t.font, fontSize: 13, color: me ? t.bubbleOutText : t.textDim, fontStyle: 'italic' }}>
            GIF (formato legacy)
          </Text>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Text bubble — extract first URL to show link preview card
  const urlMatch = /\bhttps?:\/\/[^\s<>"')\]]+/.exec(m.body ?? '');
  const previewUrl = urlMatch?.[0] ?? null;

  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
      <Pressable
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          maxWidth: '80%',
          backgroundColor: me ? t.bubbleOut : t.bubbleIn,
          paddingHorizontal: 13,
          paddingTop: quotedMsg ? 8 : 10,
          paddingBottom: 10,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          opacity: queued ? 0.55 : pressed ? 0.9 : 1,
        })}
      >
        {/* Quote banner */}
        {quotedMsg ? (
          <View
            style={{
              borderLeftWidth: 3,
              borderLeftColor: t.accent,
              paddingLeft: 8,
              marginBottom: 8,
              opacity: 0.8,
            }}
          >
            <Text numberOfLines={2} style={{ fontFamily: t.font, fontSize: 12, color: me ? t.bubbleOutText : t.bubbleInText, lineHeight: 16 }}>
              {quotedMsg.deleted
                ? i18nT('chat.deletedMessage')
                : quotedMsg.type === 'image'
                ? '📷 Imagen'
                : quotedMsg.body}
            </Text>
          </View>
        ) : null}
        <FormattedText
          body={m.body}
          t={t}
          onAccent={me}
          style={{ color: me ? t.bubbleOutText : t.bubbleInText, fontFamily: t.font, fontSize: 15, lineHeight: 20 }}
        />
        {/* Open Graph link preview card */}
        {previewUrl ? <LinkPreview url={previewUrl} t={t} /> : null}
      </Pressable>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
    </View>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ReactionPills({ t, reactions, me }: { t: Theme; reactions: [string, string[]][]; me: boolean }) {
  if (reactions.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: me ? 'flex-end' : 'flex-start' }}>
      {reactions.map(([emoji, ids]) => (
        <View
          key={emoji}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 3,
            backgroundColor: t.surface2,
            borderRadius: 99,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <Text style={{ fontSize: 13 }}>{emoji}</Text>
          {ids.length > 1 ? (
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{ids.length}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function TimestampRow({
  t, queued, time, starred, deliveryStatus,
}: {
  t: Theme;
  queued: boolean;
  time: string;
  starred?: boolean;
  deliveryStatus?: 'sent' | 'delivered' | 'read';
}) {
  const { t: i18nT } = useTranslation();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, marginTop: 3 }}>
      {starred ? <I.Star size={9} color={t.accent} /> : null}
      {queued ? (
        <>
          <I.Timer size={10} color={t.warn} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, color: t.warn, letterSpacing: 0.4 }}>
            {i18nT('chat.queued')}
          </Text>
        </>
      ) : (
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</Text>
      )}
      {!queued && deliveryStatus ? (
        deliveryStatus === 'delivered' || deliveryStatus === 'read' ? (
          <I.CheckCheck size={13} color={deliveryStatus === 'read' ? t.accent : t.textFaint} />
        ) : (
          <I.Check size={13} color={t.textFaint} />
        )
      ) : null}
    </View>
  );
}

const PLAYBACK_RATES: number[] = [1.0, 1.5, 2.0, 0.5];

function AudioBubble({
  t, m, me, queued, time, reactions, onLongPress,
}: {
  t: Theme;
  m: StoredMessage;
  me: boolean;
  queued: boolean;
  time: string;
  reactions: [string, string[]][];
  onLongPress: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  type AudioSound = import('expo-av').Audio.Sound;
  type AVPlaybackStatus = import('expo-av').AVPlaybackStatus;
  const soundRef = useRef<AudioSound | null>(null);

  useEffect(() => {
    return () => {
      void soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  // Parse duration from body "[audio:30s]"
  const durSec = parseInt(m.body.match(/\[audio:(\d+)s/)?.[1] ?? '0', 10);
  const durMs = durSec * 1000;

  async function togglePlay() {
    if (!m.mediaUri) return;
    if (playing) {
      await soundRef.current?.stopAsync().catch(() => {});
      await soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
      setPosMs(0);
      setPlaying(false);
      return;
    }
    try {
      const { Audio } = require('expo-av');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: m.mediaUri },
        { shouldPlay: true, rate: playbackRate, shouldCorrectPitch: true },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded) return;
          setPosMs(status.positionMillis ?? 0);
          if (status.didJustFinish) {
            setPlaying(false);
            setPosMs(0);
            soundRef.current = null;
          }
        }
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch { setPlaying(false); }
  }

  async function cycleRate() {
    const currentIndex = PLAYBACK_RATES.indexOf(playbackRate);
    const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(nextRate);
    if (soundRef.current) {
      try {
        await soundRef.current.setRateAsync(nextRate, true);
      } catch { /* ignore */ }
    }
  }

  async function handleSeek(seekMs: number) {
    if (!soundRef.current) return;
    try {
      await soundRef.current.setPositionAsync(seekMs);
      setPosMs(seekMs);
    } catch { /* ignore */ }
  }

  const elapsed = Math.floor(posMs / 1000);
  const display = playing
    ? `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
    : `${String(Math.floor(durSec / 60)).padStart(2, '0')}:${String(durSec % 60).padStart(2, '0')}`;

  const rateLabel = playbackRate === 1.0 ? '1×' : `${playbackRate}×`;

  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
      <Pressable
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          width: 240,
          backgroundColor: me ? t.bubbleOut : t.bubbleIn,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          opacity: queued ? 0.55 : pressed ? 0.9 : 1,
        })}
      >
        <Pressable onPress={togglePlay} style={{
          width: 36, height: 36, borderRadius: 18,
          backgroundColor: me ? 'rgba(255,255,255,0.2)' : t.surface3,
          alignItems: 'center', justifyContent: 'center',
        }}>
          {playing
            ? <I.Pause size={16} color={me ? t.bubbleOutText : t.bubbleInText} />
            : <I.Play size={16} color={me ? t.bubbleOutText : t.bubbleInText} />
          }
        </Pressable>
        <View style={{ flex: 1, gap: 5 }}>
          <AudioWaveform
            durMs={durMs}
            posMs={posMs}
            width={148}
            maxBarHeight={24}
            onSeek={handleSeek}
            t={t}
            isMe={me}
          />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.textDim }}>
            {display}
          </Text>
        </View>
        <Pressable
          onPress={cycleRate}
          accessibilityLabel={`Playback speed ${rateLabel}`}
          hitSlop={8}
          style={{
            paddingHorizontal: 5,
            paddingVertical: 3,
            borderRadius: 4,
            backgroundColor: me ? 'rgba(255,255,255,0.15)' : t.surface3,
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 28,
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.textDim, fontWeight: '700' }}>
            {rateLabel}
          </Text>
        </Pressable>
        <I.Mic size={14} color={me ? t.bubbleOutText : t.textDim} />
      </Pressable>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
    </View>
  );
}

