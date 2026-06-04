/**
 * Group call signaling for AegisLink.
 *
 * Topology: full-mesh peer-to-peer. For N participants: N*(N-1)/2 peer
 * connections. Limit: 8 participants max. Audio-only for MVP.
 *
 * All SDP offers, answers, and ICE candidates are sealed with NaCl box to
 * the recipient's static X25519 public key before reaching the relay — the
 * same sealed-signaling pattern as 1:1 calls in calls.ts.
 *
 * Wire events (routed by relay using `to` / `from`):
 *   group_call:invite  — initiator → all members
 *   group_call:accept  — member → initiator (triggers offer creation)
 *   group_call:decline — member → initiator
 *   group_call:offer   — sealed SDP offer A→B
 *   group_call:answer  — sealed SDP answer B→A
 *   group_call:ice     — sealed ICE candidate
 *   group_call:hangup  — leaving the call
 */

import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { Alert } from 'react-native';
import { getSocket, isConnected } from './client';
import { useGroupCall } from '../store/groupCall';
import { fetchTurnConfig } from '../webrtc/ice';
import {
  createPeer,
  createOffer,
  setRemoteOffer,
  createAnswer,
  setRemoteAnswer,
  addRemoteIce,
  type ActivePeer,
} from '../webrtc/peer';
import type { Identity } from '../crypto/identity';

// ---------------------------------------------------------------------------
// NaCl sealed-signaling helpers (mirrors calls.ts)
// ---------------------------------------------------------------------------

const SIGNAL_VERSION = 1;

interface SealedSignalWire {
  ciphertext: string;
  nonce: string;
}

interface SignalInner {
  v: number;
  from: string;
  payload: string;
}

function peerPublicKey(aegisId: string): Uint8Array | null {
  try {
    const { useContacts } = require('../store/contacts') as {
      useContacts: {
        getState: () => { get: (id: string) => { publicKeyB64: string } | undefined };
      };
    };
    const b64 = useContacts.getState().get(aegisId)?.publicKeyB64;
    if (!b64) return null;
    const key = decodeBase64(b64);
    return key.length === nacl.box.publicKeyLength ? key : null;
  } catch {
    return null;
  }
}

function ownKeys(): { secretKey: Uint8Array; aegisId: string } | null {
  try {
    const { useIdentity } = require('../store/identity') as {
      useIdentity: {
        getState: () => { identity: { secretKey: Uint8Array; aegisId: string } | null };
      };
    };
    const id = useIdentity.getState().identity;
    if (!id) return null;
    return { secretKey: id.secretKey, aegisId: id.aegisId };
  } catch {
    return null;
  }
}

function sealSignal(recipientAegisId: string, payload: string): SealedSignalWire | null {
  const recipientPub = peerPublicKey(recipientAegisId);
  const me = ownKeys();
  if (!recipientPub || !me) return null;

  const inner: SignalInner = { v: SIGNAL_VERSION, from: me.aegisId, payload };
  const innerBytes = new TextEncoder().encode(JSON.stringify(inner));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(innerBytes, nonce, recipientPub, me.secretKey);
  return { ciphertext: encodeBase64(ciphertext), nonce: encodeBase64(nonce) };
}

function openSignal(senderAegisId: string, wire: SealedSignalWire): string | null {
  const senderPub = peerPublicKey(senderAegisId);
  const me = ownKeys();
  if (!senderPub || !me) return null;

  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  try {
    ciphertext = decodeBase64(wire.ciphertext);
    nonce = decodeBase64(wire.nonce);
  } catch {
    return null;
  }
  if (nonce.length !== nacl.box.nonceLength) return null;

  const opened = nacl.box.open(ciphertext, nonce, senderPub, me.secretKey);
  if (!opened) return null;

  let inner: SignalInner;
  try {
    inner = JSON.parse(new TextDecoder().decode(opened)) as SignalInner;
  } catch {
    return null;
  }
  if (inner.v !== SIGNAL_VERSION) return null;
  if (inner.from !== senderAegisId) return null;
  if (typeof inner.payload !== 'string') return null;
  return inner.payload;
}

// ---------------------------------------------------------------------------
// Per-participant peer connections
// ---------------------------------------------------------------------------

interface GroupActivePeer extends ActivePeer {
  remoteDescSet: boolean;
  pendingIce: string[];
}

/** callId → (remoteAegisId → GroupActivePeer) */
const groupPeerMap = new Map<string, Map<string, GroupActivePeer>>();

