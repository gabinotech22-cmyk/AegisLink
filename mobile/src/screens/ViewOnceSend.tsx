import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, Pressable, Image, TextInput, ActivityIndicator, PanResponder, Dimensions, Modal, ScrollView, Platform } from 'react-native';
import Svg, { Path as SvgPath } from 'react-native-svg';
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat, FlipType } from 'expo-image-manipulator';
import { captureRef } from 'react-native-view-shot';
import { decodeBase64 } from 'tweetnacl-util';
import { randomUUID } from 'expo-crypto';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import { useIdentity } from '../store/identity';
import { withPickingGuard } from '../utils/pickingGuard';
// Shared process-wide recorder singleton — also used by VoiceRecorder so either
// screen can release a recorder orphaned by the other (see audioRecorder.ts).
import { acquireRecording, releaseActiveRecording, setActiveRecording } from '../utils/audioRecorder';
import { useMessages } from '../store/messages';
import { sendMessage } from '../socket/client';
import type { StoredContact } from '../db/local';
import { themedAlert } from '../components/AlertHost';

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  contact: StoredContact;
  onBack: () => void;
  onSent: () => void;
}

type ScreenMode = 'select' | 'edit' | 'confirm' | 'audio';
type DrawTool = 'draw' | 'text' | 'erase' | null;

interface DrawPath {
  id: string;
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

interface TextOverlay {
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PALETTE = [
  '#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00',
  '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de',
  '#ff2d55', '#a2845e',
];
const BRUSH_SIZES = [3, 6, 10, 16];

const { width: SCREEN_W } = Dimensions.get('window');

function pointsToD(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ViewOnceSendScreen({ contact, onBack, onSent }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const appendMsg = useMessages((s) => s.append);

  const [mode, setMode] = useState<ScreenMode>('select');
  const [sending, setSending] = useState(false);

  // ── Image editor state ──────────────────────────────────────────────────────
  const [editUri, setEditUri] = useState<string | null>(null);
  const [confirmedUri, setConfirmedUri] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [processing, setProcessing] = useState(false);
  const [tool, setTool] = useState<DrawTool>(null);
  const [drawColor, setDrawColor] = useState('#ffffff');
  const [brushIdx, setBrushIdx] = useState(1);
  const [paths, setPaths] = useState<DrawPath[]>([]);
  const [textItems, setTextItems] = useState<TextOverlay[]>([]);
  const [showTextModal, setShowTextModal] = useState(false);
  const [pendingTextPos, setPendingTextPos] = useState<{ x: number; y: number } | null>(null);
  const [textInput, setTextInput] = useState('');
  const editRef = useRef<View>(null);
  const currentPts = useRef<{ x: number; y: number }[]>([]);
  const [livePathKey, setLivePathKey] = useState(0);

  // ── Audio recorder state ────────────────────────────────────────────────────
  const [audioStage, setAudioStage] = useState<'idle' | 'recording' | 'recorded' | 'playing'>('idle');
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playbackMs, setPlaybackMs] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [audioBars] = useState(() =>
    Array.from({ length: 32 }, () => 0.15 + Math.random() * 0.85),
  );

  useEffect(() => {
    return () => {
      clearInterval(intervalRef.current ?? undefined);
      recordingRef.current = null;
      // Release via the shared singleton so an in-flight recording is torn down
      // even though this instance's ref is about to be discarded.
      void releaseActiveRecording();
      void soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  // ── Image pick ──────────────────────────────────────────────────────────────

  async function handlePickImage() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { themedAlert(i18nT('viewOnce.permissionTitle'), i18nT('viewOnce.permissionMessage')); return; }
      const result = await withPickingGuard(() =>
        ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 0.9,
          allowsEditing: false,
          exif: false,
        })
      );
      if (result.canceled || !result.assets?.[0]) return;
      setProcessing(true);
      try {
        const compressed = await manipulateAsync(
          result.assets[0].uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.88, format: SaveFormat.JPEG }
        );
        setPaths([]);
        setTextItems([]);
        setCaption('');
        setTool(null);
        setEditUri(compressed.uri);
        setMode('edit');
      } catch {
        themedAlert(i18nT('common.error'), i18nT('viewOnce.processError'));
      } finally {
        setProcessing(false);
      }
    } catch (e) {
      themedAlert(i18nT('common.error'), i18nT('viewOnce.galleryError', { message: (e as Error).message }));
    }
  }

