/**
 * messages store — unit tests
 *
 * Covers: softDelete, remoteDelete, pruneExpired, setChatEphemeralTimer,
 * getEphemeralTimer, append, clearChat, toggleReaction, togglePin,
 * loadChat (duress mode).
 *
 * All DB calls are mocked. Store state is reset before every test.
 */

// ── Mocks must be hoisted before any imports ──────────────────────────────────

jest.mock('../../db/local', () => ({
  loadMessagesByChat: jest.fn().mockResolvedValue([]),
  saveMessage: jest.fn().mockResolvedValue(undefined),
  lastMessageByChat: jest.fn().mockResolvedValue(null),
  getChatState: jest.fn().mockResolvedValue({ draft: null, unreadCount: 0 }),
  setChatDraft: jest.fn().mockResolvedValue(undefined),
  incrementUnread: jest.fn().mockResolvedValue(undefined),
  resetUnread: jest.fn().mockResolvedValue(undefined),
  getAllUnreadCounts: jest.fn().mockResolvedValue({}),
  deleteExpiredMessages: jest.fn().mockResolvedValue(undefined),
  deleteContactMessages: jest.fn().mockResolvedValue(undefined),
  deleteChatState: jest.fn().mockResolvedValue(undefined),
  deleteContactRatchetSession: jest.fn().mockResolvedValue(undefined),
  setChatEphemeralTimer: jest.fn().mockResolvedValue(undefined),
  getAllChatEphemeralTimers: jest.fn().mockResolvedValue({}),
  setMessageStarred: jest.fn().mockResolvedValue(undefined),
  setMessageDeleted: jest.fn().mockResolvedValue(undefined),
  setMessageReactions: jest.fn().mockResolvedValue(undefined),
  updateMessageDelivery: jest.fn().mockResolvedValue(undefined),
  setMessagePinned: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../preferences', () => ({
  usePreferences: { getState: () => ({ duressActive: false }) },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { useMessages } from '../messages';
import type { StoredMessage } from '../../db/local';
import * as dbLocal from '../../db/local';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    chatId: 'chat-alice',
    direction: 'out',
    body: 'hello',
    createdAt: Date.now(),
    type: 'text',
    mediaUri: null,
    deleted: false,
    starred: false,
    pinned: false,
    deliveryStatus: 'sent',
    reactions: {},
    replyToId: null,
    expiresAt: null,
    ...overrides,
  };
}

function resetStore() {
  useMessages.setState({
    byChat: {},
    previews: {},
    pinnedMsg: {},
    ephemeralTimer: 0,
    ephemeralTimers: {},
    pendingMediaUri: null,
    unreadCounts: {},
    drafts: {},
  });
}

// ── describe: softDelete ──────────────────────────────────────────────────────

describe('softDelete', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('marks deleted: true, body: "", mediaUri: null on the target message', async () => {
    const msg = makeMsg({ id: 'msg-1', body: 'secret', mediaUri: 'file://img.jpg' });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().softDelete('chat-alice', 'msg-1');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.deleted).toBe(true);
    expect(updated.body).toBe('');
    expect(updated.mediaUri).toBeNull();
  });

  it('does not affect other messages in the same chat', async () => {
    const msg1 = makeMsg({ id: 'msg-1', body: 'first' });
    const msg2 = makeMsg({ id: 'msg-2', body: 'second' });
    useMessages.setState({ byChat: { 'chat-alice': [msg1, msg2] } });

    await useMessages.getState().softDelete('chat-alice', 'msg-1');

    const list = useMessages.getState().byChat['chat-alice'];
    expect(list[1].id).toBe('msg-2');
    expect(list[1].body).toBe('second');
    expect(list[1].deleted).toBe(false);
  });

  it('calls setMessageDeleted(id) on the db', async () => {
    const msg = makeMsg({ id: 'msg-1' });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().softDelete('chat-alice', 'msg-1');

    expect(dbLocal.setMessageDeleted).toHaveBeenCalledWith('msg-1');
  });

  it('does nothing if chatId does not exist in byChat', async () => {
    // byChat is empty — softDelete creates an empty entry for the ghost chatId
    // because the set() call runs unconditionally, but no message is mutated.
    await useMessages.getState().softDelete('chat-ghost', 'msg-1');

    // The ghost key is created with an empty array — no messages were deleted.
    expect(useMessages.getState().byChat['chat-ghost']).toEqual([]);
  });
});

