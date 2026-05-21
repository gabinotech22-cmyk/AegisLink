// CRITICAL: configure TweetNaCl's PRNG BEFORE any other import that might
// touch it. React Native doesn't expose `crypto.getRandomValues`; we feed
// expo-crypto's hardware-backed bytes into nacl.setPRNG instead. This avoids
// pulling in the `react-native-get-random-values` polyfill.
import nacl from 'tweetnacl';
import { getRandomBytes } from 'expo-crypto';

nacl.setPRNG((out, n) => {
  const random = getRandomBytes(n);
  for (let i = 0; i < n; i++) out[i] = random[i];
});

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