// ICE candidates that arrive for a remote BEFORE its GroupActivePeer exists.
// Peer creation is async (getUserMedia + TURN fetch), so a remote's early
// trickled candidates used to hit `if (!groupPeer) return` and be dropped —
// leaving that mesh leg without a route and never connecting. Buffer them here
// keyed by `${callId}|${fromAegisId}` and drain into the peer the moment it is
// created. Mirrors the 1:1 ring-window fix in calls.ts.
const _groupPrePeerIce = new Map<string, string[]>();
const prePeerKey = (callId: string, from: string): string => `${callId}|${from}`;

function getPeersForCall(callId: string): Map<string, GroupActivePeer> {
  if (!groupPeerMap.has(callId)) {
    groupPeerMap.set(callId, new Map());
  }
  return groupPeerMap.get(callId)!;
}

/** Drain any pre-peer-buffered ICE for (callId, from) into a freshly created peer. */
function drainPrePeerIce(callId: string, from: string, groupPeer: GroupActivePeer): void {
  const key = prePeerKey(callId, from);
  const queued = _groupPrePeerIce.get(key);
  if (!queued) return;
  _groupPrePeerIce.delete(key);
  for (const c of queued) void bufferOrApplyIce(groupPeer, c);
}

function cleanupPeer(peer: GroupActivePeer): void {
  try { peer.cleanup(); } catch { /* ignore */ }
}

function cleanupAllPeers(callId: string): void {
  const peers = groupPeerMap.get(callId);
  if (peers) {
    for (const peer of peers.values()) cleanupPeer(peer);
    peers.clear();
  }
  groupPeerMap.delete(callId);
  // Drop any pre-peer ICE buffered for this call so a later call can't inherit
  // stale candidates.
  for (const k of _groupPrePeerIce.keys()) {
    if (k.startsWith(`${callId}|`)) _groupPrePeerIce.delete(k);
  }
}

// ---------------------------------------------------------------------------
// ICE buffering helpers
// ---------------------------------------------------------------------------

async function bufferOrApplyIce(groupPeer: GroupActivePeer, candidate: string): Promise<void> {
  if (groupPeer.remoteDescSet) {
    await addRemoteIce(groupPeer.pc, candidate);
  } else {
    groupPeer.pendingIce.push(candidate);
  }
}

async function markRemoteDescSet(groupPeer: GroupActivePeer): Promise<void> {
  groupPeer.remoteDescSet = true;
  while (groupPeer.pendingIce.length > 0) {
    const c = groupPeer.pendingIce.shift()!;
    await addRemoteIce(groupPeer.pc, c);
  }
}

// ---------------------------------------------------------------------------
// Orphan-guard: if all peers for a call failed and the call never reached
// 'in-call', transition to 'ended' and release mic/audio resources.
// ---------------------------------------------------------------------------

function maybeFinalizeFailedCall(callId: string): void {
  const peers = groupPeerMap.get(callId);
  const remainingPeers = peers?.size ?? 0;
  if (remainingPeers > 0) return;

  const state = useGroupCall.getState();
  if (state.callId !== callId) return;
  if (state.status === 'in-call' || state.status === 'ended' || state.status === 'idle') return;

  if (__DEV__) console.warn('[groupCalls] all peers failed for', callId, '— finalizing call');

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

  cleanupAllPeers(callId);
  useGroupCall.getState().setStatus('ended');
  setTimeout(() => {
    if (useGroupCall.getState().callId === callId) {
      useGroupCall.getState().reset();
    }
  }, 800);
}

// ---------------------------------------------------------------------------
// Build a single RTCPeerConnection to a remote participant (offerer side)
// ---------------------------------------------------------------------------