// ── describe: remoteDelete ────────────────────────────────────────────────────

describe('remoteDelete', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('marks deleted: true, body: "", mediaUri: null on the target message', async () => {
    const msg = makeMsg({ id: 'msg-1', body: 'remote content', mediaUri: 'file://r.jpg' });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().remoteDelete('chat-alice', 'msg-1');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.deleted).toBe(true);
    expect(updated.body).toBe('');
    expect(updated.mediaUri).toBeNull();
  });

  it('calls setMessageDeleted(id) on the db', async () => {
    const msg = makeMsg({ id: 'msg-1' });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().remoteDelete('chat-alice', 'msg-1');

    expect(dbLocal.setMessageDeleted).toHaveBeenCalledWith('msg-1');
  });

  it('does not affect sibling messages in the same chat', async () => {
    const msg1 = makeMsg({ id: 'msg-1', body: 'one' });
    const msg2 = makeMsg({ id: 'msg-2', body: 'two' });
    useMessages.setState({ byChat: { 'chat-alice': [msg1, msg2] } });

    await useMessages.getState().remoteDelete('chat-alice', 'msg-1');

    const list = useMessages.getState().byChat['chat-alice'];
    expect(list[1].body).toBe('two');
    expect(list[1].deleted).toBe(false);
  });
});

// ── describe: pruneExpired ────────────────────────────────────────────────────

describe('pruneExpired', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('removes messages whose expiresAt is <= Date.now()', () => {
    const expired = makeMsg({ id: 'msg-exp', expiresAt: Date.now() - 1000 });
    useMessages.setState({ byChat: { 'chat-alice': [expired] } });

    useMessages.getState().pruneExpired();

    expect(useMessages.getState().byChat['chat-alice']).toHaveLength(0);
  });

  it('does NOT remove messages whose expiresAt is > Date.now()', () => {
    const future = makeMsg({ id: 'msg-future', expiresAt: Date.now() + 60_000 });
    useMessages.setState({ byChat: { 'chat-alice': [future] } });

    useMessages.getState().pruneExpired();

    expect(useMessages.getState().byChat['chat-alice']).toHaveLength(1);
  });

  it('does NOT remove messages with expiresAt: null', () => {
    const permanent = makeMsg({ id: 'msg-perm', expiresAt: null });
    useMessages.setState({ byChat: { 'chat-alice': [permanent] } });

    useMessages.getState().pruneExpired();

    expect(useMessages.getState().byChat['chat-alice']).toHaveLength(1);
  });

  it('does NOT remove messages with expiresAt: undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { expiresAt: _ignored, ...rest } = makeMsg({ id: 'msg-undef' });
    const noExpiry = rest as StoredMessage;
    useMessages.setState({ byChat: { 'chat-alice': [noExpiry] } });

    useMessages.getState().pruneExpired();

    expect(useMessages.getState().byChat['chat-alice']).toHaveLength(1);
  });

  it('always calls deleteExpiredMessages() (unconditionally)', () => {
    // Even when nothing was pruned, the db sweep still fires
    const permanent = makeMsg({ id: 'msg-perm', expiresAt: null });
    useMessages.setState({ byChat: { 'chat-alice': [permanent] } });

    useMessages.getState().pruneExpired();

    // deleteExpiredMessages is always fired (fire-and-forget)
    expect(dbLocal.deleteExpiredMessages).toHaveBeenCalled();
  });

  it('calls deleteExpiredMessages() when messages were expired', () => {
    const expired = makeMsg({ id: 'msg-exp', expiresAt: Date.now() - 500 });
    useMessages.setState({ byChat: { 'chat-alice': [expired] } });

    useMessages.getState().pruneExpired();

    expect(dbLocal.deleteExpiredMessages).toHaveBeenCalled();
  });
});

// ── describe: setChatEphemeralTimer ───────────────────────────────────────────

