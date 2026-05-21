import React, { useState } from 'react';
import { useStore } from '../store/index.js';
import { sendGroupMessage } from '../socket/client.js';

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

export default function Polls({ groupId, onBack, t }) {
  const [showForm, setShowForm] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [sending, setSending] = useState(false);

  const identity = useStore((s) => s.identity);
  const groups = useStore((s) => s.groups);
  const groupMessages = useStore((s) => s.groupMessages[groupId] ?? []);
  const polls = useStore((s) => s.polls);
  const receivePollVote = useStore((s) => s.receivePollVote);
  const receiveGroupMessage = useStore((s) => s.receiveGroupMessage);

  const group = groups.find((g) => g.id === groupId);

  // Collect all poll messages in this group
  const pollMessages = groupMessages.filter(
    (m) => typeof m.text === 'string' && m.text.startsWith('[poll:'),
  );

  function setOption(idx, val) {
    setOptions((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  }

  function addOption() {
    if (options.length < 4) setOptions((prev) => [...prev, '']);
  }

  function removeOption(idx) {
    if (options.length <= 2) return;
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleCreatePoll() {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q || opts.length < 2 || !identity || !group) return;
    setSending(true);
    try {
      const msgId = crypto.randomUUID();
      const pollBody = `[poll:${q}:${opts.join('|')}]`;
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const localMsg = {
        id: msgId,
        mine: true,
        senderId: identity.aegisId,
        senderName: identity.displayName ?? identity.aegisId,
        senderColor: colorFromId(identity.aegisId),
        text: pollBody,
        time,
      };

      receiveGroupMessage(groupId, localMsg);

      // Register poll in store
      useStore.setState((s) => ({
        polls: { ...s.polls, [msgId]: { votes: {}, options: opts } },
      }));

      const plaintext = JSON.stringify({
        type: 'group_msg',
        groupId,
        groupName: group.name,
        members: group.members,
        senderId: identity.aegisId,
        senderName: identity.displayName ?? identity.aegisId,
        senderColor: colorFromId(identity.aegisId),
        body: pollBody,
        msgId,
      });

      await sendGroupMessage({ identity, groupId, plaintext, store: { getState: useStore.getState } });

      setQuestion('');
      setOptions(['', '']);
      setShowForm(false);
    } finally {
      setSending(false);
    }
  }

  function handleVote(msgId, optionIndex) {
    const socket_module_vote_body = `[vote:${msgId}:${optionIndex}]`;
    receivePollVote(msgId, optionIndex);
    if (identity && group) {
      const plaintext = JSON.stringify({
        type: 'group_msg',
        groupId,
        groupName: group.name,
        members: group.members,
        senderId: identity.aegisId,
        senderName: identity.displayName ?? identity.aegisId,
        senderColor: colorFromId(identity.aegisId),
        body: socket_module_vote_body,
      });
      sendGroupMessage({ identity, groupId, plaintext, store: { getState: useStore.getState } });
    }
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
          }}
        >
          ←
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14, color: t.text }}>
            Encuestas
            {group && (
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textMuted, marginLeft: 8 }}>
                · {group.name}
              </span>
            )}
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: '0.06em', marginTop: 1 }}>
            ANÓNIMAS · CIFRADAS
          </div>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          style={{
            background: showForm ? t.accent : t.surface2,
            border: `1px solid ${showForm ? t.accent : t.border}`,
            borderRadius: t.radiusS,
            color: showForm ? t.accentInk : t.text,
            fontFamily: t.font,
            fontSize: 12,
            fontWeight: 600,
            padding: '6px 14px',
            cursor: 'pointer',
          }}
        >
          {showForm ? 'Cancelar' : '+ Crear encuesta'}
        </button>
      </div>

      {/* Create poll form */}
      {showForm && (
        <div
          style={{
            padding: '16px 18px',
            background: t.surface2,
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          <div
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.accent,
              letterSpacing: '0.06em',
              marginBottom: 12,
            }}
          >
            NUEVA ENCUESTA
          </div>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Pregunta de la encuesta"
            style={{
              width: '100%',
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: t.radiusS,
              color: t.text,
              fontFamily: t.font,
              fontSize: 14,
              padding: '8px 12px',
              outline: 'none',
              boxSizing: 'border-box',
              marginBottom: 12,
            }}
          />

          <div
            style={{
              fontFamily: t.font,
              fontSize: 12,
              color: t.textMuted,
              marginBottom: 8,
            }}
          >
            Opciones:
          </div>

          {options.map((opt, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                value={opt}
                onChange={(e) => setOption(i, e.target.value)}
                placeholder={`Opción ${i + 1}`}
                style={{
                  flex: 1,
                  background: t.surface,
                  border: `1px solid ${t.border}`,
                  borderRadius: t.radiusS,
                  color: t.text,
                  fontFamily: t.font,
                  fontSize: 13,
                  padding: '7px 10px',
                  outline: 'none',
                }}
              />
              {options.length > 2 && (
                <button
                  onClick={() => removeOption(i)}
                  style={{
                    background: 'none',
                    border: `1px solid ${t.border}`,
                    borderRadius: t.radiusS,
                    color: t.danger,
                    cursor: 'pointer',
                    padding: '0 10px',
                    fontFamily: t.font,
                    fontSize: 13,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {options.length < 4 && (
            <button
              onClick={addOption}
              style={{
                background: 'none',
                border: `1px dashed ${t.border}`,
                borderRadius: t.radiusS,
                color: t.textMuted,
                fontFamily: t.font,
                fontSize: 12,
                padding: '6px 14px',
                cursor: 'pointer',
                width: '100%',
                marginBottom: 12,
              }}
            >
              + Añadir opción
            </button>
          )}

          <button
            onClick={handleCreatePoll}
            disabled={
              !question.trim() ||
              options.filter((o) => o.trim()).length < 2 ||
              sending
            }
            style={{
              background:
                !question.trim() || options.filter((o) => o.trim()).length < 2 || sending
                  ? t.surface
                  : t.accent,
              border: 'none',
              borderRadius: t.radiusS,
              color:
                !question.trim() || options.filter((o) => o.trim()).length < 2 || sending
                  ? t.textMuted
                  : t.accentInk,
              fontFamily: t.font,
              fontWeight: 600,
              fontSize: 13,
              padding: '8px 20px',
              cursor:
                !question.trim() || options.filter((o) => o.trim()).length < 2 || sending
                  ? 'default'
                  : 'pointer',
              width: '100%',
              marginTop: options.length < 4 ? 0 : 12,
            }}
          >
            {sending ? 'Enviando…' : 'Publicar encuesta'}
          </button>
        </div>
      )}

      {/* Polls list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {pollMessages.length === 0 && (
          <div
            style={{
              display: 'flex',
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke={t.border}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 20V10M12 20V4M6 20v-6" />
            </svg>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted }}>
              No hay encuestas en este grupo
            </span>
          </div>
        )}
        {pollMessages.map((msg) => {
          // Parse [poll:question:opt1|opt2|opt3]
          const inner = msg.text.slice(6, -1);
          const colonIdx = inner.indexOf(':');
          const pollQuestion = colonIdx !== -1 ? inner.slice(0, colonIdx) : inner;
          const optsPart = colonIdx !== -1 ? inner.slice(colonIdx + 1) : '';
          const pollOptions = optsPart ? optsPart.split('|') : [];
          const poll = polls[msg.id] ?? { votes: {} };
          const totalVotes = Object.values(poll.votes).reduce((a, b) => a + b, 0);

          return (
            <div
              key={msg.id}
              style={{
                background: t.surface,
                border: `1px solid ${t.border}`,
                borderRadius: t.radius,
                padding: '16px',
              }}
            >
              <div
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 10,
                  color: t.accent,
                  letterSpacing: '0.06em',
                  marginBottom: 6,
                }}
              >
                ENCUESTA · {msg.senderName ?? msg.senderId}
              </div>
              <div
                style={{
                  fontFamily: t.font,
                  fontWeight: 600,
                  fontSize: 16,
                  color: t.text,
                  marginBottom: 14,
                }}
              >
                {pollQuestion}
              </div>
              {pollOptions.map((opt, i) => {
                const votes = poll.votes[i] ?? 0;
                const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
                return (
                  <div key={i} style={{ marginBottom: 12 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 5,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: t.font,
                          fontSize: 13,
                          color: t.text,
                        }}
                      >
                        {opt}
                      </span>
                      <span
                        style={{
                          fontFamily: t.fontMono,
                          fontSize: 11,
                          color: t.textMuted,
                        }}
                      >
                        {votes} · {pct}%
                      </span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        background: t.surface2,
                        borderRadius: 3,
                        overflow: 'hidden',
                        marginBottom: 6,
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          background: t.accent,
                          borderRadius: 3,
                          transition: 'width 0.4s ease',
                        }}
                      />
                    </div>
                    <button
                      onClick={() => handleVote(msg.id, i)}
                      style={{
                        background: 'none',
                        border: `1px solid ${t.accent}66`,
                        borderRadius: t.radiusS,
                        color: t.accent,
                        fontFamily: t.font,
                        fontSize: 12,
                        padding: '4px 12px',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = t.accent + '22'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
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
                  color: t.textMuted,
                  marginTop: 6,
                  letterSpacing: '0.04em',
                }}
              >
                {totalVotes} voto{totalVotes !== 1 ? 's' : ''} · {msg.time}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
