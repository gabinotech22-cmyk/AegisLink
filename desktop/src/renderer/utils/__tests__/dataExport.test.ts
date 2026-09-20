/**
 * Export payload — what a plaintext GDPR file may contain. Pins: deleted
 * messages export without their text, attachments (mediaUri or wire tag with
 * the blob key) are omitted, groups are included with senderId, contacts /
 * settings follow the picks.
 */
import { describe, it, expect } from 'vitest';
import { buildExportPayload, exportBody, OMITTED_ATTACHMENT } from '../dataExport';

describe('exportBody', () => {
  it('drops deleted text, omits attachments and wire tags, keeps text', () => {
    expect(exportBody({ body: 'secret', deleted: true })).toBe('');
    expect(exportBody({ body: 'caption', mediaUri: 'file:///x.jpg' })).toBe(OMITTED_ATTACHMENT);
    expect(exportBody({ body: '[image:blob:id:KEY:nonce:token]' })).toBe(OMITTED_ATTACHMENT);
    expect(exportBody({ body: '[file:plan.pdf:blob:id:KEY]' })).toBe(OMITTED_ATTACHMENT);
    expect(exportBody({ body: 'hola' })).toBe('hola');
  });
});

describe('buildExportPayload', () => {
  const settings = { readReceipts: true, typingIndicator: false, blockScreenshots: true };
  const contacts = [{ aegisId: 'AAA-BBBB-CCCC', name: 'Carmen', verified: true, color: '#abc' }];
  const groups = [{ id: 'g1', name: 'Familia' }];
  const store: Record<string, unknown[]> = {
    'AAA-BBBB-CCCC': [
      { id: 'm1', direction: 'in', body: 'hola', createdAt: 1_700_000_000_000 },
      { id: 'm2', direction: 'out', body: 'borrado', createdAt: 1_700_000_001_000, deleted: true },
    ],
    g1: [{ id: 'g1m1', direction: 'in', body: '[image:blob:id:KEY:n:t]', createdAt: 1_700_000_002_000, senderId: 'DDD-EEEE-FFFF' }],
  };
  const loadMessages = async (id: string) => (store[id] ?? []) as never;

  it('includes contact and group conversations, never a blob key or deleted text', async () => {
    const p = await buildExportPayload({ aegisId: 'ME', contacts, groups, pick: { messages: true, contacts: true, settings: true }, settings, loadMessages });
    expect(p.version).toBe(2);
    expect(Object.keys(p.conversations)).toEqual(['Carmen (AAA-BBBB-CCCC)', 'group: Familia (g1)']);
    expect(p.totalMessages).toBe(3);
    const json = JSON.stringify(p);
    expect(json).not.toContain('KEY');
    expect(json).not.toContain('borrado');
    expect(p.conversations['group: Familia (g1)'][0].senderId).toBe('DDD-EEEE-FFFF');
    expect(p.conversations['Carmen (AAA-BBBB-CCCC)'][1]).toMatchObject({ deleted: true, body: '' });
    expect(p.settings).toEqual(settings);
    expect(p.contacts).toHaveLength(1);
  });

  it('honours the picks', async () => {
    const p = await buildExportPayload({ aegisId: 'ME', contacts, groups, pick: { messages: false, contacts: false, settings: false }, settings, loadMessages });
    expect(p.conversations).toEqual({});
    expect(p.totalMessages).toBe(0);
    expect(p.contacts).toEqual([]);
    expect(p.settings).toBeNull();
  });
});
