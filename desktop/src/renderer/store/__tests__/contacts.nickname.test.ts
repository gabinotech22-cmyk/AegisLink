/**
 * contacts store — local nickname (desktop parity with
 * mobile/src/store/__tests__/contacts.nickname.test.ts).
 *
 * The "nickname (optional)" typed in Add Contact was written into the same
 * slot as the name the contact announces, so their first profile_update
 * silently replaced it and nothing let the user see, edit or clear it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSaveContact = vi.fn().mockResolvedValue(undefined);
let mockExisting: Record<string, unknown> | null = null;

vi.mock('../../db/local', async () => {
  const actual = await vi.importActual<typeof import('../../db/local')>('../../db/local');
  return {
    effectiveContactName: actual.effectiveContactName,
    loadContacts: vi.fn().mockResolvedValue([]),
    saveContact: (c: unknown) => mockSaveContact(c),
    getContact: vi.fn(async () => mockExisting),
    deleteContact: vi.fn().mockResolvedValue(undefined),
    deleteContactMessages: vi.fn().mockResolvedValue(undefined),
    deleteContactRatchetSession: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../api', () => ({
  lookupIdentity: vi.fn(async (aegisId: string) => ({ aegisId, publicKey: 'PUBKEY_B64', signingPublicKey: 'SIGN_B64' })),
  ApiError: class ApiError extends Error {},
}));
vi.mock('../../crypto/aegisId', () => ({ keyMatchesAegisId: () => true }));
vi.mock('../../crypto/mailboxStore', () => ({ setContactMailboxRoot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../net/homeRelay', () => ({ getHomeRelay: () => null }));
vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { useContacts } from '../contacts';

const ID = 'AAA-BBBB-CCCC';
const find = () => useContacts.getState().contacts.find((x) => x.aegisId === ID)!;

describe('contacts store — local nickname (desktop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExisting = null;
    useContacts.setState({ contacts: [] });
  });

  it('keeps the nickname typed at add-time in its own slot', async () => {
    const c = await useContacts.getState().addByAegisId(ID, 'Mamá');
    expect(c.name).toBe('Mamá');
    expect(c.nickname).toBe('Mamá');
    expect(c.profileName).toBe(ID);
  });

  it('a profile_update records the announced name but does not displace the nickname', async () => {
    const c = await useContacts.getState().addByAegisId(ID, 'Mamá');
    mockExisting = c as unknown as Record<string, unknown>;
    await useContacts.getState().updateContactProfile(ID, 'Carmen García', '#abc');
    const after = find();
    expect(after.name).toBe('Mamá');
    expect(after.profileName).toBe('Carmen García');
    expect(mockSaveContact).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Mamá', profileName: 'Carmen García' }));
  });

  it('clearing the nickname shows the announced name; setting one later overrides it', async () => {
    const c = await useContacts.getState().addByAegisId(ID, 'Mamá');
    mockExisting = { ...c, profileName: 'Carmen García' };
    await useContacts.getState().setNickname(ID, null);
    expect(find().nickname).toBeNull();
    expect(find().name).toBe('Carmen García');

    mockExisting = { ...find() };
    await useContacts.getState().setNickname(ID, '  Jefa ');
    expect(find().nickname).toBe('Jefa');
    expect(find().name).toBe('Jefa');
    expect(find().profileName).toBe('Carmen García');
  });
});
