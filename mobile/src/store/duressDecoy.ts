/**
 * duressDecoy — stable decoy state for the coercion (duress) PIN.
 *
 * Product model (confirmed): the duress PIN HIDES the real account and shows
 * a decoy with seeded fake data. It is REVERSIBLE — unlocking again with the
 * real PIN restores the real identity/contacts/messages untouched. It never
 * deletes anything (that remains the job of the lock-screen gestures, the
 * remote wipe deep link, auto-wipe-on-max-attempts, and the manual Panic
 * button — none of which are touched here).
 *
 * Everything the decoy shows (identity, contacts, conversations) is generated
 * ONCE and persisted in a single SecureStore blob, then reused on every
 * subsequent duress unlock. Without this, two coerced unlocks would show two
 * different "accounts" — a dead giveaway that the app has a duress mode.
 *
 * This blob NEVER touches the real SQLite database. It is read/written only
 * to SecureStore, and only consulted by the stores (identity/contacts/
 * messages) when `usePreferences.duressActive` is true.
 */
import { logger } from '../utils/logger';
import { ss } from '../utils/secureStore';
import { createIdentity, type Identity } from '../crypto/identity';
import { resolveActiveLocale, type SupportedLocale } from '../i18n';
import type { StoredContact } from '../db/local';
import type { StoredMessage } from '../db/local';

const DECOY_BLOB_KEY = 'aegis.duress.decoy.v1';

export interface DecoyIdentity {
  aegisId: string;
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  createdAt: number;
  displayName: string;
  avatarColor: string;
}

export interface DecoyBlob {
  identity: DecoyIdentity;
  contacts: StoredContact[];
  /** Messages keyed by chatId (decoy contact aegisId). */
  messagesByChat: Record<string, StoredMessage[]>;
}

let cache: DecoyBlob | null = null;

