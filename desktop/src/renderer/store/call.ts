import { create } from 'zustand';

/**
 * Call state for the Electron renderer.
 *
 * Mobile uses react-native-webrtc's MediaStream type; in the renderer the
 * browser-native MediaStream is available globally. The ActivePeer/CallMedia
 * shapes are kept as opaque structural types — the desktop WebRTC layer (to
 * be ported) will fill them in.
 */

export type CallMedia = 'audio' | 'video';

export interface ActivePeer {
  // Opaque — defined by the desktop webrtc/peer module once ported.
  peerId: string;
  cleanup?: () => void;
  [key: string]: unknown;
}

export type CallStatus =
  | 'idle'
  | 'outgoing-ringing'
  | 'incoming-ringing'
  | 'connecting'
  | 'in-call'
  | 'ended';

export interface CallState {
  callId: string | null;
  peer: string | null;
  pendingOffer: string | null;
  media: CallMedia;
  status: CallStatus;
  startedAt: number | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  activePeer: ActivePeer | null;
  muted: boolean;
  cameraOff: boolean;

  setStatus: (s: CallStatus) => void;
  setStreams: (local: MediaStream | null, remote: MediaStream | null) => void;
  setActivePeer: (p: ActivePeer | null) => void;
  setPendingOffer: (offer: string | null) => void;
  setMuted: (m: boolean) => void;
  setCameraOff: (off: boolean) => void;
  reset: () => void;
  startOutgoing: (peer: string, callId: string, media: CallMedia) => void;
  startIncoming: (peer: string, callId: string, media: CallMedia, offer: string) => void;
}

const initial: Omit<
  CallState,
  | 'setStatus'
  | 'setStreams'
  | 'setActivePeer'
  | 'setPendingOffer'
  | 'setMuted'
  | 'setCameraOff'
  | 'reset'
  | 'startOutgoing'
  | 'startIncoming'
> = {
  callId: null,
  peer: null,
  pendingOffer: null,
  media: 'audio',
  status: 'idle',
  startedAt: null,
  localStream: null,
  remoteStream: null,
  activePeer: null,
  muted: false,
  cameraOff: false,
};

export const useCall = create<CallState>((set) => ({
  ...initial,
  setStatus: (s) => set({ status: s, startedAt: s === 'in-call' ? Date.now() : undefined }),
  setStreams: (local, remote) => set({ localStream: local, remoteStream: remote }),
  setActivePeer: (p) => set({ activePeer: p }),
  setPendingOffer: (offer) => set({ pendingOffer: offer }),
  setMuted: (m) => set({ muted: m }),
  setCameraOff: (off) => set({ cameraOff: off }),
  reset: () => set({ ...initial }),
  startOutgoing: (peer, callId, media) =>
    set({ ...initial, peer, callId, media, status: 'outgoing-ringing' }),
  startIncoming: (peer, callId, media, offer) =>
    set({ ...initial, peer, callId, media, status: 'incoming-ringing', pendingOffer: offer }),
}));
