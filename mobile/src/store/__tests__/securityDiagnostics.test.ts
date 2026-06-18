/**
 * Local-only PQXDH→v1 downgrade counter (securityDiagnostics store).
 *
 * The store persists a single aggregate count via the SecureStore wrapper.
 * We mock `../../utils/secureStore` with an in-memory map so the test pulls no
 * native modules (per the project's no-native-deps test convention), and assert
 * the counter increments, accumulates, survives a hydrate, and clears on reset.
 */

const mockMem = new Map<string, string>();
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: (k: string) => Promise.resolve(mockMem.has(k) ? mockMem.get(k)! : null),
    set: (k: string, v: string) => { mockMem.set(k, v); return Promise.resolve(); },
    delete: (k: string) => { mockMem.delete(k); return Promise.resolve(); },
  },
}));

import { useSecurityDiagnostics } from '../securityDiagnostics';

const STORAGE_KEY = 'aegis.secdiag.v1';

beforeEach(() => {
  mockMem.clear();
  // Reset the singleton store to a pristine, un-hydrated state.
  useSecurityDiagnostics.setState({
    pqDowngradeFallbacks: 0,
    lastPqDowngradeAt: null,
    hydrated: false,
  });
});

it('starts at zero', () => {
  expect(useSecurityDiagnostics.getState().pqDowngradeFallbacks).toBe(0);
  expect(useSecurityDiagnostics.getState().lastPqDowngradeAt).toBeNull();
});

it('recordPqDowngrade increments the count and stamps the time', async () => {
  await useSecurityDiagnostics.getState().recordPqDowngrade();
  const s = useSecurityDiagnostics.getState();
  expect(s.pqDowngradeFallbacks).toBe(1);
  expect(typeof s.lastPqDowngradeAt).toBe('number');
});

it('accumulates across multiple downgrades and persists the total', async () => {
  await useSecurityDiagnostics.getState().recordPqDowngrade();
  await useSecurityDiagnostics.getState().recordPqDowngrade();
  await useSecurityDiagnostics.getState().recordPqDowngrade();
  expect(useSecurityDiagnostics.getState().pqDowngradeFallbacks).toBe(3);
  expect(JSON.parse(mockMem.get(STORAGE_KEY)!).pqDowngradeFallbacks).toBe(3);
});

it('hydrate restores a previously persisted count (survives restart)', async () => {
  mockMem.set(STORAGE_KEY, JSON.stringify({ pqDowngradeFallbacks: 7, lastPqDowngradeAt: 123 }));
  await useSecurityDiagnostics.getState().hydrate();
  const s = useSecurityDiagnostics.getState();
  expect(s.pqDowngradeFallbacks).toBe(7);
  expect(s.lastPqDowngradeAt).toBe(123);
});

it('recordPqDowngrade self-hydrates so it never clobbers a persisted value', async () => {
  // Simulate a fresh launch where record fires before any explicit hydrate.
  mockMem.set(STORAGE_KEY, JSON.stringify({ pqDowngradeFallbacks: 4, lastPqDowngradeAt: 1 }));
  await useSecurityDiagnostics.getState().recordPqDowngrade();
  expect(useSecurityDiagnostics.getState().pqDowngradeFallbacks).toBe(5);
});

it('reset clears the count and deletes the persisted blob', async () => {
  await useSecurityDiagnostics.getState().recordPqDowngrade();
  await useSecurityDiagnostics.getState().reset();
  expect(useSecurityDiagnostics.getState().pqDowngradeFallbacks).toBe(0);
  expect(mockMem.has(STORAGE_KEY)).toBe(false);
});
