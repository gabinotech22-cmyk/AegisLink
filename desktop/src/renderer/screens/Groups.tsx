import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { TabBar, type Tab } from '../components/TabBar';
import { useIdentity } from '../store/identity';
import { useGroups } from '../store/groups';
import { useContacts } from '../store/contacts';
import { useMessages } from '../store/messages';
import type { StoredGroup, StoredContact } from '../db/local';

const WORK_ACCENT = '#6366f1';

const GROUP_COLORS = ['#05b875', '#8b5cf6', '#3b82f6', '#ec4899', '#f97316', '#eab308', '#06b6d4'];
const GROUP_EMOJIS = [
  { label: 'Initial', val: undefined },
  { label: 'Group', val: '👥' },
  { label: 'Chat', val: '💬' },
  { label: 'Lightning', val: '⚡' },
  { label: 'Shield', val: '🛡️' },
  { label: 'Lock', val: '🔒' },
  { label: 'Robot', val: '🤖' },
  { label: 'Fire', val: '🔥' },
  { label: 'Crown', val: '👑' },
  { label: 'Ice', val: '🧊' },
];

interface Props {
  onTab: (tab: Tab) => void;
  onOpenGroupChat: (group: StoredGroup) => void;
}

export function GroupsScreen({ onTab, onOpenGroupChat }: Props) {
  const { t } = useTheme();
  const activeProfile = useIdentity((s) => s.activeProfile);
  const isWork = activeProfile === 'work';
  const allGroups = useGroups((s) => s.groups);
  const groups = isWork
    ? allGroups.filter((g) => (g as StoredGroup & { isWork?: boolean }).isWork === true)
    : allGroups.filter((g) => !(g as StoredGroup & { isWork?: boolean }).isWork);
  const contacts = useContacts((s) => s.contacts) as StoredContact[];
  const previews = useMessages((s) => s.previews);

  const [isCreating, setIsCreating] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [groupColor, setGroupColor] = useState('#05b875');
  const [groupImage, setGroupImage] = useState<string | undefined>(undefined);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function toggleContact(id: string) {
    setSelectedContacts((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function handlePickImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) setGroupImage(URL.createObjectURL(file));
    };
    input.click();
  }

  async function handleConfirmCreate() {
    if (!groupName.trim()) { setErrorMsg('Enter a group name.'); return; }
    if (selectedContacts.length === 0) { setErrorMsg('Select at least one contact.'); return; }
    setErrorMsg(null);
    try {
      const identity = useIdentity.getState().identity;
      if (!identity) { setErrorMsg('No identity found.'); return; }
      const members = [identity.aegisId, ...selectedContacts];
      await useGroups.getState().createGroup(groupName.trim(), members, groupColor, groupImage);
      setIsCreating(false);
      setGroupName('');
      setSelectedContacts([]);
      setGroupColor('#05b875');
      setGroupImage(undefined);
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  // ── Creation flow ──
  if (isCreating) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
        <TopBar
          t={t}
          title="New Group"
          left={
            <button onClick={() => { setIsCreating(false); setGroupName(''); setSelectedContacts([]); }} aria-label="Cancel" style={iconBtn}>
              <I.ChevronL size={22} color={t.textDim} />
            </button>
          }
        />
        <div style={{ flex: 1, overflowY: 'auto', paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 32, display: 'flex', flexDirection: 'column', gap: 0 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, display: 'block' }}>GROUP NAME</span>
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="e.g. Team Alpha"
            style={{ fontFamily: t.font, fontSize: 16, color: t.text, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, marginBottom: 16, outline: 'none', width: '100%', boxSizing: 'border-box' }}
          />

          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, display: 'block' }}>PREVIEW</span>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, marginBottom: 10 }}>
            <Avatar t={t} name={groupImage ?? (groupName.trim() || 'G')} color={groupColor} size={64} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 20 }}>
            <button onClick={handlePickImage} aria-label="Pick image" style={outlineBtn(t)}>
              <I.Plus size={14} color={t.text} />
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>Gallery</span>
            </button>
            {groupImage && (
              <button onClick={() => setGroupImage(undefined)} aria-label="Remove image" style={{ ...outlineBtn(t), backgroundColor: `${t.danger}15`, borderColor: t.danger }}>
                <I.Trash size={14} color={t.danger} />
                <span style={{ fontFamily: t.font, fontSize: 12, color: t.danger }}>Remove</span>
              </button>
            )}
          </div>

          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, display: 'block' }}>COLOR</span>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
            {GROUP_COLORS.map((c) => (
              <button key={c} onClick={() => setGroupColor(c)} aria-label={`Color ${c}`} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c, border: `2px solid ${groupColor === c ? t.text : 'transparent'}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {groupColor === c && <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
              </button>
            ))}
          </div>

          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, display: 'block' }}>ICON</span>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 8, marginBottom: 20, overflowX: 'auto', paddingBottom: 6 }}>
            {GROUP_EMOJIS.map((e) => {
              const isSel = groupImage === e.val;
              return (
                <button key={e.label} onClick={() => setGroupImage(e.val)} aria-label={e.label} style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: t.radiusS, backgroundColor: isSel ? t.accent : t.surface, border: `1px solid ${isSel ? t.accent : t.borderStrong}`, cursor: 'pointer', minWidth: 50, textAlign: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 13, color: isSel ? t.accentInk : t.text, fontFamily: t.font }}>{e.val ?? 'G'}</span>
                </button>
              );
            })}
          </div>

          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, marginBottom: 8, display: 'block' }}>
            MEMBERS ({selectedContacts.length} selected)
          </span>
          {contacts.length === 0 ? (
            <div style={{ padding: 24, backgroundColor: t.surface, borderRadius: t.radius, display: 'flex', flexDirection: 'column', alignItems: 'center', border: `1px solid ${t.border}`, marginBottom: 24 }}>
              <I.Users size={24} color={t.textDim} />
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center', marginTop: 8 }}>No contacts yet. Add contacts first.</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 24 }}>
              {contacts.map((c) => {
                const isSel = selectedContacts.includes(c.aegisId);
                return (
                  <button key={c.aegisId} onClick={() => toggleContact(c.aegisId)} aria-label={`Toggle ${c.name}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: isSel ? `${t.accent}11` : t.surface, border: `1px solid ${isSel ? t.accent : t.border}`, borderRadius: t.radius, cursor: 'pointer', textAlign: 'left' }}>
                    <Avatar t={t} name={c.avatarImage ?? c.name} color={c.color ?? t.surface2} size={32} photoUri={c.avatarImage ?? undefined} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>{c.name}</span>
                      <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, display: 'block', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.aegisId}</span>
                    </div>
                    <div style={{ width: 20, height: 20, borderRadius: 10, border: `1.5px solid ${isSel ? t.accent : t.borderStrong}`, backgroundColor: isSel ? t.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {isSel && <I.Check size={12} color={t.accentInk} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {errorMsg && (
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger, display: 'block', marginBottom: 12 }}>{errorMsg}</span>
          )}

          <button onClick={() => void handleConfirmCreate()} aria-label="Create group" style={{ backgroundColor: t.accent, paddingTop: 14, paddingBottom: 14, borderRadius: t.radius, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 15 }}>Create Group</span>
          </button>
        </div>
      </div>
    );
  }

  // ── Group list ──
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title={isWork ? 'Channels' : 'Groups'}
        big
        right={
          <button onClick={() => setIsCreating(true)} aria-label="Create group" style={iconBtn}>
            <I.Plus size={22} color={t.accent} />
          </button>
        }
      />

      {isWork && (
        <div style={{ margin: '4px 18px 8px', paddingTop: 9, paddingBottom: 9, paddingLeft: 14, paddingRight: 14, backgroundColor: `${WORK_ACCENT}11`, border: `1px solid ${WORK_ACCENT}44`, borderRadius: 10, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <I.Users size={13} color={WORK_ACCENT} />
          <span style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: WORK_ACCENT, letterSpacing: 0.6 }}>Work channels are encrypted team workspaces</span>
        </div>
      )}

      {groups.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingLeft: 32, paddingRight: 32 }}>
          <ConstellationVisual t={t} />
          <h2 style={{ fontFamily: t.fontDisplay, fontSize: 24, fontWeight: '600', letterSpacing: -0.4, color: t.text, marginTop: 28, marginBottom: 10, textAlign: 'center' }}>
            {isWork ? 'Your work space is ready' : 'No groups yet'}
          </h2>
          <p style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: '21px', textAlign: 'center', maxWidth: 280, marginBottom: 26, marginTop: 0 }}>
            {isWork ? 'Create encrypted channels for your team.' : 'Create a group to chat with multiple people at once.'}
          </p>
          <button onClick={() => setIsCreating(true)} aria-label={isWork ? 'New channel' : 'Create group'} style={{ backgroundColor: isWork ? WORK_ACCENT : t.accent, paddingLeft: 24, paddingRight: 24, paddingTop: 13, paddingBottom: 13, borderRadius: t.radius, border: 'none', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
            <I.Plus size={18} color={isWork ? '#fff' : t.accentInk} />
            <span style={{ color: isWork ? '#fff' : t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
              {isWork ? 'New Channel' : 'Create Group'}
            </span>
          </button>
          <button aria-label="Join by link" style={{ backgroundColor: 'transparent', border: `1px solid ${t.borderStrong}`, paddingLeft: 24, paddingRight: 24, paddingTop: 12, paddingBottom: 12, borderRadius: t.radius, cursor: 'pointer' }}>
            <span style={{ color: t.text, fontFamily: t.font, fontWeight: '500', fontSize: 14 }}>Join by link</span>
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {groups.map((item) => {
            const previewMsg = previews[item.id];
            let lastText = 'No messages';
            if (previewMsg) {
              if (previewMsg.body.includes(': ')) {
                const colonIdx = previewMsg.body.indexOf(': ');
                const snd = previewMsg.body.substring(0, colonIdx);
                const actual = previewMsg.body.substring(colonIdx + 2);
                lastText = `${snd.substring(0, 8)}: ${actual}`;
              } else {
                lastText = previewMsg.body;
              }
            }
            return (
              <button
                key={item.id}
                onClick={() => onOpenGroupChat(item)}
                aria-label={`Open ${item.name}`}
                style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 14, paddingBottom: 14, borderBottom: `1px solid ${t.divider}`, backgroundColor: 'transparent', border: 'none', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: t.divider, cursor: 'pointer', width: '100%', textAlign: 'left', boxSizing: 'border-box' }}
              >
                <Avatar t={t} name={item.avatarImage ?? item.name} color={item.avatarColor ?? t.accent} size={44} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{item.name}</span>
                    {previewMsg && <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, flexShrink: 0 }}>{new Date(previewMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                  </div>
                  <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastText}</span>
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                    <I.Lock size={10} color={t.accent} />
                    <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.5 }}>E2EE · {item.members.length} MEMBERS</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <TabBar t={t} current="groups" onChange={onTab} isWork={isWork} />
    </div>
  );
}

function ConstellationVisual({ t }: { t: Theme }) {
  return (
    <svg viewBox="0 0 180 140" width={180} height={140}>
      <line x1={50} y1={40} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <line x1={130} y1={40} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <line x1={40} y1={100} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <line x1={140} y1={100} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <circle cx={50} cy={40} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <circle cx={130} cy={40} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <circle cx={40} cy={100} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <circle cx={140} cy={100} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <circle cx={90} cy={70} r={22} fill={`${t.accent}22`} stroke={t.accent} strokeWidth={1.5} />
      <path d="M90 48 L99 54 L99 66 L90 72 L81 66 L81 54 Z" fill="none" stroke={t.accent} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}

function outlineBtn(t: Theme): CSSProperties {
  return {
    display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
    borderRadius: t.radiusS, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`,
    cursor: 'pointer',
  };
}

const iconBtn: CSSProperties = {
  padding: 8, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
