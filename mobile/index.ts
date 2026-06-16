// CRITICAL: install the crypto RNG sources (TweetNaCl PRNG + @noble's
// globalThis.crypto.getRandomValues) BEFORE any other import. See cryptoSetup.ts
// for why this must be the very first import (ESM hoisting + @noble capturing
// crypto at module-load time).
import './cryptoSetup';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
