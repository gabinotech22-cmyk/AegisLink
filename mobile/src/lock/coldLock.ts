/**
 * The cold-start app lock decision, as a pure function (App.tsx applies it).
 *
 * The lock screen must cover the app the first time an identity is ready in
 * this process whenever the lock is enabled — decided ONCE, and only after the
 * persisted preferences have loaded: before that, `appLockEnabled` is the
 * store default (false), and deciding on it would show a locked install's
 * content unlocked.
 *
 * Deciding once is also what keeps turning the lock ON in settings from
 * locking the app on the spot (it used to: the effect re-ran on the toggle and
 * demanded the PIN the user had just set). From then on the lock engages when
 * the app goes to the background and comes back, or on the next cold start.
 */
export type ColdLockAction =
  | 'reset' // no identity (onboarding, panic wipe, profile switch): forget the decision, unlock
  | 'wait' // not decidable yet (identity or preferences still loading)
  | 'lock' // cold start with the lock enabled
  | 'keep'; // already decided, or cold start with the lock disabled: leave the lock state alone

export function coldLockAction(params: {
  hasIdentity: boolean;
  identityReady: boolean;
  prefsHydrated: boolean;
  appLockEnabled: boolean;
  alreadyDecided: boolean;
}): ColdLockAction {
  const { hasIdentity, identityReady, prefsHydrated, appLockEnabled, alreadyDecided } = params;
  if (!hasIdentity) return 'reset';
  if (alreadyDecided) return 'keep';
  if (!identityReady || !prefsHydrated) return 'wait';
  return appLockEnabled ? 'lock' : 'keep';
}
