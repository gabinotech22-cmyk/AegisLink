import { Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import { useCall } from '../store/call';
import { acceptCall, endCall } from '../socket/calls';

let _initialized = false;

export function initCallKeep(): void {
  if (_initialized || Platform.OS === 'web') return;
  _initialized = true;

  RNCallKeep.setup({
    ios: {
      appName: 'AegisLink',
      supportsVideo: true,
      maximumCallGroups: '1',
      maximumCallsPerCallGroup: '1',
      includesCallsInRecents: false, // privacy — don't show in iOS recents
    },
    android: {
      alertTitle: 'Permisos requeridos',
      alertDescription: 'AegisLink necesita acceso al teléfono para llamadas cifradas.',
      cancelButton: 'Cancelar',
      okButton: 'Aceptar',
      additionalPermissions: [],
      foregroundService: {
        channelId: 'aegislink-calls',
        channelName: 'AegisLink Llamadas',
        notificationTitle: 'AegisLink · Llamada activa',
        notificationIcon: 'ic_notification',
      },
      selfManaged: true,
    },
  }).catch(() => { /* permissions denied */ });

  // User answered via native CallKit/Android UI
  RNCallKeep.addEventListener('answerCall', ({ callUUID }: { callUUID: string }) => {
    const state = useCall.getState();
    if (state.callId === callUUID) {
      void acceptCall();
    }
  });

  // User ended/rejected via native UI
  RNCallKeep.addEventListener('endCall', ({ callUUID }: { callUUID: string }) => {
    const state = useCall.getState();
    if (state.callId === callUUID || state.status === 'incoming-ringing') {
      endCall('declined');
    }
  });

  // Required by iOS — must call when audio session is activated
  RNCallKeep.addEventListener('didActivateAudioSession', () => {
    // Audio session activated by CallKit — no additional action needed
    // expo-av routing is handled in calls.ts
  });

  RNCallKeep.addEventListener('didDisplayIncomingCall', ({ callUUID, error }: { callUUID: string; error?: string }) => {
    if (error && __DEV__) console.warn('[callkeep] displayIncomingCall error:', error);
  });
}

/** Show native incoming call UI. Call this when call:invite is received. */
export function displayIncomingCall(
  callId: string,
  handle: string,
  name: string,
  isVideo: boolean,
): void {
  try {
    RNCallKeep.displayIncomingCall(callId, handle, name, 'generic', isVideo);
  } catch (e) {
    if (__DEV__) console.warn('[callkeep] displayIncomingCall failed:', e);
  }
}

/** Mark call as active (connected). */
export function reportCallConnected(callId: string): void {
  try {
    RNCallKeep.reportConnectedOutgoingCallWithUUID(callId);
  } catch { /* no-op */ }
}

/** End the native call UI when we hang up from in-app. */
export function endNativeCall(callId: string): void {
  try {
    RNCallKeep.endCall(callId);
  } catch { /* no-op */ }
}

/** Update mute state in native call UI. */
export function setNativeMuted(callId: string, muted: boolean): void {
  try {
    RNCallKeep.setMutedCall(callId, muted);
  } catch { /* no-op */ }
}
