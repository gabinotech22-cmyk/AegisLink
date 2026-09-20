/**
 * Notification content policy (audit 2026-09-20). "Show content" governs
 * everything that identifies a conversation on the lock screen:
 *   - previews OFF → generic title and body, for 1:1 AND groups (no group
 *     name), even when a keyword bypassed mute/master;
 *   - previews ON → the human label of the message, never the wire body (a
 *     media wire carries the blob key/nonce/token);
 *   - missed call: obeys master / muted caller / previews;
 *   - app-update notice obeys the master switch.
 */
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  setBadgeCountAsync: jest.fn(async () => true),
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidNotificationPriority: { HIGH: 'high', MAX: 'max', DEFAULT: 'default' },
}));
jest.mock('../../config', () => ({ SERVER_URL: 'https://example.test' }));
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn(async () => null), set: jest.fn(async () => undefined), delete: jest.fn(async () => undefined) },
}));
const mockGetContact = jest.fn(async (_id: string) => null as null | { mutedUntil?: number | null });
jest.mock('../../db/local', () => ({ getContact: (id: string) => mockGetContact(id) }));
jest.mock('../../store/messages', () => ({ useMessages: { getState: () => ({ unreadCounts: {} }) } }));

import * as Notifications from 'expo-notifications';
import { showIncomingNotification, showMissedCallNotification, setActiveChatNotificationId } from '../push';
import { usePreferences } from '../../store/preferences';

const sched = Notifications.scheduleNotificationAsync as jest.Mock;
const content = () => (sched.mock.calls[sched.mock.calls.length - 1][0] as { content: { title: string; body: string } }).content;
const BLOB = '[image:blob:9f1c-id:S3VrZXk=:bm9uY2U=:dG9rZW4=]mira esto';

beforeEach(() => {
  sched.mockClear();
  mockGetContact.mockResolvedValue(null);
  setActiveChatNotificationId(null);
  usePreferences.setState({ notifMaster: true, notifPreview: false, notifSound: true, notifKeywords: ['urgente'], mutedChats: [], mentionsOnlyChats: [] });
});

describe('previews OFF', () => {
  it('1:1 → generic title and body, no sender', async () => {
    await showIncomingNotification('ALICE', 'Alice', 'hola', false);
    expect(content().title).toBe('AegisLink');
    expect(content().body).not.toContain('hola');
    expect(content().body).not.toContain('Alice');
  });

  it('group → no group name, no sender', async () => {
    await showIncomingNotification('BOB', 'Bob', 'hola grupo', true, 'Equipo secreto', 'GRP');
    expect(content().title).toBe('AegisLink');
    expect(JSON.stringify(content())).not.toMatch(/Equipo secreto|Bob|hola grupo/);
  });

  it('a keyword bypasses mute but not the content switch', async () => {
    usePreferences.setState({ mutedChats: ['ALICE'] });
    await showIncomingNotification('ALICE', 'Alice', 'es URGENTE', false);
    expect(sched).toHaveBeenCalledTimes(1);
    expect(content().title).toBe('AegisLink');
    expect(content().body).not.toContain('URGENTE');
  });
});

describe('previews ON', () => {
  beforeEach(() => usePreferences.setState({ notifPreview: true }));

  it('shows the human label of a media message, never the blob reference', async () => {
    await showIncomingNotification('ALICE', 'Alice', BLOB, false);
    expect(content().title).toBe('AegisLink · Alice');
    expect(content().body).not.toContain('blob:');
    expect(content().body).not.toContain('S3VrZXk=');
    expect(content().body).toMatch(/📷/);
  });

  it('text shows as text', async () => {
    await showIncomingNotification('ALICE', 'Alice', 'hola', false);
    expect(content().body).toContain('hola');
  });
});

describe('missed call', () => {
  it('previews OFF → no caller name; master OFF → nothing; muted caller → nothing', async () => {
    await showMissedCallNotification('ALICE', 'Alice', 'c1');
    expect(content().title).toBe('AegisLink');
    sched.mockClear();
    usePreferences.setState({ notifMaster: false });
    await showMissedCallNotification('ALICE', 'Alice', 'c2');
    expect(sched).not.toHaveBeenCalled();
    usePreferences.setState({ notifMaster: true });
    mockGetContact.mockResolvedValue({ mutedUntil: Date.now() + 60_000 });
    await showMissedCallNotification('ALICE', 'Alice', 'c3');
    expect(sched).not.toHaveBeenCalled();
  });
});