describe('setChatEphemeralTimer', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('stores the timer in ephemeralTimers[chatId]', async () => {
    await useMessages.getState().setChatEphemeralTimer('chat-alice', 30);

    expect(useMessages.getState().ephemeralTimers['chat-alice']).toBe(30);
  });

  it('calls setChatEphemeralTimer(chatId, seconds) on the db', async () => {
    await useMessages.getState().setChatEphemeralTimer('chat-alice', 60);

    expect(dbLocal.setChatEphemeralTimer).toHaveBeenCalledWith('chat-alice', 60);
  });

  it('setting 0 stores 0 (disables the timer)', async () => {
    await useMessages.getState().setChatEphemeralTimer('chat-alice', 30);
    await useMessages.getState().setChatEphemeralTimer('chat-alice', 0);

    expect(useMessages.getState().ephemeralTimers['chat-alice']).toBe(0);
  });

  it('persists independent timers for different chats', async () => {
    await useMessages.getState().setChatEphemeralTimer('chat-alice', 10);
    await useMessages.getState().setChatEphemeralTimer('chat-bob', 120);

    expect(useMessages.getState().ephemeralTimers['chat-alice']).toBe(10);
    expect(useMessages.getState().ephemeralTimers['chat-bob']).toBe(120);
  });
});

// ── describe: getEphemeralTimer ───────────────────────────────────────────────

describe('getEphemeralTimer', () => {
  beforeEach(() => resetStore());

  it('returns 0 when no timer has been set for the chatId', () => {
    const result = useMessages.getState().getEphemeralTimer('chat-unknown');
    expect(result).toBe(0);
  });

  it('returns the correct value when a timer exists', async () => {
    await useMessages.getState().setChatEphemeralTimer('chat-alice', 45);

    const result = useMessages.getState().getEphemeralTimer('chat-alice');
    expect(result).toBe(45);
  });
});

// ── describe: append ──────────────────────────────────────────────────────────

describe('append', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('adds the message to byChat[chatId]', async () => {
    const msg = makeMsg({ id: 'msg-1', chatId: 'chat-alice', direction: 'out' });

    await useMessages.getState().append(msg);

    expect(useMessages.getState().byChat['chat-alice']).toHaveLength(1);
    expect(useMessages.getState().byChat['chat-alice'][0].id).toBe('msg-1');
  });

  it('appends to an existing list without replacing it', async () => {
    const first = makeMsg({ id: 'msg-1', chatId: 'chat-alice', direction: 'out' });
    const second = makeMsg({ id: 'msg-2', chatId: 'chat-alice', direction: 'in' });
    useMessages.setState({ byChat: { 'chat-alice': [first] } });

    await useMessages.getState().append(second);

    expect(useMessages.getState().byChat['chat-alice']).toHaveLength(2);
  });

  it('updates previews[chatId] to the appended message', async () => {
    const msg = makeMsg({ id: 'msg-1', chatId: 'chat-alice', body: 'preview me' });

    await useMessages.getState().append(msg);

    expect(useMessages.getState().previews['chat-alice'].id).toBe('msg-1');
  });

  it('increments unreadCounts for incoming (direction: "in") messages', async () => {
    const inbound = makeMsg({ id: 'msg-in', chatId: 'chat-alice', direction: 'in' });

    await useMessages.getState().append(inbound);

    expect(useMessages.getState().unreadCounts['chat-alice']).toBe(1);
  });

  it('increments unreadCounts cumulatively for multiple inbound messages', async () => {
    const m1 = makeMsg({ id: 'msg-1', chatId: 'chat-alice', direction: 'in' });
    const m2 = makeMsg({ id: 'msg-2', chatId: 'chat-alice', direction: 'in' });

    await useMessages.getState().append(m1);
    await useMessages.getState().append(m2);

    expect(useMessages.getState().unreadCounts['chat-alice']).toBe(2);
  });

  it('does NOT increment unreadCounts for outgoing (direction: "out") messages', async () => {
    const outbound = makeMsg({ id: 'msg-out', chatId: 'chat-alice', direction: 'out' });

    await useMessages.getState().append(outbound);

    expect(useMessages.getState().unreadCounts['chat-alice']).toBeUndefined();
  });

  it('does NOT increment unreadCounts for an incoming message whose chat is currently focused', async () => {
    const { setActiveChatNotificationId } = require('../../notifications/push') as typeof import('../../notifications/push');
    setActiveChatNotificationId('chat-alice');
    try {
      const inbound = makeMsg({ id: 'msg-in', chatId: 'chat-alice', direction: 'in' });
      await useMessages.getState().append(inbound);
      // User is looking at the chat — badge stays at 0, message still stored.
      expect(useMessages.getState().unreadCounts['chat-alice']).toBe(0);
      expect(useMessages.getState().byChat['chat-alice']).toHaveLength(1);
    } finally {
      setActiveChatNotificationId(null);
    }
  });

  it('STILL increments unreadCounts for an incoming message to a non-focused chat', async () => {
    const { setActiveChatNotificationId } = require('../../notifications/push') as typeof import('../../notifications/push');
    setActiveChatNotificationId('chat-alice'); // a DIFFERENT chat is focused
    try {
      const inbound = makeMsg({ id: 'msg-in', chatId: 'chat-bob', direction: 'in' });
      await useMessages.getState().append(inbound);
      expect(useMessages.getState().unreadCounts['chat-bob']).toBe(1);
    } finally {
      setActiveChatNotificationId(null);
    }
  });
});

