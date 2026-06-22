import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';
import { fileToDownscaledDataUrl } from '../utils/image';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  onBack: () => void;
  onDevices: () => void;
  onPanic: () => void;
  onAppIcon: () => void;
  onSubscription?: () => void;
  onKeys: () => void;
}

const PROFILE_COLORS = ['#05b875', '#8b5cf6', '#3b82f6', '#ec4899', '#f97316', '#eab308', '#6366f1'];
const PROFILE_EMOJIS = [
  { label: 'Initial', val: null as string | null },
  { label: 'Shield', val: '🛡️' },
  { label: 'Lock', val: '🔒' },
  { label: 'Key', val: '🔑' },
  { label: 'Lightning', val: '⚡' },
  { label: 'Owl', val: '🦉' },
  { label: 'Fox', val: '🦊' },
  { label: 'Ice', val: '🧊' },
  { label: 'UFO', val: '🛸' },
  { label: 'Robot', val: '🤖' },
];

export function ProfileScreen({ onBack, onDevices, onPanic, onAppIcon, onSubscription, onKeys }: Props) {
  const { t } = useTheme();

  const identity = useIdentity((s) => s.identity);
  const storeDisplayName = useIdentity((s) => s.displayName);
  const storeAvatarColor = useIdentity((s) => s.avatarColor);
  const storeAvatarImage = useIdentity((s) => s.avatarImage);
  const storeProfileStatus = useIdentity((s) => s.profileStatus);
  const updateProfile = useIdentity((s) => s.updateProfile);
  const updateStatus = useIdentity((s) => s.updateStatus);

  const displayName = storeDisplayName;
  const aegisId = identity?.aegisId ?? '— — —';
  const avatarColor = storeAvatarColor;
  const avatarImage = storeAvatarImage;
  const profileStatus = storeProfileStatus;

  const photoVis = usePreferences((s) => s.photoVis);
  const lastSeen = usePreferences((s) => s.lastSeenVisible);
  const typing = usePreferences((s) => s.typingVisible);
  const setPref = usePreferences((s) => s.set);
  function setPhotoVis(v: 'all' | 'contacts' | 'none') { void setPref('photoVis', v); }
  function setLastSeen(v: boolean) { void setPref('lastSeenVisible', v); }
  function setTyping(v: boolean) { void setPref('typingVisible', v); }

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(displayName);
  const [editColor, setEditColor] = useState(avatarColor);
  const [editImage, setEditImage] = useState<string | null>(avatarImage);
  const [isEditingStatus, setIsEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function openEdit() {
    setEditName(displayName);
    setEditColor(avatarColor);
    setEditImage(avatarImage);
    setIsEditing(true);
  }

  function handlePickImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      // Downscale to a small JPEG data: URL. Unlike URL.createObjectURL (which is
      // revoked on reload and never persists), a data URL survives restarts and is
      // safe to store in the DB / broadcast to contacts.
      fileToDownscaledDataUrl(file)
        .then((dataUrl) => setEditImage(dataUrl))
        .catch(() => setErrorMsg('Could not load that image.'));
    };
    input.click();
  }

  function handleSaveProfile() {
    if (!editName.trim()) { setErrorMsg('Name cannot be empty.'); return; }
    void updateProfile(editName.trim(), editColor, editImage);
    setIsEditing(false);
    setErrorMsg(null);
  }

  function handleDeleteIdentity() {
    if (!window.confirm('Delete this identity? All messages and contacts will be permanently erased.')) return;
    void import('../store/identity').then(({ useIdentity: id }) => id.getState().reset());
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title="Profile"
        big
        left={
          <button onClick={onBack} aria-label="Back" style={iconBtn}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 24 }}>
        {/* Identity card */}
        <button
          onClick={openEdit}
          aria-label="Edit profile"
          style={{ margin: '4px 18px 18px', padding: 18, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`, borderRadius: t.radius, cursor: 'pointer', width: 'calc(100% - 36px)', boxSizing: 'border-box', textAlign: 'left', display: 'block' }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Avatar t={t} name={displayName} color={avatarColor} size={56} photoUri={avatarImage ?? undefined} seed={identity?.publicKeyB64} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: t.fontDisplay, fontWeight: '600', fontSize: 17, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName}
                </span>
                <div style={{ padding: 3, borderRadius: 99, backgroundColor: t.surface2 }}>
                  <I.Settings size={10} color={t.accent} />
                </div>
              </div>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: avatarColor, letterSpacing: 0.5, marginTop: 2, display: 'block' }}>
                {aegisId}
              </span>
            </div>
          </div>
          <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 12, lineHeight: '16px', display: 'block' }}>
            Your identity is cryptographically isolated — tap to edit your display name and avatar.
          </span>
        </button>

        {/* Status */}
        <Section t={t} label="STATUS">
          <button
            onClick={() => { setStatusDraft(profileStatus); setIsEditingStatus(true); }}
            aria-label="Edit status"
            style={{ padding: 14, background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', boxSizing: 'border-box' }}
          >
            <div style={{ paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10, backgroundColor: t.surface2, borderRadius: t.radiusS, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: profileStatus ? t.text : t.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {profileStatus || 'Add a status…'}
              </span>
              <I.Settings size={14} color={t.textFaint} />
            </div>
          </button>
        </Section>

        <Section t={t} label="VISIBILITY" hint="Who can see this">
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, borderBottom: `1px solid ${t.divider}`, gap: 12 }}>
            <span style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.text }}>Profile photo</span>
            <PhotoVisPicker t={t} value={photoVis} onChange={setPhotoVis} />
          </div>
          <Toggle t={t} label="Last seen" sub="Show when you were last active" value={lastSeen} onChange={setLastSeen} />
          <Toggle t={t} label="Typing indicator" value={typing} onChange={setTyping} noBorder />
        </Section>

        <Section t={t} label="APPEARANCE">
          <Row t={t} icon={<I.Image size={18} color={t.textDim} />} label="App icon" sub="Customize the app icon" onPress={onAppIcon} noBorder />
        </Section>

        <Section t={t} label="ACCOUNT">
          <Row t={t} icon={<I.Key size={18} color={t.textDim} />} label="Identities & keys" sub="View your public keys & fingerprint" onPress={onKeys} />
          <Row t={t} icon={<I.Phone size={18} color={t.textDim} />} label="Linked devices" onPress={onDevices} />
          <Row t={t} icon={<I.Shield size={18} color={t.accent} />} label="Panic mode" sub="Instantly wipe all data" onPress={onPanic} />
          {onSubscription && (
            <Row t={t} icon={<I.Zap size={18} color={t.textDim} />} label="Anonymous subscription" sub="Pay with crypto, no account required" onPress={onSubscription} />
          )}
          <Row t={t} icon={<I.Trash size={18} color={t.danger} />} label="Delete identity" danger noBorder onPress={handleDeleteIdentity} />
        </Section>
      </div>

      {/* Edit Profile Modal */}
      {isEditing && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 100 }} onClick={() => setIsEditing(false)}>
          <div style={{ backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.border}`, padding: 20, width: '100%', maxWidth: 400, maxHeight: '80vh', overflowY: 'auto', boxSizing: 'border-box' }} onClick={(e) => e.stopPropagation()}>
            <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 15, color: t.text, display: 'block', marginBottom: 16 }}>Edit Profile</span>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
              <Avatar t={t} name={editName} color={editColor} size={72} photoUri={editImage ?? undefined} seed={identity?.publicKeyB64} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 20 }}>
              <button onClick={handlePickImage} aria-label="Pick image" style={outlineBtn(t)}>
                <I.Plus size={14} color={t.text} />
                <span style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>Gallery</span>
              </button>
              {editImage && (
                <button onClick={() => setEditImage(null)} aria-label="Remove photo" style={{ ...outlineBtn(t), backgroundColor: `${t.danger}15`, borderColor: t.danger }}>
                  <I.Trash size={14} color={t.danger} />
                  <span style={{ fontFamily: t.font, fontSize: 12, color: t.danger }}>Remove</span>
                </button>
              )}
            </div>

            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginBottom: 6 }}>Display name</span>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={20}
              placeholder="Your name"
              style={{ color: t.text, backgroundColor: t.bg, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, padding: 12, fontSize: 15, marginBottom: 16, fontFamily: t.font, width: '100%', boxSizing: 'border-box', outline: 'none' }}
            />

            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginBottom: 8 }}>Color</span>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
              {PROFILE_COLORS.map((c) => (
                <button key={c} onClick={() => setEditColor(c)} aria-label={`Color ${c}`} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c, border: `2px solid ${editColor === c ? t.text : 'transparent'}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {editColor === c && <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
                </button>
              ))}
            </div>

            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginBottom: 8 }}>Avatar icon</span>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 8, marginBottom: 20, overflowX: 'auto', paddingBottom: 4 }}>
              {PROFILE_EMOJIS.map((e) => {
                const isSel = editImage === e.val;
                return (
                  <button key={e.label} onClick={() => setEditImage(e.val)} aria-label={e.label} style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: t.radiusS, backgroundColor: isSel ? t.accent : t.surface2, border: `1px solid ${isSel ? t.accent : t.borderStrong}`, cursor: 'pointer', flexShrink: 0, minWidth: 44 }}>
                    <span style={{ fontSize: 13, color: isSel ? t.accentInk : t.text }}>{e.val ?? editName[0]?.toUpperCase() ?? 'A'}</span>
                  </button>
                );
              })}
            </div>

            {errorMsg && <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger, display: 'block', marginBottom: 12 }}>{errorMsg}</span>}

            <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
              <button onClick={() => setIsEditing(false)} aria-label="Cancel" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: t.font, fontSize: 14, color: t.textDim }}>Cancel</span>
              </button>
              <button onClick={handleSaveProfile} aria-label="Save profile" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, backgroundColor: t.accent, borderRadius: t.radiusS, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.accentInk }}>Save</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status edit modal */}
      {isEditingStatus && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 100 }} onClick={() => setIsEditingStatus(false)}>
          <div style={{ backgroundColor: t.surface, borderRadius: t.radius, border: `1px solid ${t.borderStrong}`, padding: 20, width: '100%', maxWidth: 360, boxSizing: 'border-box' }} onClick={(e) => e.stopPropagation()}>
            <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 15, color: t.text, display: 'block', marginBottom: 14 }}>Edit Status</span>
            <input
              value={statusDraft}
              onChange={(e) => setStatusDraft(e.target.value)}
              placeholder="What's on your mind?"
              maxLength={80}
              autoFocus
              style={{ backgroundColor: t.surface2, color: t.text, fontFamily: t.font, fontSize: 14, borderRadius: t.radiusS, paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10, marginBottom: 6, border: 'none', outline: 'none', width: '100%', boxSizing: 'border-box' }}
            />
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginBottom: 16, textAlign: 'right', display: 'block' }}>{statusDraft.length}/80</span>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 10 }}>
              <button onClick={() => setIsEditingStatus(false)} aria-label="Cancel" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: t.font, fontSize: 14, color: t.textDim }}>Cancel</span>
              </button>
              <button onClick={() => { void updateStatus(statusDraft.trim()); setIsEditingStatus(false); }} aria-label="Save status" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, backgroundColor: t.accent, borderRadius: t.radiusS, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.accentInk }}>Save</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PhotoVisPicker({ t, value, onChange }: { t: Theme; value: 'all' | 'contacts' | 'none'; onChange: (v: 'all' | 'contacts' | 'none') => void }) {
  const opts: { id: 'all' | 'contacts' | 'none'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'contacts', label: 'Contacts' },
    { id: 'none', label: 'None' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
      {opts.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} aria-label={o.label} aria-pressed={value === o.id} style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 5, paddingBottom: 5, borderRadius: t.radiusS, backgroundColor: value === o.id ? t.accent : t.surface2, border: 'none', cursor: 'pointer' }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: value === o.id ? t.accentInk : t.textDim }}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function outlineBtn(t: Theme): CSSProperties {
  return {
    display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
    borderRadius: t.radiusS, backgroundColor: t.surface2, border: `1px solid ${t.borderStrong}`,
    cursor: 'pointer',
  };
}

const iconBtn: CSSProperties = {
  padding: 8, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
