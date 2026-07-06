/**
 * contacts store — duress (coercion) write-guard tests
 *
 * Product model: while showing the decoy account, mutators still update the
 * in-memory (decoy) contact list so the UI stays responsive/coherent, but
 * MUST NEVER touch the real SQLite DB. This locks in that guarantee for every
 * mutator that normally calls saveContact/deleteContact/pinContact.
 */

jest.mock('../../db/local', () => ({
  loadContacts: jest.fn().mockResolvedValue([]),
  saveContact: jest.fn().mockResolvedValue(undefined),
  getContact: jest.fn().mockResolvedValue(null),
  deleteContact: jest.fn().mockResolvedValue(undefined),
  deleteContactMessages: jest.fn().mockResolvedValue(undefined),
  deleteContactRatchetSession: jest.fn().mockResolvedValue(undefined),
  pinContact: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../preferences', () => ({
  usePreferences: { getState: jest.fn() },
}));

jest.mock('../duressDecoy', () => ({
  getOrCreateDecoyBlob: jest.fn().mockResolvedValue({
    identity: { aegisId: 'DECOY-0000-0000' },
    contacts: [
      { aegisId: 'DECOY-CONTACT-1', publicKeyB64: 'k1', name: 'sam.rivera', verified: true, addedAt: 1000 },
    ],
    messagesByChat: {},
  }),
}));

jest.mock('../messages', () => ({
  useMessages: { getState: () => ({ clearChat: jest.fn().mockResolvedValue(undefined) }) },
}));

import { useContacts } from '../contacts';
import { usePreferences } from '../preferences';
import * as dbLocal from '../../db/local';

function setDuress(active: boolean) {
  (usePreferences.getState as jest.Mock).mockReturnValue({ duressActive: active });
}

describe('contacts store — duress write guard', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    setDuress(true);
    await useContacts.getState().hydrate();
  });

  it('hydrate() serves the seeded decoy list without calling loadContacts (real DB)', () => {
    expect(useContacts.getState().contacts.map((c) => c.aegisId)).toEqual(['DECOY-CONTACT-1']);
    expect(dbLocal.loadContacts).not.toHaveBeenCalled();
  });

  it('muteContact() updates in-memory only — saveContact is never called', async () => {
    await useContacts.getState().muteContact('DECOY-CONTACT-1', true, null);
    expect(useContacts.getState().contacts[0].muted).toBe(true);
    expect(dbLocal.saveContact).not.toHaveBeenCalled();
  });

  it('pinContact() updates in-memory only — the real dbPinContact is never called', async () => {
    await useContacts.getState().pinContact('DECOY-CONTACT-1', true);
    expect(useContacts.getState().contacts[0].pinned).toBe(true);
    expect(dbLocal.pinContact).not.toHaveBeenCalled();
  });

  it('setChatHidden() updates in-memory only — saveContact is never called', async () => {
    await useContacts.getState().setChatHidden('DECOY-CONTACT-1', true);
    expect(useContacts.getState().contacts[0].hidden).toBe(true);
    expect(dbLocal.saveContact).not.toHaveBeenCalled();
  });

  it('updateContactProfile() updates in-memory only — saveContact is never called', async () => {
    await useContacts.getState().updateContactProfile('DECOY-CONTACT-1', 'New Name');
    expect(useContacts.getState().contacts[0].name).toBe('New Name');
    expect(dbLocal.saveContact).not.toHaveBeenCalled();
  });

  it('removeContact() removes in-memory only — no real deleteContact/deleteContactMessages calls', async () => {
    await useContacts.getState().removeContact('DECOY-CONTACT-1');
    expect(useContacts.getState().contacts).toEqual([]);
    expect(dbLocal.deleteContact).not.toHaveBeenCalled();
    expect(dbLocal.deleteContactMessages).not.toHaveBeenCalled();
    expect(dbLocal.deleteContactRatchetSession).not.toHaveBeenCalled();
  });

  it('addByAegisId() refuses to add new contacts while duress is active', async () => {
    await expect(useContacts.getState().addByAegisId('SOME-ID')).rejects.toThrow();
    expect(dbLocal.saveContact).not.toHaveBeenCalled();
  });
});