async function createGroupPeerAsOfferer(
  callId: string,
  remoteAegisId: string,
): Promise<void> {
  const socket = getSocket();
  const me = ownKeys();
  if (!socket || !me) return;

  let turnConfig: import('../webrtc/ice').RTCConfigShape | undefined;
  // forceRelay=false: allow direct/STUN candidates (relay-only gave one-way audio
  // via coturn hairpinning). TURN stays as fallback.
  try { turnConfig = await fetchTurnConfig(me.aegisId, false); } catch { /* default */ }

  const peer = await createPeer(
    'audio',
    {
      onLocalStream: (stream) => useGroupCall.getState().setLocalStream(stream),
      onRemoteStream: (stream) => useGroupCall.getState().setParticipantStream(remoteAegisId, stream),
      onIceCandidate: (candidate) => {
        const payload = JSON.stringify(candidate.toJSON?.() ?? candidate);
        const sealed = sealSignal(remoteAegisId, payload);
        if (!sealed) {
          if (__DEV__) console.warn('[groupCalls] cannot seal ICE for', remoteAegisId);
          return;
        }
        socket.emit('group_call:ice', { callId, to: remoteAegisId, ...sealed });
      },
      onConnectionStateChange: (state) => {
        if (__DEV__) console.log('[groupCalls] peer', remoteAegisId, 'state:', state);
        if (state === 'connected') {
          useGroupCall.getState().setParticipantConnected(remoteAegisId, true);
          useGroupCall.getState().setStatus('in-call');
        }
        if (state === 'failed' || state === 'closed') {
          useGroupCall.getState().setParticipantConnected(remoteAegisId, false);
        }
      },
    },
    turnConfig,
  );

  const groupPeer: GroupActivePeer = { ...peer, remoteDescSet: false, pendingIce: [] };
  getPeersForCall(callId).set(remoteAegisId, groupPeer);
  drainPrePeerIce(callId, remoteAegisId, groupPeer);

  // Create and send sealed offer
  try {
    const offer = await createOffer(peer.pc);
    const sealed = sealSignal(remoteAegisId, offer);
    if (!sealed) {
      if (__DEV__) console.warn('[groupCalls] cannot seal offer for', remoteAegisId);
      cleanupPeer(groupPeer);
      getPeersForCall(callId).delete(remoteAegisId);
      maybeFinalizeFailedCall(callId);
      return;
    }
    socket.emit('group_call:offer', { callId, to: remoteAegisId, ...sealed });
  } catch (e) {
    if (__DEV__) console.warn('[groupCalls] createOffer failed for', remoteAegisId, e);
    cleanupPeer(groupPeer);
    getPeersForCall(callId).delete(remoteAegisId);
    maybeFinalizeFailedCall(callId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an outgoing group call. Emits `group_call:invite` to each member.
 * RTCPeerConnections are created per-member as they accept.
 */
export async function startGroupCall(
  identity: Identity,
  group: { id: string; name: string; members: string[] },
  otherMembers: string[],
): Promise<void> {
  const socket = getSocket();
  if (!socket || !isConnected()) {
    Alert.alert('Sin conexión', 'Necesitas estar conectado para iniciar una llamada grupal.');
    return;
  }

  const callId = Crypto.randomUUID();
  useGroupCall.getState().startOutgoing(callId, group.id, group.name, otherMembers);

  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: true,
    });
  } catch { /* expo-av unavailable */ }

  socket.emit('group_call:invite', {
    to: otherMembers,
    callId,
    groupId: group.id,
    groupName: group.name,
    media: 'audio',
  });
}

/**
 * Accept an incoming group call. Emits `group_call:accept` to the initiator.
 * The initiator will then send SDP offers to us.
 */
export async function acceptGroupCall(
  callId: string,
  initiatorAegisId: string,
): Promise<void> {
  const socket = getSocket();
  if (!socket) return;

  useGroupCall.getState().setStatus('connecting');

  try {
    const { Audio } = require('expo-av') as typeof import('expo-av');
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: true,
    });
  } catch { /* expo-av unavailable */ }

  socket.emit('group_call:accept', { to: initiatorAegisId, callId });
}

/**
 * Decline an incoming group call.
 */
export function declineGroupCall(callId: string, initiatorAegisId: string): void {
  const socket = getSocket();
  if (socket) {
    socket.emit('group_call:decline', { to: initiatorAegisId, callId });
  }
  useGroupCall.getState().reset();
}

/**
 * Leave/end the group call. Sends hangup to all participants and cleans up
 * all RTCPeerConnections.
 */
export function hangupGroupCall(): void {
  const { callId, participants } = useGroupCall.getState();
  if (!callId) return;

  const socket = getSocket();
  const allAegisIds = participants.map((p) => p.aegisId);
  if (socket && allAegisIds.length > 0) {
    socket.emit('group_call:hangup', { to: allAegisIds, callId });
  }

  cleanupAllPeers(callId);

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

  useGroupCall.getState().setStatus('ended');
  setTimeout(() => useGroupCall.getState().reset(), 800);
}

/**
 * Toggle local microphone mute.
 */
