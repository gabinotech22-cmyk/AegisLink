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

export default function Groups({ onOpenGroup, onBack, t }) {
  const [showForm, setShowForm] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [creating, setCreating] = useState(false);

  const identity = useStore((s) => s.identity);
  const contacts = useStore((s) => s.contacts);
  const groups = useStore((s) => s.groups);
  const groupMessages = useStore((s) => s.groupMessages);

  function toggleMember(aegisId) {
    setSelectedMembers((prev) =>
      prev.includes(aegisId) ? prev.filter((id) => id !== aegisId) : [...prev, aegisId],
    );
  }

  async function handleCreate() {
    if (!groupName.trim() || selectedMembers.length === 0 || !identity) return;
    setCreating(true);
    try {
      const groupId = crypto.randomUUID();
      const members = [identity.aegisId, ...selectedMembers];

      const newGroup = {
        id: groupId,
        name: groupName.trim(),
        members,
        createdAt: Date.now(),
        createdBy: identity.aegisId,
      };

      useStore.setState((s) => ({ groups: [...s.groups, newGroup] }));

      // Notify all members about the new group
      const plaintext = JSON.stringify({
        type: 'group_create',
        groupId,
        groupName: newGroup.name,
        members,
        senderId: identity.aegisId,
        senderName: identity.displayName ?? identity.aegisId,
        senderColor: colorFromId(identity.aegisId),
        body: `[group_create:${groupId}:${newGroup.name}:${members.join(',')}]`,
      });

      await sendGroupMessage({ identity, groupId, plaintext, store: { getState: useStore.getState } });

      setGroupName('');
      setSelectedMembers([]);
      setShowForm(false);
      onOpenGroup(groupId);
    } finally {
      setCreating(false);
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
            Grupos
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: '0.06em', marginTop: 1 }}>
            E2EE · CIFRADO
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
          {showForm ? 'Cancelar' : '+ Nuevo grupo'}
        </button>
      </div>

      {/* Create group form */}
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
            NUEVO GRUPO
          </div>
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Nombre del grupo"
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
            Agregar contactos:
          </div>

          {contacts.length === 0 && (
            <div
              style={{
                fontFamily: t.font,
                fontSize: 12,
                color: t.textMuted,
                marginBottom: 12,
                fontStyle: 'italic',
              }}
            >
              No tienes contactos aún
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {contacts.map((c) => {
              const selected = selectedMembers.includes(c.aegisId);
              return (
                <button
                  key={c.aegisId}
                  onClick={() => toggleMember(c.aegisId)}
                  style={{
                    background: selected ? t.accent + '22' : 'transparent',
                    border: `1px solid ${selected ? t.accent : t.border}`,
                    borderRadius: t.radiusS,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      background: colorFromId(c.aegisId) + '33',
                      border: `1px solid ${colorFromId(c.aegisId)}66`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: t.fontMono,
                      fontSize: 11,
                      color: colorFromId(c.aegisId),
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {c.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: t.font,
                        fontSize: 13,
                        color: selected ? t.accent : t.text,
                        fontWeight: selected ? 600 : 400,
                      }}
                    >
                      {c.name}
                    </div>
                    <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textMuted }}>
                      {c.aegisId}
                    </div>
                  </div>
                  {selected && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={t.accent}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          <button
            onClick={handleCreate}
            disabled={!groupName.trim() || selectedMembers.length === 0 || creating}
            style={{
              background:
                !groupName.trim() || selectedMembers.length === 0 || creating
                  ? t.surface
                  : t.accent,
              border: 'none',
              borderRadius: t.radiusS,
              color:
                !groupName.trim() || selectedMembers.length === 0 || creating
                  ? t.textMuted
                  : t.accentInk,
              fontFamily: t.font,
              fontWeight: 600,
              fontSize: 13,
              padding: '8px 20px',
              cursor:
                !groupName.trim() || selectedMembers.length === 0 || creating
                  ? 'default'
                  : 'pointer',
              width: '100%',
            }}
          >
            {creating ? 'Creando…' : `Crear grupo (${selectedMembers.length + 1} miembros)`}
          </button>
        </div>
      )}

      {/* Groups list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {groups.length === 0 && (
          <div
            style={{
              display: 'flex',
              flex: 1,
              height: '100%',
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
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
            </svg>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted }}>
              No tienes grupos aún
            </span>
          </div>
        )}
        {groups.map((group) => {
          const msgs = groupMessages[group.id] ?? [];
          const lastMsg = msgs[msgs.length - 1];
          return (
            <button
              key={group.id}
              onClick={() => onOpenGroup(group.id)}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                borderBottom: `1px solid ${t.border}`,
                padding: '12px 18px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.surface2; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  background: t.accent + '22',
                  border: `1px solid ${t.accent}44`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: t.fontMono,
                  fontSize: 13,
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
                <div
                  style={{
                    fontFamily: t.font,
                    fontSize: 12,
                    color: t.textMuted,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginTop: 2,
                  }}
                >
                  {lastMsg
                    ? lastMsg.text?.startsWith('[')
                      ? '[adjunto]'
                      : lastMsg.text
                    : `${group.members?.length ?? 0} miembros`}
                </div>
              </div>
              <div
                style={{
                  background: t.surface2,
                  border: `1px solid ${t.border}`,
                  borderRadius: 99,
                  padding: '2px 8px',
                  fontFamily: t.fontMono,
                  fontSize: 9,
                  color: t.textMuted,
                  flexShrink: 0,
                }}
              >
                {group.members?.length ?? 0}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
