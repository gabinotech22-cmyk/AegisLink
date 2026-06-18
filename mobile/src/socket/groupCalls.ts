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
;
import { getSocket, isConnected } from './client';
import { useGroupCall } from '../store/groupCall';
import { useActiveCalls } from '../store/activeCalls';
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
import { themedAlert } from '../components/AlertHost';
import { startInCallAudio, stopInCallAudio } from '../webrtc/inCall';
import { startCallService, stopCallService } from '../webrtc/callForegroundService';

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

  // Release proximity sensor, wake-lock and audio focus, and tear down the
  // Android foreground service / its persistent notification.
  stopInCallAudio();
  stopCallService();

  cleanupAllPeers(callId);
  stopHeartbeat();
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
// Voice-channel heartbeat (Discord-style awareness, no server state)
//
// While we are in a group call we periodically re-broadcast a `group_call:channel`
// event to the rest of the group carrying the current participant roster. Online
// members render a "join" banner from it (useActiveCalls); offline members get a
// relay push wake-up. Awareness self-heals: if we stop (hangup/crash) the
// heartbeat stops and every receiver's banner goes stale after STALE_MS.
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 20_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let channelMeta: { callId: string; groupId: string; groupName: string; members: string[] } | null = null;
let _pruneTimer: ReturnType<typeof setInterval> | null = null;
// callIds we've already raised a local "Unirse" notification for — so the 20s
// heartbeats don't re-notify. Bounded; oldest evicted past 256 entries.
const _notifiedChannelCallIds = new Set<string>();

/** Participants we currently believe are in the call (us + known peers). */
function currentParticipants(): string[] {
  const me = ownKeys()?.aegisId;
  const others = useGroupCall.getState().participants.map((p) => p.aegisId);
  const all = me ? [me, ...others] : others;
  return Array.from(new Set(all));
}

function emitChannelHeartbeat(): void {
  const socket = getSocket();
  const me = ownKeys()?.aegisId;
  if (!socket || !channelMeta || !me) return;
  const recipients = channelMeta.members.filter((m) => m !== me);
  if (recipients.length === 0) return;
  socket.emit('group_call:channel', {
    to: recipients,
    callId: channelMeta.callId,
    groupId: channelMeta.groupId,
    groupName: channelMeta.groupName,
    participants: currentParticipants(),
    media: 'audio',
  });
}

