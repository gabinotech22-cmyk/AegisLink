import Constants from 'expo-constants';

/**
 * True when the JS is loaded inside Expo Go (the "store client"). In that
 * environment native modules outside Expo Go's bundled set are unavailable
 * — including react-native-webrtc — so call paths must be no-ops.
 */
export const IS_EXPO_GO = Constants.executionEnvironment === 'storeClient';

export const WEBRTC_AVAILABLE = !IS_EXPO_GO;
