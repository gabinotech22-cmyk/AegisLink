/**
 * State reconciliation (2026-09-20 audit), desktop twin of the mobile cases in
 * store/__tests__/messages.test.ts:
 *   - a store action on a chat that was never loaded must not leave behind a
 *     partial list that loadChat later trusts as the whole history;
 *   - the sidebar preview follows deletes (for me / for everyone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  loadMessagesByChat: vi.fn(async (_c: string) => [] as unknown[]),
  lastMessageByChat: vi.fn(async (_c: string) => null as unknown),
}));

vi.mock('../../db/local', () => ({
  loadMessagesByChat: (c: string) => h.loadMessagesByChat(c),
  saveMessage: vi.fn(async () => undefined),
  lastMessageByChat: (c: string) => h.lastMessageByChat(c),
  getChatState: vi.fn(async () => ({ draft: null, unreadCount: 0 })),
  setChatDraft: vi.fn(async () => undefined),
  incrementUnread: vi.fn(async () => undefined),
  resetUnread: vi.fn(async () => undefined),
  getAllUnreadCounts: vi.fn(async () => ({})),
  deleteExpiredMessages: vi.fn(async () => undefined),
  deleteContactMessages: vi.fn(async () => undefined),
  deleteChatState: vi.fn(async () => undefined),
  deleteContactRatchetSession: vi.fn(async () => undefined),
  setMessageStarred: vi.fn(async () => undefined),
  setMessageDeleted: vi.fn(async () => undefined),
  setRemoteMessageDeleted: vi.fn(async () => true),
  setMessageReactions: vi.fn(async () => undefined),
  setMessagePinned: vi.fn(async () => undefined),
  updateMessageDelivery: vi.fn(async () => undefined),
}));
vi.mock('../preferences', () => ({ usePreferences: { getState: () => ({ duressActive: false }) } }));

import { useMessages } from '../messages';
import type { StoredMessage } from '../../db/local';

function msg(o: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'm', chatId: 'c', direction: 'out', body: 'hi', createdAt: Date.now(), type: 'text',
    mediaUri: null, deleted: false, starred: false, pinned: false, deliveryStatus: 'sent',
    reactions: {}, replyToId: null, expiresAt: null, ...o,
  } as StoredMessage;
}

beforeEach(() => {
  useMessages.setState({ byChat: {}, loadedChats: {}, previews: {}, pinnedMsg: {}, unreadCounts: {}, drafts: {} });
  h.loadMessagesByChat.mockReset();
  h.lastMessageByChat.mockReset();
});

describe('loadedChats', () => {
  it('a delivery receipt for an unopened chat does not make it open empty', async () => {
    h.loadMessagesByChat.mockResolvedValueOnce([msg({ id: 'old-1' }), msg({ id: 'old-2' })]);
    await useMessages.getState().updateDelivery('c', 'old-2', 'delivered'); // seeds byChat.c = []
    expect(useMessages.getState().byChat['c']).toEqual([]);
    const list = await useMessages.getState().loadChat('c');
    expect(list.map((m) => m.id)).toEqual(['old-1', 'old-2']);
  });

  it('an incoming message before the chat is loaded does not hide the history', async () => {
    h.loadMessagesByChat.mockResolvedValueOnce([msg({ id: 'old' }), msg({ id: 'new', direction: 'in' })]);
    await useMessages.getState().append(msg({ id: 'new', direction: 'in' }));
    const list = await useMessages.getState().loadChat('c');
    expect(list.map((m) => m.id)).toEqual(['old', 'new']);
  });

  it('once loaded, the cache is used', async () => {
    h.loadMessagesByChat.mockResolvedValueOnce([msg({ id: 'a' })]);
    await useMessages.getState().loadChat('c');
    await useMessages.getState().loadChat('c');
    expect(h.loadMessagesByChat).toHaveBeenCalledTimes(1);
  });
});

describe('previews follow deletes', () => {
  it('softDelete / remoteDelete of the last message blank the sidebar preview', async () => {
    const last = msg({ id: 'last', body: 'secret', direction: 'in' });
    useMessages.setState({ byChat: { c: [last] }, previews: { c: last } });
    await useMessages.getState().softDelete('c', 'last');
    expect(useMessages.getState().previews['c']).toMatchObject({ deleted: true, body: '' });

    const again = msg({ id: 'again', body: 'more', direction: 'in' });
    useMessages.setState({ byChat: { c: [again] }, previews: { c: again } });
    await useMessages.getState().remoteDelete('c', 'again');
    expect(useMessages.getState().previews['c']).toMatchObject({ deleted: true, body: '' });
  });
});
