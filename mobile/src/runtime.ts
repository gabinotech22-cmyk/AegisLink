import Constants from 'expo-constants';

/**
 * True when the JS is loaded inside Expo Go (the "store client"). In that
 * environment native modules outside Expo Go's bundled set are unavailable
 * — including react-native-webrtc — so call paths must be no-ops.
 */
export const IS_EXPO_GO = Constants.executionEnvironment === 'storeClient';

export const WEBRTC_AVAILABLE = !IS_EXPO_GO;

/**
 * Marketing version of the installed binary ("1.0.6"), read from the config
 * baked in at build time. This is what the relay's `latestVersion` /
 * `minVersion` advertisement is compared against — locally, never on the wire.
 * Falls back to '0.0.0' when unavailable (tests, Expo Go) so the comparison
 * still type-checks and a missing value can never be mistaken for "up to date".
 */
export const APP_VERSION: string = Constants.expoConfig?.version ?? '0.0.0';
