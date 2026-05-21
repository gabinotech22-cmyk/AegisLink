import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

interface StoredContact {
  aegisId: string;
  name: string;
  publicKeyB64: string;
  color?: string;
  avatarImage?: string | null;
  verified: boolean;
  addedAt: number;
}

interface Props {
  onBack: () => void;
  onAddContact: () => void;
  onOpenContact: (contact: StoredContact) => void;
  onChat: (contact: StoredContact) => void;
}

export function ContactsScreen({ onBack, onAddContact, onOpenContact, onChat }: Props) {
  const { t } = useTheme();
  const contacts: StoredContact[] = []; // stub
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (!q) return sorted;
    return sorted.filter((c) => c.name.toLowerCase().includes(q) || c.aegisId.toLowerCase().includes(q));
  }, [contacts, query]);

  const sections = useMemo(() => {
    const map = new Map<string, StoredContact[]>();
    for (const c of filtered) {
      const initial = (c.name.trim()[0] ?? '#').toUpperCase();
      const key = /^[A-Z]$/.test(initial) ? initial : '#';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title="Contacts"
        big
        left={
          <button onClick={onBack} aria-label="Back" style={iconBtn}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
        right={
          <button onClick={onAddContact} aria-label="Add contact" style={iconBtn}>
            <I.Plus size={22} color={t.accent} />
          </button>
        }
      />

      {/* Search */}
      <div style={{ margin: '4px 18px 10px', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, backgroundColor: t.surface2, borderRadius: 99, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <I.Search size={16} color={t.textDim} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search contacts…"
          style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.text, background: 'none', border: 'none', outline: 'none', padding: 0 }}
        />
        {query.length > 0 && (
          <button onClick={() => setQuery('')} aria-label="Clear search" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
            <I.X size={14} color={t.textDim} />
          </button>
        )}
      </div>

      {/* Count */}
      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, paddingLeft: 22, paddingRight: 22, marginBottom: 8, display: 'block' }}>
        {filtered.length} {filtered.length === 1 ? 'contact' : 'contacts'}
      </span>

      {filtered.length === 0 ? (
        <EmptyState t={t} hasContacts={contacts.length > 0} onAdd={onAddContact} />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sections.map(([letter, rows]) => (
            <div key={letter}>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 1.4, paddingLeft: 22, paddingRight: 22, paddingTop: 14, paddingBottom: 6, display: 'block' }}>
                {letter}
              </span>
              {rows.map((c, i) => (
                <ContactRow
                  key={c.aegisId}
                  t={t}
                  contact={c}
                  onPress={() => onOpenContact(c)}
                  onChat={() => onChat(c)}
                  noBorder={i === rows.length - 1}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactRow({ t, contact, onPress, onChat, noBorder }: { t: Theme; contact: StoredContact; onPress: () => void; onChat: () => void; noBorder: boolean }) {
  const [hovered, setHovered] = useState(false);
  const isAegisId = /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name);

  return (
    <div
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onPress()}
      aria-label={`View contact ${contact.name}`}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 18, paddingTop: 11, paddingBottom: 11, gap: 12, backgroundColor: hovered ? t.surface : 'transparent', borderBottom: noBorder ? 'none' : `1px solid ${t.divider}`, cursor: 'pointer', transition: 'background-color 0.1s' }}
    >
      <Avatar t={t} name={contact.avatarImage ?? contact.name} color={contact.color ?? t.surface2} size={42} photoUri={contact.avatarImage ?? undefined} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: isAegisId ? t.fontMono : t.font, fontSize: 15, fontWeight: '600', color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>
            {contact.name}
          </span>
          {contact.verified && (
            <div style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: t.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <I.Check size={9} color={t.accentInk} stroke={3} />
            </div>
          )}
        </div>
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2, letterSpacing: 0.4, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {contact.aegisId}
        </span>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onChat(); }}
        aria-label={`Chat with ${contact.name}`}
        style={{ padding: 8, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      >
        <I.Chat size={18} color={t.accent} />
      </button>
    </div>
  );
}

function EmptyState({ t, hasContacts, onAdd }: { t: Theme; hasContacts: boolean; onAdd: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingLeft: 32, paddingRight: 32 }}>
      <div style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
        <I.Users size={32} color={t.textDim} />
      </div>
      <span style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '600', letterSpacing: -0.3, color: t.text, marginBottom: 8, textAlign: 'center', display: 'block' }}>
        {hasContacts ? 'No results' : 'No contacts yet'}
      </span>
      <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: '19px', maxWidth: 280, marginBottom: 18, display: 'block' }}>
        {hasContacts ? 'Try a different name or AegisLink ID.' : 'Add contacts by their AegisLink ID or scan their QR code.'}
      </span>
      {!hasContacts && (
        <button onClick={onAdd} aria-label="Add contact" style={{ backgroundColor: t.accent, paddingLeft: 22, paddingRight: 22, paddingTop: 12, paddingBottom: 12, borderRadius: t.radius, border: 'none', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <I.Plus size={18} color={t.accentInk} />
          <span style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>Add Contact</span>
        </button>
      )}
    </div>
  );
}

const iconBtn: CSSProperties = {
  padding: 8, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