  // ── Ephemeral video pick + send ──────────────────────────────────────────────
  // Videos skip the drawing editor: pick → encrypt-inline → send. The recipient
  // already decodes "[viewonce:data:video/mp4;base64,…]" (see socket/client.ts)
  // and the viewer plays it once before wiping it.
  async function handlePickVideo() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { themedAlert(i18nT('viewOnce.permissionTitle'), i18nT('viewOnce.permissionMessage')); return; }
      const result = await withPickingGuard(() =>
        ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['videos'] as ImagePicker.MediaType[],
          quality: 0.7,
          videoMaxDuration: 30,
          allowsEditing: false,
        })
      );
      if (result.canceled || !result.assets?.[0] || !identity) return;
      const uri = result.assets[0].uri;
      setProcessing(true);
      try {
        const id = randomUUID();
        await appendMsg({
          id,
          chatId: contact.aegisId,
          direction: 'out',
          body: '[viewonce:video]',
          createdAt: Date.now(),
          type: 'view_once',
          mediaUri: uri,
        });
        try {
          const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
          const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
          await sendMessage({
            identity,
            recipientAegisId: contact.aegisId,
            recipientPublicKey: decodeBase64(contact.publicKeyB64),
            plaintext: `[viewonce:data:video/mp4;base64,${base64}]`,
            skipLocalAppend: true,
          });
        } catch {
          // queued offline — bubble already shows
        }
        onSent();
      } catch {
        themedAlert(i18nT('common.error'), i18nT('viewOnce.processError'));
      } finally {
        setProcessing(false);
      }
    } catch (e) {
      themedAlert(i18nT('common.error'), i18nT('viewOnce.galleryError', { message: (e as Error).message }));
    }
  }

  // ── Editor tools ─────────────────────────────────────────────────────────

  async function rotateImage() {
    if (!editUri) return;
    setProcessing(true);
    try {
      const res = await manipulateAsync(editUri, [{ rotate: 90 }], { compress: 0.9, format: SaveFormat.JPEG });
      setEditUri(res.uri);
      setPaths([]);
      setTextItems([]);
    } finally {
      setProcessing(false);
    }
  }

  async function flipImage() {
    if (!editUri) return;
    setProcessing(true);
    try {
      const res = await manipulateAsync(editUri, [{ flip: FlipType.Horizontal }], { compress: 0.9, format: SaveFormat.JPEG });
      setEditUri(res.uri);
      setPaths([]);
      setTextItems([]);
    } finally {
      setProcessing(false);
    }
  }

  function undoLast() {
    if (paths.length > 0) {
      setPaths((p) => p.slice(0, -1));
    } else if (textItems.length > 0) {
      setTextItems((ti) => ti.slice(0, -1));
    }
  }

  function clearAll() {
    setPaths([]);
    setTextItems([]);
  }

  // PanResponder for drawing
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        if (tool === 'text') {
          setPendingTextPos({ x: locationX, y: locationY });
          setTextInput('');
          setShowTextModal(true);
          return;
        }
        if (tool === 'draw') {
          currentPts.current = [{ x: locationX, y: locationY }];
          setLivePathKey((k) => k + 1);
        }
      },
      onPanResponderMove: (e) => {
        if (tool !== 'draw') return;
        const { locationX, locationY } = e.nativeEvent;
        currentPts.current = [...currentPts.current, { x: locationX, y: locationY }];
        setLivePathKey((k) => k + 1);
      },
      onPanResponderRelease: () => {
        if (tool !== 'draw' || currentPts.current.length < 2) {
          currentPts.current = [];
          return;
        }
        const brushSize = BRUSH_SIZES[brushIdx];
        setPaths((prev) => [
          ...prev,
          { id: randomUUID(), points: [...currentPts.current], color: drawColor, width: brushSize },
        ]);
        currentPts.current = [];
        setLivePathKey((k) => k + 1);
      },
    })
  ).current;

  function addTextOverlay() {
    if (!textInput.trim() || !pendingTextPos) return;
    setTextItems((ti) => [
      ...ti,
      {
        id: randomUUID(),
        text: textInput.trim(),
        x: pendingTextPos.x - 60,
        y: pendingTextPos.y - 12,
        color: drawColor,
        fontSize: 22,
      },
    ]);
    setShowTextModal(false);
    setTextInput('');
    setPendingTextPos(null);
  }

  // ── Capture and confirm ──────────────────────────────────────────────────

  async function handleEditorDone() {
    setProcessing(true);
    try {
      // Fast path: if the user added no drawings or text overlays, there is
      // nothing to flatten — use the already-processed image directly and skip
      // react-native-view-shot's captureRef entirely. captureRef snapshots a
      // rendered GPU surface and fails on devices/emulators without hardware
      // surface capture (e.g. software-rendered emulators), which previously
      // produced a hard "Could not process the image securely" error.
      const hasAnnotations = paths.length > 0 || textItems.length > 0;
      if (!hasAnnotations || !editRef.current) {
        if (editUri) {
          setConfirmedUri(editUri);
          setMode('confirm');
          return;
        }
        themedAlert(i18nT('common.error'), i18nT('viewOnce.processError'));
        return;
      }
      try {
        const captured = await captureRef(editRef, { format: 'jpg', quality: 0.85 });
        setConfirmedUri(captured);
        setMode('confirm');
      } catch {
        // Surface capture unavailable — fall back to the un-annotated base
        // image so a view-once can still be sent rather than blocking the user.
        if (editUri) {
          setConfirmedUri(editUri);
          setMode('confirm');
        } else {
          themedAlert(i18nT('common.error'), i18nT('viewOnce.processError'));
        }
      }
    } finally {
      setProcessing(false);
    }
  }

  // ── Send image ──────────────────────────────────────────────────────────────

  async function handleSendImage() {
    if (!confirmedUri || !identity || sending) return;
    setSending(true);
    try {
      const id = randomUUID();
      await appendMsg({
        id,
        chatId: contact.aegisId,
        direction: 'out',
        body: caption ? `[viewonce]\n${caption}` : '[viewonce]',
        createdAt: Date.now(),
        type: 'image',
        mediaUri: confirmedUri,
      });
      try {
        const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
        const base64 = await FileSystem.readAsStringAsync(confirmedUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const captionPart = caption ? `|${caption}` : '';
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: `[viewonce:data:image/jpeg;base64,${base64}${captionPart}]`,
          skipLocalAppend: true,
        });
      } catch {
        // queued offline — bubble already shows
      }
      onSent();
    } catch (e) {
      setSending(false);
      themedAlert(i18nT('common.error'), (e as Error).message);
    }
  }

  // ── Audio recording ─────────────────────────────────────────────────────────

  async function startAudioRecording() {
    // Release any recorder orphaned by a previous attempt OR by VoiceRecorder
    // (the inline composer mic) before preparing a new one — otherwise expo-av
    // throws "Only one Recording object can be prepared at a given time."
    try { await recordingRef.current?.stopAndUnloadAsync(); } catch { /* ignore */ }
    recordingRef.current = null;
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { themedAlert(i18nT('voiceRecorder.permissionTitle'), i18nT('voiceRecorder.permissionMessage')); return; }
      // acquireRecording() shares the process-wide singleton, frees any orphan,
      // and retries once after an audio-session reset if the lock is still held.
      const rec = await acquireRecording();
      recordingRef.current = rec;
      setElapsedMs(0);
      setAudioStage('recording');
      intervalRef.current = setInterval(() => setElapsedMs((p) => p + 100), 100);
    } catch (e) {
      await releaseActiveRecording();
      recordingRef.current = null;
      setAudioStage('idle');
      themedAlert(i18nT('common.error'), (e as Error).message);
    }
  }

  async function stopAudioRecording() {
    clearInterval(intervalRef.current ?? undefined);
    intervalRef.current = null;
    try {
      await recordingRef.current?.stopAndUnloadAsync();
      const status = await recordingRef.current?.getStatusAsync();
      const fileUri = recordingRef.current?.getURI() ?? null;
      recordingRef.current = null;
      setActiveRecording(null);
      if (fileUri) {
        setAudioUri(fileUri);
        setDurationMs(status?.durationMillis ?? elapsedMs);
        setAudioStage('recorded');
      }
    } catch (e) {
      await releaseActiveRecording();
      recordingRef.current = null;
      themedAlert(i18nT('common.error'), (e as Error).message);
      setAudioStage('idle');
    }
  }

  async function playAudio() {
    if (!audioUri) return;
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUri },
        { shouldPlay: true },
        (status) => {
          if (!status.isLoaded) return;
          setPlaybackMs(status.positionMillis ?? 0);
          if (status.didJustFinish) { setAudioStage('recorded'); setPlaybackMs(0); }
        }
      );
      soundRef.current = sound;
      setAudioStage('playing');
    } catch (e) { themedAlert(i18nT('common.error'), (e as Error).message); }
  }

  async function stopAudio() {
    await soundRef.current?.stopAsync().catch(() => {});
    await soundRef.current?.unloadAsync().catch(() => {});
    soundRef.current = null;
    setPlaybackMs(0);
    setAudioStage('recorded');
  }

  function discardAudio() {
    void soundRef.current?.unloadAsync().catch(() => {});
    setAudioUri(null);
    setElapsedMs(0);
    setDurationMs(0);
    setPlaybackMs(0);
    setAudioStage('idle');
  }

  async function handleSendAudio() {
    if (!audioUri || !identity || sending) return;
    setSending(true);
    try {
      const durSec = Math.ceil(durationMs / 1000);
      const id = randomUUID();
      await appendMsg({
        id,
        chatId: contact.aegisId,
        direction: 'out',
        body: `[viewonce:audio:${durSec}s]`,
        createdAt: Date.now(),
        type: 'view_once',
        mediaUri: audioUri,
      });
      try {
        const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
        const base64 = await FileSystem.readAsStringAsync(audioUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: `[viewonce:audio:${durSec}s:data:audio/m4a;base64,${base64}]`,
          skipLocalAppend: true,
        });
      } catch {
        // queued offline
      }
      onSent();
    } catch (e) {
      setSending(false);
      themedAlert(i18nT('common.error'), (e as Error).message);
    }
  }

  // ── Processing spinner ───────────────────────────────────────────────────────

  if (processing) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <ActivityIndicator color={t.accent} size="large" />
        <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8 }}>
          {i18nT('common.processingImage')}
        </Text>
      </View>
    );
  }

  // ── Select screen ────────────────────────────────────────────────────────────

  if (mode === 'select') {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
        <TopBar
          t={t}
          title={i18nT('viewOnce.title')}
          left={
            <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
              <I.ChevronL size={22} color={t.textDim} />
            </Pressable>
          }
        />
        <View style={{ flex: 1, paddingHorizontal: 18, paddingTop: 12 }}>
          <View style={{ alignItems: 'center', paddingVertical: 20, gap: 10 }}>
            <View style={{
              width: 66, height: 66, borderRadius: 33,
              backgroundColor: t.surface, borderWidth: 1, borderColor: t.borderStrong,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <I.EyeOff size={30} stroke={1.6} color={t.accent} />
            </View>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '600', letterSpacing: -0.4, color: t.text, textAlign: 'center' }}>
              {i18nT('viewOnce.sendEphemeral')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, textAlign: 'center', maxWidth: 280 }}>
              {i18nT('viewOnce.sendEphemeralDesc')}
            </Text>
          </View>

          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.0, marginBottom: 12 }}>
            {i18nT('viewOnce.selectMedia')}
          </Text>

          <View style={{ flexDirection: 'row', gap: 12 }}>
            {/* Photo card */}
            <Pressable
              onPress={handlePickImage}
              style={({ pressed }) => ({
                flex: 1, height: 140,
                backgroundColor: t.surface, borderWidth: 1,
                borderColor: `${t.accent}44`, borderRadius: t.radius,
                alignItems: 'center', justifyContent: 'center', gap: 10,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: `${t.accent}18`, alignItems: 'center', justifyContent: 'center' }}>
                <I.Image size={26} stroke={1.6} color={t.accent} />
              </View>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8 }}>{i18nT('viewOnce.mediaPhoto')}</Text>
            </Pressable>

            {/* Audio card */}
            <Pressable
              onPress={() => { setAudioStage('idle'); setMode('audio'); }}
              style={({ pressed }) => ({
                flex: 1, height: 140,
                backgroundColor: t.surface, borderWidth: 1,
                borderColor: `${t.accent}44`, borderRadius: t.radius,
                alignItems: 'center', justifyContent: 'center', gap: 10,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: `${t.accent}18`, alignItems: 'center', justifyContent: 'center' }}>
                <I.Mic size={26} stroke={1.6} color={t.accent} />
              </View>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8 }}>{i18nT('viewOnce.mediaAudio')}</Text>
            </Pressable>

            {/* Video card */}
            <Pressable
              onPress={handlePickVideo}
              style={({ pressed }) => ({
                flex: 1, height: 140,
                backgroundColor: t.surface, borderWidth: 1,
                borderColor: `${t.accent}44`, borderRadius: t.radius,
                alignItems: 'center', justifyContent: 'center', gap: 10,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: `${t.accent}18`, alignItems: 'center', justifyContent: 'center' }}>
                <I.Video size={26} stroke={1.6} color={t.accent} />
              </View>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8 }}>{i18nT('viewOnce.mediaVideo', 'VIDEO')}</Text>
            </Pressable>
          </View>

          {/* Security footer */}
          <View style={{
            marginTop: 20, padding: 14,
            backgroundColor: t.surface, borderWidth: 1,
            borderColor: t.border, borderRadius: t.radius, gap: 6,
          }}>
            {([
              i18nT('viewOnce.bullet1'),
              i18nT('viewOnce.bullet2'),
              i18nT('viewOnce.bullet3'),
            ] as string[]).map((line) => (
              <View key={line} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <I.Check size={12} color={t.accent} />
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, flex: 1 }}>{line}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    );
  }

  // ── Image editor ─────────────────────────────────────────────────────────────

  if (mode === 'edit' && editUri) {
    const brushSize = BRUSH_SIZES[brushIdx];
    const livePath = currentPts.current.length > 1 ? pointsToD(currentPts.current) : null;

    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Top bar */}
        <View style={{
          paddingTop: insets.top + 6, paddingBottom: 10, paddingHorizontal: 14,
          flexDirection: 'row', alignItems: 'center', gap: 8,
        }}>
          <Pressable onPress={() => setMode('select')} hitSlop={8} style={{ padding: 6 }}>
            <I.ChevronL size={22} color="#fff" />
          </Pressable>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
            {/* Rotate CW */}
            <Pressable onPress={rotateImage} hitSlop={6} style={editorBtn}>
              <I.RotateCW size={18} color="#fff" />
            </Pressable>
            {/* Flip H */}
            <Pressable onPress={flipImage} hitSlop={6} style={editorBtn}>
              <I.Flip size={18} color="#fff" />
            </Pressable>
            {/* Undo */}
            <Pressable onPress={undoLast} hitSlop={6} style={editorBtn} disabled={paths.length === 0 && textItems.length === 0}>
              <Text style={{ color: (paths.length > 0 || textItems.length > 0) ? '#fff' : '#555', fontSize: 16 }}>↩</Text>
            </Pressable>
            {/* Done */}
            <Pressable
              onPress={handleEditorDone}
              style={{ backgroundColor: t.accent, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accentInk, fontWeight: '700', letterSpacing: 0.5 }}>
                {i18nT('common.done').toUpperCase()}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Canvas */}
        <View
          ref={editRef}
          style={{ flex: 1, position: 'relative' }}
          {...(tool === 'draw' || tool === 'text' ? panResponder.panHandlers : {})}
        >
          <Image
            source={{ uri: editUri }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            resizeMode="contain"
          />
          {/* SVG drawing layer */}
          <Svg style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
            {paths.map((p) => (
              <SvgPath
                key={p.id}
                d={pointsToD(p.points)}
                stroke={p.color}
                strokeWidth={p.width}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {livePath ? (
              <SvgPath
                key={livePathKey}
                d={livePath}
                stroke={drawColor}
                strokeWidth={brushSize}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
          </Svg>
          {/* Text overlays */}
          {textItems.map((item) => (
            <Pressable
              key={item.id}
              onLongPress={() => setTextItems((ti) => ti.filter((x) => x.id !== item.id))}
              style={{ position: 'absolute', top: item.y, left: item.x }}
            >
              <Text style={{
                color: item.color, fontSize: item.fontSize, fontWeight: '700',
                textShadowColor: 'rgba(0,0,0,0.7)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3,
              }}>
                {item.text}
              </Text>
            </Pressable>
          ))}
          {/* View-once badge */}
          <View style={{
            position: 'absolute', top: 12, right: 12,
            flexDirection: 'row', alignItems: 'center', gap: 5,
            backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 99,
            paddingHorizontal: 10, paddingVertical: 5,
          }}>
            <I.EyeOff size={11} color="#ff8b95" />
            <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: '#ff8b95', letterSpacing: 0.6 }}>{i18nT('viewOnce.previewBadge')}</Text>
          </View>
        </View>

        {/* Bottom toolbar */}
        <View style={{ paddingBottom: insets.bottom + 8, paddingTop: 12, paddingHorizontal: 14, gap: 12 }}>
          {/* Color palette (visible when draw or text active) */}
          {(tool === 'draw' || tool === 'text') && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
              <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 4 }}>
                {PALETTE.map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setDrawColor(c)}
                    style={{
                      width: 28, height: 28, borderRadius: 14,
                      backgroundColor: c,
                      borderWidth: drawColor === c ? 3 : 1,
                      borderColor: drawColor === c ? t.accent : 'rgba(255,255,255,0.3)',
                    }}
                  />
                ))}
              </View>
            </ScrollView>
          )}

          {/* Brush size row (draw only) */}
          {tool === 'draw' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {BRUSH_SIZES.map((sz, idx) => (
                <Pressable key={sz} onPress={() => setBrushIdx(idx)} style={{ alignItems: 'center', justifyContent: 'center', width: 36, height: 36 }}>
                  <View style={{
                    width: sz + 4, height: sz + 4, borderRadius: (sz + 4) / 2,
                    backgroundColor: brushIdx === idx ? drawColor : 'rgba(255,255,255,0.3)',
                  }} />
                </Pressable>
              ))}
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.5)', marginLeft: 4 }}>
                {brushSize}px
              </Text>
            </View>
          )}

          {/* Tool buttons */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ToolBtn label={i18nT('viewOnce.toolDraw')} icon={<I.Brush size={18} color={tool === 'draw' ? t.accent : '#fff'} />}
              active={tool === 'draw'} onPress={() => setTool(tool === 'draw' ? null : 'draw')} />
            <ToolBtn label={i18nT('viewOnce.toolText')} icon={<I.Type size={18} color={tool === 'text' ? t.accent : '#fff'} />}
              active={tool === 'text'} onPress={() => setTool(tool === 'text' ? null : 'text')} />
            <ToolBtn label={i18nT('viewOnce.toolErase')} icon={<I.Eraser size={18} color={tool === 'erase' ? t.accent : '#fff'} />}
              active={tool === 'erase'} onPress={clearAll} />
          </View>
        </View>

        {/* Text input modal */}
        <Modal visible={showTextModal} transparent animationType="fade">
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
            <View style={{ width: '100%', backgroundColor: t.surface, borderRadius: t.radius, padding: 20, gap: 14 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8 }}>{i18nT('viewOnce.addText')}</Text>
              <TextInput
                autoFocus
                value={textInput}
                onChangeText={setTextInput}
                placeholder={i18nT('viewOnce.textPlaceholder')}
                placeholderTextColor={t.textFaint}
                style={{
                  color: drawColor, fontFamily: t.font, fontSize: 18, fontWeight: '700',
                  borderBottomWidth: 1, borderBottomColor: t.border, paddingVertical: 8,
                }}
                onSubmitEditing={addTextOverlay}
                returnKeyType="done"
              />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable onPress={() => setShowTextModal(false)} style={{ flex: 1, padding: 12, borderRadius: t.radiusS, borderWidth: 1, borderColor: t.border, alignItems: 'center' }}>
                  <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>{i18nT('common.cancel')}</Text>
                </Pressable>
                <Pressable onPress={addTextOverlay} style={{ flex: 1, padding: 12, borderRadius: t.radiusS, backgroundColor: t.accent, alignItems: 'center' }}>
                  <Text style={{ fontFamily: t.font, fontSize: 13, color: t.accentInk, fontWeight: '600' }}>{i18nT('viewOnce.addTextBtn')}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  // ── Confirm image ─────────────────────────────────────────────────────────────

  if (mode === 'confirm' && confirmedUri) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', paddingTop: insets.top }}>
        {/* Top bar */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}>
          <Pressable onPress={() => setMode('edit')} hitSlop={8} style={{ padding: 6 }}>
            <I.ChevronL size={22} color="#fff" />
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={handleSendImage}
            disabled={sending}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: t.accent, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            {sending
              ? <ActivityIndicator size="small" color={t.accentInk} />
              : <I.Send size={16} color={t.accentInk} />}
            <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accentInk, fontWeight: '700', letterSpacing: 0.5 }}>
              {sending ? i18nT('viewOnce.sending') : i18nT('viewOnce.sendBtn')}
            </Text>
          </Pressable>
        </View>

        {/* Preview */}
        <View style={{ flex: 1, position: 'relative' }}>
          <Image source={{ uri: confirmedUri }} style={{ flex: 1 }} resizeMode="contain" />
          <View style={{
            position: 'absolute', top: 12, right: 12,
            flexDirection: 'row', alignItems: 'center', gap: 5,
            backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5,
          }}>
            <I.EyeOff size={11} color="#ff8b95" />
            <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: '#ff8b95', letterSpacing: 0.6 }}>{i18nT('viewOnce.previewBadge')}</Text>
          </View>
        </View>

        {/* Caption + meta */}
        <View style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 14, paddingTop: 12, gap: 10, backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <TextInput
            value={caption}
            onChangeText={setCaption}
            placeholder={i18nT('viewOnce.captionPlaceholder')}
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={{
              color: '#fff', fontFamily: t.font, fontSize: 15,
              borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.2)', paddingVertical: 8,
            }}
            maxLength={200}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <I.Timer size={10} color="rgba(255,255,255,0.5)" />
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.5)', letterSpacing: 0.6 }}>
              {i18nT('viewOnce.autoDestruct')}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  // ── Audio screen ──────────────────────────────────────────────────────────────

  if (mode === 'audio') {
    const isRecording = audioStage === 'recording';
    const hasRecording = audioStage === 'recorded' || audioStage === 'playing';
    const isPlaying = audioStage === 'playing';
    const progress = durationMs > 0 ? (isPlaying ? playbackMs / durationMs : 1) : 0;

    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
        <TopBar
          t={t}
          title={i18nT('viewOnce.audioTitle')}
          left={
            <Pressable onPress={() => { discardAudio(); setMode('select'); }} hitSlop={8} style={{ padding: 4 }}>
              <I.ChevronL size={22} color={t.textDim} />
            </Pressable>
          }
        />

        {/* View-once badge */}
        <View style={{ alignItems: 'center', paddingTop: 8 }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 5,
            backgroundColor: `${t.danger}18`, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 5,
            borderWidth: 1, borderColor: `${t.danger}44`,
          }}>
            <I.EyeOff size={11} color="#ff8b95" />
            <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: '#ff8b95', letterSpacing: 0.6 }}>
              {i18nT('viewOnce.audioBadge')}
            </Text>
          </View>
        </View>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 40 }}>
          {/* Waveform */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 64 }}>
            {audioBars.map((h, i) => {
              const barPct = (i + 1) / audioBars.length;
              const active = isRecording
                ? (i / audioBars.length) < ((elapsedMs % 3000) / 3000)
                : hasRecording ? barPct <= progress : false;
              return (
                <View
                  key={i}
                  style={{
                    width: 3, height: Math.max(4, h * 56), borderRadius: 2,
                    backgroundColor: active
                      ? (isPlaying ? t.accent : isRecording ? t.danger : t.accent)
                      : t.surface3,
                  }}
                />
              );
            })}
          </View>

          {/* Timer */}
          <Text style={{ fontFamily: t.fontMono, fontSize: 42, fontWeight: '200', letterSpacing: 2, color: isRecording ? t.danger : t.text }}>
            {isRecording ? formatMs(elapsedMs) : isPlaying ? formatMs(playbackMs) : hasRecording ? formatMs(durationMs) : '00:00'}
          </Text>

          {/* Controls */}
          {!hasRecording ? (
            <Pressable
              onPress={isRecording ? stopAudioRecording : startAudioRecording}
              style={({ pressed }) => ({
                width: 80, height: 80, borderRadius: 40,
                backgroundColor: isRecording ? t.danger : t.accent,
                alignItems: 'center', justifyContent: 'center',
                opacity: pressed ? 0.8 : 1,
              })}
            >
              {isRecording
                ? <View style={{ width: 26, height: 26, borderRadius: 4, backgroundColor: '#fff' }} />
                : <I.Mic size={34} color={t.accentInk} />}
            </Pressable>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 24 }}>
              {/* Discard */}
              <Pressable onPress={discardAudio} style={ctrlBtn(t)}>
                <I.Trash size={20} color={t.danger} />
              </Pressable>
              {/* Play/Stop */}
              <Pressable
                onPress={isPlaying ? stopAudio : playAudio}
                style={({ pressed }) => ({ width: 68, height: 68, borderRadius: 34, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.borderStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}
              >
                {isPlaying
                  ? <I.Pause size={28} color={t.text} />
                  : <I.Play size={28} color={t.text} />}
              </Pressable>
              {/* Send */}
              <Pressable
                onPress={handleSendAudio}
                disabled={sending}
                style={({ pressed }) => ({ width: 52, height: 52, borderRadius: 26, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
              >
                {sending
                  ? <ActivityIndicator size="small" color={t.accentInk} />
                  : <I.Send size={20} color={t.accentInk} />}
              </Pressable>
            </View>
          )}

          <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, textAlign: 'center' }}>
            {audioStage === 'idle' ? i18nT('voiceRecorder.tap') :
             isRecording ? i18nT('viewOnce.audioRecordingHint') :
             isPlaying ? i18nT('voiceRecorder.playing') : i18nT('viewOnce.audioReadyHint')}
          </Text>
        </View>
      </View>
    );
  }

  return null;
}

// ── Helper sub-components ─────────────────────────────────────────────────────

const editorBtn = {
  width: 36, height: 36, borderRadius: 18,
  backgroundColor: 'rgba(255,255,255,0.12)',
  alignItems: 'center' as const, justifyContent: 'center' as const,
};

function ToolBtn({
  label, icon, active, onPress,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 14, paddingVertical: 9,
        backgroundColor: active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.07)',
        borderRadius: 22, borderWidth: 1,
        borderColor: active ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.12)',
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {icon}
      <Text style={{ fontFamily: 'System', fontSize: 11, color: active ? '#fff' : 'rgba(255,255,255,0.6)', fontWeight: '600', letterSpacing: 0.4 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function ctrlBtn(t: any) {
  return {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: t.surface2, borderWidth: 1,
    borderColor: t.borderStrong,
    alignItems: 'center' as const, justifyContent: 'center' as const,
  };
}
