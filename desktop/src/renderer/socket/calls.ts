/**
 * AegisLink Desktop — WebRTC call signaling (Electron renderer).
 *
 * Ported from mobile/src/socket/calls.ts.
 * Changes vs. mobile:
 *  - react-native-webrtc → native browser RTCPeerConnection / getUserMedia (Chromium)
 *  - expo-crypto.randomUUID() → crypto.randomUUID() (Web Crypto API)
 *  - require('../webrtc/peer') → inline browser WebRTC (no native module abstraction needed)
 *  - __DEV__ → import.meta.env.DEV
 *  - Dynamic require() stores → static imports
 *
 * WebRTC in Electron renderer: RTCPeerConnection, RTCSessionDescription,
 * RTCIceCandidate, and navigator.mediaDevices.getUserMedia are all native
 * Chromium APIs — no polyfill required.
 */

import { getSocket, isConnected } from './client';
import { useCall } from '../store/call';
import { saveCall } from '../db/local';
import { useMessages } from '../store/messages';
import { useIdentity } from '../store/identity';
import { RELAY_URL } from '../config';

const DEV = import.meta.env.DEV;

export type CallMedia = 'audio' | 'video';

// ── ICE config ────────────────────────────────────────────────────────────────

interface RTCConfigShape {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  iceTransportPolicy?: 'all' | 'relay';
}

function defaultRtcConfig(): RTCConfigShape {
  const TURN_URL = (import.meta.env.VITE_TURN_URL as string | undefined) ?? '';
  const TURN_USERNAME = (import.meta.env.VITE_TURN_USERNAME as string | undefined) ?? '';
  const TURN_PASSWORD = (import.meta.env.VITE_TURN_PASSWORD as string | undefined) ?? '';

  const iceServers: RTCConfigShape['iceServers'] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (TURN_URL) {
    iceServers.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_PASSWORD });
  }
  return { iceServers };
}

