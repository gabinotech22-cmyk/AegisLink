import { createIdentity } from './identity';
import { generatePreKeys } from './signal/x3dh';
import type {
  Identity,
  PreKeyBundle,
  PreKeySecrets,
  PublicIdentity,
} from './types';

/**
 * Anonymous 3-step onboarding.
 *
 *   Step 1 — generateLocalIdentity():
 *     Generates an Identity entirely on-device. No network. No email,
 *     no phone, no display name.
 *
 *   Step 2 — generateInitialPreKeys(identity):
 *     Generates a signed prekey + N one-time prekeys. Public bundle is
 *     uploadable; secrets stay on device.
 *
 *   Step 3 — buildRegistrationPayload(identity, bundle):
 *     Produces the EXACT payload the relay needs to register the user.
 *     Contains zero PII — only public keys and the derived AegisID.
 *
 * The caller (Mobile team) is responsible for:
 *   - Writing `identity` and `preKeySecrets` to expo-secure-store
 *     under SECURE_STORE_KEYS.IDENTITY and SECURE_STORE_KEYS.PREKEY_SECRETS.
 *   - POSTing the result of step 3 to the relay's /register endpoint.
 */

export interface OnboardingStep1 {
  identity: Identity;
}

export interface OnboardingStep2 {
  bundle: PreKeyBundle;
  secrets: PreKeySecrets;
}

export interface OnboardingStep3 {
  /** Public-only registration payload — safe to send to the relay. */
  registration: {
    profile: PublicIdentity;
    bundle: PreKeyBundle;
  };
}

export function generateLocalIdentity(): OnboardingStep1 {
  const identity = createIdentity();
  return { identity };
}

export function generateInitialPreKeys(
  identity: Identity,
  opkCount = 100,
): OnboardingStep2 {
  const { signedPreKey, oneTimePreKeys, opkSecrets } = generatePreKeys(
    identity,
    1,
    opkCount,
  );

  const bundle: PreKeyBundle = {
    identityKeyB64: identity.publicKeyB64,
    signingPublicKeyB64: identity.signingPublicKeyB64,
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKeyB64: signedPreKey.publicKeyB64,
      signatureB64: signedPreKey.signatureB64,
    },
    // The first OPK is exposed as the "current" one — the relay rotates
    // through them as sessions are established.
    oneTimePreKey: oneTimePreKeys.length > 0 ? oneTimePreKeys[0] : null,
  };

  const secrets: PreKeySecrets = {
    signedPreKey: { keyId: signedPreKey.keyId, secretKey: signedPreKey.secretKey },
    opkSecrets,
  };

  return { bundle, secrets };
}

export function buildRegistrationPayload(
  identity: Identity,
  bundle: PreKeyBundle,
): OnboardingStep3 {
  const profile: PublicIdentity = {
    aegisId: identity.aegisId,
    publicKeyB64: identity.publicKeyB64,
    signingPublicKeyB64: identity.signingPublicKeyB64,
  };
  return { registration: { profile, bundle } };
}

/** Convenience: run all three steps in memory (used in tests). */
export function runAnonymousOnboarding(opkCount = 100): {
  identity: Identity;
  bundle: PreKeyBundle;
  secrets: PreKeySecrets;
  registration: OnboardingStep3['registration'];
} {
  const { identity } = generateLocalIdentity();
  const { bundle, secrets } = generateInitialPreKeys(identity, opkCount);
  const { registration } = buildRegistrationPayload(identity, bundle);
  return { identity, bundle, secrets, registration };
}
