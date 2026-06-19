import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useIdentity } from '../store/identity';
import { useMessages } from '../store/messages';
import { useConnection } from '../store/connection';
import { useTyping } from '../store/typing';
import { useContacts } from '../store/contacts';
import type { StoredMessage } from '../db/local';

// ---------------------------------------------------------------------------
// Local contact type (subset used in this screen)
// ---------------------------------------------------------------------------

interface StoredContact {
  aegisId: string;
  name: string;
  color?: string;
  avatarImage?: string | null;
  verified?: boolean;
  blocked?: boolean;
  status?: string;
  zeroTrust?: boolean;
  publicKeyB64: string;
  addedAt: number;
  mutedUntil?: number | null;
  muted?: boolean;
}

// ---------------------------------------------------------------------------

interface Props {
  contact: StoredContact;
  onBack: () => void;
  onContactDetail: () => void;
  onAttach: () => void;
  onEphemeral: () => void;
}

export function ChatScreen({ contact, onBack, onContactDetail, onAttach, onEphemeral }: Props) {
  const { t } = useTheme();
  const { identity } = useIdentity();
  const online = useConnection((s) => s.online);
  const isContactTyping = useTyping((s) => s.typing[contact.aegisId] ?? false);

  const byChat = useMessages((s) => s.byChat);
  const pinnedMsgMap = useMessages((s) => s.pinnedMsg);
  const loadChat = useMessages((s) => s.loadChat);
  const markRead = useMessages((s) => s.markRead);
  const toggleStar = useMessages((s) => s.toggleStar);
  const softDelete = useMessages((s) => s.softDelete);
  const togglePin = useMessages((s) => s.togglePin);
  const saveDraft = useMessages((s) => s.saveDraft);
  const append = useMessages((s) => s.append);
  const drafts = useMessages((s) => s.drafts);
  const pendingMediaUri = useMessages((s) => s.pendingMediaUri);
  const setPendingMedia = useMessages((s) => s.setPendingMedia);

  const list: StoredMessage[] = byChat[contact.aegisId] ?? [];
  const pinnedMsg = pinnedMsgMap[contact.aegisId] ?? null;

  const [draft, setDraft] = useState(drafts[contact.aegisId] ?? '');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const [actionsMsg, setActionsMsg] = useState<StoredMessage | null>(null);
  const [mismatchKey] = useState<string | null>(null);

  // Multi-file staging — each item keeps a preview URL (for UI) and the raw Blob
  // (for E2EE upload at send-time). previewUrlsRef mirrors the state so the
  // unmount cleanup closure always sees the current set of URLs to revoke.
  const [stagedItems, setStagedItems] = useState<{ previewUrl: string; blob: Blob; name: string; isImage: boolean }[]>([]);
  const stagedItemsRef = useRef<{ previewUrl: string }[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function addStagedItems(newItems: { previewUrl: string; blob: Blob; name: string; isImage: boolean }[]) {
    setStagedItems((prev) => {
      const next = [...prev, ...newItems];
      stagedItemsRef.current = next;
      return next;
    });
  }

  function removeStagedItem(index: number) {
    setStagedItems((prev) => {
      URL.revokeObjectURL(prev[index].previewUrl);
      const next = prev.filter((_, i) => i !== index);
      stagedItemsRef.current = next;
      return next;
    });
  }

  function clearStagedItems() {
    setStagedItems((prev) => {
      prev.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      stagedItemsRef.current = [];
      return [];
    });
  }

  // Revoke all preview object URLs on unmount
  useEffect(() => {
    return () => {
      stagedItemsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    };
  }, []);

  // Consume pendingMediaUri written by AttachSheet (EXIF-stripped canvas blob URL)
  useEffect(() => {
    if (!pendingMediaUri) return;
    const uri = pendingMediaUri;
    setPendingMedia(null);
    fetch(uri)
      .then((r) => r.blob())
      .then((blob) => {
        const previewUrl = URL.createObjectURL(blob);
        URL.revokeObjectURL(uri);
        addStagedItems([{ previewUrl, blob, name: 'photo.jpg', isImage: true }]);
      })
      .catch(() => URL.revokeObjectURL(uri));
  }, [pendingMediaUri]);

  useEffect(() => {
    void loadChat(contact.aegisId);
    void markRead(contact.aegisId);
  }, [contact.aegisId]);

  // Sync draft from store on contact change
  useEffect(() => {
    setDraft(drafts[contact.aegisId] ?? '');
  }, [contact.aegisId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [list.length]);

  const msgById = useMemo(
    () => Object.fromEntries(list.map((m) => [m.id, m])),
    [list],
  );

  function handleDraftChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setDraft(val);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      void saveDraft(contact.aegisId, val);
    }, 600);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  async function handleSend() {
    if (sending) return;
    const hasText = draft.trim().length > 0;
    const hasFiles = stagedItems.length > 0;
    if (!hasText && !hasFiles) return;
    if (!identity) return;
    setSending(true);
    setErrorMsg(null);

    const capturedDraft = draft.trim();
    const capturedItems = [...stagedItems];
    const capturedReplyTo = replyTo?.id ?? undefined;

    // Optimistic clear so UI feels fast
    setDraft('');
    void saveDraft(contact.aegisId, '');
    clearStagedItems();
    setReplyTo(null);

    try {
      const { decodeBase64 } = await import('tweetnacl-util');
      const { sendMessage } = await import('../socket/client');
      const base = {
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
      };

      if (capturedItems.length > 0) {
        const { encryptAndUploadMedia } = await import('../crypto/media');
        for (let i = 0; i < capturedItems.length; i++) {
          const item = capturedItems[i];
          const wireUri = await encryptAndUploadMedia(item.blob);
          const isLast = i === capturedItems.length - 1;
          // Attach caption to last attachment — mirrors mobile's send pattern
          const caption = isLast && capturedDraft ? capturedDraft : '';
          const plaintext = caption ? `[image:${wireUri}]${caption}` : `[image:${wireUri}]`;

          // Local append BEFORE sendMessage so the sender sees the rendered
          // image bubble (with caption) instead of the raw wire URI as text.
          // A fresh objectURL is created here because the staging previewUrl
          // was revoked by clearStagedItems() above.
          const localMediaUrl = URL.createObjectURL(item.blob);
          await append({
            id: crypto.randomUUID(),
            chatId: contact.aegisId,
            direction: 'out',
            body: caption,
            createdAt: Date.now(),
            type: 'image',
            mediaUri: localMediaUrl,
          });

          // skipLocalAppend so socket/client doesn't re-append with the raw
          // [image:blob:…]caption plaintext on top of our optimistic bubble.
          await sendMessage({
            ...base,
            plaintext,
            replyToId: i === 0 ? capturedReplyTo : undefined,
            skipLocalAppend: true,
          });
        }
      } else {
        await sendMessage({ ...base, plaintext: capturedDraft, replyToId: capturedReplyTo });
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const newItems = files.map((file) => ({
      previewUrl: URL.createObjectURL(file),
      blob: file as Blob,
      name: file.name,
      isImage: file.type.startsWith('image/'),
    }));
    addStagedItems(newItems);
    e.target.value = '';
  }

  async function handleCall(media: 'audio' | 'video') {
    const callStore = (await import('../store/call')).useCall.getState();
    callStore.startOutgoing(contact.aegisId, crypto.randomUUID(), media);
  }

  function handleReply(m: StoredMessage) {
    setReplyTo(m);
    setActionsMsg(null);
  }

  async function handleStar(m: StoredMessage) {
    await toggleStar(contact.aegisId, m.id);
    setActionsMsg(null);
  }

  async function handleDelete(m: StoredMessage) {
    await softDelete(contact.aegisId, m.id);
    setActionsMsg(null);
  }

  async function handleTogglePin(m: StoredMessage) {
    await togglePin(contact.aegisId, m.id);
    setActionsMsg(null);
  }

  function scrollToMessage(id: string) {
    const el = msgRefs.current[id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const isAegisId = /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      {/* Top bar */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10, gap: 6, borderBottom: `1px solid ${t.divider}`, flexShrink: 0 }}>
        <button onClick={onBack} aria-label="Back" style={iconBtn}>
          <I.ChevronL size={22} color={t.text} />
        </button>
        <button
          onClick={onContactDetail}
          aria-label={`View contact ${contact.name}`}
          style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
        >
          <Avatar t={t} name={contact.avatarImage ?? contact.name} color={contact.color ?? t.surface2} size={36} photoUri={contact.avatarImage ?? undefined} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontFamily: isAegisId ? t.fontMono : t.font, fontWeight: '600', fontSize: 15, color: t.text, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {contact.name}
            </span>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
              {isContactTyping ? (
                <span style={{ fontFamily: t.font, fontSize: 10, color: t.accent, fontStyle: 'italic' }}>typing…</span>
              ) : (
                <>
                  <I.Lock size={10} color={contact.verified ? t.accent : t.warn} />
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: contact.verified ? t.accent : t.warn, letterSpacing: 0.5 }}>
                    {contact.verified ? 'E2E Verified' : 'E2E Not Verified'}
                  </span>
                </>
              )}
            </div>
          </div>
        </button>
        <button onClick={() => void handleCall('audio')} aria-label="Audio call" style={iconBtn}>
          <I.Phone size={20} color={t.text} />
        </button>
        <button onClick={() => void handleCall('video')} aria-label="Video call" style={iconBtn}>
          <I.Video size={20} color={t.text} />
        </button>
      </div>

      {/* Offline banner */}
      {!online && (
        <div data-testid="offline-banner" style={{ padding: '8px 16px', backgroundColor: '#f59e0b', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ flex: 1, fontFamily: t.fontMono, fontSize: 11, color: '#000', fontWeight: '700', letterSpacing: 0.5 }}>
            OFFLINE — messages will queue
          </span>
        </div>
      )}

      {/* Key mismatch banner */}
      {mismatchKey && (
        <div style={{ margin: '10px 12px 4px', padding: 14, backgroundColor: t.dark ? 'rgba(255,107,107,0.12)' : 'rgba(184,68,42,0.08)', border: `1px solid ${t.danger}66`, borderRadius: t.radius, flexShrink: 0 }}>
          <span style={{ fontFamily: t.font, fontWeight: '700', fontSize: 13, color: t.danger, display: 'block', marginBottom: 4 }}>
            ⚠️ Key changed — possible MITM
          </span>
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block' }}>
            Verify identity out-of-band before continuing.
          </span>
          <button onClick={onContactDetail} style={{ marginTop: 8, backgroundColor: t.danger, border: 'none', borderRadius: t.radiusS, padding: '7px 14px', cursor: 'pointer' }}>
            <span style={{ color: '#fff', fontFamily: t.font, fontSize: 12, fontWeight: '600' }}>Re-verify</span>
          </button>
        </div>
      )}

      {/* E2E pill */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0', flexShrink: 0 }}>
        <div style={{ backgroundColor: t.surface2, paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, borderRadius: 99, display: 'flex', alignItems: 'center', gap: 6 }}>
          <I.Lock size={9} color={t.textDim} />
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>End-to-end encrypted</span>
        </div>
      </div>

      {/* Pinned message banner */}
      {pinnedMsg && !pinnedMsg.deleted && (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, backgroundColor: t.surface, borderBottom: `1px solid ${t.border}`, gap: 8, flexShrink: 0, cursor: 'pointer' }}
          onClick={() => scrollToMessage(pinnedMsg.id)}
        >
          <I.Pin size={13} color={t.accent} />
          <span style={{ flex: 1, fontFamily: t.font, fontSize: 12, color: t.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pinnedMsg.type === 'image' ? '📷 Image' : pinnedMsg.body}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); void handleTogglePin(pinnedMsg); }}
            aria-label="Unpin message"
            style={iconBtn}
          >
            <I.X size={14} color={t.textDim} />
          </button>
        </div>
      )}

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', paddingLeft: 14, paddingRight: 14, paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        {list.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No messages yet</span>
          </div>
        )}
        {list.map((m) => (
          <div
            key={m.id}
            ref={(el) => { msgRefs.current[m.id] = el; }}
          >
            <Bubble
              t={t}
              m={m}
              online={online}
              quotedMsg={m.replyToId ? msgById[m.replyToId] : undefined}
              onContextMenu={() => setActionsMsg(m)}
            />
          </div>
        ))}
      </div>

      {/* Reply banner */}
      {replyTo && (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8, backgroundColor: t.surface2, borderTop: `1px solid ${t.border}`, gap: 8, flexShrink: 0 }}>
          <I.Reply size={14} color={t.accent} />
          <span style={{ flex: 1, fontFamily: t.font, fontSize: 12, color: t.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {replyTo.deleted ? 'Deleted message' : replyTo.body || (replyTo.type === 'image' ? '📷 Image' : '…')}
          </span>
          <button onClick={() => setReplyTo(null)} aria-label="Cancel reply" style={iconBtn}>
            <I.X size={16} color={t.textDim} />
          </button>
        </div>
      )}

      {/* Staged media tray — scrollable horizontal strip of thumbnails */}
      {stagedItems.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8, backgroundColor: t.surface2, borderTop: `1px solid ${t.divider}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
            {stagedItems.map((item, i) => (
              <div
                key={i}
                style={{ position: 'relative', flexShrink: 0, width: 64, height: 64, borderRadius: t.radiusS, overflow: 'visible', backgroundColor: t.surface3 }}
              >
                {item.isImage ? (
                  <img
                    src={item.previewUrl}
                    alt={item.name}
                    style={{ width: 64, height: 64, borderRadius: t.radiusS, objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: 64, height: 64, borderRadius: t.radiusS, backgroundColor: t.surface3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 4, boxSizing: 'border-box' }}>
                    <I.Attach size={20} color={t.accent} />
                    <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, textAlign: 'center', overflow: 'hidden', width: '100%', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  </div>
                )}
                <button
                  onClick={() => removeStagedItem(i)}
                  aria-label={`Remove ${item.name}`}
                  style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, backgroundColor: t.danger, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, zIndex: 1 }}
                >
                  <I.X size={11} color="#fff" />
                </button>
              </div>
            ))}
            {/* Add more files button */}
            <label
              style={{ flexShrink: 0, width: 64, height: 64, borderRadius: t.radiusS, border: `1px dashed ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', backgroundColor: 'transparent' }}
              aria-label="Add more files"
            >
              <I.Plus size={22} color={t.textDim} />
              <input ref={fileInputRef} type="file" accept="image/*,application/pdf,text/plain,application/zip,application/octet-stream" multiple style={{ display: 'none' }} onChange={handleFileChange} />
            </label>
          </div>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>
            {stagedItems.length} {stagedItems.length === 1 ? 'FILE' : 'FILES'} — WILL ENCRYPT BEFORE SENDING
          </span>
        </div>
      )}

      {/* Error */}
      {errorMsg && (
        <div style={{ padding: '6px 14px', backgroundColor: `${t.danger}22`, flexShrink: 0 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger }}>{errorMsg}</span>
        </div>
      )}

      {/* Unverified contact banner */}
      {!contact.verified && (
        <div style={{ padding: '8px 16px', backgroundColor: '#1a1200', borderTop: `1px solid #ff9500`, color: '#ff9500', fontSize: 12, fontFamily: t.fontMono, flexShrink: 0 }}>
          Unverified contact. Sending is enabled — verify their identity for maximum security.
        </div>
      )}

      {/* Composer */}
      {contact.blocked ? (
        <div style={{ padding: '14px 12px', backgroundColor: t.surface, borderTop: `1px solid ${t.divider}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.danger, fontWeight: '500' }}>You have blocked this contact</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 14, borderTop: `1px solid ${t.divider}`, backgroundColor: t.surface, flexShrink: 0 }}>
          {/* Attach — opens file picker directly when no tray is visible;
              the staged tray has its own Add button once files are staged */}
          {stagedItems.length === 0 && (
            <label style={{ ...iconBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} aria-label="Attach file">
              <I.Attach size={22} color={t.textDim} />
              <input type="file" accept="image/*,application/pdf,text/plain,application/zip,application/octet-stream" multiple style={{ display: 'none' }} onChange={handleFileChange} />
            </label>
          )}
          {/* Draft input */}
          <input
            value={draft}
            onChange={handleDraftChange}
            onKeyDown={handleKeyDown}
            placeholder={online ? 'Message…' : 'Offline — message will queue'}
            style={{
              flex: 1,
              backgroundColor: t.surface2,
              color: t.text,
              fontFamily: t.font,
              fontSize: 15,
              border: 'none',
              borderRadius: 22,
              paddingLeft: 16,
              paddingRight: 16,
              paddingTop: 10,
              paddingBottom: 10,
              outline: 'none',
            }}
          />
          {/* Ephemeral timer */}
          <button onClick={onEphemeral} aria-label="Set ephemeral timer" style={iconBtn}>
            <I.Timer size={22} color={t.textDim} />
          </button>
          {/* Send */}
          <button
            onClick={() => void handleSend()}
            disabled={(!draft.trim() && stagedItems.length === 0) || sending}
            aria-label="Send message"
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: (draft.trim() || stagedItems.length > 0) && online ? t.accent : t.surface3,
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: (!draft.trim() && stagedItems.length === 0) || sending ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
          >
            <I.Send size={18} color={(draft.trim() || stagedItems.length > 0) && online ? t.accentInk : t.textFaint} />
          </button>
        </div>
      )}

      {/* Message actions overlay */}
      {actionsMsg && (
        <MessageActionsOverlay
          t={t}
          m={actionsMsg}
          myAegisId={identity?.aegisId}
          onReply={() => handleReply(actionsMsg)}
          onStar={() => void handleStar(actionsMsg)}
          onPin={() => void handleTogglePin(actionsMsg)}
          onDelete={() => void handleDelete(actionsMsg)}
          onClose={() => setActionsMsg(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message Actions Overlay
// ---------------------------------------------------------------------------

interface ActionsOverlayProps {
  t: Theme;
  m: StoredMessage;
  myAegisId?: string;
  onReply: () => void;
  onStar: () => void;
  onPin: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function MessageActionsOverlay({ t, m, myAegisId, onReply, onStar, onPin, onDelete, onClose }: ActionsOverlayProps) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 8, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 10, paddingRight: 4, paddingTop: 6, paddingBottom: 8, borderBottom: `1px solid ${t.divider}`, marginBottom: 4 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.8 }}>MESSAGE</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I.X size={16} color={t.textDim} />
          </button>
        </div>

        <ActionRow t={t} icon={<I.Reply size={16} color={t.text} />} label="Reply" onClick={onReply} />
        <ActionRow t={t} icon={<I.Star size={16} color={m.starred ? t.accent : t.text} />} label={m.starred ? 'Unstar' : 'Star'} onClick={onStar} />
        <ActionRow t={t} icon={<I.Pin size={16} color={m.pinned ? t.accent : t.text} />} label={m.pinned ? 'Unpin' : 'Pin'} onClick={onPin} />
        {m.direction === 'out' && (
          <ActionRow t={t} icon={<I.Trash size={16} color={t.danger} />} label="Delete" danger onClick={onDelete} />
        )}
      </div>
    </div>
  );
}

function ActionRow({ t, icon, label, danger, onClick }: { t: Theme; icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-label={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, background: hovered ? t.surface2 : 'none', border: 'none', cursor: 'pointer', borderRadius: t.radiusS, textAlign: 'left', width: '100%' }}
    >
      {icon}
      <span style={{ fontFamily: t.font, fontSize: 14, color: danger ? t.danger : t.text }}>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Bubble
// ---------------------------------------------------------------------------

interface BubbleProps {
  t: Theme;
  m: StoredMessage;
  online: boolean;
  quotedMsg?: StoredMessage;
  onContextMenu: () => void;
}

function Bubble({ t, m, online, quotedMsg, onContextMenu }: BubbleProps) {
  const me = m.direction === 'out';
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const queued = me && !online;
  const reactions = m.reactions ? Object.entries(m.reactions).filter(([, ids]) => ids.length > 0) : [];

  if (m.deleted) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <div style={{ backgroundColor: t.surface2, paddingLeft: 13, paddingRight: 13, paddingTop: 8, paddingBottom: 8, borderRadius: t.radius, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <I.Trash size={13} color={t.textFaint} />
          <span style={{ color: t.textFaint, fontFamily: t.font, fontSize: 13, fontStyle: 'italic' }}>Deleted message</span>
        </div>
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>{time}</span>
      </div>
    );
  }

  // View-once bubble
  if (m.body?.startsWith('[viewonce]')) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <div
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
          style={{ maxWidth: 220, backgroundColor: me ? t.bubbleOut : t.bubbleIn, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, padding: 12, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, opacity: queued ? 0.55 : 1, cursor: 'context-menu' }}
        >
          <I.Lock size={16} color={me ? t.bubbleOutText : t.bubbleInText} />
          <div>
            <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: me ? t.bubbleOutText : t.bubbleInText, display: 'block' }}>View Once</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? `${t.bubbleOutText}aa` : t.textDim }}>Opens once, then disappears</span>
          </div>
        </div>
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </div>
    );
  }

  // Call event bubble
  const callMatch = m.body?.match(/^\[call:(audio|video):(\w+)(?::(\d+))?\]$/);
  if (callMatch) {
    const callMedia = callMatch[1] as 'audio' | 'video';
    const callResult = callMatch[2]; // 'ended' | 'missed' | 'declined'
    const duration = callMatch[3] ? parseInt(callMatch[3], 10) : null;
    const mins = duration ? Math.floor(duration / 60) : 0;
    const secs = duration ? duration % 60 : 0;
    const isMissed = callResult === 'missed' || callResult === 'declined';
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4, marginBottom: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: 99, paddingLeft: 14, paddingRight: 14, paddingTop: 6, paddingBottom: 6 }}>
          {callMedia === 'video' ? <I.Video size={13} color={isMissed ? t.danger : t.textDim} /> : <I.Phone size={13} color={isMissed ? t.danger : t.textDim} />}
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: isMissed ? t.danger : t.textDim, letterSpacing: 0.5 }}>
            {isMissed ? 'MISSED CALL' : duration ? `${mins}:${String(secs).padStart(2, '0')}` : 'CALL ENDED'}
          </span>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</span>
        </div>
      </div>
    );
  }

  // Contact card bubble
  const contactMatch = m.body?.match(/^\[contact:(.+):([A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4})\]$/);
  if (contactMatch) {
    const cName = contactMatch[1];
    const cAegisId = contactMatch[2];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <div
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
          style={{ width: 220, backgroundColor: me ? t.bubbleOut : t.bubbleIn, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, padding: 12, opacity: queued ? 0.55 : 1, cursor: 'context-menu' }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: t.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 16, fontWeight: '700', color: '#000' }}>{cName.charAt(0).toUpperCase()}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: me ? t.bubbleOutText : t.text, display: 'block' }}>{cName}</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? `${t.bubbleOutText}aa` : t.textDim, display: 'block' }}>{cAegisId}</span>
            </div>
          </div>
        </div>
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </div>
    );
  }

  // Location bubble
  if (m.body?.startsWith('📍')) {
    const address = m.body.replace(/^📍\s*/, '');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <div
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
          style={{ width: 220, backgroundColor: me ? t.bubbleOut : t.bubbleIn, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, overflow: 'hidden', opacity: queued ? 0.55 : 1, cursor: 'context-menu' }}
        >
          {/* Minimal SVG map placeholder */}
          <svg viewBox="0 0 220 110" width={220} height={110} style={{ display: 'block', backgroundColor: t.surface3 }}>
            <rect width={220} height={110} fill={t.surface3} />
            {/* Grid lines */}
            {[22, 44, 66, 88, 110, 132, 154, 176, 198].map((x) => (
              <line key={`v${x}`} x1={x} y1={0} x2={x} y2={110} stroke={t.divider} strokeWidth={0.5} />
            ))}
            {[22, 44, 66, 88].map((y) => (
              <line key={`h${y}`} x1={0} y1={y} x2={220} y2={y} stroke={t.divider} strokeWidth={0.5} />
            ))}
            {/* Pin */}
            <circle cx={110} cy={52} r={8} fill={t.danger} />
            <circle cx={110} cy={52} r={4} fill="#fff" />
            <line x1={110} y1={60} x2={110} y2={72} stroke={t.danger} strokeWidth={2} />
          </svg>
          <div style={{ padding: '8px 12px' }}>
            <span style={{ fontFamily: t.font, fontSize: 12, color: me ? t.bubbleOutText : t.text, display: 'block' }}>{address}</span>
          </div>
        </div>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </div>
    );
  }

  // Image bubble
  if (m.type === 'image' && m.mediaUri) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <div
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
          style={{ borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, overflow: 'hidden', opacity: queued ? 0.55 : 1, cursor: 'context-menu' }}
        >
          <img src={m.mediaUri} alt="image message" style={{ width: 220, height: 180, objectFit: 'cover', display: 'block', backgroundColor: t.surface2 }} />
        </div>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </div>
    );
  }

  // Audio bubble with playback
  if (m.type === 'audio') {
    return <AudioBubble t={t} m={m} me={me} queued={queued} time={time} reactions={reactions} onContextMenu={onContextMenu} />;
  }

  // File bubble
  if (m.type === 'file') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <div
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
          style={{ maxWidth: '80%', backgroundColor: me ? t.bubbleOut : t.bubbleIn, paddingLeft: 13, paddingRight: 13, paddingTop: 10, paddingBottom: 10, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, opacity: queued ? 0.55 : 1, cursor: 'context-menu' }}
        >
          <I.Attach size={20} color={me ? t.bubbleOutText : t.bubbleInText} />
          <span style={{ color: me ? t.bubbleOutText : t.bubbleInText, fontFamily: t.font, fontSize: 14 }}>{m.body || 'file'}</span>
        </div>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </div>
    );
  }

  // Text bubble
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
      <div
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
        style={{ maxWidth: '80%', backgroundColor: me ? t.bubbleOut : t.bubbleIn, paddingLeft: 13, paddingRight: quotedMsg ? 13 : 13, paddingTop: quotedMsg ? 8 : 10, paddingBottom: 10, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, opacity: queued ? 0.55 : 1, cursor: 'context-menu' }}
      >
        {quotedMsg && (
          <div style={{ borderLeft: `3px solid ${t.accent}`, paddingLeft: 8, marginBottom: 8, opacity: 0.8 }}>
            <span style={{ fontFamily: t.font, fontSize: 12, color: me ? t.bubbleOutText : t.bubbleInText, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {quotedMsg.deleted ? 'Deleted message' : quotedMsg.type === 'image' ? '📷 Image' : quotedMsg.body}
            </span>
          </div>
        )}
        <span style={{ color: me ? t.bubbleOutText : t.bubbleInText, fontFamily: t.font, fontSize: 15, lineHeight: '20px' }}>
          {m.body}
        </span>
      </div>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audio Bubble with playback
// ---------------------------------------------------------------------------

interface AudioBubbleProps {
  t: Theme;
  m: StoredMessage;
  me: boolean;
  queued: boolean;
  time: string;
  reactions: [string, string[]][];
  onContextMenu: () => void;
}

function AudioBubble({ t, m, me, queued, time, reactions, onContextMenu }: AudioBubbleProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!m.mediaUri) return;
    const audio = new Audio(m.mediaUri);
    audioRef.current = audio;

    audio.addEventListener('loadedmetadata', () => setDuration(audio.duration));
    audio.addEventListener('timeupdate', () => {
      setCurrentTime(audio.currentTime);
      setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    });
    audio.addEventListener('ended', () => {
      setPlaying(false);
      setProgress(0);
      setCurrentTime(0);
    });

    return () => {
      audio.pause();
      audio.src = '';
    };
  }, [m.mediaUri]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play();
      setPlaying(true);
    }
  }

  function formatTime(secs: number) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
      <div
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
        style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, width: 240, backgroundColor: me ? t.bubbleOut : t.bubbleIn, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, opacity: queued ? 0.55 : 1, cursor: 'context-menu' }}
      >
        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause audio' : 'Play audio'}
          style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: me ? 'rgba(255,255,255,0.2)' : t.surface3, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer', flexShrink: 0 }}
        >
          {playing
            ? <I.Pause size={16} color={me ? t.bubbleOutText : t.bubbleInText} />
            : <I.Play size={16} color={me ? t.bubbleOutText : t.bubbleInText} />
          }
        </button>
        <div style={{ flex: 1 }}>
          {/* Progress bar */}
          <div style={{ height: 4, borderRadius: 2, backgroundColor: me ? 'rgba(255,255,255,0.2)' : t.surface3, position: 'relative', overflow: 'hidden', cursor: 'pointer' }}>
            <div style={{ height: '100%', width: `${progress * 100}%`, backgroundColor: me ? t.bubbleOutText : t.accent, borderRadius: 2 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.textDim }}>
              {formatTime(currentTime)}
            </span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? `${t.bubbleOutText}88` : t.textFaint }}>
              {formatTime(duration)}
            </span>
          </div>
        </div>
      </div>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <TimestampRow t={t} queued={queued} time={time} />
    </div>
  );
}

function ReactionPills({ t, reactions, me }: { t: Theme; reactions: [string, string[]][]; me: boolean }) {
  if (reactions.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: me ? 'flex-end' : 'flex-start' }}>
      {reactions.map(([emoji, ids]) => (
        <div key={emoji} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: t.surface2, borderRadius: 99, paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3, border: `1px solid ${t.border}` }}>
          <span style={{ fontSize: 13 }}>{emoji}</span>
          {ids.length > 1 && <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{ids.length}</span>}
        </div>
      ))}
    </div>
  );
}

function TimestampRow({ t, queued, time, starred, deliveryStatus }: { t: Theme; queued: boolean; time: string; starred?: boolean; deliveryStatus?: 'sent' | 'delivered' | 'read' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 4, paddingRight: 4, marginTop: 3 }}>
      {starred && <I.Star size={9} color={t.accent} />}
      {queued ? (
        <>
          <I.Timer size={10} color={t.warn} />
          <span style={{ fontFamily: t.fontMono, fontSize: 9.5, color: t.warn, letterSpacing: 0.4 }}>queued</span>
        </>
      ) : (
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</span>
      )}
      {!queued && deliveryStatus && (
        deliveryStatus === 'delivered' || deliveryStatus === 'read'
          ? <I.CheckCheck size={13} color={deliveryStatus === 'read' ? t.accent : t.textFaint} />
          : <I.Check size={13} color={t.textFaint} />
      )}
    </div>
  );
}

const iconBtn: CSSProperties = {
  padding: 6,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
