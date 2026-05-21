/* eslint-env node */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// When AEGIS_EXPO_GO=1, alias `react-native-webrtc` to a no-op stub. Without
// this the JS bundle imports the native module at load time and Expo Go
// (which doesn't bundle WebRTC) crashes with "native module doesn't exist".
//
//   npm run start          → Expo Go mode (stub active)
//   npm run start:dev      → Dev client mode (real WebRTC)
if (process.env.AEGIS_EXPO_GO === '1') {
  const stub = path.resolve(__dirname, 'src/webrtc/webrtc-expogo-stub.ts');
  const originalResolve = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === 'react-native-webrtc') {
      return { type: 'sourceFile', filePath: stub };
    }
    return originalResolve
      ? originalResolve(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };
  // eslint-disable-next-line no-console
  console.log('[metro] AEGIS_EXPO_GO=1 — react-native-webrtc aliased to stub');
}

module.exports = config;
