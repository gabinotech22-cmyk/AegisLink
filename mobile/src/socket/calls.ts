import * as Crypto from 'expo-crypto';
import { getSocket, isConnected } from './client';
import { useCall } from '../store/call';
import { displayIncomingCall, endNativeCall, reportCallConnected, setNativeMuted } from '../calls/callkeep';
import { saveCall } from '../db/local';
import {
  createPeer,
  createOffer,
  setRemoteOffer,
  createAnswer,
  setRemoteAnswer,
  addRemoteIce,
  type CallMedia,
} from '../webrtc/peer';
import { fetchTurnConfig } from '../webrtc/ice';

// ---------------------------------------------------------------------------
// Ring timeout — cleared whenever the call advances past outgoing-ringing
// ---------------------------------------------------------------------------
let _ringTimeout: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Pending ICE candidate queue — candidates can arrive before setRemoteDescription
// is called (e.g. while the callee is still ringing). Buffer them and flush once
// the remote description is set.
// ---------------------------------------------------------------------------
let _pendingIceCandidates: string[] = [];
let _remoteDescriptionSet = false;

function bufferOrApplyIce(pc: import('../webrtc/peer').ActivePeer['pc'], candidate: string): void {
  if (_remoteDescriptionSet) {
    void addRemoteIce(pc, candidate);
  } else {
    _pendingIceCandidates.push(candidate);
  }
}

async function flushPendingIce(pc: import('../webrtc/peer').ActivePeer['pc']): Promise<void> {
  _remoteDescriptionSet = true;
  const queued = _pendingIceCandidates.splice(0);
  for (const c of queued) {
    await addRemoteIce(pc, c);
  }
}

function resetIceQueue(): void {
  _pendingIceCandidates = [];
  _remoteDescriptionSet = false;
}

function clearRingTimeout(): void {
  if (_ringTimeout !== null) {
    clearTimeout(_ringTimeout);
    _ringTimeout = null;
  }
}