const DECOY_NAMES = [
  { name: 'sam.rivera', color: '#8b5cf6' },
  { name: 'jordan.k', color: '#3b82f6' },
  { name: 'nina.oyelaran', color: '#ec4899' },
  { name: 'wei.chen', color: '#f97316' },
  { name: 'lucas.almeida', color: '#eab308' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Small, deliberately mundane conversation starters — nothing sensitive.
 * One set per supported UI language: a decoy chatting in a language the
 * device was never set to would itself be a giveaway that something is off.
 * Picked ONCE at first generation (see getOrCreateDecoyBlob) via the SAME
 * resolveActiveLocale() background notifications use — the blob is then
 * persisted forever, so it stays consistent across unlocks regardless of
 * later language changes (matching the "same decoy every time" invariant
 * this module already guarantees for the identity/contacts).
 */
const DECOY_SCRIPTS_BY_LOCALE: Record<SupportedLocale, string[][]> = {
  es: [
    ['hola! llegaste bien?', 'si, todo tranquilo jaja', 'buenisimo, nos vemos el finde entonces'],
    ['viste el partido de ayer?', 'no pude, como quedo?', 'un desastre jajaja te cuento luego'],
    ['te mando la receta que te dije', 'dale, gracias!', 'de nada, avisame como te sale'],
    ['mañana café a las 5?', 'perfecto, en el de siempre?', 'si, ahi te espero'],
    ['me pasas la foto del cumple?', 'ya te la mando', 'gracias! salio buenisima'],
  ],
  en: [
    ['hey! did you get there ok?', 'yep, all good haha', 'awesome, see you this weekend then'],
    ['did you watch the game yesterday?', 'couldn’t, how’d it go?', 'a disaster lol, tell you later'],
    ['sending you that recipe I mentioned', 'cool, thanks!', 'np, let me know how it turns out'],
    ['coffee tomorrow at 5?', 'sounds good, usual spot?', 'yep, see you there'],
    ['can you send the birthday photo?', 'sending it now', 'thanks! it came out great'],
  ],
  it: [
    ['ciao! sei arrivato bene?', 'sì, tutto tranquillo haha', 'perfetto, ci vediamo nel weekend allora'],
    ['hai visto la partita di ieri?', 'non ho potuto, com’è andata?', 'un disastro haha ti racconto dopo'],
    ['ti mando la ricetta che ti dicevo', 'dai, grazie!', 'di niente, fammi sapere come viene'],
    ['caffè domani alle 5?', 'perfetto, al solito posto?', 'sì, ti aspetto lì'],
    ['mi mandi la foto del compleanno?', 'te la mando subito', 'grazie! è venuta benissimo'],
  ],
};

function buildDecoyIdentity(): DecoyIdentity {
  // Real, cryptographically random key material — never all-zero. Forensic
  // analysis must not be able to distinguish this from a genuine identity.
  const identity: Identity = createIdentity();
  const displayName = identity.aegisId.toLowerCase().replace(/-/g, '').slice(0, 12);
  return {
    aegisId: identity.aegisId,
    publicKeyB64: identity.publicKeyB64,
    secretKeyB64: identity.secretKeyB64,
    signingPublicKeyB64: identity.signingPublicKeyB64,
    signingSecretKeyB64: identity.signingSecretKeyB64,
    createdAt: identity.createdAt,
    displayName,
    avatarColor: '#5bf2b9',
  };
}

function buildDecoyContactsAndMessages(
  now: number,
  locale: SupportedLocale,
): { contacts: StoredContact[]; messagesByChat: Record<string, StoredMessage[]> } {
  const contacts: StoredContact[] = [];
  const messagesByChat: Record<string, StoredMessage[]> = {};
  const scripts = DECOY_SCRIPTS_BY_LOCALE[locale] ?? DECOY_SCRIPTS_BY_LOCALE.en;

  DECOY_NAMES.forEach((person, i) => {
    // Plausible-looking but fake AegisID-shaped identifier for the decoy peer.
    const fakeIdentity = createIdentity();
    const aegisId = fakeIdentity.aegisId;
    const addedAt = now - (30 + i * 5) * DAY_MS;

    contacts.push({
      aegisId,
      publicKeyB64: fakeIdentity.publicKeyB64,
      name: person.name,
      verified: i % 2 === 0,
      addedAt,
      color: person.color,
      profile: 'personal',
    });

    const script = scripts[i % scripts.length];
    const chatMsgs: StoredMessage[] = script.map((body, j) => ({
      id: `decoy-${i}-${j}`,
      chatId: aegisId,
      direction: j % 2 === 0 ? 'in' : 'out',
      body,
      // Recent-but-plausible timestamps within the last couple of weeks.
      createdAt: now - (14 - i * 2 - j) * 60 * 60 * 1000,
      type: 'text',
      mediaUri: null,
      deleted: false,
      starred: false,
      pinned: false,
      deliveryStatus: 'read',
      reactions: {},
      replyToId: null,
      expiresAt: null,
    }));
    messagesByChat[aegisId] = chatMsgs;
  });

  return { contacts, messagesByChat };
}

/**
 * Returns the persisted decoy blob, generating and persisting it on first use.
 * Idempotent and safe to call from multiple stores during the same duress
 * hydration — subsequent calls hit the in-memory cache.
 */
export async function getOrCreateDecoyBlob(): Promise<DecoyBlob> {
  if (cache) return cache;

  try {
    const raw = await ss.get(DECOY_BLOB_KEY);
    if (raw) {
      cache = JSON.parse(raw) as DecoyBlob;
      return cache;
    }
  } catch (e) {
    if (__DEV__) logger.warn('[duressDecoy] failed to read existing decoy blob:', e);
  }

  const now = Date.now();
  const locale = await resolveActiveLocale();
  const identity = buildDecoyIdentity();
  const { contacts, messagesByChat } = buildDecoyContactsAndMessages(now, locale);
  const blob: DecoyBlob = { identity, contacts, messagesByChat };

  try {
    await ss.set(DECOY_BLOB_KEY, JSON.stringify(blob));
  } catch (e) {
    if (__DEV__) logger.warn('[duressDecoy] failed to persist decoy blob (using in-memory only):', e);
  }

  cache = blob;
  return blob;
}

/** Clears the in-memory cache only (does not touch SecureStore). Test helper. */
export function resetDecoyCache(): void {
  cache = null;
}

/**
 * Appends an in-memory-only message to a decoy chat (e.g. a message the
 * coercer types while under duress). Persisted to the SAME SecureStore blob
 * so it survives the duress session, but NEVER touches the real SQLite DB.
 */
export async function appendDecoyMessage(chatId: string, message: StoredMessage): Promise<void> {
  const blob = await getOrCreateDecoyBlob();
  const existing = blob.messagesByChat[chatId] ?? [];
  blob.messagesByChat = { ...blob.messagesByChat, [chatId]: [...existing, message] };
  cache = blob;
  try {
    await ss.set(DECOY_BLOB_KEY, JSON.stringify(blob));
  } catch (e) {
    if (__DEV__) logger.warn('[duressDecoy] failed to persist decoy message (kept in-memory only):', e);
  }
}
