import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../store/index.js';
import { sendGroupMessage, getSocket } from '../socket/client.js';

// Derive a deterministic color from an aegisId string
function colorFromId(id) {
  const palette = [
    '#5bf2b9', '#f2a65b', '#5b9ef2', '#f25b8a', '#d4f25b',
    '#c45bf2', '#5bf2e0', '#f2db5b', '#f25b5b', '#5bf289',
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function PollBubble({ text, msgId, t, mine }) {
  // Format: [poll:question:opt1|opt2|opt3]
  const inner = text.slice(6, -1); // strip [poll: and ]
  const colonIdx = inner.indexOf(':');
  const question = colonIdx !== -1 ? inner.slice(0, colonIdx) : inner;
  const optsPart = colonIdx !== -1 ? inner.slice(colonIdx + 1) : '';
  const options = optsPart ? optsPart.split('|') : [];

  const polls = useStore((s) => s.polls);
  const poll = polls[msgId] ?? { votes: {} };
  const totalVotes = Object.values(poll.votes).reduce((a, b) => a + b, 0);

  const identity = useStore((s) => s.identity);

  function handleVote(idx) {
    const socket = getSocket();
    if (!socket?.connected) return;
    const payload = JSON.stringify({ type: 'vote', messageId: msgId, optionIndex: idx });
    socket.emit('group:msg', { body: `[vote:${msgId}:${idx}]` });
    useStore.getState().receivePollVote(msgId, idx);
  }

  return (
    <div
      style={{
        background: mine ? t.accent : t.surface,
        border: mine ? 'none' : `1px solid ${t.border}`,
        borderRadius: t.radiusS,
        padding: '10px 14px',
        minWidth: 200,
        maxWidth: 280,
      }}
    >
      <div
        style={{
          fontFamily: t.fontMono,
          fontSize: 10,
          color: mine ? t.accentInk : t.accent,
          letterSpacing: '0.06em',
          marginBottom: 6,
        }}
      >
        ENCUESTA
      </div>
      <div
        style={{
          fontFamily: t.font,
          fontWeight: 600,
          fontSize: 14,
          color: mine ? t.accentInk : t.text,
          marginBottom: 10,
        }}
      >
        {question}
      </div>
      {options.map((opt, i) => {
        const votes = poll.votes[i] ?? 0;
        const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontFamily: t.font,
                fontSize: 12,
                color: mine ? t.accentInk : t.text,
                marginBottom: 3,
              }}
            >
              <span>{opt}</span>
              <span style={{ opacity: 0.7 }}>{pct}%</span>
            </div>
            <div
              style={{
                height: 4,
                background: mine ? 'rgba(0,0,0,0.15)' : t.surface2,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${pct}%`,
                  background: mine ? t.accentInk : t.accent,
                  borderRadius: 2,
                  transition: 'width 0.3s',
                }}
              />
            </div>
            <button
              onClick={() => handleVote(i)}
              style={{
                marginTop: 4,
                background: 'none',
                border: `1px solid ${mine ? t.accentInk : t.accent}`,
                borderRadius: t.radiusS,
                color: mine ? t.accentInk : t.accent,
                fontFamily: t.font,
                fontSize: 11,
                padding: '3px 10px',
                cursor: 'pointer',
              }}
            >
              Votar
            </button>
          </div>
        );
      })}
      <div
        style={{
          fontFamily: t.fontMono,
          fontSize: 9,
          color: mine ? t.accentInk : t.textMuted,
          opacity: 0.7,
          marginTop: 4,
        }}
      >
        {totalVotes} voto{totalVotes !== 1 ? 's' : ''}
      </div>
    </div>
  );
}

export default function GroupChat({ groupId, onBack, t }) {
  const [input, setInput] = useState('');
  const bottomRef = useRef(null);

  const identity = useStore((s) => s.identity);
  const groups = useStore((s) => s.groups);
  const groupMessages = useStore((s) => s.groupMessages[groupId] ?? []);
  const receiveGroupMessage = useStore((s) => s.receiveGroupMessage);

  const group = groups.find((g) => g.id === groupId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [groupMessages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || !identity || !group) return;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgId = crypto.randomUUID();

    const localMsg = {
      id: msgId,
      mine: true,
      senderId: identity.aegisId,
      senderName: identity.displayName ?? identity.aegisId,
      senderColor: colorFromId(identity.aegisId),
      text,
      time,
    };

    receiveGroupMessage(groupId, localMsg);
    setInput('');

    const plaintext = JSON.stringify({
      type: 'group_msg',
      groupId,
      groupName: group.name,
      members: group.members,
      senderId: identity.aegisId,
      senderName: identity.displayName ?? identity.aegisId,
      senderColor: colorFromId(identity.aegisId),
      body: text,
    });

    await sendGroupMessage({ identity, groupId, plaintext, store: { getState: useStore.getState } });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!group) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: t.bg,
        }}
      >
        <span style={{ fontFamily: t.font, fontSize: 14, color: t.textMuted }}>
          Grupo no encontrado
        </span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, minWidth: 0 }}>
      {/* Header */}
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
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: t.textMuted,
            fontFamily: t.font,
            fontSize: 13,
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ←
        </button>
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
            flexShrink: 0,
          }}
        >
          {group.name.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: t.font,
              fontWeight: 600,
              fontSize: 14,
              color: t.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {group.name}
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: '0.06em', marginTop: 1 }}>
            E2EE · GRUPO
          </div>
        </div>
        <div
          style={{
            background: t.accent + '22',
            border: `1px solid ${t.accent}44`,
            borderRadius: 99,
            padding: '2px 10px',
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.accent,
            flexShrink: 0,
          }}
        >
          {group.members?.length ?? 0} miembros
        </div>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {groupMessages.length === 0 && (
          <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted }}>
              Aún no hay mensajes en este grupo
            </span>
          </div>
        )}
        {groupMessages.map((msg) => {
          const isPoll = typeof msg.text === 'string' && msg.text.startsWith('[poll:');
          return (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: msg.mine ? 'flex-end' : 'flex-start',
              }}
            >
              {!msg.mine && (
                <div
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 10,
                    color: msg.senderColor ?? colorFromId(msg.senderId ?? ''),
                    marginBottom: 3,
                    marginLeft: 4,
                  }}
                >
                  {msg.senderName ?? msg.senderId}
                </div>
              )}
              {isPoll ? (
                <PollBubble text={msg.text} msgId={msg.id} t={t} mine={msg.mine} />
              ) : (
                <div
                  style={{
                    background: msg.mine ? t.accent : t.surface,
                    color: msg.mine ? t.accentInk : t.text,
                    borderRadius: t.radiusS,
                    padding: '8px 12px',
                    border: msg.mine ? 'none' : `1px solid ${t.border}`,
                    maxWidth: '65%',
                  }}
                >
                  <div style={{ fontFamily: t.font, fontSize: 14, lineHeight: 1.5 }}>{msg.text}</div>
                  <div
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 9,
                      opacity: 0.6,
                      marginTop: 4,
                      textAlign: 'right',
                    }}
                  >
                    {msg.time}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div
        style={{
          padding: '10px 14px',
          background: t.surface,
          borderTop: `1px solid ${t.border}`,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Mensaje al grupo…"
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
        <button
          onClick={handleSend}
          disabled={!input.trim()}
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
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke={input.trim() ? t.accentInk : t.textMuted}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
