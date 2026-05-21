import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../store/index.js';
import { sendMessage, getSocket, emitTyping, sendReadReceipts, sendDeleteForEveryone } from '../socket/client.js';
import { saveMessage, loadMessages, updateMessageReactions, deleteMessage } from '../db/local.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// ─── Utility: file → base64 ───────────────────────────────────────────────────

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // data:mime;base64,...
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Relay URL helper ─────────────────────────────────────────────────────────

function getRelayUrl() {
  return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELAY_URL)
    ? import.meta.env.VITE_RELAY_URL
    : 'http://localhost:3001';
}

// ─── Main Chat component ──────────────────────────────────────────────────────

export default function Chat({ t }) {
  const [input, setInput] = useState('');
  const [ephemeralSeconds, setEphemeralSeconds] = useState(null);
  const [replyTo, setReplyTo] = useState(null); // { id, text, mine }
  const [toast, setToast] = useState(null); // string message
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);

  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlobUrl, setAudioBlobUrl] = useState(null);
  const [audioBase64, setAudioBase64] = useState(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  // Feature: typing indicator timer
  const typingTimerRef = useRef(null);

  // Feature: read receipts sent set
  const sentReceiptsRef = useRef(new Set());

  // Feature: context menu { visible, x, y, msg }
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, msg: null });

  // Feature: image modal
  const [imageModal, setImageModal] = useState(null); // src string or null

  // Feature: key mismatch banner
  const [keyMismatch, setKeyMismatch] = useState(false);
  const [keyTrusted, setKeyTrusted] = useState(false);

  // Feature: view-once seen set
  const [viewOnceSeen, setViewOnceSeen] = useState(new Set());

  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);
  const draftTimerRef = useRef(null);

  const identity = useStore((s) => s.identity);
  const activeChat = useStore((s) => s.activeChat);
  const contacts = useStore((s) => s.contacts);
  const messages = useStore((s) => s.messages[activeChat] ?? []);
  const appendMessage = useStore((s) => s.appendMessage);
  const setMessages = useStore((s) => s.setMessages);
  const updateConversation = useStore((s) => s.updateConversation);
  const updateMessage = useStore((s) => s.updateMessage);
  const removeMessage = useStore((s) => s.removeMessage);
  const connected = useStore((s) => s.connected);
  const typingMap = useStore((s) => s.typing);
  const pinnedMsg = useStore((s) => s.pinnedMsg);
  const setPinnedMsg = useStore((s) => s.setPinnedMsg);
  const saveDraft = useStore((s) => s.saveDraft);
  const drafts = useStore((s) => s.drafts);
  const settings = useStore((s) => s.settings);

  const contact = contacts.find((c) => c.aegisId === activeChat) ?? null;
  const isBlocked = contact?.blocked === true;
  const isTyping = activeChat ? !!typingMap[activeChat] : false;
  const pinnedMessage = activeChat ? pinnedMsg[activeChat] : null;

  // ─── Load messages ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!activeChat) return;

    // Reset key mismatch state when switching chats
    setKeyMismatch(false);
    setKeyTrusted(false);

    // Load draft for this chat
    const savedDraft = drafts[activeChat] ?? '';
    setInput(savedDraft);

    loadMessages(activeChat).then((rows) => {
      const mapped = rows.map((r) => ({
        id: r.id,
        mine: r.direction === 'out',
        text: r.body,
        time: new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: r.deliveryStatus,
        type: r.type ?? 'text',
        mediaUri: r.mediaUri ?? null,
        replyToId: r.replyToId ?? null,
        reactions: r.reactions ?? {},
        expiresAt: r.expiresAt ?? null,
      }));
      setMessages(activeChat, mapped);

      // Feature: read receipts — send for all incoming messages not yet receipted
      const socket = getSocket();
      if (socket?.connected) {
        const unsentIds = mapped
          .filter((m) => !m.mine && !sentReceiptsRef.current.has(m.id))
          .map((m) => m.id);
        if (unsentIds.length > 0) {
          sendReadReceipts(activeChat, unsentIds);
          unsentIds.forEach((id) => sentReceiptsRef.current.add(id));
        }
      }
    }).catch(() => {});

    updateConversation(activeChat, { unread: 0 });

    // Feature: key mismatch check — fetch identity from relay and compare
    if (contact?.publicKeyB64) {
      fetch(`${getRelayUrl()}/identity/${activeChat}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.publicKey && contact.publicKeyB64 && data.publicKey !== contact.publicKeyB64) {
            setKeyMismatch(true);
          }
        })
        .catch(() => { /* relay unreachable — silently ignore */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat]);

  // Feature: send read receipts when new messages arrive in the active chat
  useEffect(() => {
    if (!activeChat) return;
    const socket = getSocket();
    if (!socket?.connected) return;
    const unsentIds = messages
      .filter((m) => !m.mine && !sentReceiptsRef.current.has(m.id))
      .map((m) => m.id);
    if (unsentIds.length > 0) {
      sendReadReceipts(activeChat, unsentIds);
      unsentIds.forEach((id) => sentReceiptsRef.current.add(id));
    }
  }, [messages, activeChat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── Ephemeral countdown ────────────────────────────────────────────────────

  useEffect(() => {
    if (!messages.length) return;
    const ephemeralMsgs = messages.filter((m) => m.expiresAt && m.expiresAt > 0);
    if (!ephemeralMsgs.length) return;

    const interval = setInterval(() => {
      const now = Date.now();
      ephemeralMsgs.forEach((m) => {
        if (m.expiresAt <= now) {
          deleteMessage(m.id).catch(() => {});
          removeMessage(activeChat, m.id);
        } else {
          updateMessage(activeChat, m.id, { _tick: now });
        }
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [messages, activeChat, removeMessage, updateMessage]);

  // ─── Close context menu on outside click ────────────────────────────────────

  useEffect(() => {
    if (!contextMenu.visible) return;
    const handler = () => setContextMenu((c) => ({ ...c, visible: false }));
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu.visible]);

  // ─── Close image modal on Escape ────────────────────────────────────────────

  useEffect(() => {
    if (!imageModal) return;
    const handler = (e) => { if (e.key === 'Escape') setImageModal(null); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [imageModal]);

  // ─── Init ephemeral from settings ────────────────────────────────────────────

  useEffect(() => {
    if (settings?.ephemeral_default_seconds > 0) {
      setEphemeralSeconds(settings.ephemeral_default_seconds);
    }
  }, [activeChat]); // re-init when chat changes

  // ─── Toast helper ───────────────────────────────────────────────────────────

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  // ─── Draft persistence ───────────────────────────────────────────────────────

  function handleInputChange(e) {
    const val = e.target.value;
    setInput(val);

    // Feature: typing indicator
    if (activeChat && contact) {
      emitTyping(contact.aegisId, true);
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        emitTyping(contact.aegisId, false);
      }, 3000);
    }

    // Feature: draft persistence (debounced 800ms)
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (activeChat) saveDraft(activeChat, val);
    }, 800);
  }

  function handleInputBlur() {
    if (activeChat) {
      clearTimeout(draftTimerRef.current);
      saveDraft(activeChat, input);
    }
  }

  // ─── Handle send ────────────────────────────────────────────────────────────

  async function handleSend(overrideText, overrideType, overrideMediaUri) {
    const text = overrideText ?? input.trim();
    const type = overrideType ?? 'text';
    if (!text || !identity || !contact) return;

    if (isBlocked) {
      showToast('Contacto bloqueado');
      return;
    }

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7);

    const msg = {
      id: msgId,
      mine: true,
      text,
      time,
      status: 'sent',
      ephemeral: ephemeralSeconds,
      type,
      mediaUri: overrideMediaUri ?? null,
      replyToId: replyTo?.id ?? null,
      reactions: {},
      expiresAt: ephemeralSeconds ? Date.now() + ephemeralSeconds * 1000 : null,
    };

    appendMessage(activeChat, msg);
    updateConversation(activeChat, {
      lastMsg: type !== 'text' ? `[${type}]` : text,
      lastTime: time,
    });

    if (!overrideText) {
      setInput('');
      saveDraft(activeChat, '');
    }
    setReplyTo(null);

    // Stop typing indicator on send
    clearTimeout(typingTimerRef.current);
    emitTyping(contact.aegisId, false);

    await saveMessage({
      id: msgId,
      chatId: activeChat,
      direction: 'out',
      body: text,
      createdAt: Date.now(),
      deliveryStatus: 'sent',
      type,
      mediaUri: overrideMediaUri ?? null,
      replyToId: replyTo?.id ?? null,
      expiresAt: ephemeralSeconds ? Date.now() + ephemeralSeconds * 1000 : null,
    });

    await sendMessage(activeChat, text, identity, contact, msgId, {
      type,
      replyToId: replyTo?.id ?? null,
      mediaUri: overrideMediaUri ?? null,
    });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ─── Reactions ──────────────────────────────────────────────────────────────

  async function handleReaction(msgId, emoji) {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg) return;
    const reactions = { ...(msg.reactions ?? {}) };
    reactions[emoji] = (reactions[emoji] ?? 0) + 1;
    updateMessage(activeChat, msgId, { reactions });
    await updateMessageReactions(msgId, reactions);
    // Emit reaction event via socket
    const socket = getSocket();
    if (socket?.connected && contact) {
      socket.emit('reaction', { to: contact.aegisId, msgId, emoji });
    }
  }

  // ─── Context menu actions ────────────────────────────────────────────────────

  function handleContextMenu(e, msg) {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, msg });
  }

  function ctxReply() {
    if (!contextMenu.msg) return;
    setReplyTo(contextMenu.msg);
    setContextMenu((c) => ({ ...c, visible: false }));
  }

  function ctxStar() {
    if (!contextMenu.msg) return;
    const starred = !contextMenu.msg.starred;
    updateMessage(activeChat, contextMenu.msg.id, { starred });
    setContextMenu((c) => ({ ...c, visible: false }));
  }

  function ctxPin() {
    if (!contextMenu.msg) return;
    setPinnedMsg(activeChat, contextMenu.msg);
    setContextMenu((c) => ({ ...c, visible: false }));
  }

  function ctxDeleteForMe() {
    if (!contextMenu.msg) return;
    removeMessage(activeChat, contextMenu.msg.id);
    deleteMessage(contextMenu.msg.id).catch(() => {});
    setContextMenu((c) => ({ ...c, visible: false }));
  }

  function ctxDeleteForEveryone() {
    if (!contextMenu.msg || !contact) return;
    sendDeleteForEveryone(contact.aegisId, contextMenu.msg.id);
    removeMessage(activeChat, contextMenu.msg.id);
    deleteMessage(contextMenu.msg.id).catch(() => {});
    setContextMenu((c) => ({ ...c, visible: false }));
  }

  function ctxCopy() {
    if (!contextMenu.msg) return;
    const text = contextMenu.msg.text ?? '';
    navigator.clipboard.writeText(text).catch(() => {});
    setContextMenu((c) => ({ ...c, visible: false }));
    showToast('Copiado');
  }

  // ─── File attachment ─────────────────────────────────────────────────────────

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setAttachMenuOpen(false);

    if (file.size > MAX_FILE_BYTES) {
      showToast('Archivo demasiado grande (máx 5 MB)');
      return;
    }

    const b64DataUrl = await fileToBase64(file);
    const isImage = file.type.startsWith('image/');
    const isAudio = file.type.startsWith('audio/');

    let body;
    if (isImage) {
      body = `[image:${b64DataUrl}]`;
    } else if (isAudio) {
      body = `[audio:${b64DataUrl}:${Math.round(file.size / 1000)}kb:${file.name}]`;
    } else {
      body = `[file:${file.name}:${Math.round(file.size / 1000)}kb:${b64DataUrl}]`;
    }

    const type = isImage ? 'image' : isAudio ? 'audio' : 'file';
    await handleSend(body, type, b64DataUrl);
  }

  // ─── Location ────────────────────────────────────────────────────────────────

  function handleShareLocation() {
    setAttachMenuOpen(false);
    if (!navigator.geolocation) {
      showToast('Geolocalización no disponible');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const body = `[location:${lat},${lon}]`;
        await handleSend(body, 'location', null);
      },
      () => showToast('No se pudo obtener la ubicación'),
    );
  }

  // ─── Voice recording ─────────────────────────────────────────────────────────

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        setAudioBlobUrl(url);
        setAudioDuration(recordingSeconds);
        const reader = new FileReader();
        reader.onload = () => setAudioBase64(reader.result);
        reader.readAsDataURL(blob);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    } catch {
      showToast('No se pudo acceder al micrófono');
    }
  }

  function stopRecording() {
    clearInterval(recordingTimerRef.current);
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  function discardAudio() {
    if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
    setAudioBlobUrl(null);
    setAudioBase64(null);
    setAudioDuration(0);
  }

  async function sendAudio() {
    if (!audioBase64) return;
    const body = `[audio:${audioBase64}:${audioDuration}s]`;
    await handleSend(body, 'audio', audioBase64);
    discardAudio();
  }

  // ─── Ephemeral timer badge label ─────────────────────────────────────────────

  function fmtEphemeralBadge(secs) {
    if (!secs) return '';
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.round(secs / 60)}m`;
    return `${Math.round(secs / 3600)}h`;
  }

  // ─── Empty state ─────────────────────────────────────────────────────────────

  if (!activeChat || !contact) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: t.bg,
          gap: 12,
        }}
      >
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={t.border} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z" />
        </svg>
        <span style={{ fontFamily: t.font, fontSize: 14, color: t.textMuted }}>
          Selecciona una conversación
        </span>
      </div>
    );
  }

  const fmtRecording = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, '0')}`;
  const ephemeralBadge = fmtEphemeralBadge(ephemeralSeconds ?? settings?.ephemeral_default_seconds);

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, minWidth: 0, position: 'relative' }}
      onClick={() => contextMenu.visible && setContextMenu((c) => ({ ...c, visible: false }))}
    >

      {/* Image modal */}
      {imageModal && (
        <div
          onClick={() => setImageModal(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <button
            onClick={() => setImageModal(null)}
            style={{
              position: 'absolute',
              top: 20,
              right: 24,
              background: 'none',
              border: 'none',
              color: '#fff',
              fontSize: 28,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
          <img
            src={imageModal}
            alt="fullscreen"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, objectFit: 'contain' }}
          />
        </div>
      )}

      {/* Context menu */}
      {contextMenu.visible && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            zIndex: 500,
            minWidth: 180,
            overflow: 'hidden',
          }}
        >
          <CtxItem t={t} onClick={ctxReply}>↩ Responder</CtxItem>
          <CtxItem t={t} onClick={ctxStar}>
            {contextMenu.msg?.starred ? '⭐ Quitar estrella' : '⭐ Destacar'}
          </CtxItem>
          <CtxItem t={t} onClick={ctxPin}>📌 Fijar</CtxItem>
          <CtxItem t={t} onClick={ctxCopy}>📋 Copiar texto</CtxItem>
          <CtxItem t={t} onClick={ctxDeleteForMe}>🗑 Eliminar para mí</CtxItem>
          {contextMenu.msg?.mine && (
            <CtxItem t={t} onClick={ctxDeleteForEveryone} danger>
              🗑🌐 Eliminar para todos
            </CtxItem>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'absolute',
            bottom: 80,
            left: '50%',
            transform: 'translateX(-50%)',
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            padding: '8px 18px',
            fontFamily: t.font,
            fontSize: 13,
            color: t.text,
            zIndex: 200,
            pointerEvents: 'none',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          }}
        >
          {toast}
        </div>
      )}

      {/* Feature: Offline banner */}
      {!connected && (
        <div
          style={{
            background: '#92400e',
            padding: '7px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontFamily: t.font, fontSize: 12, color: '#fef3c7', flex: 1 }}>
            SIN CONEXIÓN — los mensajes se enviarán al reconectar
          </span>
          <button
            onClick={() => getSocket()?.connect()}
            style={{
              background: 'none',
              border: `1px solid #fef3c7`,
              borderRadius: t.radiusS,
              color: '#fef3c7',
              fontFamily: t.font,
              fontSize: 11,
              padding: '3px 10px',
              cursor: 'pointer',
            }}
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Chat header */}
      <div
        style={{
          padding: '12px 18px',
          background: t.surface,
          borderBottom: `1px solid ${t.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            background: t.accent + '22',
            border: `1px solid ${t.accent}44`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: t.fontMono,
            fontSize: 12,
            color: t.accent,
            fontWeight: 600,
          }}
        >
          {contact.name.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {contact.name}
            {isBlocked && <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.danger, marginLeft: 8 }}>BLOQUEADO</span>}
          </div>
          {/* Feature: typing indicator subtitle */}
          {isTyping ? (
            <div style={{ fontFamily: t.font, fontSize: 11, color: t.accent, marginTop: 1, fontStyle: 'italic' }}>
              escribiendo…
            </div>
          ) : (
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: '0.06em', marginTop: 1 }}>
              E2EE · DOUBLE RATCHET
            </div>
          )}
        </div>
        <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textMuted, letterSpacing: '0.06em', flexShrink: 0 }}>
          {contact.aegisId}
        </div>
      </div>

      {/* Feature: Key mismatch banner */}
      {keyMismatch && !keyTrusted && (
        <div
          style={{
            background: '#78350f',
            borderBottom: `1px solid #d97706`,
            padding: '8px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontFamily: t.font, fontSize: 12, color: '#fef3c7', flex: 1 }}>
            ⚠️ La clave de este contacto cambió. Verifica antes de continuar.
          </span>
          <button
            onClick={() => setKeyTrusted(true)}
            style={{
              background: 'none',
              border: `1px solid #fbbf24`,
              borderRadius: t.radiusS,
              color: '#fbbf24',
              fontFamily: t.font,
              fontSize: 11,
              padding: '3px 10px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Confiar de todas formas
          </button>
        </div>
      )}

      {/* Blocked banner */}
      {isBlocked && (
        <div
          style={{
            background: t.danger + '22',
            borderBottom: `1px solid ${t.danger}44`,
            padding: '8px 18px',
            fontFamily: t.font,
            fontSize: 13,
            color: t.danger,
            textAlign: 'center',
          }}
        >
          Contacto bloqueado. Los mensajes no se enviarán.
        </div>
      )}

      {/* Feature: Pinned message banner */}
      {pinnedMessage && (
        <div
          style={{
            background: t.surface2,
            borderBottom: `1px solid ${t.border}`,
            padding: '6px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14 }}>📌</span>
          <span
            style={{
              fontFamily: t.font,
              fontSize: 12,
              color: t.textMuted,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {pinnedMessage.text?.startsWith('[') ? '[adjunto]' : pinnedMessage.text}
          </span>
          <button
            onClick={() => setPinnedMsg(activeChat, null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, padding: 2, lineHeight: 1, fontSize: 14 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {messages.length === 0 && (
          <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted }}>
              Inicio de conversación cifrada E2EE.
            </span>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            t={t}
            allMessages={messages}
            onReply={(m) => setReplyTo(m)}
            onReaction={handleReaction}
            onContextMenu={handleContextMenu}
            onOpenImage={(src) => setImageModal(src)}
            viewOnceSeen={viewOnceSeen}
            onViewOnce={(id) => setViewOnceSeen((prev) => new Set([...prev, id]))}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Ephemeral indicator */}
      {ephemeralSeconds && (
        <div
          style={{
            padding: '4px 18px',
            background: t.surface,
            borderTop: `1px solid ${t.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={t.warn} strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" />
          </svg>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.warn, letterSpacing: '0.06em' }}>
            EFÍMERO · {ephemeralSeconds}s
          </span>
          <button
            onClick={() => setEphemeralSeconds(null)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: t.textMuted, cursor: 'pointer', fontFamily: t.font, fontSize: 11 }}
          >
            Desactivar
          </button>
        </div>
      )}

      {/* Reply banner */}
      {replyTo && (
        <div
          style={{
            padding: '6px 14px',
            background: t.surface2,
            borderTop: `1px solid ${t.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div
            style={{
              width: 3,
              alignSelf: 'stretch',
              background: t.accent,
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, marginBottom: 2 }}>
              {replyTo.mine ? 'Tú' : contact.name}
            </div>
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {replyTo.text?.startsWith('[') ? '[adjunto]' : replyTo.text}
            </div>
          </div>
          <button
            onClick={() => setReplyTo(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, padding: 4 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Audio preview (after recording) */}
      {audioBlobUrl && (
        <div
          style={{
            padding: '10px 14px',
            background: t.surface,
            borderTop: `1px solid ${t.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <audio src={audioBlobUrl} controls style={{ flex: 1, height: 32 }} />
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted }}>
            {fmtDuration(audioDuration)}
          </span>
          <button
            onClick={discardAudio}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.danger, padding: 4 }}
            title="Descartar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <button
            onClick={sendAudio}
            style={{
              background: t.accent,
              border: 'none',
              borderRadius: t.radiusS,
              color: t.accentInk,
              fontFamily: t.font,
              fontWeight: 600,
              fontSize: 12,
              padding: '6px 14px',
              cursor: 'pointer',
            }}
          >
            Enviar
          </button>
        </div>
      )}

      {/* Input area */}
      <div
        style={{
          padding: '10px 14px',
          background: t.surface,
          borderTop: `1px solid ${t.border}`,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {/* Attach menu popup */}
        {attachMenuOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: 54,
              left: 14,
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: t.radiusS,
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              zIndex: 50,
              minWidth: 160,
            }}
          >
            <AttachMenuItem
              t={t}
              label="Imagen / Archivo"
              icon="📎"
              onClick={() => { fileInputRef.current?.click(); }}
            />
            <AttachMenuItem
              t={t}
              label="Ubicación"
              icon="📍"
              onClick={handleShareLocation}
            />
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,.pdf,.zip,.doc,.docx"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {/* Ephemeral timer */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <InputIconButton
            t={t}
            title="Mensaje efímero"
            active={!!ephemeralSeconds}
            onClick={() => {
              const options = [null, 10, 30, 60, 300];
              const idx = options.indexOf(ephemeralSeconds);
              setEphemeralSeconds(options[(idx + 1) % options.length]);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" />
            </svg>
          </InputIconButton>
          {/* Feature: ephemeral timer badge */}
          {ephemeralBadge && (
            <span
              style={{
                position: 'absolute',
                bottom: 0,
                right: 0,
                background: t.warn,
                color: '#000',
                fontSize: 8,
                fontFamily: t.fontMono,
                borderRadius: 99,
                padding: '1px 3px',
                lineHeight: 1.2,
                pointerEvents: 'none',
              }}
            >
              {ephemeralBadge}
            </span>
          )}
        </div>

        {/* Attach button */}
        <InputIconButton
          t={t}
          title="Adjuntar"
          active={attachMenuOpen}
          onClick={() => setAttachMenuOpen((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </InputIconButton>

        {/* Voice record button */}
        <InputIconButton
          t={t}
          title={recording ? 'Detener grabación' : 'Grabar audio'}
          active={recording}
          onClick={recording ? stopRecording : startRecording}
        >
          {recording ? (
            <VoiceWaveform t={t} />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
            </svg>
          )}
        </InputIconButton>

        {/* Recording timer */}
        {recording && (
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger, letterSpacing: '0.06em', flexShrink: 0 }}>
            {fmtRecording}
          </span>
        )}

        {/* Text input */}
        <textarea
          value={input}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          placeholder="Mensaje…"
          rows={1}
          style={{
            flex: 1,
            background: t.surface2,
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            color: t.text,
            fontFamily: t.font,
            fontSize: 14,
            padding: '8px 12px',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.5,
            maxHeight: 120,
            overflowY: 'auto',
          }}
        />

        {/* Send */}
        <button
          onClick={() => handleSend()}
          disabled={!input.trim() && !audioBlobUrl}
          style={{
            width: 36,
            height: 36,
            borderRadius: t.radiusS,
            background: input.trim() ? t.accent : t.surface2,
            border: 'none',
            cursor: input.trim() ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'background 0.14s',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={input.trim() ? t.accentInk : t.textMuted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, t, allMessages, onReply, onReaction, onContextMenu, onOpenImage, viewOnceSeen, onViewOnce }) {
  const [hovered, setHovered] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);

  const replyMsg = msg.replyToId ? allMessages.find((m) => m.id === msg.replyToId) : null;

  const now = Date.now();
  const countdown = msg.expiresAt && msg.expiresAt > now ? Math.ceil((msg.expiresAt - now) / 1000) : null;

  // Feature: call event bubble
  if (msg.text?.startsWith('[call:')) {
    return <CallEventBubble msg={msg} t={t} />;
  }

  // Feature: contact card bubble
  const contactMatch = msg.text?.match(/^\[contact:([^:]+):([^\]]+)\]$/);
  if (contactMatch) {
    return <ContactCardBubble name={contactMatch[1]} aegisId={contactMatch[2]} t={t} />;
  }

  return (
    <div
      style={{ display: 'flex', justifyContent: msg.mine ? 'flex-end' : 'flex-start', position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setEmojiPickerOpen(false); }}
      onContextMenu={(e) => onContextMenu(e, msg)}
    >
      {/* Hover actions */}
      {hovered && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            [msg.mine ? 'left' : 'right']: 0,
            display: 'flex',
            gap: 4,
            zIndex: 10,
          }}
        >
          <HoverActionBtn t={t} title="Responder" onClick={() => onReply(msg)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 00-4-4H4" />
            </svg>
          </HoverActionBtn>
          <HoverActionBtn t={t} title="Reaccionar" onClick={() => setEmojiPickerOpen((v) => !v)}>
            <span style={{ fontSize: 11 }}>😀</span>
          </HoverActionBtn>
          {emojiPickerOpen && (
            <div
              style={{
                position: 'absolute',
                top: 28,
                [msg.mine ? 'left' : 'right']: 0,
                background: t.surface,
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusS,
                display: 'flex',
                gap: 4,
                padding: '6px 8px',
                zIndex: 20,
                boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              }}
            >
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => { onReaction(msg.id, emoji); setEmojiPickerOpen(false); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 18,
                    lineHeight: 1,
                    padding: '2px 4px',
                    borderRadius: 4,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = t.surface2; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ maxWidth: '65%' }}>
        {/* Quoted reply */}
        {replyMsg && (
          <div
            style={{
              background: msg.mine ? 'rgba(0,0,0,0.15)' : t.surface2,
              borderLeft: `3px solid ${t.accent}`,
              borderRadius: `${t.radiusS}px ${t.radiusS}px 0 0`,
              padding: '5px 10px',
              marginBottom: 2,
            }}
          >
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, marginBottom: 2 }}>
              {replyMsg.mine ? 'Tú' : '…'}
            </div>
            <div style={{ fontFamily: t.font, fontSize: 12, color: msg.mine ? t.accentInk : t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {replyMsg.text?.startsWith('[') ? '[adjunto]' : replyMsg.text}
            </div>
          </div>
        )}

        {/* Bubble */}
        <div
          style={{
            background: msg.mine ? t.accent : t.surface,
            color: msg.mine ? t.accentInk : t.text,
            borderRadius: t.radiusS,
            padding: '8px 12px',
            border: msg.mine ? 'none' : `1px solid ${t.border}`,
          }}
        >
          <MessageContent
            msg={msg}
            t={t}
            onOpenImage={onOpenImage}
            viewOnceSeen={viewOnceSeen}
            onViewOnce={onViewOnce}
          />

          {/* Countdown */}
          {countdown !== null && (
            <div style={{ fontFamily: t.fontMono, fontSize: 9, color: msg.mine ? t.accentInk : t.warn, opacity: 0.8, marginTop: 3 }}>
              ⏱ {countdown}s
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 4 }}>
            {msg.starred && <span style={{ fontSize: 10 }}>⭐</span>}
            <span style={{ fontFamily: t.fontMono, fontSize: 9, opacity: 0.6 }}>{msg.time}</span>
            {msg.mine && <DeliveryTick status={msg.status} t={t} />}
          </div>
        </div>

        {/* Reactions */}
        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {Object.entries(msg.reactions).map(([emoji, count]) => (
              <span
                key={emoji}
                style={{
                  background: t.surface2,
                  border: `1px solid ${t.border}`,
                  borderRadius: 99,
                  padding: '2px 7px',
                  fontSize: 12,
                  fontFamily: t.font,
                  color: t.text,
                  cursor: 'default',
                }}
              >
                {emoji}{count > 1 ? ` ${count}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Call event bubble ────────────────────────────────────────────────────────

function CallEventBubble({ msg, t }) {
  // Format: [call:status:media:duration]
  const inner = msg.text.slice(6, -1); // strip [call: and ]
  const parts = inner.split(':');
  const status = parts[0] ?? 'missed';    // missed | ended
  const media = parts[1] ?? 'voice';      // voice | video
  const duration = parts[2] ?? '';

  const isVideo = media === 'video';
  const isMissed = status === 'missed';

  let label;
  if (isMissed) {
    label = isVideo ? 'Videollamada perdida' : 'Llamada perdida';
  } else {
    label = isVideo ? `Videollamada · ${duration}` : `Llamada de voz · ${duration}`;
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: t.surface2,
          border: `1px solid ${t.border}`,
          borderRadius: 99,
          padding: '5px 14px',
          fontFamily: t.font,
          fontSize: 12,
          color: isMissed ? (t.danger ?? '#f87171') : t.textMuted,
        }}
      >
        {isVideo ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 11a19.79 19.79 0 01-3.07-8.67A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 7.91a16 16 0 006.16 6.16l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
          </svg>
        )}
        {label}
        <span style={{ fontFamily: t.fontMono, fontSize: 9, opacity: 0.5 }}>{msg.time}</span>
      </div>
    </div>
  );
}

// ─── Contact card bubble ──────────────────────────────────────────────────────

function ContactCardBubble({ name, aegisId, t }) {
  function copyId() {
    navigator.clipboard.writeText(aegisId).catch(() => {});
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
      <div
        style={{
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusS,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minWidth: 220,
          maxWidth: 280,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            background: t.accent + '22',
            border: `1px solid ${t.accent}44`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 13, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
            {aegisId.slice(0, 20)}…
          </div>
        </div>
        <button
          onClick={copyId}
          style={{
            background: 'none',
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusS,
            color: t.accent,
            fontFamily: t.font,
            fontSize: 11,
            padding: '4px 8px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          Agregar
        </button>
      </div>
    </div>
  );
}

// ─── Message content renderer ────────────────────────────────────────────────

function MessageContent({ msg, t, onOpenImage, viewOnceSeen, onViewOnce }) {
  const text = msg.text ?? '';

  // Feature: view-once image
  if (text === '[viewonce]' || text.startsWith('[viewonce:image:')) {
    const seen = viewOnceSeen?.has(msg.id);
    if (seen) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.5 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
          <span style={{ fontFamily: t.font, fontSize: 13 }}>Ver una vez · Ya visto</span>
        </div>
      );
    }
    const src = text.startsWith('[viewonce:image:') ? text.slice(16, -1) : null;
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => {
          if (src && onOpenImage) onOpenImage(src);
          if (onViewOnce) onViewOnce(msg.id);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
        </svg>
        <span style={{ fontFamily: t.font, fontSize: 13 }}>Ver una vez · Toca para abrir</span>
      </div>
    );
  }

  // Feature: view-once audio
  if (text.startsWith('[viewonce:audio:')) {
    const seen = viewOnceSeen?.has(msg.id);
    const inner = text.slice(16, -1);
    const colonIdx = inner.lastIndexOf(':');
    const duration = colonIdx !== -1 ? inner.slice(colonIdx + 1) : '';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: seen ? 0.5 : 1 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
          <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
        </svg>
        {duration && <span style={{ fontFamily: t.fontMono, fontSize: 10, opacity: 0.7 }}>{duration}</span>}
        <span style={{ fontFamily: t.font, fontSize: 13 }}>
          {seen ? 'Ya escuchado' : 'Escuchar una vez'}
        </span>
        {!seen && (
          <button
            onClick={() => onViewOnce && onViewOnce(msg.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 12, fontFamily: t.font, textDecoration: 'underline' }}
          >
            ▶
          </button>
        )}
      </div>
    );
  }

  if (msg.type === 'image' || text.startsWith('[image:')) {
    const src = text.startsWith('[image:') ? text.slice(7, -1) : text;
    return (
      <img
        src={src}
        alt="adjunto"
        style={{ maxWidth: 280, maxHeight: 200, borderRadius: 6, display: 'block', cursor: 'pointer' }}
        onClick={() => onOpenImage && onOpenImage(src)}
        onError={(e) => { e.target.style.display = 'none'; }}
      />
    );
  }

  if (msg.type === 'location' || text.startsWith('[location:')) {
    const coords = text.startsWith('[location:') ? text.slice(10, -1) : text;
    const [lat, lon] = coords.split(',');
    const mapUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=14&size=240x140&markers=${lat},${lon}`;
    const mapsUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=14`;
    return (
      <div>
        <img
          src={mapUrl}
          alt="mapa"
          style={{ maxWidth: 240, height: 140, borderRadius: 6, display: 'block', marginBottom: 6 }}
          onError={(e) => { e.target.style.display = 'none'; }}
        />
        <div style={{ fontFamily: t.fontMono, fontSize: 10, opacity: 0.7, marginBottom: 4 }}>
          {parseFloat(lat).toFixed(5)}, {parseFloat(lon).toFixed(5)}
        </div>
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontFamily: t.font, fontSize: 12, color: msg.mine ? t.accentInk : t.accent, textDecoration: 'underline' }}
        >
          Abrir en mapas
        </a>
      </div>
    );
  }

  if (msg.type === 'audio' || text.startsWith('[audio:')) {
    let src = text;
    let durationLabel = '';
    if (text.startsWith('[audio:')) {
      const inner = text.slice(7, -1);
      const colonIdx = inner.lastIndexOf(':');
      const meta = inner.slice(colonIdx + 1);
      src = inner.slice(0, colonIdx);
      durationLabel = meta;
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <audio src={src} controls style={{ height: 28, flex: 1 }} />
        {durationLabel && (
          <span style={{ fontFamily: t.fontMono, fontSize: 10, opacity: 0.7 }}>{durationLabel}</span>
        )}
      </div>
    );
  }

  if (msg.type === 'file' || text.startsWith('[file:')) {
    let name = 'archivo';
    let size = '';
    let src = '';
    if (text.startsWith('[file:')) {
      const inner = text.slice(6, -1);
      const parts = inner.split(':');
      name = parts[0] ?? 'archivo';
      size = parts[1] ?? '';
      src = parts.slice(2).join(':');
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" /><polyline points="13 2 13 9 20 9" />
        </svg>
        <div>
          <div style={{ fontFamily: t.font, fontSize: 13 }}>{name}</div>
          {size && <div style={{ fontFamily: t.fontMono, fontSize: 10, opacity: 0.6 }}>{size}</div>}
        </div>
        {src && (
          <a
            href={src}
            download={name}
            style={{ fontFamily: t.font, fontSize: 12, color: msg.mine ? t.accentInk : t.accent, textDecoration: 'underline', marginLeft: 'auto' }}
          >
            Descargar
          </a>
        )}
      </div>
    );
  }

  return <div style={{ fontFamily: t.font, fontSize: 14, lineHeight: 1.5 }}>{text}</div>;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DeliveryTick({ status, t }) {
  // ✓ sent, ✓✓ grey = delivered, ✓✓ accent = read
  if (status === 'sent') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" title="Enviado">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  const color = status === 'read' ? (t.accentInk ?? '#fff') : 'rgba(255,255,255,0.45)';
  return (
    <svg width="18" height="12" viewBox="0 0 30 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" title={status === 'read' ? 'Leído' : 'Entregado'}>
      <path d="M20 6L9 17l-5-5" />
      <path d="M27 6L16 17" />
    </svg>
  );
}

function InputIconButton({ t, title, onClick, active, children }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 34,
        height: 34,
        borderRadius: t.radiusS,
        background: hovered || active ? t.surface2 : 'transparent',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: active ? t.accent : t.textMuted,
        flexShrink: 0,
        transition: 'background 0.12s, color 0.12s',
      }}
    >
      {children}
    </button>
  );
}

function HoverActionBtn({ t, title, onClick, children }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        background: t.surface,
        border: `1px solid ${t.border}`,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: t.textMuted,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function AttachMenuItem({ t, label, icon, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? t.surface2 : 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '9px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: t.font,
        fontSize: 13,
        color: t.text,
        textAlign: 'left',
      }}
    >
      <span style={{ fontSize: 16 }}>{icon}</span>
      {label}
    </button>
  );
}

function CtxItem({ t, onClick, children, danger }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: '100%',
        background: hovered ? t.surface2 : 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '8px 14px',
        fontFamily: t.font,
        fontSize: 13,
        color: danger ? (t.danger ?? '#f87171') : t.text,
        textAlign: 'left',
      }}
    >
      {children}
    </button>
  );
}

function VoiceWaveform({ t }) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', height: 16 }}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            width: 3,
            borderRadius: 2,
            background: t.danger,
            animation: `wave${i} 0.8s ease-in-out infinite alternate`,
            height: i === 2 ? 14 : 8,
          }}
        />
      ))}
      <style>{`
        @keyframes wave1 { from { height: 4px; } to { height: 12px; } }
        @keyframes wave2 { from { height: 8px; } to { height: 16px; } }
        @keyframes wave3 { from { height: 4px; } to { height: 10px; } }
      `}</style>
    </div>
  );
}

function fmtDuration(secs) {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
