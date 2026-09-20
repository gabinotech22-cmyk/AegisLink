/**
 * "Your data" export (GDPR portability) — the payload builder.
 *
 * Byte-identical with desktop/src/renderer/utils/dataExport.ts.
 *
 * What never goes into the file: the text of a message deleted for everyone
 * (the sender withdrew it), and attachment wire tags — a media reference
 * carries the blob key/nonce/token, and an export is meant to be read, moved
 * and kept in the clear. Groups are conversations too.
 */

export interface ExportMessageLike {
  id: string;
  direction: 'in' | 'out';
  body: string;
  createdAt: number;
  type?: string | null;
  mediaUri?: string | null;
  deleted?: boolean;
  senderId?: string | null;
}

export interface ExportContactLike {
  aegisId: string;
  name: string;
  verified: boolean;
  color?: string;
}

export interface ExportGroupLike {
  id: string;
  name: string;
}

export interface ExportSettings {
  readReceipts: boolean;
  typingIndicator: boolean;
  blockScreenshots: boolean;
}

export interface ExportPick {
  messages: boolean;
  contacts: boolean;
  settings: boolean;
}

export interface ExportedMessage {
  id: string;
  direction: 'in' | 'out';
  body: string;
  createdAt: string;
  type: string;
  deleted: boolean;
  /** Group messages only: who sent it. */
  senderId?: string;
}

export interface ExportPayload {
  version: 2;
  exportedAt: string;
  aegisId: string | null;
  contacts: { name: string; aegisId: string; verified: boolean; color?: string }[];
  /** Keyed by chat: "<name> (<aegisId>)" for contacts, "group: <name> (<id>)" for groups. */
  conversations: Record<string, ExportedMessage[]>;
  totalMessages: number;
  settings: ExportSettings | null;
}

const WIRE_TAG = /^\[(image|video|audio|gif|sticker|viewonce|location|file|poll|call|join_request|multi)[:\]]/;

export const OMITTED_ATTACHMENT = '[attachment omitted]';

/** The body an export may contain for a message. */
export function exportBody(m: Pick<ExportMessageLike, 'body' | 'mediaUri' | 'deleted'>): string {
  if (m.deleted) return '';
  if (m.mediaUri || WIRE_TAG.test(m.body)) return OMITTED_ATTACHMENT;
  return m.body;
}

export function toExportedMessage(m: ExportMessageLike, isGroup: boolean): ExportedMessage {
  const out: ExportedMessage = {
    id: m.id,
    direction: m.direction,
    body: exportBody(m),
    createdAt: new Date(m.createdAt).toISOString(),
    type: m.type ?? 'text',
    deleted: m.deleted === true,
  };
  if (isGroup && m.senderId) out.senderId = m.senderId;
  return out;
}

export async function buildExportPayload(opts: {
  aegisId: string | null;
  contacts: ExportContactLike[];
  groups: ExportGroupLike[];
  pick: ExportPick;
  settings: ExportSettings;
  loadMessages: (chatId: string) => Promise<ExportMessageLike[]>;
  now?: Date;
}): Promise<ExportPayload> {
  const conversations: Record<string, ExportedMessage[]> = {};
  let totalMessages = 0;
  if (opts.pick.messages) {
    for (const c of opts.contacts) {
      let msgs: ExportMessageLike[] = [];
      try { msgs = await opts.loadMessages(c.aegisId); } catch { /* skip inaccessible chat */ }
      if (msgs.length === 0) continue;
      conversations[`${c.name} (${c.aegisId})`] = msgs.map((m) => toExportedMessage(m, false));
      totalMessages += msgs.length;
    }
    for (const g of opts.groups) {
      let msgs: ExportMessageLike[] = [];
      try { msgs = await opts.loadMessages(g.id); } catch { /* skip */ }
      if (msgs.length === 0) continue;
      conversations[`group: ${g.name} (${g.id})`] = msgs.map((m) => toExportedMessage(m, true));
      totalMessages += msgs.length;
    }
  }
  return {
    version: 2,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    aegisId: opts.aegisId,
    contacts: opts.pick.contacts
      ? opts.contacts.map((c) => ({ name: c.name, aegisId: c.aegisId, verified: c.verified, color: c.color }))
      : [],
    conversations,
    totalMessages,
    settings: opts.pick.settings ? opts.settings : null,
  };
}
