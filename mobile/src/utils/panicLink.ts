/**
 * Remote panic deep-link verifier (H-5).
 *
 * The panic screen generates a signed wipe-trigger URL of the form
 *   aegislink://panic?token=<uuid>&sig=<base64 ed25519 sig>
 *
 * `handlePanicDeepLink` is the ONLY safe entry point: it
 *   1. parses the URL
 *   2. checks token + signature presence
 *   3. verifies the Ed25519 signature against the local identity signing key
 *   4. compares the token bytes to the one stored at panic-config time
 *   5. only then triggers wipeDatabase
 *
 * Any failure path returns silently — never log details (would help an
 * attacker test stolen tokens). This module never throws.
 *
 * Wire-up: register a Linking listener at app bootstrap (e.g. in App.tsx
 * useEffect) that calls handlePanicDeepLink(url) for every incoming URL
 * whose scheme is aegislink:// and host is "panic".
 */

import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8 } from 'tweetnacl-util';
import { ss } from './secureStore';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';

const PANIC_KEY = 'aegis.panic.v1';

interface PanicConfig {
  remoteToken?: string;
  remoteTokenSig?: string;
}

function parseQuery(url: string): Record<string, string> {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of url.slice(qIdx + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    try {
      out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    } catch { /* malformed escape — drop */ }
  }
  return out;
}

/**
 * Returns `true` iff the URL was a valid signed panic trigger that resulted
 * in a successful wipe. Any verification failure returns `false` silently.
 */
export async function handlePanicDeepLink(url: string): Promise<boolean> {
  // 1. Scheme/host gate
  if (!url.startsWith('aegislink://panic')) return false;

  // 2. Required params present
  const q = parseQuery(url);
  if (!q.token || !q.sig) return false;

  // 3. Identity must be loaded for signature verification
  const identity = useIdentity.getState().identity;
  if (!identity?.signingPublicKey) return false;

  // 4. Token must match the stored remote token (defeats replay of a different
  //    user's panic link). Reading SecureStore here is async but the URL
  //    handler is async anyway.
  let stored: PanicConfig = {};
  try {
    const raw = await ss.get(PANIC_KEY);
    if (raw) stored = JSON.parse(raw) as PanicConfig;
  } catch { return false; }
  if (!stored.remoteToken || !stored.remoteTokenSig) return false;
  if (stored.remoteToken !== q.token) return false;

  // 5. Verify Ed25519 signature against the local signing public key.
  //    The signature in the deep-link MUST match the one we generated
  //    locally — even if the token matches, a wrong signature means the
  //    URL was forged after the user changed identity or someone tampered.
  let sigOk = false;
  try {
    sigOk = nacl.sign.detached.verify(
      decodeUTF8(q.token),
      decodeBase64(q.sig),
      identity.signingPublicKey,
    );
  } catch { return false; }
  if (!sigOk) return false;

  // 6. All checks passed — execute irreversible wipe.
  try {
    await wipeDatabase();
    await useIdentity.getState().reset();
    return true;
  } catch {
    return false;
  }
}
