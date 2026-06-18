/**
 * DistributionListsScreen — gestión de listas de difusión (broadcast).
 *
 * Port fiel de mobile/src/screens/DistributionLists.tsx.
 * Diferencias:
 *  - FlatList   → <div> con map (el set es pequeño)
 *  - Modal RN   → overlay div absoluto fixed (cubre la pantalla)
 *  - Pressable  → <button> / <div> con onClick
 *  - safe area  → no aplica en desktop
 *
 * Una lista guarda N aegisIds; al enviar un broadcast cada destinatario recibe
 * un mensaje E2EE independiente, así no se filtra la pertenencia a la lista.
 */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useDistribution, type DistributionList } from '../store/distribution';
import { useContacts } from '../store/contacts';

interface Props {
  onBack: () => void;
  onOpenList: (list: DistributionList) => void;
}

export function DistributionListsScreen({ onBack, onOpenList }: Props) {
  const { t } = useTheme();
  const lists = useDistribution((s) => s.lists);
  const hydrate = useDistribution((s) => s.hydrate);
  const createList = useDistribution((s) => s.create);
  const removeList = useDistribution((s) => s.remove);
  const contacts = useContacts((s) => s.contacts);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<DistributionList | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  function toggleMember(aegisId: string) {
    setSelectedMembers((prev) =>
      prev.includes(aegisId) ? prev.filter((id) => id !== aegisId) : [...prev, aegisId]
    );
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || selectedMembers.length === 0) return;
    await createList(name, selectedMembers);
    setCreating(false);
    setNewName('');
    setSelectedMembers([]);
  }

  function handleDeleteRequest(list: DistributionList) {
    setConfirmDelete(list);
  }

  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    await removeList(confirmDelete.id);
    setConfirmDelete(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title="Distribution Lists"
        left={
          <button onClick={onBack} aria-label="Go back" style={iconBtn}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
        right={
          <button onClick={() => setCreating(true)} aria-label="Create new distribution list" style={iconBtn}>
            <I.Plus size={22} color={t.accent} />
          </button>
        }
      />

      {lists.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, paddingLeft: 40, paddingRight: 40 }}>
          <I.Users size={36} color={t.textFaint} />
          <span style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text, textAlign: 'center' }}>
            No distribution lists
          </span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: '19px' }}>
            Click + to create a list and broadcast messages to multiple contacts at once.
          </span>
          <button
            onClick={() => setCreating(true)}
            aria-label="Create first distribution list"
            style={{
              padding: '11px 22px',
              backgroundColor: t.accent,
              border: 'none',
              borderRadius: t.radiusL,
              marginTop: 6,
              cursor: 'pointer',
              fontFamily: t.font,
              fontSize: 14,
              fontWeight: '600',
              color: t.accentInk,
            }}
          >
            Create List
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lists.map((item) => (
            <div
              key={item.id}
              onClick={() => onOpenList(item)}
              role="button"
              tabIndex={0}
              aria-label={`${item.name}, ${item.members.length} members`}
              style={{
                backgroundColor: t.surface,
                border: `1px solid ${t.border}`,
                borderRadius: t.radius,
                padding: 16,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                cursor: 'pointer',
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: `${t.accent}18`,
                  border: `1px solid ${t.accent}33`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <I.Broadcast size={20} color={t.accent} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text, display: 'block' }}>
                  {item.name}
                </span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, marginTop: 3, display: 'block' }}>
                  {item.members.length} {item.members.length === 1 ? 'MEMBER' : 'MEMBERS'}
                </span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteRequest(item); }}
                aria-label={`Delete ${item.name}`}
                style={iconBtn}
              >
                <I.Trash size={16} color={t.textFaint} />
              </button>
              <I.Chevron size={16} color={t.textFaint} />
            </div>
          ))}
        </div>
      )}

      {/* Create overlay */}
      {creating && (
        <div style={overlayStyle(t)}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                paddingLeft: 18,
                paddingRight: 18,
                paddingTop: 14,
                paddingBottom: 14,
                borderBottom: `1px solid ${t.border}`,
                gap: 12,
              }}
            >
              <button onClick={() => { setCreating(false); setNewName(''); setSelectedMembers([]); }} aria-label="Cancel" style={iconBtn}>
                <I.X size={22} color={t.textDim} />
              </button>
              <span style={{ flex: 1, fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
                New Distribution List
              </span>
              <button
                onClick={() => void handleCreate()}
                disabled={!newName.trim() || selectedMembers.length === 0}
                aria-label="Save distribution list"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 4,
                  cursor: (!newName.trim() || selectedMembers.length === 0) ? 'not-allowed' : 'pointer',
                  fontFamily: t.font,
                  fontSize: 15,
                  fontWeight: '600',
                  color: (!newName.trim() || selectedMembers.length === 0) ? t.textFaint : t.accent,
                }}
              >
                Save
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  backgroundColor: t.surface,
                  border: `1px solid ${t.border}`,
                  borderRadius: t.radius,
                  paddingLeft: 14,
                  paddingRight: 14,
                  paddingTop: 4,
                  paddingBottom: 4,
                }}
              >
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="List name…"
                  autoFocus
                  aria-label="Distribution list name"
                  style={{
                    width: '100%',
                    fontFamily: t.font,
                    fontSize: 15,
                    color: t.text,
                    padding: '12px 0',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                  }}
                />
              </div>

              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6, marginTop: 6 }}>
                SELECT MEMBERS
              </span>

              {contacts.length === 0 ? (
                <div style={{ paddingTop: 22, paddingBottom: 22, display: 'flex', justifyContent: 'center' }}>
                  <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>
                    No contacts available.
                  </span>
                </div>
              ) : (
                contacts.map((contact) => {
                  const isSelected = selectedMembers.includes(contact.aegisId);
                  return (
                    <div
                      key={contact.aegisId}
                      onClick={() => toggleMember(contact.aegisId)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${isSelected ? 'Deselect' : 'Select'} ${contact.name}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        padding: 14,
                        backgroundColor: isSelected ? `${t.accent}12` : t.surface,
                        border: `1px solid ${isSelected ? `${t.accent}44` : t.border}`,
                        borderRadius: t.radiusS,
                        cursor: 'pointer',
                      }}
                    >
                      <div
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          border: `2px solid ${isSelected ? t.accent : t.borderStrong}`,
                          backgroundColor: isSelected ? t.accent : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {isSelected && <I.Check size={12} color={t.accentInk} />}
                      </div>
                      <span style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {contact.name}
                      </span>
                      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.3 }}>
                        {contact.aegisId.slice(0, 8)}…
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation overlay */}
      {confirmDelete && (
        <div style={overlayStyle(t, true)}>
          <div
            style={{
              backgroundColor: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: t.radius,
              padding: 22,
              maxWidth: 380,
              width: 'calc(100% - 32px)',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <span style={{ fontFamily: t.fontDisplay, fontSize: 16, fontWeight: '600', color: t.text }}>
              Delete &ldquo;{confirmDelete.name}&rdquo;?
            </span>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px' }}>
              This will permanently remove this distribution list. The contacts themselves are not affected.
            </span>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  padding: '9px 16px',
                  backgroundColor: 'transparent',
                  border: `1px solid ${t.border}`,
                  borderRadius: t.radiusS,
                  fontFamily: t.font,
                  fontSize: 13,
                  color: t.text,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteConfirm()}
                style={{
                  padding: '9px 16px',
                  backgroundColor: t.danger,
                  border: 'none',
                  borderRadius: t.radiusS,
                  fontFamily: t.font,
                  fontSize: 13,
                  fontWeight: '600',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const iconBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function overlayStyle(t: ReturnType<typeof useTheme>['t'], dim?: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: dim ? 'rgba(0,0,0,0.55)' : t.bg,
    display: 'flex',
    alignItems: dim ? 'center' : 'stretch',
    justifyContent: dim ? 'center' : 'stretch',
    zIndex: 1000,
  };
}
