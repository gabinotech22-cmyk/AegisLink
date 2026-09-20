/**
 * Contacts store — local nickname regression tests.
 *
 * The "nickname (optional)" field of Add Contact used to be written into the
 * same slot as the name the contact announces, so the first profile_update
 * silently replaced it and there was no way to see, edit or clear it. Now:
 *   1. addByAegisId(id, nickname) keeps the nickname in its own slot.
 *   2. updateContactProfile never displaces a nickname (but records the
 *      announced name as profileName).
 *   3. setNickname(null) falls back to the announced name, then to the id.
 *   4. Without a nickname the announced name is what we show.
 */

const mockSaveContact = jest.fn().mockResolvedValue(undefined);
let mockExisting: Record<string, unknown> | null = null;

jest.mock('../../db/local', () => ({
  loadContacts: jest.fn().mockResolvedValue([]),
  saveContact: (c: unknown) => mockSaveContact(c),
  getContact: jest.fn(async () => mockExisting),
  deleteContact: jest.fn().mockResolvedValue(undefined),
  deleteContactMessages: jest.fn().mockResolvedValue(undefined),
  deleteContactRatchetSession: jest.fn().mockResolvedValue(undefined),
  pinContact: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../api', () => ({
  lookupIdentity: jest.fn(async (aegisId: string) => ({ aegisId, publicKey: 'PUBKEY_B64', signingPublicKey: 'SIGN_B64' })),
  ApiError: class ApiError extends Error {},
}));
jest.mock('../../crypto/aegisId', () => ({ keyMatchesAegisId: () => true }));

import { useContacts } from '../contacts';

const ID = 'AAA-BBBB-CCCC';
const find = () => useContacts.getState().contacts.find((x) => x.aegisId === ID)!;

describe('contacts store — local nickname', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(after.nickname).toBe('Mamá');
    expect(after.profileName).toBe('Carmen García');
    expect(mockSaveContact).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Mamá', profileName: 'Carmen García' }));
  });

  it('clearing the nickname shows the announced name; without one, the id', async () => {
    const c = await useContacts.getState().addByAegisId(ID, 'Mamá');
    mockExisting = { ...c, profileName: 'Carmen García' };
    await useContacts.getState().setNickname(ID, null);
    let after = find();
    expect(after.nickname).toBeNull();
    expect(after.name).toBe('Carmen García');

    mockExisting = { ...after, profileName: ID };
    await useContacts.getState().setNickname(ID, '   ');
    after = find();
    expect(after.name).toBe(ID);
  });

  it('setting a nickname later overrides the announced name and trims it', async () => {
    const c = await useContacts.getState().addByAegisId(ID);
    expect(c.nickname).toBeNull();
    mockExisting = { ...c, profileName: 'Carmen García', name: 'Carmen García' };
    await useContacts.getState().setNickname(ID, '  Jefa ');
    const after = find();
    expect(after.nickname).toBe('Jefa');
    expect(after.name).toBe('Jefa');
    expect(after.profileName).toBe('Carmen García');
  });

  it('without a nickname the announced name is what we show', async () => {
    const c = await useContacts.getState().addByAegisId(ID);
    mockExisting = c as unknown as Record<string, unknown>;
    await useContacts.getState().updateContactProfile(ID, 'Carmen García');
    expect(find().name).toBe('Carmen García');
  });
});
