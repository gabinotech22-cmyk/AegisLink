// `import type` is erased at compile time — zero runtime cost, no native module load.
import type {
  RTCPeerConnection as RTCPeerConnectionT,
  RTCSessionDescription as RTCSessionDescriptionT,
  RTCIceCandidate as RTCIceCandidateT,
  MediaStream,
} from 'react-native-webrtc';
import { rtcConfig, type RTCConfigShape } from './ice';

export type CallMedia = 'audio' | 'video';

// Lazy runtime accessor — only called when a real call starts (never in Expo Go).
function wrtc() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('react-native-webrtc') as typeof import('react-native-webrtc');
}

export interface PeerHandlers {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onIceCandidate: (candidate: RTCIceCandidateT) => void;
  onConnectionStateChange: (state: string) => void;
}

export interface ActivePeer {
  pc: RTCPeerConnectionT;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  cleanup: () => void;
}

export async function createPeer(
  media: CallMedia,
  handlers: PeerHandlers,
  config?: RTCConfigShape,
): Promise<ActivePeer> {
  const { RTCPeerConnection, mediaDevices } = wrtc();
  const pc = new RTCPeerConnection((config ?? rtcConfig()) as never);

  const constraints =
    media === 'video'
      ? { audio: true, video: { facingMode: 'user' } }
      : { audio: true, video: false };
  const localStream = (await mediaDevices.getUserMedia(constraints)) as unknown as MediaStream;
  for (const track of localStream.getTracks()) {
    (pc as any).addTrack(track, localStream);
  }
  handlers.onLocalStream(localStream);

  let remoteStream: MediaStream | null = null;
  (pc as any).addEventListener('track', (event: { streams: MediaStream[] }) => {
    if (event.streams?.[0]) {
      remoteStream = event.streams[0];
      handlers.onRemoteStream(remoteStream);
    }
  });

  (pc as any).addEventListener('icecandidate', (event: { candidate: RTCIceCandidateT | null }) => {
    if (event.candidate) handlers.onIceCandidate(event.candidate);
  });

  (pc as any).addEventListener('connectionstatechange', () => {
    handlers.onConnectionStateChange((pc as any).connectionState);
  });

  const cleanup = () => {
    try { for (const t of localStream.getTracks()) t.stop(); } catch { /* ignore */ }
    try { (pc as any).close(); } catch { /* ignore */ }
  };

  return { pc: pc as unknown as RTCPeerConnectionT, localStream, remoteStream, cleanup };
}

export async function createOffer(pc: RTCPeerConnectionT): Promise<string> {
  const offer = await (pc as any).createOffer({});
  await (pc as any).setLocalDescription(offer);
  return JSON.stringify(offer);
}

export async function setRemoteOffer(pc: RTCPeerConnectionT, offerSdp: string): Promise<void> {
  const { RTCSessionDescription } = wrtc();
  const offer = new RTCSessionDescription(JSON.parse(offerSdp) as ConstructorParameters<typeof RTCSessionDescriptionT>[0]);
  await (pc as any).setRemoteDescription(offer);
}

export async function createAnswer(pc: RTCPeerConnectionT): Promise<string> {
  const answer = await (pc as any).createAnswer();
  await (pc as any).setLocalDescription(answer);
  return JSON.stringify(answer);
}

export async function setRemoteAnswer(pc: RTCPeerConnectionT, answerSdp: string): Promise<void> {
  const { RTCSessionDescription } = wrtc();
  const answer = new RTCSessionDescription(JSON.parse(answerSdp) as ConstructorParameters<typeof RTCSessionDescriptionT>[0]);
  await (pc as any).setRemoteDescription(answer);
}

export async function addRemoteIce(pc: RTCPeerConnectionT, candidate: string): Promise<void> {
  try {
    const { RTCIceCandidate } = wrtc();
    const ice = new RTCIceCandidate(JSON.parse(candidate));
    await (pc as any).addIceCandidate(ice);
  } catch (e) {
    if (__DEV__) console.warn('[webrtc] addIceCandidate failed', (e as Error).message);
  }
}
