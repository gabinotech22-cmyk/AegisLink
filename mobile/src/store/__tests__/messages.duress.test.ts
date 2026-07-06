/**
 * messages store — duress (coercion) write-guard tests
 *
 * A message the coercer sends/receives while the decoy account is shown must
 * be reflected in memory (so the decoy UI looks alive) but NEVER reach the
 * real SQLite DB. This locks that in across the write-mutators.
 */

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
  setRemoteMessageDeleted: jest.fn().mockResolvedValue(true),
  setMessageReactions: jest.fn().mockResolvedValue(undefined),
  updateMessageDelivery: jest.fn().mockResolvedValue(undefined),
  setMessagePinned: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../preferences', () => ({
  usePreferences: { getState: jest.fn() },
}));

const mockAppendDecoyMessage = jest.fn().mockResolvedValue(undefined);
jest.mock('../duressDecoy', () => ({
  getOrCreateDecoyBlob: jest.fn().mockResolvedValue({
    identity: { aegisId: 'DECOY-0000-0000' },
    contacts: [],
    messagesByChat: {},
  }),
  appendDecoyMessage: (...args: unknown[]) => mockAppendDecoyMessage(...args),
}));

jest.mock('../contacts', () => ({
  useContacts: { getState: () => ({ contacts: [], setChatHidden: jest.fn() }) },
}));

import { useMessages } from '../messages';
import { usePreferences } from '../preferences';
import * as dbLocal from '../../db/local';
import type { StoredMessage } from '../../db/local';

function setDuress(active: boolean) {
  (usePreferences.getState as jest.Mock).mockReturnValue({ duressActive: active });
}

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    chatId: 'decoy-chat',
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

describe('messages store — duress write guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDuress(true);
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
  });

  it('append() writes to the decoy blob, not saveMessage (real DB)', async () => {
    const msg = makeMsg();
    await useMessages.getState().append(msg);

    expect(mockAppendDecoyMessage).toHaveBeenCalledWith('decoy-chat', msg);
    expect(dbLocal.saveMessage).not.toHaveBeenCalled();
    expect(useMessages.getState().byChat['decoy-chat']).toEqual([msg]);
  });

  it('toggleStar() updates in-memory only — setMessageStarred is never called', async () => {
    const msg = makeMsg({ id: 'm1', starred: false });
    useMessages.setState({ byChat: { 'decoy-chat': [msg] } });

    await useMessages.getState().toggleStar('decoy-chat', 'm1');

    expect(useMessages.getState().byChat['decoy-chat'][0].starred).toBe(true);
    expect(dbLocal.setMessageStarred).not.toHaveBeenCalled();
  });

  it('softDelete() updates in-memory only — setMessageDeleted is never called', async () => {
    const msg = makeMsg({ id: 'm1' });
    useMessages.setState({ byChat: { 'decoy-chat': [msg] } });

    await useMessages.getState().softDelete('decoy-chat', 'm1');

    expect(useMessages.getState().byChat['decoy-chat'][0].deleted).toBe(true);
    expect(dbLocal.setMessageDeleted).not.toHaveBeenCalled();
  });

  it('togglePin() updates in-memory only — setMessagePinned is never called', async () => {
    const msg = makeMsg({ id: 'm1', pinned: false });
    useMessages.setState({ byChat: { 'decoy-chat': [msg] } });

    await useMessages.getState().togglePin('decoy-chat', 'm1');

    expect(useMessages.getState().byChat['decoy-chat'][0].pinned).toBe(true);
    expect(dbLocal.setMessagePinned).not.toHaveBeenCalled();
  });

  it('clearChat() clears in-memory only — no real deleteContactMessages/deleteChatState calls', async () => {
    useMessages.setState({ byChat: { 'decoy-chat': [makeMsg()] }, previews: { 'decoy-chat': makeMsg() } });

    await useMessages.getState().clearChat('decoy-chat');

    // An empty cached entry (not undefined): loadChat's in-memory cache must
    // win so the cleared chat isn't resurrected from the decoy blob.
    expect(useMessages.getState().byChat['decoy-chat']).toEqual([]);
    expect(dbLocal.deleteContactMessages).not.toHaveBeenCalled();
    expect(dbLocal.deleteChatState).not.toHaveBeenCalled();
    expect(dbLocal.deleteContactRatchetSession).not.toHaveBeenCalled();
  });

  it('saveDraft() updates in-memory only — setChatDraft is never called', async () => {
    await useMessages.getState().saveDraft('decoy-chat', 'draft text');

    expect(useMessages.getState().drafts['decoy-chat']).toBe('draft text');
    expect(dbLocal.setChatDraft).not.toHaveBeenCalled();
  });

  // Read-side guards: Home mounts and App foregrounds while the decoy is
  // shown, so these loaders must not pull real-DB state into the decoy UI.
  it('loadAllUnreads() never reads the real DB under duress', async () => {
    await useMessages.getState().loadAllUnreads();
    expect(dbLocal.getAllUnreadCounts).not.toHaveBeenCalled();
    expect(useMessages.getState().unreadCounts).toEqual({});
  });

  it('loadAllEphemeralTimers() never reads the real DB under duress', async () => {
    await useMessages.getState().loadAllEphemeralTimers();
    expect(dbLocal.getAllChatEphemeralTimers).not.toHaveBeenCalled();
    expect(useMessages.getState().ephemeralTimers).toEqual({});
  });

  it('refreshPreview() never reads the real DB under duress', async () => {
    await useMessages.getState().refreshPreview('decoy-chat');
    expect(dbLocal.lastMessageByChat).not.toHaveBeenCalled();
  });

  it('setChatEphemeralTimer() updates in-memory only under duress', async () => {
    await useMessages.getState().setChatEphemeralTimer('decoy-chat', 300);
    expect(useMessages.getState().ephemeralTimers['decoy-chat']).toBe(300);
    expect(dbLocal.setChatEphemeralTimer).not.toHaveBeenCalled();
  });

  it('loadChat() prefers in-memory decoy state over the blob (in-session edits survive reopen)', async () => {
    const edited = makeMsg({ id: 'm1', starred: true });
    useMessages.setState({ byChat: { 'decoy-chat': [edited] } });

    const list = await useMessages.getState().loadChat('decoy-chat');

    expect(list).toEqual([edited]);
    // The blob (mocked with messagesByChat: {}) must not have clobbered the edit.
    expect(useMessages.getState().byChat['decoy-chat'][0].starred).toBe(true);
  });

  it('clearChat() under duress leaves an empty cached entry so the chat is not resurrected from the blob', async () => {
    useMessages.setState({ byChat: { 'decoy-chat': [makeMsg()] } });

    await useMessages.getState().clearChat('decoy-chat');
    expect(useMessages.getState().byChat['decoy-chat']).toEqual([]);

    // Reopening the chat must respect the cleared (cached) state, not reload
    // the seeded conversation from the decoy blob.
    const list = await useMessages.getState().loadChat('decoy-chat');
    expect(list).toEqual([]);
  });
});
