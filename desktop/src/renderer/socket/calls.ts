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
import { useContacts } from '../store/contacts';
import { RELAY_URL, SEALED_TRANSPORT_VERSION } from '../config';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, decodeUTF8 } from 'tweetnacl-util';
import {
  sealCallInvite,
  openCallInvite,
  sealWithCallKey,
  openWithCallKey,
} from '../crypto/callSession';

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

async function fetchTurnConfig(_aegisId: string): Promise<RTCConfigShape> {
  // A-7 auth (parity with mobile): minting TURN credentials requires proof of a
  // registered identity. Sign `${aegisId}:turn:${timeBucket}` with the ACTIVE
  // identity's Ed25519 key (the authoritative signer, read from the store), like
  // POST /prekeys. No identity → no creds (STUN-only fallback).
  const id = useIdentity.getState().identity;
  if (!id?.signingSecretKey) return defaultRtcConfig();
  const ts = Date.now();
  const bucket = Math.floor(ts / 30_000);
  const sig = encodeBase64(
    nacl.sign.detached(decodeUTF8(`${id.aegisId}:turn:${bucket}`), id.signingSecretKey),
  );
  try {
    const query =
      `aegisId=${encodeURIComponent(id.aegisId)}` +
      `&sig=${encodeURIComponent(sig)}` +
      `&ts=${ts}`;
    const res = await fetch(
      `${RELAY_URL}/turn/credentials?${query}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return defaultRtcConfig();
    // Server returns { urls, username, credential, ttl }. Accept the legacy
    // `password` alias too for older relays.
    const { username, credential, password } = (await res.json()) as {
      username: string;
      credential?: string;
      password?: string;
      ttl: number;
    };
    const cred = credential ?? password ?? '';
    const TURN_URL = (import.meta.env.VITE_TURN_URL as string | undefined) ?? '';
    const iceServers: RTCConfigShape['iceServers'] = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    if (TURN_URL) {
      iceServers.push({ urls: TURN_URL, username, credential: cred });
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

// ── Sealed-sender v2 call signaling (Phase 2) ───────────────────────────────
// Parity with mobile. v2 hides the caller's identity from the relay: the invite
// carries a sealed-sender handshake embedding a per-call symmetric `callKey`;
// answer/ICE are sealed with secretbox under it. v2 SEND is flag-gated; v2
// RECEIVE is always wired. NOTE: desktop's v1 path emits signaling in cleartext
// (pre-existing); v2 additionally encrypts the SDP/ICE content end-to-end.
const callKeys = new Map<string, Uint8Array>();
function rememberCallKey(callId: string, key: Uint8Array): void { callKeys.set(callId, key); }
function forgetCallKey(callId: string): void {
  const k = callKeys.get(callId);
  if (k) { k.fill(0); callKeys.delete(callId); }
}

function ownSealedKeys(): { secretKey: Uint8Array; signingSecretKey: Uint8Array; aegisId: string } | null {
  const id = useIdentity.getState().identity;
  if (!id?.signingSecretKey) return null;
  return { secretKey: id.secretKey, signingSecretKey: id.signingSecretKey, aegisId: id.aegisId };
}
function peerBoxKey(aegisId: string): Uint8Array | null {
  const b64 = useContacts.getState().get(aegisId)?.publicKeyB64;
  if (!b64) return null;
  try { const k = decodeBase64(b64); return k.length === nacl.box.publicKeyLength ? k : null; } catch { return null; }
}
function peerSigningKey(aegisId: string): Uint8Array | null {
  const b64 = useContacts.getState().get(aegisId)?.signingPublicKeyB64;
  if (!b64) return null;
  try { const k = decodeBase64(b64); return k.length === nacl.sign.publicKeyLength ? k : null; } catch { return null; }
}

/**
 * Emit answer / ICE. Uses the v2 symmetric channel when we hold a callKey for
 * this call, else the legacy v1 cleartext channel (unchanged desktop behavior).
 */
function emitCallSignal(
  socket: NonNullable<ReturnType<typeof getSocket>>,
  kind: 'answer' | 'ice',
  callId: string,
  toAegisId: string,
  payload: string,
): void {
  const key = callKeys.get(callId);
  if (key) {
    const wire = sealWithCallKey(key, payload);
    socket.emit(`call:${kind}:v2`, { callId, to: toAegisId, ...wire });
    return;
  }
  if (kind === 'ice') socket.emit('call:ice', { callId, to: toAegisId, candidate: payload });
  else socket.emit('call:answer', { callId, to: toAegisId, answer: payload });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Subscribes to incoming-call signaling events on the socket.
 * Call this once after the socket authenticates (auth:ok).
 */
export function attachCallHandlers(): void {
  const socket = getSocket();
  if (!socket) return;

  socket.off('call:invite'); socket.off('call:answer'); socket.off('call:ice'); socket.off('call:hangup');
  socket.off('call:invite:v2'); socket.off('call:answer:v2'); socket.off('call:ice:v2'); socket.off('call:hangup:v2');

  socket.on('call:invite', async (msg: CallInvitePayload) => {
    processIncomingInvite(socket, msg.from, msg.callId, msg.media, msg.offer);
  });

  // Sealed-sender v2 invite: no `from`; openCallInvite authenticates the caller
  // and yields the per-call key. Always wired so a v2 caller reaches us.
  socket.on('call:invite:v2', async (msg: SealedInviteWire) => {
    const me = ownSealedKeys();
    if (!me) return;
    const opened = openCallInvite(
      { ciphertext: msg.ciphertext, nonce: msg.nonce, epk: msg.epk },
      me.secretKey,
      peerSigningKey,
      Date.now(),
    );
    if (!opened) {
      if (DEV) console.warn('[calls] call:invite:v2 open/auth failed — dropping');
      return;
    }
    rememberCallKey(msg.callId, opened.callKey);
    processIncomingInvite(socket, opened.from, msg.callId, msg.media, opened.offer);
  });

  socket.on('call:answer', async (msg: CallAnswerPayload) => {
    await processIncomingAnswer(msg.callId, msg.answer);
  });
  socket.on('call:answer:v2', async (msg: SealedKeyWire) => {
    const key = callKeys.get(msg.callId);
    if (!key) return;
    const answer = openWithCallKey(key, { ciphertext: msg.ciphertext, nonce: msg.nonce });
    if (!answer) { if (DEV) console.warn('[calls] call:answer:v2 decrypt failed'); return; }
    await processIncomingAnswer(msg.callId, answer);
  });

  socket.on('call:ice', async (msg: CallIcePayload) => {
    await processIncomingIce(msg.callId, msg.candidate);
  });
  socket.on('call:ice:v2', async (msg: SealedKeyWire) => {
    const key = callKeys.get(msg.callId);
    if (!key) return;
    const candidate = openWithCallKey(key, { ciphertext: msg.ciphertext, nonce: msg.nonce });
    if (!candidate) { if (DEV) console.warn('[calls] call:ice:v2 decrypt failed'); return; }
    await processIncomingIce(msg.callId, candidate);
  });

  socket.on('call:hangup', (msg: CallHangupPayload) => {
    processIncomingHangup(msg.callId);
  });
  socket.on('call:hangup:v2', (msg: { callId: string; reason?: string }) => {
    processIncomingHangup(msg.callId);
  });
}

/** Wire shape for an incoming v2 call:invite (no `from`). */
interface SealedInviteWire {
  callId: string;
  media: CallMedia;
  ciphertext: string;
  nonce: string;
  epk: string;
}
/** Wire shape for an incoming v2 answer / ICE (symmetric, no `from`). */
interface SealedKeyWire {
  callId: string;
  ciphertext: string;
  nonce: string;
}

/** Shared incoming-invite handling — used by both v1 and v2 invite handlers. */
function processIncomingInvite(
  socket: NonNullable<ReturnType<typeof getSocket>>,
  from: string,
  callId: string,
  media: CallMedia,
  offer: string,
): void {
  const state = useCall.getState();
  if (state.status !== 'idle' && state.status !== 'ended') {
    if (callKeys.has(callId)) socket.emit('call:hangup:v2', { callId, to: from, reason: 'busy' });
    else socket.emit('call:hangup', { callId, to: from, reason: 'busy' });
    saveCall({ id: callId, contactId: from, direction: 'in', media, status: 'declined', startedAt: Date.now(), durationS: 0 }).catch(() => {});
    if (useIdentity.getState().identity) {
      void useMessages.getState().append({
        id: crypto.randomUUID(),
        chatId: from,
        direction: 'in',
        body: `[call:declined:${media}:0s]`,
        createdAt: Date.now(),
        type: 'text',
      });
    }
    return;
  }
  state.startIncoming(from, callId, media, offer);
}

/** Shared answer handling — used by both v1 and v2 answer handlers. */
async function processIncomingAnswer(msgCallId: string, answer: string): Promise<void> {
  clearRingTimeout();
  const { activePeer, callId } = useCall.getState();
  if (!activePeer || callId !== msgCallId) return;
  await setRemoteAnswer(activePeer.pc as RTCPeerConnection, answer);
  useCall.getState().setStatus('connecting');
}

/** Shared ICE handling — used by both v1 and v2 ICE handlers. */
async function processIncomingIce(msgCallId: string, candidate: string): Promise<void> {
  const { activePeer, callId } = useCall.getState();
  if (!activePeer || callId !== msgCallId) return;
  await addRemoteIce(activePeer.pc as RTCPeerConnection, candidate);
}

/** Shared hangup handling — used by both v1 and v2 hangup handlers. */
function processIncomingHangup(msgCallId: string): void {
  const { callId, activePeer } = useCall.getState();
  if (callId !== msgCallId) return;
  if (activePeer?.cleanup) activePeer.cleanup();
  forgetCallKey(msgCallId);
  useCall.getState().setStatus('ended');
  setTimeout(() => useCall.getState().reset(), 800);
}

/** Start an outgoing call. */
export async function startCall(toAegisId: string, media: CallMedia): Promise<void> {
  if (!isConnected()) throw new Error('not_connected');
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  const callId = crypto.randomUUID();
  useCall.getState().startOutgoing(toAegisId, callId, media);

  // Decide sealed-sender v2 and generate the callKey UP FRONT so ICE trickling
  // out during createOffer is already sealed under it (emitCallSignal picks v2
  // whenever callKeys holds this callId).
  const useV2Call = SEALED_TRANSPORT_VERSION === 'v2' && !!peerBoxKey(toAegisId) && !!ownSealedKeys();
  if (useV2Call) rememberCallKey(callId, nacl.randomBytes(nacl.secretbox.keyLength));

  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  const turnConfig = await fetchTurnConfig(ownAegisId);

  const peer = await createPeer(
    media,
    {
      onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
      onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
      onIceCandidate: (candidate) => {
        emitCallSignal(socket, 'ice', callId, toAegisId, JSON.stringify(candidate.toJSON()));
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
  if (useV2Call) {
    const me = ownSealedKeys();
    const recipientPub = peerBoxKey(toAegisId);
    const callKey = callKeys.get(callId);
    if (!me || !recipientPub || !callKey) { endCall('encrypt_failure'); return; }
    const sealed = sealCallInvite(recipientPub, me.aegisId, me.signingSecretKey, offer, Date.now(), callKey);
    socket.emit('call:invite:v2', { callId, to: toAegisId, media, ...sealed.wire });
  } else {
    socket.emit('call:invite', { callId, to: toAegisId, media, offer });
  }

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
        emitCallSignal(socket, 'ice', callId, peerId, JSON.stringify(candidate.toJSON()));
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
  // Uses the v2 symmetric channel if the call arrived sealed (we hold a callKey).
  emitCallSignal(socket, 'answer', callId, peerId, answer);
  useCall.getState().setPendingOffer(null);
}

/** Reject an incoming call or end an active one. */
export function endCall(reason: string = 'hangup'): void {
  clearRingTimeout();
  const { peer: peerId, callId, activePeer, status, media, startedAt, pendingOffer } =
    useCall.getState();
  const socket = getSocket();
  if (socket && peerId && callId) {
    // Mirror the call's transport so the relay still never sees `from`.
    if (callKeys.has(callId)) socket.emit('call:hangup:v2', { callId, to: peerId, reason });
    else socket.emit('call:hangup', { callId, to: peerId, reason });
  }
  if (callId) forgetCallKey(callId);

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