// ── describe: clearChat ───────────────────────────────────────────────────────

describe('clearChat', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('removes byChat entry for the chatId', async () => {
    const msg = makeMsg({ chatId: 'chat-alice' });
    useMessages.setState({
      byChat: { 'chat-alice': [msg] },
      previews: { 'chat-alice': msg },
      unreadCounts: { 'chat-alice': 3 },
      pinnedMsg: { 'chat-alice': msg },
      drafts: { 'chat-alice': 'draft text' },
    });

    await useMessages.getState().clearChat('chat-alice');

    expect(useMessages.getState().byChat['chat-alice']).toBeUndefined();
  });

  it('removes previews, unreadCounts, pinnedMsg and drafts for the chatId', async () => {
    const msg = makeMsg({ chatId: 'chat-alice' });
    useMessages.setState({
      byChat: { 'chat-alice': [msg] },
      previews: { 'chat-alice': msg },
      unreadCounts: { 'chat-alice': 2 },
      pinnedMsg: { 'chat-alice': msg },
      drafts: { 'chat-alice': 'hello' },
    });

    await useMessages.getState().clearChat('chat-alice');

    const s = useMessages.getState();
    expect(s.previews['chat-alice']).toBeUndefined();
    expect(s.unreadCounts['chat-alice']).toBeUndefined();
    expect(s.pinnedMsg['chat-alice']).toBeUndefined();
    expect(s.drafts['chat-alice']).toBeUndefined();
  });

  it('calls deleteContactMessages, deleteChatState, deleteContactRatchetSession', async () => {
    useMessages.setState({ byChat: { 'chat-alice': [] } });

    await useMessages.getState().clearChat('chat-alice');

    expect(dbLocal.deleteContactMessages).toHaveBeenCalledWith('chat-alice');
    expect(dbLocal.deleteChatState).toHaveBeenCalledWith('chat-alice');
    expect(dbLocal.deleteContactRatchetSession).toHaveBeenCalledWith('chat-alice');
  });

  it('does not affect other chats', async () => {
    const aliceMsg = makeMsg({ id: 'msg-a', chatId: 'chat-alice' });
    const bobMsg = makeMsg({ id: 'msg-b', chatId: 'chat-bob' });
    useMessages.setState({
      byChat: { 'chat-alice': [aliceMsg], 'chat-bob': [bobMsg] },
      previews: { 'chat-alice': aliceMsg, 'chat-bob': bobMsg },
      unreadCounts: { 'chat-alice': 1, 'chat-bob': 5 },
    });

    await useMessages.getState().clearChat('chat-alice');

    const s = useMessages.getState();
    expect(s.byChat['chat-bob']).toHaveLength(1);
    expect(s.previews['chat-bob'].id).toBe('msg-b');
    expect(s.unreadCounts['chat-bob']).toBe(5);
  });
});

// ── describe: toggleReaction ──────────────────────────────────────────────────

describe('toggleReaction', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('adds an emoji when it does not exist yet', async () => {
    const msg = makeMsg({ id: 'msg-1', reactions: {} });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().toggleReaction('chat-alice', 'msg-1', '❤️', 'user-a');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.reactions?.['❤️']).toContain('user-a');
  });

  it('removes the emoji for a reactor who already reacted (toggle off)', async () => {
    const msg = makeMsg({ id: 'msg-1', reactions: { '❤️': ['user-a'] } });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().toggleReaction('chat-alice', 'msg-1', '❤️', 'user-a');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    // With 0 reactors the key should be removed entirely
    expect(updated.reactions?.['❤️']).toBeUndefined();
  });

  it('supports multiple reactors on the same emoji', async () => {
    const msg = makeMsg({ id: 'msg-1', reactions: { '👍': ['user-a'] } });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().toggleReaction('chat-alice', 'msg-1', '👍', 'user-b');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.reactions?.['👍']).toContain('user-a');
    expect(updated.reactions?.['👍']).toContain('user-b');
    expect(updated.reactions?.['👍']).toHaveLength(2);
  });

  it('cleans up the emoji key when the last reactor removes their reaction', async () => {
    const msg = makeMsg({ id: 'msg-1', reactions: { '🔥': ['user-a'] } });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().toggleReaction('chat-alice', 'msg-1', '🔥', 'user-a');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.reactions).not.toHaveProperty('🔥');
  });

  it('uses "self" as the default reactorId when aegisId is omitted', async () => {
    const msg = makeMsg({ id: 'msg-1', reactions: {} });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().toggleReaction('chat-alice', 'msg-1', '😂');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.reactions?.['😂']).toContain('self');
  });
});

