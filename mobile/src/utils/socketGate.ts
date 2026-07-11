import type { PublishStatus } from '../store/identity';

/**
 * Pure gate deciding whether App.tsx is allowed to open the relay socket for
 * the current identity.
 *
 * Root cause this exists for (2026-07 iPhone registration race): App.tsx used
 * to call connectSocket() the instant identity.status became 'ready', which
 * happens in the SAME synchronous tick that store/identity.ts's generate()/
 * hydrate() fire off `void runPublish(...)` in the background (PoW + POST
 * /identity + POST /prekeys). On a slow link (real device RTT, TLS cert
 * pinning, PoW mining time) the socket reaches the relay BEFORE registration
 * lands, the relay replies `error_msg{code:'unknown_identity'}` and drops the
 * connection, and the client used to re-run registration a SECOND time in
 * parallel from socket/client.ts's `unknown_identity` handler — doubling PoW
 * work and doubling hits against the relay's per-IP registration rate limit.
 *
 * The fix: never open the socket while publishStatus === 'publishing' (a
 * registration attempt is actively in flight). Every other state is safe to
 * connect on, preserving existing behavior:
 *  - 'published': normal ready state — either a fresh registration just
 *    succeeded, or hydrate() restored an already-registered identity from the
 *    `aegis.published.<slot>` SecureStore flag (see store/identity.ts
 *    hydrate(), which sets publishStatus: 'published' synchronously and does
 *    NOT re-register — see `alreadyPublished` branch).
 *  - 'failed': a resolved (non-in-flight) registration failure. Connecting
 *    anyway is safe — the socket will either succeed or itself receive
 *    `unknown_identity`, which is now funneled through the guarded
 *    retryPublish() (see socket/client.ts) instead of racing a fresh
 *    ensureRegistered() call.
 *  - 'unknown': the initial/default state. Also resolved (not in-flight), so
 *    connecting preserves pre-fix behavior for any edge case that leaves the
 *    store here.
 *
 * `duressActive` (CodeRabbit PR #301): never connect with the decoy identity
 * — doing so would leak that panic/duress mode is active to the relay. This
 * used to be a separate inline `if (usePreferences.getState().duressActive)
 * return;` check duplicated at each connectSocket call site (present on
 * mobile, MISSING on desktop — a real security gap fixed by folding it into
 * this single, testable predicate both platforms now share).
 */
export function shouldConnectSocket(params: {
  hasIdentity: boolean;
  identityStatus: 'idle' | 'loading' | 'generating' | 'ready';
  publishStatus: PublishStatus;
  duressActive: boolean;
}): boolean {
  const { hasIdentity, identityStatus, publishStatus, duressActive } = params;
  if (duressActive) return false;
  if (!hasIdentity) return false;
  if (identityStatus !== 'ready') return false;
  return publishStatus !== 'publishing';
}

/**
 * Whether the "stuck offline" 5s timer that surfaces NetworkErrorScreen
 * should be allowed to run. Must stay false while a registration attempt is
 * in flight (publishStatus 'publishing') or hasn't started resolving yet
 * ('unknown') and while onboarding is on screen — the socket is
 * INTENTIONALLY not connected yet in that state (see shouldConnectSocket
 * above), so `online === false` here is expected, not a real network error.
 * Firing NetworkErrorScreen during this window plants it underneath the
 * onboarding flow and it then jumps to the foreground the instant onboarding
 * finishes (setShowOnboarding(false)) — the exact "pantalla de reconexión
 * sale sola" symptom this gate fixes.
 *
 * A genuinely resolved registration failure ('failed') still arms the timer
 * — NetworkErrorScreen's `publishStatus === 'failed'` block is the intended
 * surface for that case and must keep working.
 */
export function shouldArmNetErrorTimer(params: {
  showOnboarding: boolean | null;
  publishStatus: PublishStatus;
}): boolean {
  const { showOnboarding, publishStatus } = params;
  if (showOnboarding) return false;
  if (publishStatus === 'publishing' || publishStatus === 'unknown') return false;
  return true;
}
