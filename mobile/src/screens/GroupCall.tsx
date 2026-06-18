import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useGroupCall } from '../store/groupCall';
import { useContacts } from '../store/contacts';
import { hangupGroupCall, toggleGroupCallMute } from '../socket/groupCalls';

interface Props {
  onClose: () => void;
}

export function GroupCallScreen({ onClose }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  const status = useGroupCall((s) => s.status);
  const groupName = useGroupCall((s) => s.groupName);
  const participants = useGroupCall((s) => s.participants);
  const muted = useGroupCall((s) => s.muted);
  const startedAt = useGroupCall((s) => s.startedAt);
  const contacts = useContacts((s) => s.contacts);

  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Proximity sensor + screen-off near the ear is handled at the audio-session
  // level by InCallManager (see webrtc/inCall.ts), started in the group-call
  // lifecycle — so it keeps working even when this screen is unmounted/backgrounded.

  // Auto-close when call ends (reset to idle)
  useEffect(() => {
    if (status === 'idle') onClose();
  }, [status, onClose]);

  // Elapsed timer — starts once in-call
  useEffect(() => {
    if (status === 'in-call' && startedAt) {
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [status, startedAt]);

  function formatElapsed(s: number): string {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function statusLabel(): string {
    switch (status) {
      case 'ringing-out': return i18nT('groupCall.calling', 'Llamando…');
      case 'connecting': return i18nT('groupCall.connecting', 'Conectando…');
      case 'in-call': return formatElapsed(elapsed);
      case 'ended': return i18nT('groupCall.ended', 'Llamada finalizada');
      default: return '';
    }
  }

  function handleHangup() {
    hangupGroupCall();
  }

  function handleMute() {
    toggleGroupCallMute();
  }

  // Resolve display name from contacts
  function nameForId(aegisId: string): string {
    return contacts.find((c) => c.aegisId === aegisId)?.name ?? aegisId.substring(0, 8);
  }

  function colorForId(aegisId: string): string {
    return contacts.find((c) => c.aegisId === aegisId)?.color ?? t.accent;
  }

  return (
    <View style={[styles.container, { backgroundColor: '#000', paddingTop: insets.top }]}>
      {/* Background glow */}
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        <View
          style={{
            position: 'absolute',
            top: -100,
            left: -100,
            right: -100,
            height: 400,
            borderRadius: 9999,
            backgroundColor: t.accent,
            opacity: 0.06,
          }}
        />
      </View>

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.encryptedBadge}>
          <I.Lock size={10} color={t.accent} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1 }}>
            {i18nT('groupCall.e2ee', 'E2EE · MESH').toUpperCase()}
          </Text>
        </View>
        <Text style={[styles.groupName, { fontFamily: t.font, color: '#fff' }]} numberOfLines={1}>
          {groupName ?? i18nT('groupCall.groupCall', 'Llamada grupal')}
        </Text>
        <Text style={[styles.statusText, { fontFamily: t.fontMono, color: 'rgba(255,255,255,0.6)' }]}>
          {statusLabel()}
        </Text>
      </View>

      {/* Participants grid */}
      {participants.length === 0 ? (
        <View style={styles.emptyState}>
          <I.Users size={40} color={t.accent} />
          <Text style={{ fontFamily: t.font, fontSize: 14, color: 'rgba(255,255,255,0.5)', marginTop: 12, textAlign: 'center' }}>
            {i18nT('groupCall.waitingForParticipants', 'Esperando participantes…')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={participants}
          keyExtractor={(item) => item.aegisId}
          numColumns={2}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={{ gap: 12 }}
          renderItem={({ item }) => (
            <ParticipantTile
              aegisId={item.aegisId}
              name={nameForId(item.aegisId)}
              color={colorForId(item.aegisId)}
              connected={item.connected}
              muted={item.muted}
              t={t}
            />
          )}
          removeClippedSubviews
          maxToRenderPerBatch={8}
        />
      )}

      {/* Controls */}
      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, 28) }]}>
        {/* Mute */}
        <ControlBtn
          onPress={handleMute}
          color={muted ? t.danger : 'rgba(255,255,255,0.12)'}
          icon={muted
            ? <I.MicOff size={24} color="#fff" />
            : <I.Mic size={24} color="#fff" />
          }
          label={muted
            ? i18nT('call.unmute', 'ACTIVAR').toUpperCase()
            : i18nT('call.mute', 'SILENCIAR').toUpperCase()
          }
          accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
        />

        {/* Speaker placeholder (audio routing) */}
        <ControlBtn
          onPress={() => { /* TODO: toggle speaker */ }}
          color="rgba(255,255,255,0.12)"
          icon={<I.Volume size={24} color="#fff" />}
          label={i18nT('call.speaker', 'ALTAVOZ').toUpperCase()}
          accessibilityLabel="Toggle speaker"
        />

        {/* Hangup */}
        <ControlBtn
          onPress={handleHangup}
          color={t.danger}
          icon={<I.Phone size={28} color="#fff" />}
          label={i18nT('call.hangup', 'COLGAR').toUpperCase()}
          rotate
          accessibilityLabel="Hang up group call"
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Participant tile
// ---------------------------------------------------------------------------

interface TileProps {
  aegisId: string;
  name: string;
  color: string;
  connected: boolean;
  muted: boolean;
  t: import('../theme/vault').Theme;
}

function ParticipantTile({ name, color, connected, muted, t }: TileProps) {
  const initial = name.trim()[0]?.toUpperCase() ?? '?';

  return (
    <View
      style={[
        styles.tile,
        {
          backgroundColor: '#0d1311',
          borderColor: connected ? t.accent : 'rgba(255,255,255,0.1)',
        },
      ]}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 22, color: '#fff' }}>
          {initial}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        style={{ fontFamily: t.font, fontSize: 12, color: '#fff', marginTop: 8, maxWidth: 100 }}
      >
        {name}
      </Text>

      <View style={styles.tileStatusRow}>
        {connected ? (
          <View style={styles.connectedDot} />
        ) : (
          <View style={styles.connectingDot} />
        )}
        {muted && <I.MicOff size={11} color="rgba(255,255,255,0.5)" />}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Control button
// ---------------------------------------------------------------------------

interface ControlBtnProps {
  onPress: () => void;
  color: string;
  icon: React.ReactNode;
  label: string;
  rotate?: boolean;
  accessibilityLabel: string;
}

function ControlBtn({ onPress, color, icon, label, rotate, accessibilityLabel }: ControlBtnProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({ alignItems: 'center', gap: 8, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: color,
          alignItems: 'center',
          justifyContent: 'center',
          transform: rotate ? [{ rotate: '135deg' }] : undefined,
        }}
      >
        {icon}
      </View>
      <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 9, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { alignItems: 'center', paddingTop: 20, paddingBottom: 16, paddingHorizontal: 24 },
  encryptedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 99,
    marginBottom: 14,
  },
  groupName: { fontSize: 24, fontWeight: '600', letterSpacing: -0.4, marginBottom: 6 },
  statusText: { fontSize: 12, letterSpacing: 0.5 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  grid: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 12,
  },
  tile: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  tileStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  connectedDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#00FF88' },
  connectingDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: 'rgba(255,255,255,0.3)' },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
});
