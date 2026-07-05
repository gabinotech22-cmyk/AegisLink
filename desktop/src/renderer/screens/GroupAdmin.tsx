import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';
import { useGroups } from '../store/groups';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import type { StoredGroup } from '../db/local';

interface Props {
  group: StoredGroup;
  onBack: () => void;
}

export function GroupAdminScreen({ group: groupProp, onBack }: Props) {
  const { t } = useTheme();
  const { renameGroup, addMember, removeMember, updateGroupPermissions, leaveGroup, dissolveGroup } = useGroups();
  const contacts = useContacts((s) => s.contacts);
  const identity = useIdentity((s) => s.identity);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(groupProp.name);

  const group = useGroups((s) => s.groups.find((g) => g.id === groupProp.id)) ?? groupProp;

  const isMe = (id: string) => id === identity?.aegisId;
  const amIAdmin = !!identity && identity.aegisId === group.adminId;

  function getMemberName(id: string) {
    if (isMe(id)) return 'You';
    return contacts.find((c) => c.aegisId === id)?.name ?? id.slice(0, 8) + '…';
  }

  function getMemberColor(id: string) {
    if (isMe(id)) return t.accent;
    return contacts.find((c) => c.aegisId === id)?.color ?? t.surface2;
  }

  async function handleRename() {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === group.name) { setEditingName(false); return; }
    await renameGroup(group.id, trimmed);
    setEditingName(false);
  }

  function handleAddMember() {
    const eligible = contacts.filter((c) => !group.members.includes(c.aegisId));
    if (eligible.length === 0) { window.alert('All contacts are already in this group.'); return; }
    const options = eligible.slice(0, 10).map((c) => c.name).join('\n');
    const name = window.prompt(`Enter contact name to add:\n\n${options}`);
    if (!name) return;
    const match = eligible.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (!match) { window.alert('Contact not found.'); return; }
    void addMember(group.id, match.aegisId);
  }

  function handleRemoveMember(id: string) {
    if (isMe(id)) {
      const isAdmin = !!identity && identity.aegisId === group.adminId;
      // The group admin "leaving" actually DISSOLVES the group for everyone —
      // a plain leaveGroup would only wipe it locally and silently strand every
      // other member in a group whose creator vanished. Non-admins keep the
      // original leave-only flow (they lack the signing key to dissolve).
      const message = isAdmin
        ? 'You are the admin. Leaving will delete this group for every member, not just you. Continue?'
        : 'Leave group and delete locally?';
      if (window.confirm(message)) {
        if (isAdmin) void dissolveGroup(group.id);
        else void leaveGroup(group.id);
        onBack();
      }
      return;
    }
    const name = getMemberName(id);
    if (window.confirm(`Remove ${name} from the group?`)) {
      void removeMember(group.id, id);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Group settings" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 24 }}>
        {/* Group header */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 22px 18px' }}>
          <div style={{ width: 76, height: 76, borderRadius: t.radius, backgroundColor: `${group.avatarColor ?? t.accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I.Users size={34} color={group.avatarColor ?? t.accent} />
          </div>

          {editingName ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(); }}
                autoFocus
                style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '600', color: t.text, backgroundColor: 'transparent', border: 'none', borderBottom: `2px solid ${t.accent}`, outline: 'none', minWidth: 120, padding: '2px 0' }}
              />
              <button onClick={() => void handleRename()} aria-label="Confirm name" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <I.Check size={22} color={t.accent} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setNameInput(group.name); setEditingName(true); }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, background: 'none', border: 'none', cursor: 'pointer' }}
              aria-label="Edit group name"
            >
              <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text }}>{group.name}</span>
              <I.Key size={14} color={t.textDim} />
            </button>
          )}

          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5, marginTop: 4 }}>
            E2EE · {group.members.length} members
          </span>
        </div>

        {/* Members */}
        <Section t={t} label={`MEMBERS · ${group.members.length}`}>
          {group.members.map((id, i) => {
            const name = getMemberName(id);
            const color = getMemberColor(id);
            const me = isMe(id);
            const isAdmin = me || group.adminId === id;
            const isMod = !isAdmin && (group.moderators ?? []).includes(id);
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < group.members.length - 1 ? `1px solid ${t.divider}` : 'none' }}>
                <div style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: color + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontFamily: t.fontMono, fontSize: 14, fontWeight: '600', color }}>{name.trim()[0]?.toUpperCase() ?? '?'}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    <span style={{ fontFamily: t.fontMono, fontSize: 9, color: isAdmin ? t.accent : isMod ? t.warn : t.textDim, backgroundColor: t.surface2, padding: '3px 6px', borderRadius: 4 }}>
                      {isAdmin ? 'ADMIN' : isMod ? 'MOD' : 'MEMBER'}
                    </span>
                  </div>
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4 }}>
                    {me ? 'you' : id.slice(0, 16) + '…'}
                  </span>
                </div>
                {!me && (
                  <button onClick={() => handleRemoveMember(id)} aria-label={`Remove ${name}`} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6 }}>
                    <I.X size={16} color={t.textDim} />
                  </button>
                )}
              </div>
            );
          })}

          <button
            onClick={handleAddMember}
            aria-label="Add member"
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', width: '100%', background: 'none', border: 'none', cursor: 'pointer', boxSizing: 'border-box' }}
          >
            <div style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: t.surface2, border: `1px dashed ${t.accent}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <I.Plus size={20} color={t.accent} />
            </div>
            <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '500', color: t.accent, flex: 1, textAlign: 'left' }}>Add member</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>FROM CONTACTS</span>
          </button>
        </Section>

        {/* Permissions */}
        <Section t={t} label="PERMISSIONS">
          <Toggle
            t={t}
            label="Only admins can send"
            sub="Members can only read messages"
            value={group.permissions?.onlyAdminsSend ?? false}
            onChange={(v) => void updateGroupPermissions(group.id, { permissions: { ...(group.permissions ?? {}), onlyAdminsSend: v } })}
          />
          <Toggle
            t={t}
            label="Disable reactions"
            sub="No emoji reactions in this group"
            value={group.permissions?.disableReactions ?? false}
            onChange={(v) => void updateGroupPermissions(group.id, { permissions: { ...(group.permissions ?? {}), disableReactions: v } })}
            noBorder
          />
        </Section>

        {/* Danger zone */}
        <Section t={t} label="DANGER ZONE">
          <button
            onClick={() => {
              if (window.confirm('Leave group permanently?')) { void leaveGroup(group.id); onBack(); }
            }}
            style={{ display: 'block', width: '100%', padding: '13px 16px', textAlign: 'left', background: 'none', border: 'none', borderBottom: `1px solid ${t.divider}`, cursor: 'pointer', fontFamily: t.font, fontSize: 14, color: t.danger }}
            aria-label="Leave group"
          >
            Leave group
          </button>
          {/* Only the group admin holds the signing key that can dissolve the
              group for every member (see socket/client.ts broadcastGroupDissolve
              / signGroupDissolve) — a non-admin clicking this could previously
              only wipe their own local copy while the button promised
              otherwise. Hidden for non-admins to avoid that false promise. */}
          {amIAdmin && (
            <button
              onClick={() => {
                if (window.confirm('Delete group for everyone? This cannot be undone.')) {
                  void dissolveGroup(group.id);
                  onBack();
                }
              }}
              style={{ display: 'block', width: '100%', padding: '13px 16px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: t.font, fontSize: 14, color: t.danger, fontWeight: '600' }}
              aria-label="Delete group"
            >
              Delete group for everyone
            </button>
          )}
        </Section>
      </div>
    </div>
  );
}