async function fetchTurnConfig(aegisId: string): Promise<RTCConfigShape> {
  try {
    const res = await fetch(
      `${RELAY_URL}/turn/credentials?aegisId=${encodeURIComponent(aegisId)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return defaultRtcConfig();
    const { username, password } = (await res.json()) as {
      username: string;
      password: string;
      ttl: number;
    };
    const TURN_URL = (import.meta.env.VITE_TURN_URL as string | undefined) ?? '';
    const iceServers: RTCConfigShape['iceServers'] = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    if (TURN_URL) {
      iceServers.push({ urls: TURN_URL, username, credential: password });
    }
    return { iceServers };
  } catch {
    return defaultRtcConfig();
  }
}

// ── Browser WebRTC peer helpers ───────────────────────────────────────────────

interface ActivePeer {
  pc: RTCPeerConnection;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  cleanup: () => void;
}

interface PeerHandlers {
  onLocalStream: (s: MediaStream) => void;
  onRemoteStream: (s: MediaStream) => void;
  onIceCandidate: (c: RTCIceCandidate) => void;
  onConnectionStateChange: (state: string) => void;
}

async function createPeer(
  media: CallMedia,
  handlers: PeerHandlers,
  config: RTCConfigShape,
): Promise<ActivePeer> {
  const pc = new RTCPeerConnection(config as RTCConfiguration);

  const constraints: MediaStreamConstraints =
    media === 'video'
      ? { audio: true, video: { facingMode: 'user' } }
      : { audio: true, video: false };

  const localStream = await navigator.mediaDevices.getUserMedia(constraints);
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }
  handlers.onLocalStream(localStream);

  let remoteStream: MediaStream | null = null;
  pc.addEventListener('track', (event: RTCTrackEvent) => {
    if (event.streams?.[0]) {
      remoteStream = event.streams[0];
      handlers.onRemoteStream(remoteStream);
    }
  });

  pc.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) handlers.onIceCandidate(event.candidate);
  });

  pc.addEventListener('connectionstatechange', () => {
    handlers.onConnectionStateChange(pc.connectionState);
  });

  const cleanup = () => {
    try { for (const t of localStream.getTracks()) t.stop(); } catch {/* ignore */}
    try { pc.close(); } catch {/* ignore */}
  };

  return { pc, localStream, remoteStream, cleanup };
}

async function createOffer(pc: RTCPeerConnection): Promise<string> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return JSON.stringify(offer);
}

async function setRemoteOffer(pc: RTCPeerConnection, offerSdp: string): Promise<void> {
  const offer = new RTCSessionDescription(JSON.parse(offerSdp) as RTCSessionDescriptionInit);
  await pc.setRemoteDescription(offer);
}

async function createAnswer(pc: RTCPeerConnection): Promise<string> {
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return JSON.stringify(answer);
}

async function setRemoteAnswer(pc: RTCPeerConnection, answerSdp: string): Promise<void> {
  const answer = new RTCSessionDescription(JSON.parse(answerSdp) as RTCSessionDescriptionInit);
  await pc.setRemoteDescription(answer);
}

async function addRemoteIce(pc: RTCPeerConnection, candidate: string): Promise<void> {
  try {
    const ice = new RTCIceCandidate(JSON.parse(candidate) as RTCIceCandidateInit);
    await pc.addIceCandidate(ice);
  } catch (e) {
    if (DEV) console.warn('[webrtc] addIceCandidate failed', (e as Error).message);
  }
}

// ── Ring timeout ──────────────────────────────────────────────────────────────
let _ringTimeout: ReturnType<typeof setTimeout> | null = null;

function clearRingTimeout(): void {
  if (_ringTimeout !== null) {
    clearTimeout(_ringTimeout);
    _ringTimeout = null;
  }
}

// ── Wire payload types ────────────────────────────────────────────────────────

interface CallInvitePayload {
  callId: string;
  from: string;
  media: CallMedia;
  offer: string;
}

interface CallAnswerPayload {
  callId: string;
  from: string;
  answer: string;
}

interface CallIcePayload {
  callId: string;
  from: string;
  candidate: string;
}

interface CallHangupPayload {
  callId: string;
  from: string;
  reason?: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Subscribes to incoming-call signaling events on the socket.
 * Call this once after the socket authenticates (auth:ok).
 */
export function attachCallHandlers(): void {
  const socket = getSocket();
  if (!socket) return;

  socket.on('call:invite', async (msg: CallInvitePayload) => {
    const state = useCall.getState();
    if (state.status !== 'idle' && state.status !== 'ended') {
      socket.emit('call:hangup', { callId: msg.callId, to: msg.from, reason: 'busy' });
      saveCall({
        id: msg.callId,
        contactId: msg.from,
        direction: 'in',
        media: msg.media,
        status: 'declined',
        startedAt: Date.now(),
        durationS: 0,
      }).catch(() => {});
      if (useIdentity.getState().identity) {
        void useMessages.getState().append({
          id: crypto.randomUUID(),
          chatId: msg.from,
          direction: 'in',
          body: `[call:declined:${msg.media}:0s]`,
          createdAt: Date.now(),
          type: 'text',
        });
      }
      return;
    }
    state.startIncoming(msg.from, msg.callId, msg.media, msg.offer);
  });

  socket.on('call:answer', async (msg: CallAnswerPayload) => {
    clearRingTimeout();
    const { activePeer, callId } = useCall.getState();
    if (!activePeer || callId !== msg.callId) return;
    await setRemoteAnswer(activePeer.pc as RTCPeerConnection, msg.answer);
    useCall.getState().setStatus('connecting');
  });

  socket.on('call:ice', async (msg: CallIcePayload) => {
    const { activePeer, callId } = useCall.getState();
    if (!activePeer || callId !== msg.callId) return;
    await addRemoteIce(activePeer.pc as RTCPeerConnection, msg.candidate);
  });

  socket.on('call:hangup', (msg: CallHangupPayload) => {
    const { callId, activePeer } = useCall.getState();
    if (callId !== msg.callId) return;
    if (activePeer?.cleanup) activePeer.cleanup();
    useCall.getState().setStatus('ended');
    setTimeout(() => useCall.getState().reset(), 800);
  });
}

/** Start an outgoing call. */
export async function startCall(toAegisId: string, media: CallMedia): Promise<void> {
  if (!isConnected()) throw new Error('not_connected');
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  const callId = crypto.randomUUID();
  useCall.getState().startOutgoing(toAegisId, callId, media);

  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  const turnConfig = await fetchTurnConfig(ownAegisId);

  const peer = await createPeer(
    media,
    {
      onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
      onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
      onIceCandidate: (candidate) => {
        socket.emit('call:ice', {
          callId,
          to: toAegisId,
          candidate: JSON.stringify(candidate.toJSON()),
        });
      },
      onConnectionStateChange: (state) => {
        if (state === 'connected') useCall.getState().setStatus('in-call');
        if (state === 'failed' || state === 'closed') endCall('rtc_failure');
      },
    },
    turnConfig,
  );
  useCall.getState().setActivePeer({ ...peer, peerId: toAegisId });

  const offer = await createOffer(peer.pc as RTCPeerConnection);
  socket.emit('call:invite', { callId, to: toAegisId, media, offer });

  _ringTimeout = setTimeout(() => {
    if (useCall.getState().status === 'outgoing-ringing') {
      endCall('no_answer');
    }
  }, 45_000);
}

/** Accept an incoming call (we already have the offer in pendingOffer). */
export async function acceptCall(): Promise<void> {
  const { peer: peerId, callId, media, pendingOffer } = useCall.getState();
  if (!peerId || !callId || !pendingOffer) return;
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  useCall.getState().setStatus('connecting');

  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  const turnConfig = await fetchTurnConfig(ownAegisId);

  const peer = await createPeer(
    media,
    {
      onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
      onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
      onIceCandidate: (candidate) => {
        socket.emit('call:ice', {
          callId,
          to: peerId,
          candidate: JSON.stringify(candidate.toJSON()),
        });
      },
      onConnectionStateChange: (state) => {
        if (state === 'connected') useCall.getState().setStatus('in-call');
        if (state === 'failed' || state === 'closed') endCall('rtc_failure');
      },
    },
    turnConfig,
  );
  useCall.getState().setActivePeer({ ...peer, peerId });

  await setRemoteOffer(peer.pc as RTCPeerConnection, pendingOffer);
  const answer = await createAnswer(peer.pc as RTCPeerConnection);
  socket.emit('call:answer', { callId, to: peerId, answer });
  useCall.getState().setPendingOffer(null);
}

/** Reject an incoming call or end an active one. */
export function endCall(reason: string = 'hangup'): void {
  clearRingTimeout();
  const { peer: peerId, callId, activePeer, status, media, startedAt, pendingOffer } =
    useCall.getState();
  const socket = getSocket();
  if (socket && peerId && callId) {
    socket.emit('call:hangup', { callId, to: peerId, reason });
  }

  if (callId && peerId) {
    const wasIncoming =
      status === 'incoming-ringing' || (status === 'in-call' && pendingOffer !== null);
    const wasAnswered = status === 'in-call';
    const callStatus: 'missed' | 'answered' | 'declined' =
      reason === 'declined' ? 'declined' : wasAnswered ? 'answered' : 'missed';
    const durationS =
      wasAnswered && startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;

    saveCall({
      id: callId,
      contactId: peerId,
      direction: wasIncoming ? 'in' : 'out',
      media: media ?? 'audio',
      status: callStatus,
      startedAt: startedAt ?? Date.now(),
      durationS,
    }).catch(() => {});

    if (useIdentity.getState().identity) {
      void useMessages.getState().append({
        id: crypto.randomUUID(),
        chatId: peerId,
        direction: wasIncoming ? 'in' : 'out',
        body: `[call:${callStatus}:${media ?? 'audio'}:${durationS}s]`,
        createdAt: Date.now(),
        type: 'text',
      });
    }
  }

  if (activePeer?.cleanup) activePeer.cleanup();
  useCall.getState().setStatus('ended');
  setTimeout(() => useCall.getState().reset(), 600);
}

export function toggleMute(): void {
  const { activePeer, muted } = useCall.getState();
  if (!activePeer?.localStream) return;
  const newMuted = !muted;
  for (const track of (activePeer.localStream as MediaStream).getAudioTracks())
    track.enabled = !newMuted;
  useCall.getState().setMuted(newMuted);
}

export function toggleCamera(): void {
  const { activePeer, cameraOff } = useCall.getState();
  if (!activePeer?.localStream) return;
  const newOff = !cameraOff;
  for (const track of (activePeer.localStream as MediaStream).getVideoTracks())
    track.enabled = !newOff;
  useCall.getState().setCameraOff(newOff);
}