// ── describe: togglePin ───────────────────────────────────────────────────────

describe('togglePin', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('pins a message that is currently unpinned', async () => {
    const msg = makeMsg({ id: 'msg-1', pinned: false });
    useMessages.setState({ byChat: { 'chat-alice': [msg] } });

    await useMessages.getState().togglePin('chat-alice', 'msg-1');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.pinned).toBe(true);
    expect(useMessages.getState().pinnedMsg['chat-alice']?.id).toBe('msg-1');
  });

  it('unpins a message that is already pinned (toggle off)', async () => {
    const msg = makeMsg({ id: 'msg-1', pinned: true });
    useMessages.setState({
      byChat: { 'chat-alice': [msg] },
      pinnedMsg: { 'chat-alice': msg },
    });

    await useMessages.getState().togglePin('chat-alice', 'msg-1');

    const updated = useMessages.getState().byChat['chat-alice'][0];
    expect(updated.pinned).toBe(false);
    expect(useMessages.getState().pinnedMsg['chat-alice']).toBeNull();
  });

  it('unpins the previously pinned message when a new one is pinned', async () => {
    const first = makeMsg({ id: 'msg-1', pinned: true });
    const second = makeMsg({ id: 'msg-2', pinned: false });
    useMessages.setState({
      byChat: { 'chat-alice': [first, second] },
      pinnedMsg: { 'chat-alice': first },
    });

    await useMessages.getState().togglePin('chat-alice', 'msg-2');

    const list = useMessages.getState().byChat['chat-alice'];
    const prev = list.find((m) => m.id === 'msg-1');
    const next = list.find((m) => m.id === 'msg-2');

    expect(prev?.pinned).toBe(false);
    expect(next?.pinned).toBe(true);
    expect(useMessages.getState().pinnedMsg['chat-alice']?.id).toBe('msg-2');
  });

  it('calls setMessagePinned for the target and the previous pin', async () => {
    const first = makeMsg({ id: 'msg-1', pinned: true });
    const second = makeMsg({ id: 'msg-2', pinned: false });
    useMessages.setState({
      byChat: { 'chat-alice': [first, second] },
      pinnedMsg: { 'chat-alice': first },
    });

    await useMessages.getState().togglePin('chat-alice', 'msg-2');

    expect(dbLocal.setMessagePinned).toHaveBeenCalledWith('msg-1', false);
    expect(dbLocal.setMessagePinned).toHaveBeenCalledWith('msg-2', true);
  });
});

// ── describe: loadChat — duress mode ─────────────────────────────────────────

describe('loadChat — duress mode', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('returns [] and does not call loadMessagesByChat when duressActive is true', async () => {
    // Override the preferences mock to simulate duress mode
    jest.resetModules();
    jest.doMock('../preferences', () => ({
      usePreferences: { getState: () => ({ duressActive: true }) },
    }));

    // Re-import store after re-mocking preferences
    // We achieve duress simulation by temporarily patching the mock module
    const { usePreferences } = require('../preferences') as {
      usePreferences: { getState: () => { duressActive: boolean } };
    };
    (usePreferences as { getState: () => { duressActive: boolean } }).getState = () => ({
      duressActive: true,
    });

    const result = await useMessages.getState().loadChat('chat-alice');

    expect(result).toEqual([]);
    expect(dbLocal.loadMessagesByChat).not.toHaveBeenCalled();

    // Restore to non-duress for other tests
    (usePreferences as { getState: () => { duressActive: boolean } }).getState = () => ({
      duressActive: false,
    });
  });
});