function startHeartbeat(meta: { callId: string; groupId: string; groupName: string; members: string[] }): void {
  channelMeta = meta;
  emitChannelHeartbeat(); // announce immediately, then on an interval
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(emitChannelHeartbeat, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  channelMeta = null;
}

/** Resolve a group's trusted name + member list from the local store. */
function localGroupInfo(groupId: string): { name: string; members: string[] } | null {
  try {
    const { useGroups } = require('../store/groups') as typeof import('../store/groups');
    const g = useGroups.getState().groups.find((x) => x.id === groupId);
    return g ? { name: g.name, members: g.members } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a group voice channel. Instead of ringing everyone, we announce the
 * channel (group_call:channel) and start heartbeating; members see a banner and
 * join when they want. We enter the call immediately (alone) and mesh with each
 * member as they join.
 */
export async function startGroupCall(
  identity: Identity,
  group: { id: string; name: string; members: string[] },
  otherMembers: string[],
): Promise<void> {
  const socket = getSocket();
  if (!socket || !isConnected()) {
    themedAlert('Sin conexión', 'Necesitas estar conectado para iniciar una llamada grupal.');
    return;
  }

  void otherMembers; // recipients are derived from group.members in the heartbeat
  const callId = Crypto.randomUUID();
  // Enter the channel immediately (alone). startOutgoing with an empty roster,
  // then mark in-call — we are "in the channel" and waiting for joiners.
  useGroupCall.getState().startOutgoing(callId, group.id, group.name, []);
  useGroupCall.getState().setStatus('in-call');

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

  // Earpiece route + proximity sensor (real screen-off near the ear), plus an
  // Android foreground service so the call survives the app being backgrounded.
  startInCallAudio();
  startCallService(useGroupCall.getState().groupName || 'AegisLink', 'Llamada de voz en curso');

  // Announce the channel + start heartbeating. No ring — members get a banner.
  startHeartbeat({ callId, groupId: group.id, groupName: group.name, members: group.members });
}

/**
 * Join an already-open voice channel for `groupId`. Reads the current roster
 * from the banner state and announces our join (`group_call:accept`) to every
 * current participant, each of whom offers us a peer connection — reusing the
 * exact mesh path that the initiator/accept flow already uses.
 */
export async function joinGroupCall(groupId: string): Promise<void> {
  const active = useActiveCalls.getState().getFresh(groupId, Date.now());
  if (!active) {
    themedAlert('Llamada finalizada', 'Esta llamada ya no está activa.');
    return;
  }
  const socket = getSocket();
  const me = ownKeys();
  if (!socket || !isConnected() || !me) {
    themedAlert('Sin conexión', 'Necesitas estar conectado para unirte a la llamada.');
    return;
  }

  const info = localGroupInfo(groupId);
  const groupName = info?.name ?? groupId;
  const others = active.participants.filter((p) => p !== me.aegisId);

  // Enforce the mesh cap on the resulting size (existing peers + us).
  if (others.length >= 8) {
    themedAlert('Llamada llena', 'Esta llamada alcanzó el máximo de 8 participantes.');
    return;
  }

  useGroupCall.getState().startOutgoing(active.callId, groupId, groupName, []);
  useGroupCall.getState().setStatus('connecting');
  for (const p of others) useGroupCall.getState().addParticipant(p);

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

  // Earpiece route + proximity sensor (real screen-off near the ear), plus an
  // Android foreground service so the call survives the app being backgrounded.
  startInCallAudio();
  startCallService(useGroupCall.getState().groupName || 'AegisLink', 'Llamada de voz en curso');

  // Tell each current participant we joined — their accept handler offers to us.
  for (const p of others) {
    socket.emit('group_call:accept', { to: p, callId: active.callId });
  }

  // Start our own heartbeat so the rest of the group sees us in the roster, and
  // drop our local banner for this group (we're in the call now).
  const members = info?.members ?? [...active.participants, me.aegisId];
  startHeartbeat({ callId: active.callId, groupId, groupName, members });
  useActiveCalls.getState().remove(groupId);
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

  // Earpiece route + proximity sensor (real screen-off near the ear), plus an
  // Android foreground service so the call survives the app being backgrounded.
  startInCallAudio();
  startCallService(useGroupCall.getState().groupName || 'AegisLink', 'Llamada de voz en curso');

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

  stopHeartbeat();
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

  // Release proximity sensor, wake-lock and audio focus, and tear down the
  // Android foreground service / its persistent notification.
  stopInCallAudio();
  stopCallService();

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

  // Idempotent (see attachCallHandlers): a reconnect builds a new socket.io
  // instance, so clear our events before (re)registering to avoid both lost
  // handlers after a socket recreation and stacked duplicates on re-attach.
  for (const ev of [
    'group_call:accept',
    'group_call:decline',
    'group_call:offer',
    'group_call:answer',
    'group_call:ice',
    'group_call:channel',
    'group_call:hangup',
  ]) {
    socket.off(ev);
  }

  // Periodic banner pruning so stale channels (everyone left / crashed) drop
  // their banners after STALE_MS even without an explicit teardown signal.
  if (_pruneTimer) clearInterval(_pruneTimer);
  _pruneTimer = setInterval(() => useActiveCalls.getState().prune(Date.now()), 10_000);

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

  // ── Voice-channel heartbeat → banner awareness (no ring) ───────────────────
  socket.on(
    'group_call:channel',
    (msg: {
      from: string;
      callId: string;
      groupId: string;
      groupName: string;
      participants?: string[];
      media: 'audio' | 'video';
    }) => {
      // If this heartbeat is for the call I'm already in, it's not a banner.
      if (useGroupCall.getState().callId === msg.callId) return;

      // ── Membership gate (receiver-side) ────────────────────────────────────
      // Drop heartbeats from unknown groups or from senders not in our trusted
      // member list. This is a UX gate, not a cryptographic boundary — the relay
      // already authenticates every sender via Ed25519 challenge-response. We
      // intentionally do NOT enforce admin-only here: the Discord-style channel
      // model lets any member open a voice channel (the banner is passive, it does
      // not ring anyone).
      let localGroup: import('../db/local').StoredGroup | undefined;
      try {
        const { useGroups } = require('../store/groups') as typeof import('../store/groups');
        localGroup = useGroups.getState().groups.find((g) => g.id === msg.groupId);
      } catch { return; }
      if (!localGroup) return; // Unknown group — ignore
      // A heartbeat can come from any participant; gate on the channel's
      // initiator. First sighting records the initiator; later heartbeats keep it.
      const existing = useActiveCalls.getState().calls[msg.groupId];
      const initiator = existing?.callId === msg.callId ? existing.initiator : msg.from;
      if (!localGroup.members.includes(initiator)) {
        if (__DEV__) console.warn('[groupCalls] channel dropped — initiator not in group', initiator);
        return;
      }

      const isNewChannel = existing?.callId !== msg.callId;

      useActiveCalls.getState().upsert({
        callId: msg.callId,
        groupId: msg.groupId,
        initiator,
        participants: msg.participants && msg.participants.length > 0 ? msg.participants : [msg.from],
        lastHeartbeat: Date.now(),
      });

      // First time we see THIS channel (not every 20s heartbeat): surface the
      // local "Unirse / Descartar" notification. Skipped when this group's chat
      // is already on screen (the in-chat banner covers that), inside push.ts.
      if (isNewChannel && !_notifiedChannelCallIds.has(msg.callId)) {
        _notifiedChannelCallIds.add(msg.callId);
        if (_notifiedChannelCallIds.size > 256) {
          _notifiedChannelCallIds.delete(_notifiedChannelCallIds.values().next().value as string);
        }
        try {
          const { showGroupCallChannelNotification } =
            require('../notifications/push') as typeof import('../notifications/push');
          void showGroupCallChannelNotification(msg.groupId, msg.groupName, msg.callId);
        } catch { /* push module not ready — banner still shows in-app */ }
      }
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
