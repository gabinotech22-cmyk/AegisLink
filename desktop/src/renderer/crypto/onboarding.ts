import { createIdentity } from './identity';
import { generatePreKeys } from './signal/x3dh';
import type {
  Identity,
  PreKeyBundle,
  PreKeySecrets,
  PublicIdentity,
} from './types';

/**
 * Anonymous 3-step onboarding. No expo deps; pure in-memory generation.
 * The caller is responsible for persisting via window.aegis.secureStorage.
 */

export interface OnboardingStep1 {
  identity: Identity;
}

export interface OnboardingStep2 {
  bundle: PreKeyBundle;
  secrets: PreKeySecrets;
}

export interface OnboardingStep3 {
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