interface CallInvitePayload {
  callId: string;
  from: string;
  media: CallMedia;
  offer: string; // SDP JSON
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

/**
 * Subscribes to incoming-call signaling events. Must be called after the
 * socket is connected and authenticated.
 *
 * NOTE: signaling is NOT sealed-sender — the server sees who is calling whom.
 * Media itself is E2EE via DTLS-SRTP (built into WebRTC). Sealed signaling
 * is Fase 4+ hardening.
 */
export function attachCallHandlers(): void {
  const socket = getSocket();
  if (!socket) return;

  socket.on('call:invite', async (msg: CallInvitePayload) => {
    const state = useCall.getState();
    if (state.status !== 'idle' && state.status !== 'ended') {
      // Busy — auto-reject; log as declined
      socket.emit('call:hangup', { callId: msg.callId, to: msg.from, reason: 'busy' });
      saveCall({ id: msg.callId, contactId: msg.from, direction: 'in', media: msg.media, status: 'declined', startedAt: Date.now(), durationS: 0 }).catch(() => {});
      const { useMessages } = require('../store/messages');
      const { useIdentity } = require('../store/identity');
      if (useIdentity.getState().identity) {
        void useMessages.getState().append({
          id: Crypto.randomUUID(),
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

    // Show native incoming call UI (CallKit on iOS, ConnectionService on Android)
    const callerName = (() => {
      try {
        const { useContacts } = require('../store/contacts') as { useContacts: { getState: () => { get: (id: string) => { name: string } | undefined } } };
        return useContacts.getState().get(msg.from)?.name ?? msg.from;
      } catch { return msg.from; }
    })();
    displayIncomingCall(msg.callId, msg.from, callerName, msg.media === 'video');
  });

  socket.on('call:answer', async (msg: CallAnswerPayload) => {
    clearRingTimeout(); // callee answered — cancel the no-answer timeout
    const { activePeer, callId } = useCall.getState();
    if (!activePeer || callId !== msg.callId) return;
    await setRemoteAnswer(activePeer.pc, msg.answer);
    // Flush any ICE candidates that arrived before the remote description was set
    await flushPendingIce(activePeer.pc);
    useCall.getState().setStatus('connecting');
  });

  socket.on('call:ice', async (msg: CallIcePayload) => {
    const { activePeer, callId } = useCall.getState();
    if (!activePeer || callId !== msg.callId) return;
    // Buffer candidates if remote description is not yet set
    bufferOrApplyIce(activePeer.pc, msg.candidate);
  });

  socket.on('call:hangup', (msg: CallHangupPayload) => {
    const { callId, activePeer } = useCall.getState();
    if (callId !== msg.callId) return;
    activePeer?.cleanup();
    // Dismiss native CallKit / ConnectionService UI for remote-initiated hangups
    endNativeCall(msg.callId);
    resetIceQueue();
    useCall.getState().setStatus('ended');
    setTimeout(() => useCall.getState().reset(), 800);
  });
}

/** Start an outgoing call. */
export async function startCall(toAegisId: string, media: CallMedia): Promise<void> {
  if (!isConnected()) throw new Error('not_connected');
  const socket = getSocket();
  if (!socket) throw new Error('no_socket');

  const callId = Crypto.randomUUID();
  useCall.getState().startOutgoing(toAegisId, callId, media);

  const { useIdentity } = require('../store/identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  const turnConfig = await fetchTurnConfig(ownAegisId);

  // Set audio mode for call — earpiece for audio, speakerphone for video
  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: media !== 'video',
    });
  } catch { /* expo-av not available in this context */ }

  // Reset the ICE queue for this new call
  resetIceQueue();

  const peer = await createPeer(media, {
    onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
    onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
    onIceCandidate: (candidate) => {
      socket.emit('call:ice', {
        callId,
        to: toAegisId,
        candidate: JSON.stringify(candidate.toJSON?.() ?? candidate),
      });
    },
    onConnectionStateChange: (state) => {
      if (state === 'connected') {
        useCall.getState().setStatus('in-call');
        const { callId: cid } = useCall.getState();
        if (cid) reportCallConnected(cid);
      }
      if (state === 'failed' || state === 'closed') endCall('rtc_failure');
    },
  }, turnConfig);
  // setActivePeer BEFORE createOffer so toggleMute/toggleCamera always see a
  // valid peer reference from this point forward.
  useCall.getState().setActivePeer(peer);

  const offer = await createOffer(peer.pc);
  socket.emit('call:invite', { callId, to: toAegisId, media, offer });

  // Auto-end if callee does not answer within 45 seconds
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

  const { useIdentity } = require('../store/identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
  const ownAegisId = useIdentity.getState().identity?.aegisId ?? 'anon';
  const turnConfig = await fetchTurnConfig(ownAegisId);

  // Reset the ICE queue for this new call leg
  resetIceQueue();

  // Set audio mode for call — earpiece for audio, speakerphone for video.
  // On iOS this is called before CallKit activates the session; the
  // didActivateAudioSession handler in callkeep.ts will re-apply the routing
  // once CallKit hands over the audio session.
  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: media !== 'video',
    });
  } catch { /* expo-av not available in this context */ }

  const peer = await createPeer(media, {
    onLocalStream: (s) => useCall.getState().setStreams(s, useCall.getState().remoteStream),
    onRemoteStream: (s) => useCall.getState().setStreams(useCall.getState().localStream, s),
    onIceCandidate: (candidate) => {
      socket.emit('call:ice', {
        callId,
        to: peerId,
        candidate: JSON.stringify(candidate.toJSON?.() ?? candidate),
      });
    },
    onConnectionStateChange: (state) => {
      if (state === 'connected') {
        useCall.getState().setStatus('in-call');
        const { callId: cid } = useCall.getState();
        if (cid) reportCallConnected(cid);
      }
      if (state === 'failed' || state === 'closed') endCall('rtc_failure');
    },
  }, turnConfig);
  // setActivePeer BEFORE setRemoteOffer so toggleMute/toggleCamera never see null
  useCall.getState().setActivePeer(peer);

  await setRemoteOffer(peer.pc, pendingOffer);
  // Flush ICE candidates that arrived while we were still ringing
  await flushPendingIce(peer.pc);
  const answer = await createAnswer(peer.pc);
  socket.emit('call:answer', { callId, to: peerId, answer });
  // Clear pendingOffer — direction is already stored in the call store.
  useCall.getState().setPendingOffer(null);
}

/** Reject an incoming call or end an active one. */
export function endCall(reason: string = 'hangup'): void {
  clearRingTimeout(); // always cancel the no-answer timer, regardless of call direction
  resetIceQueue();
  const { peer: peerId, callId, activePeer, status, media, startedAt, direction } = useCall.getState();
  const socket = getSocket();
  if (socket && peerId && callId) {
    socket.emit('call:hangup', { callId, to: peerId, reason });
  }

  // Persist call history
  if (callId && peerId) {
    // Use the direction field set at call start — reliable even after pendingOffer is cleared.
    const wasIncoming = direction === 'in';
    const wasAnswered = status === 'in-call';
    const callStatus: 'missed' | 'answered' | 'declined' =
      reason === 'declined' ? 'declined' : wasAnswered ? 'answered' : 'missed';
    const durationS = wasAnswered && startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    saveCall({
      id: callId, contactId: peerId,
      direction: wasIncoming ? 'in' : 'out',
      media: media ?? 'audio',
      status: callStatus,
      startedAt: startedAt ?? Date.now(), durationS,
    }).catch(() => {});

    // Append a system message to the chat thread so the call appears inline
    const { useMessages } = require('../store/messages');
    const { useIdentity } = require('../store/identity');
    if (useIdentity.getState().identity) {
      void useMessages.getState().append({
        id: Crypto.randomUUID(),
        chatId: peerId,
        direction: wasIncoming ? 'in' : 'out',
        body: `[call:${callStatus}:${media ?? 'audio'}:${durationS}s]`,
        createdAt: Date.now(),
        type: 'text',
      });
    }
  }

  // Restore normal audio mode
  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    void Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: false,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
  } catch { /* no-op */ }

  activePeer?.cleanup();

  // Dismiss native call UI
  const { callId: cid } = useCall.getState();
  if (cid) endNativeCall(cid);

  useCall.getState().setStatus('ended');
  setTimeout(() => useCall.getState().reset(), 600);
}

export function toggleMute(): void {
  const { activePeer, muted } = useCall.getState();
  if (!activePeer?.localStream) return;
  const newMuted = !muted;
  for (const track of activePeer.localStream.getAudioTracks()) track.enabled = !newMuted;
  useCall.getState().setMuted(newMuted);
  const { callId: cid } = useCall.getState();
  if (cid) setNativeMuted(cid, newMuted);
}

export function toggleCamera(): void {
  const { activePeer, cameraOff } = useCall.getState();
  if (!activePeer?.localStream) return;
  const newOff = !cameraOff;
  for (const track of activePeer.localStream.getVideoTracks()) track.enabled = !newOff;
  useCall.getState().setCameraOff(newOff);
}
