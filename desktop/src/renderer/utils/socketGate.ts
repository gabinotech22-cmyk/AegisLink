import type { PublishStatus } from '../store/identity';

/**
 * Pure gate deciding whether App.tsx is allowed to open the relay socket for
 * the current identity. Mirrors mobile/src/utils/socketGate.ts — see that
 * file for the full root-cause writeup (2026-07 registration race).
 *
 * Desktop had the same race: App.tsx used to call connectSocket() the
 * instant identity.status became 'ready', in the same synchronous tick that
 * store/identity.ts's generate()/hydrate() fire off `void runPublish(...)`
 * in the background (PoW + POST /identity + POST /prekeys). On a slow link
 * the socket can reach the relay before registration lands, the relay
 * replies `error_msg{code:'unknown_identity'}`, and — before this fix —
 * socket/client.ts's unknown_identity handler ran its OWN separate inline
 * PoW/registration flow instead of going through the single-flight
 * publishToServer()/runPublish() path, doubling PoW work and hits against
 * the relay's per-IP registration rate limit.
 *
 * Never open the socket while publishStatus === 'publishing' (a registration
 * attempt is actively in flight). Every other state is safe to connect on:
 *  - 'published': fresh registration succeeded, OR hydrate() restored an
 *    already-registered identity from the `aegis.prekeysPublished.<slot>`
 *    flag without re-registering.
 *  - 'failed' / 'unknown': resolved (non-in-flight) states — connecting
 *    anyway is safe, since any resulting `unknown_identity` is now funneled
 *    through the guarded retryPublish() instead of racing a fresh publish.
 */
export function shouldConnectSocket(params: {
  hasIdentity: boolean;
  identityStatus: 'idle' | 'loading' | 'generating' | 'ready';
  publishStatus: PublishStatus;
}): boolean {
  const { hasIdentity, identityStatus, publishStatus } = params;
  if (!hasIdentity) return false;
  if (identityStatus !== 'ready') return false;
  return publishStatus !== 'publishing';
}
