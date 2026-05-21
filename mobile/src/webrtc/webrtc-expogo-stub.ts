/**
 * Stub for react-native-webrtc when running in Expo Go.
 *
 * react-native-webrtc is a native module — Expo Go doesn't include it, and
 * even importing it crashes the bundle on load. `metro.config.js` aliases
 * `react-native-webrtc` to this file when AEGIS_EXPO_GO=1.
 *
 * The stub mirrors the public API surface so TypeScript stays happy. Any
 * runtime use throws a clear error — calls are simply unavailable in Expo Go.
 * Build a dev client (`eas build --profile development`) to use real WebRTC.
 */
import type { ReactNode } from 'react';

const NOT_AVAILABLE =
  'WebRTC is not available in Expo Go. Build a dev client with `eas build --profile development` to make calls.';

class Unsupported {
  constructor() {
    throw new Error(NOT_AVAILABLE);
  }
}

export const RTCPeerConnection = Unsupported as unknown as new (...args: unknown[]) => unknown;
export const RTCSessionDescription = Unsupported as unknown as new (...args: unknown[]) => unknown;
export const RTCIceCandidate = Unsupported as unknown as new (...args: unknown[]) => unknown;

// RTCView is a component; render nothing in the stub (Call screen never opens
// in Expo Go anyway because handleCall throws before navigation).
export function RTCView(_props: Record<string, unknown>): ReactNode {
  return null;
}

export const mediaDevices = {
  async getUserMedia(): Promise<never> {
    throw new Error(NOT_AVAILABLE);
  },
  async enumerateDevices(): Promise<never> {
    throw new Error(NOT_AVAILABLE);
  },
};

// Re-exported types so importing modules typecheck.
export type MediaStream = {
  toURL(): string;
  getTracks(): { stop(): void; enabled: boolean }[];
  getAudioTracks(): { enabled: boolean }[];
  getVideoTracks(): { enabled: boolean }[];
};