export function toggleGroupCallMute(): void {
  const { localStream, muted } = useGroupCall.getState();
  if (!localStream) return;
  const newMuted = !muted;
  for (const track of localStream.getAudioTracks()) {
    track.enabled = !newMuted;
  }
  useGroupCall.getState().setMuted(newMuted);
}

// ---------------------------------------------------------------------------
// Socket event listeners — mirrors attachCallHandlers() in calls.ts
// ---------------------------------------------------------------------------

/**
 * Register all `group_call:*` socket event listeners. Call this once after
 * the socket connects and authenticates (from App.tsx alongside attachCallHandlers).
 */
export function attachGroupCallHandlers(): void {
  const socket = getSocket();
  if (!socket) return;

  // ── Initiator receives accept from a member ─────────────────────────────
  socket.on(
    'group_call:accept',
    (msg: { from: string; callId: string }) => {
      const state = useGroupCall.getState();
      if (state.callId !== msg.callId) return;
      if (state.status !== 'ringing-out' && state.status !== 'in-call' && state.status !== 'connecting') return;

      state.addParticipant(msg.from);
      if (state.status === 'ringing-out') {
        useGroupCall.getState().setStatus('connecting');
      }

      void createGroupPeerAsOfferer(msg.callId, msg.from).catch((e) => {
        if (__DEV__) console.warn('[groupCalls] createGroupPeerAsOfferer failed for', msg.from, e);
      });
    },
  );

  // ── Member receives decline ─────────────────────────────────────────────
  socket.on(
    'group_call:decline',
    (msg: { from: string; callId: string }) => {
      const state = useGroupCall.getState();
      if (state.callId !== msg.callId) return;
      if (__DEV__) console.log('[groupCalls]', msg.from, 'declined');
      const peers = groupPeerMap.get(msg.callId);
      if (peers) {
        const peer = peers.get(msg.from);
        if (peer) { cleanupPeer(peer); peers.delete(msg.from); }
      }
    },
  );

  // ── Receive sealed SDP offer (non-initiator gets this) ────────────────────
  socket.on(
    'group_call:offer',
    (msg: { from: string; callId: string; ciphertext: string; nonce: string }) => {
      const state = useGroupCall.getState();
      if (state.callId !== msg.callId) return;

      const offerSdp = openSignal(msg.from, msg);
      if (!offerSdp) {
        if (__DEV__) console.warn('[groupCalls] failed to open offer from', msg.from);
        return;
      }

      state.addParticipant(msg.from);

      const socket2 = getSocket();
      const me = ownKeys();
      if (!socket2 || !me) return;

      void (async () => {
        let turnConfig: import('../webrtc/ice').RTCConfigShape | undefined;
        // forceRelay=false: allow direct/STUN candidates (relay-only gave one-way audio
  // via coturn hairpinning). TURN stays as fallback.
  try { turnConfig = await fetchTurnConfig(me.aegisId, false); } catch { /* default */ }

        const peer = await createPeer(
          'audio',
          {
            onLocalStream: (stream) => useGroupCall.getState().setLocalStream(stream),
            onRemoteStream: (stream) => useGroupCall.getState().setParticipantStream(msg.from, stream),
            onIceCandidate: (candidate) => {
              const payload = JSON.stringify(candidate.toJSON?.() ?? candidate);
              const sealed = sealSignal(msg.from, payload);
              if (!sealed) return;
              socket2.emit('group_call:ice', { callId: msg.callId, to: msg.from, ...sealed });
            },
            onConnectionStateChange: (connState) => {
              if (connState === 'connected') {
                useGroupCall.getState().setParticipantConnected(msg.from, true);
                useGroupCall.getState().setStatus('in-call');
              }
              if (connState === 'failed' || connState === 'closed') {
                useGroupCall.getState().setParticipantConnected(msg.from, false);
              }
            },
          },
          turnConfig,
        );

        const groupPeer: GroupActivePeer = { ...peer, remoteDescSet: false, pendingIce: [] };
        getPeersForCall(msg.callId).set(msg.from, groupPeer);
        drainPrePeerIce(msg.callId, msg.from, groupPeer);

        try {
          await setRemoteOffer(peer.pc, offerSdp);
          await markRemoteDescSet(groupPeer);
          const answer = await createAnswer(peer.pc);
          const sealed = sealSignal(msg.from, answer);
          if (!sealed) {
            if (__DEV__) console.warn('[groupCalls] cannot seal answer for', msg.from);
            cleanupPeer(groupPeer);
            getPeersForCall(msg.callId).delete(msg.from);
            maybeFinalizeFailedCall(msg.callId);
            return;
          }
          socket2.emit('group_call:answer', { callId: msg.callId, to: msg.from, ...sealed });
        } catch (e) {
          if (__DEV__) console.warn('[groupCalls] offer handling failed for', msg.from, e);
          cleanupPeer(groupPeer);
          getPeersForCall(msg.callId).delete(msg.from);
          maybeFinalizeFailedCall(msg.callId);
        }
      })();
    },
  );

  // ── Receive sealed SDP answer ─────────────────────────────────────────────
  socket.on(
    'group_call:answer',
    (msg: { from: string; callId: string; ciphertext: string; nonce: string }) => {
      const state = useGroupCall.getState();
      if (state.callId !== msg.callId) return;

      const answerSdp = openSignal(msg.from, msg);
      if (!answerSdp) {
        if (__DEV__) console.warn('[groupCalls] failed to open answer from', msg.from);
        return;
      }

      const groupPeer = getPeersForCall(msg.callId).get(msg.from);
      if (!groupPeer) return;

      void (async () => {
        try {
          await setRemoteAnswer(groupPeer.pc, answerSdp);
          await markRemoteDescSet(groupPeer);
        } catch (e) {
          if (__DEV__) console.warn('[groupCalls] setRemoteAnswer failed for', msg.from, e);
        }
      })();
    },
  );

  // ── Receive sealed ICE candidate ──────────────────────────────────────────
  socket.on(
    'group_call:ice',
    (msg: { from: string; callId: string; ciphertext: string; nonce: string }) => {
      const state = useGroupCall.getState();
      if (state.callId !== msg.callId) return;

      const candidateJson = openSignal(msg.from, msg);
      if (!candidateJson) {
        if (__DEV__) console.warn('[groupCalls] failed to open ICE from', msg.from);
        return;
      }

      const groupPeer = getPeersForCall(msg.callId).get(msg.from);
      if (!groupPeer) {
        // Peer for this remote not created yet (still acquiring mic / TURN).
        // Buffer the candidate instead of dropping it; drainPrePeerIce flushes
        // it as soon as the peer is created.
        const key = prePeerKey(msg.callId, msg.from);
        const arr = _groupPrePeerIce.get(key) ?? [];
        arr.push(candidateJson);
        _groupPrePeerIce.set(key, arr);
        return;
      }

      void bufferOrApplyIce(groupPeer, candidateJson);
    },
  );

  // ── Incoming group call invite ─────────────────────────────────────────────
  socket.on(
    'group_call:invite',
    (msg: {
      from: string;
      callId: string;
      groupId: string;
      groupName: string;
      media: 'audio' | 'video';
    }) => {
      const currentStatus = useGroupCall.getState().status;
      // Auto-decline if already in a call
      if (currentStatus !== 'idle' && currentStatus !== 'ended') {
        const sock = getSocket();
        sock?.emit('group_call:decline', { to: msg.from, callId: msg.callId });
        return;
      }

      // Try to resolve trusted group name from local store
      let groupName = msg.groupName;
      try {
        const { useGroups } = require('../store/groups') as {
          useGroups: { getState: () => { groups: Array<{ id: string; name: string }> } };
        };
        const localGroup = useGroups.getState().groups.find((g) => g.id === msg.groupId);
        if (localGroup) groupName = localGroup.name;
      } catch { /* ignore */ }

      useGroupCall.getState().startIncoming(msg.callId, msg.groupId, groupName, msg.from);
    },
  );

  // ── Remote peer hangs up ──────────────────────────────────────────────────
  socket.on(
    'group_call:hangup',
    (msg: { from: string; callId: string }) => {
      const state = useGroupCall.getState();
      if (state.callId !== msg.callId) return;

      const peers = groupPeerMap.get(msg.callId);
      if (peers) {
        const peer = peers.get(msg.from);
        if (peer) { cleanupPeer(peer); peers.delete(msg.from); }
      }
      useGroupCall.getState().setParticipantConnected(msg.from, false);

      // If the initiator hangs up during ringing-in (before we're in-call), end completely
      const isInitiator = state.initiator === msg.from;
      const remainingPeers = peers?.size ?? 0;
      if (isInitiator && remainingPeers === 0 && state.status !== 'in-call') {
        useGroupCall.getState().setStatus('ended');
        setTimeout(() => useGroupCall.getState().reset(), 800);
      }
    },
  );
}
