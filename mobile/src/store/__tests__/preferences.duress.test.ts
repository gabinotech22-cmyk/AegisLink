/**
 * store/preferences — the decoy (duress) session must not show or overwrite
 * the real user's preferences.
 *
 * Preferences were global and outside the decoy: under coercion, Settings →
 * Notifications listed the REAL keywords, muted chats/groups/channels, and any
 * toggle pressed persisted over the real values. Verifies:
 *   1. hydrate() under duress masks the sensitive lists to defaults in memory
 *      and leaves storage untouched.
 *   2. set() under duress changes memory only — nothing is persisted.
 *   3. hydrate() after the real PIN restores the real values.
 */

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/secureStore', () => ({
  ss: { get: (...a: unknown[]) => mockGet(...a), set: (...a: unknown[]) => mockSet(...a), delete: jest.fn().mockResolvedValue(undefined) },
}));

import { usePreferences, maskForDuress } from '../preferences';

const REAL = {
  notifKeywords: ['abogado', 'frontera'],
  mutedChats: ['group-real-1'],
  mentionsOnlyChats: ['AAA-BBBB-CCCC'],
  mutedChannels: ['chan-1'],
  themeDark: false,
  notifMaster: false,
};

describe('preferences under duress', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockClear();
    mockGet.mockResolvedValue(JSON.stringify(REAL));
    usePreferences.setState({ duressActive: false, hydrated: false });
  });

  it('masks keywords / muted lists in the decoy, keeps neutral prefs, never writes', async () => {
    usePreferences.setState({ duressActive: true });
    await usePreferences.getState().hydrate();
    const s = usePreferences.getState();
    expect(s.notifKeywords).not.toContain('abogado');
    expect(s.mutedChats).toEqual([]);
    expect(s.mentionsOnlyChats).toEqual([]);
    expect(s.mutedChannels).toEqual([]);
    // Neutral prefs still look like the user's app (theme, master switch).
    expect(s.themeDark).toBe(false);
    expect(s.notifMaster).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('set() in the decoy is memory-only', async () => {
    usePreferences.setState({ duressActive: true });
    await usePreferences.getState().hydrate();
    await usePreferences.getState().set('notifMaster', true);
    expect(usePreferences.getState().notifMaster).toBe(true);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('the real PIN gets the real values back', async () => {
    usePreferences.setState({ duressActive: true });
    await usePreferences.getState().hydrate();
    await usePreferences.getState().set('mutedChats', ['decoy-group']);
    usePreferences.setState({ duressActive: false });
    await usePreferences.getState().hydrate();
    const s = usePreferences.getState();
    expect(s.notifKeywords).toEqual(['abogado', 'frontera']);
    expect(s.mutedChats).toEqual(['group-real-1']);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('maskForDuress only touches the sensitive keys', () => {
    const masked = maskForDuress({ ...usePreferences.getState(), ...REAL } as never);
    expect(masked.notifKeywords).not.toEqual(REAL.notifKeywords);
    expect(masked.themeDark).toBe(false);
  });
});
