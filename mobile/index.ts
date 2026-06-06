// CRITICAL: configure TweetNaCl's PRNG BEFORE any other import that might
// touch it. React Native doesn't expose `crypto.getRandomValues`; we feed
// expo-crypto's hardware-backed bytes into nacl.setPRNG instead. This avoids
// pulling in the `react-native-get-random-values` polyfill.
import nacl from 'tweetnacl';
import { getRandomBytes } from 'expo-crypto';

nacl.setPRNG((out, n) => {
  // expo-crypto's getRandomBytes REJECTS requests larger than 1024 bytes
  // ("expected a valid number from range 0...1024"). Fill `out` in ≤1024-byte
  // chunks so large requests work. Without this, any nacl.randomBytes(n > 1024)
  // throws — e.g. the length-hiding pad (crypto/metadata.ts) on a large message
  // such as an inline-avatar profile_update needs ~1.7 KB of pad → the whole
  // profile broadcast failed and the avatar never reached the other device.
  const MAX = 1024;
  for (let offset = 0; offset < n; offset += MAX) {
    const chunk = Math.min(MAX, n - offset);
    const random = getRandomBytes(chunk);
    for (let i = 0; i < chunk; i++) out[offset + i] = random[i];
  }
});

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
