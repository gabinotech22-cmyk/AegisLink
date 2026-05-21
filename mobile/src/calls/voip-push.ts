import { Platform } from 'react-native';
import { SERVER_URL } from '../config';

// VoIP push token registration for iOS PushKit
// The native module for this requires @react-native-voip-push-notification
// but we can stub it here and complete when that package is added

export async function registerVoIPToken(aegisId: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    // Dynamic require — package may not be installed yet
    const VoipPushNotification = require('@react-native-voip-push-notification/react-native-voip-push-notification').default;
    VoipPushNotification.addEventListener('register', async (token: string) => {
      await fetch(`${SERVER_URL}/push/register-voip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aegisId, voipToken: token, platform: 'ios' }),
      });
    });
    VoipPushNotification.registerVoipToken();
  } catch {
    // Package not installed — will use regular push as fallback
  }
}
