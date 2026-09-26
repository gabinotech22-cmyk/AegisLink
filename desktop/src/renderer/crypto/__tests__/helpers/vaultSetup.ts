/**
 * F-1b: the app unlocks its active profile's key vault at hydrate
 * (store/identity.ts); tests start in that state for the primary profile, so
 * `createIdentity()` works at module level and in any hook. Tests of locking
 * and of other profiles unlock / lock explicitly.
 */
import { vault } from '../../sodium/vault';

await vault.unlock('self');
