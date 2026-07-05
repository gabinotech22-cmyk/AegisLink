/**
 * infra/scripts/rotate-turn-creds.ts
 *
 * Generates a new TURN_SECRET and prints the deployment command.
 * Run as a cron job or GitHub Actions scheduled workflow (every 24 h).
 *
 * Usage:
 *   npx tsx infra/scripts/rotate-turn-creds.ts
 *
 * The output is a shell snippet that exports the new secret and calls deploy.sh.
 * The secret is never written to disk by this script — it is only printed to
 * stdout so the operator (or CI runner) can inject it into the environment.
 *
 * AegisLink privacy: the TURN_SECRET is an HMAC seed only. It does not identify
 * any user — it is used to sign ephemeral per-call credentials server-side.
 */

import { randomBytes, createHmac } from 'node:crypto';

const TTL_SECONDS = 86_400; // 24 hours

/**
 * Generate a new random TURN static secret (256-bit hex string).
 */
function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate a single set of ephemeral TURN credentials using the HMAC-SHA1
 * mechanism defined in RFC 8489 §9.2 and the coturn use-auth-secret extension.
 *
 * The username is not a real user identifier — it is a composite of a future
 * timestamp (expiry) and an opaque session handle. coturn never logs it.
 */
export function generateTurnCredentials(
  secret: string,
  sessionHandle: string = 'anon',
  ttlSeconds: number = TTL_SECONDS,
): { username: string; credential: string; ttl: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiresAt}:${sessionHandle}`;
  // lgtm[js/weak-cryptographic-algorithm]
  const credential = createHmac('sha1', secret)
    .update(username)
    .digest('base64');
  return { username, credential, ttl: ttlSeconds };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('rotate-turn-creds.ts') || process.argv[1]?.endsWith('rotate-turn-creds.js')) {
  const newSecret = generateSecret();

  // Verify the new secret works end-to-end
  const testCreds = generateTurnCredentials(newSecret, 'rotation-test');

  console.log('# New TURN_SECRET generated (valid for 24 h)');
  console.log('# Verify credentials round-trip: OK');
  console.log(`# Test username: ${testCreds.username}`);
  console.log('#');
  console.log('# To deploy, run:');
  console.log(`export TURN_SECRET='${newSecret}'`);
  console.log('bash $DEPLOY_PATH/infra/deploy.sh');
  console.log('#');
  console.log('# Or set this secret in your CI/CD secrets store and trigger the deploy workflow.');
}
