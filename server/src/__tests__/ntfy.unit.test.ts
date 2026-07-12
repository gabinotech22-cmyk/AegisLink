/**
 * ntfy.unit.test.ts
 *
 * Fase 4 · Slice 2b.1 — unit-level gating for notifyMailbox() against a
 * stubbed `fetch`. Kept in its own file (no module mock like
 * ntfyMailboxPush.relay.test.ts) so the real gate logic runs.
 *
 * Server jest config is ESM (ts-jest/presets/default-esm, jest globals NOT
 * injected) — `jest` must come from '@jest/globals' (see blob.test.ts).
 */

import { jest } from '@jest/globals';

describe('notifyMailbox() gate', () => {
  test('flag off -> no fetch call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const prevFlag = process.env['PUSH_MAILBOX_ENABLED'];
    const prevUrl = process.env['NTFY_URL'];
    delete process.env['PUSH_MAILBOX_ENABLED'];
    process.env['NTFY_URL'] = 'http://ntfy:80';
    try {
      const { notifyMailbox } = await import('../push/ntfy.js');
      await notifyMailbox('AAAA');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (prevFlag === undefined) delete process.env['PUSH_MAILBOX_ENABLED'];
      else process.env['PUSH_MAILBOX_ENABLED'] = prevFlag;
      if (prevUrl === undefined) delete process.env['NTFY_URL'];
      else process.env['NTFY_URL'] = prevUrl;
    }
  });

  test('flag on, no NTFY_URL -> no fetch call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const prevFlag = process.env['PUSH_MAILBOX_ENABLED'];
    const prevUrl = process.env['NTFY_URL'];
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    delete process.env['NTFY_URL'];
    try {
      const { notifyMailbox } = await import('../push/ntfy.js');
      await notifyMailbox('AAAA');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (prevFlag === undefined) delete process.env['PUSH_MAILBOX_ENABLED'];
      else process.env['PUSH_MAILBOX_ENABLED'] = prevFlag;
      if (prevUrl === undefined) delete process.env['NTFY_URL'];
      else process.env['NTFY_URL'] = prevUrl;
    }
  });

  test('flag on + NTFY_URL set -> POSTs an empty body to topic=mailboxTopic(id)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const prevFlag = process.env['PUSH_MAILBOX_ENABLED'];
    const prevUrl = process.env['NTFY_URL'];
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    process.env['NTFY_URL'] = 'http://ntfy:80';
    try {
      const { notifyMailbox, mailboxTopic: topicFn } = await import('../push/ntfy.js');
      await notifyMailbox('a+b/c==');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe(`http://ntfy:80/${topicFn('a+b/c==')}`);
      expect((init as RequestInit).body).toBe('');
      expect((init as RequestInit).headers).toMatchObject({ Priority: 'high' });
    } finally {
      fetchSpy.mockRestore();
      if (prevFlag === undefined) delete process.env['PUSH_MAILBOX_ENABLED'];
      else process.env['PUSH_MAILBOX_ENABLED'] = prevFlag;
      if (prevUrl === undefined) delete process.env['NTFY_URL'];
      else process.env['NTFY_URL'] = prevUrl;
    }
  });
});
