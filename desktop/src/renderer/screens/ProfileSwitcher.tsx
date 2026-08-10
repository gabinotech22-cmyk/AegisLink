/**
 * ProfileSwitcher — Section 11, desktop.
 *
 * Lists every profile and switches between them. Port of the mobile screen,
 * rewritten for the web renderer (no FlatList, no Pressable, no themedAlert).
 *
 * Switching is genuinely slow here: the main process closes one encrypted
 * SQLite file and opens another. The row shows a spinner and the whole list is
 * disabled while it runs, because a second click mid-switch would ask main for
 * a slot that is not the open one and come back as a "profile mismatch" error.
 */
import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Avatar } from '../components/Avatar';
import { useProfiles, type Profile } from '../store/profiles';
import { useIdentity } from '../store/identity';

interface Props {
  onBack: () => void;
  onCreateProfile: () => void;
}

export function ProfileSwitcherScreen({ onBack, onCreateProfile }: Props) {
  const { t } = useTheme();
  const profiles = useProfiles((s) => s.profiles);
  const activeSlotId = useProfiles((s) => s.activeSlotId);
  const hydrate = useProfiles((s) => s.hydrate);
  const switchProfile = useProfiles((s) => s.switchProfile);
  const removeProfile = useProfiles((s) => s.removeProfile);

  // Only the ACTIVE profile has keys loaded, so only it can seed its identicon
  // from the public key. Inactive rows carry metadata only and seed by aegisId.
  const activePublicKeyB64 = useIdentity((s) => s.identity?.publicKeyB64);
  const activeAvatarImage = useIdentity((s) => s.avatarImage);

  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  async function handleSwitch(profile: Profile) {
    if (profile.slotId === activeSlotId || switching) return;
    const ok = window.confirm(
      `Switch to "${profile.displayName}"?\n\n` +
        'This closes every open chat and loads that profile’s own database.'
    );
    if (!ok) return;
    setError(null);
    setSwitching(profile.slotId);
    try {
      await switchProfile(profile.slotId);
      onBack();
    } catch (e) {
      // Surfaced, never swallowed: a half-finished switch leaves the app on a
      // profile the user did not pick, and silence there is the worst outcome
      // for a feature whose whole promise is that profiles stay apart.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(null);
    }
  }

  async function handleDelete(profile: Profile) {
    if (switching) return;
    if (profiles.length <= 1) {
      setError('You must keep at least one profile.');
      return;
    }
    if (profile.slotId === 'self') {
      setError(
        'The primary profile cannot be deleted here. Use Delete identity in Profile → Settings.'
      );
      return;
    }
    const ok = window.confirm(
      `Delete "${profile.displayName}"?\n\n` +
        'Every key, message and contact in this profile is erased permanently. ' +
        'This cannot be undone.'
    );
    if (!ok) return;
    setError(null);
    try {
      await removeProfile(profile.slotId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: '100%',
        backgroundColor: t.bg,
      }}
    >
      <TopBar
        t={t}
        title="Profiles"
        left={
          <button
            onClick={onBack}
            aria-label="Go back"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
          >
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
        right={
          <button
            onClick={onCreateProfile}
            aria-label="Create a new profile"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 8 }}
          >
            <I.Plus size={22} color={t.accent} />
          </button>
        }
      />

      {error && (
        <div
          role="alert"
          style={{
            margin: '10px 18px 0',
            padding: '10px 12px',
            borderRadius: t.radiusS,
            backgroundColor: t.surface,
            border: `1px solid ${t.danger}`,
            fontFamily: t.font,
            fontSize: 13,
            color: t.danger,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 8 }}>
        {profiles.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '48px 32px',
              fontFamily: t.font,
              fontSize: 15,
              color: t.textDim,
              textAlign: 'center',
            }}
          >
            No profiles found. Restart the app to initialise them.
          </div>
        ) : (
          profiles.map((p, i) => (
            <ProfileRow
              key={p.slotId}
              t={t}
              profile={p}
              isSwitching={switching === p.slotId}
              disabled={switching !== null && switching !== p.slotId}
              showDivider={i < profiles.length - 1}
              activeSeed={p.isActive ? activePublicKeyB64 : undefined}
              activePhoto={p.isActive ? activeAvatarImage : null}
              onSelect={() => void handleSwitch(p)}
              onDelete={() => void handleDelete(p)}
            />
          ))
        )}

        <button
          onClick={onCreateProfile}
          aria-label="Create a new profile"
          disabled={switching !== null}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            padding: '16px 18px',
            marginTop: 8,
            width: '100%',
            background: 'none',
            border: 'none',
            cursor: switching ? 'default' : 'pointer',
            opacity: switching ? 0.5 : 1,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: t.surface,
              border: `1px solid ${t.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxSizing: 'border-box',
            }}
          >
            <I.Plus size={22} color={t.accent} />
          </div>
          <span style={{ fontFamily: t.font, fontSize: 15, fontWeight: 600, color: t.accent }}>
            New profile
          </span>
        </button>
      </div>

      <div
        style={{
          padding: '12px 18px 16px',
          borderTop: `1px solid ${t.divider}`,
          fontFamily: t.fontMono,
          fontSize: 10,
          color: t.textFaint,
          letterSpacing: 0.8,
          textAlign: 'center',
        }}
      >
        EVERY PROFILE HAS ITS OWN E2EE KEYS AND ITS OWN DATABASE FILE
      </div>
    </div>
  );
}

function ProfileRow({
  t,
  profile,
  isSwitching,
  disabled,
  showDivider,
  activeSeed,
  activePhoto,
  onSelect,
  onDelete,
}: {
  t: Theme;
  profile: Profile;
  isSwitching: boolean;
  disabled: boolean;
  showDivider: boolean;
  activeSeed?: string;
  activePhoto?: string | null;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const seed = activeSeed ?? profile.aegisId;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        borderBottom: showDivider ? `1px solid ${t.divider}` : 'none',
        backgroundColor: hover && !disabled ? t.surface2 : 'transparent',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <button
        onClick={onSelect}
        disabled={disabled || profile.isActive}
        aria-label={`Profile ${profile.displayName}${profile.isActive ? ', active' : ''}`}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          padding: '13px 8px 13px 18px',
          flex: 1,
          minWidth: 0,
          background: 'none',
          border: 'none',
          cursor: disabled || profile.isActive ? 'default' : 'pointer',
          textAlign: 'left',
        }}
      >
        {/* The active profile gets a ring; the avatar shrinks to leave the gap. */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: profile.isActive ? `2px solid ${t.text}` : 'none',
            flexShrink: 0,
            boxSizing: 'border-box',
          }}
        >
          <Avatar
            t={t}
            name={profile.displayName || profile.aegisId}
            color={profile.avatarColor}
            size={profile.isActive ? 42 : 48}
            photoUri={activePhoto}
            seed={seed}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: t.font,
              fontSize: 15,
              fontWeight: 600,
              color: t.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {profile.displayName}
          </div>
          <div
            style={{
              fontFamily: t.fontMono,
              fontSize: 11,
              color: t.textDim,
              letterSpacing: 0.5,
              marginTop: 2,
            }}
          >
            {profile.aegisId}
          </div>
          {profile.isActive && (
            <div
              style={{
                fontFamily: t.fontMono,
                fontSize: 9,
                color: t.accent,
                letterSpacing: 0.8,
                marginTop: 3,
              }}
            >
              ACTIVE
            </div>
          )}
        </div>

        {isSwitching ? (
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8 }}>
            SWITCHING…
          </span>
        ) : profile.isActive ? (
          <I.Check size={18} color={t.accent} />
        ) : (
          <I.Chevron size={14} color={t.textFaint} />
        )}
      </button>

      {/* Mobile hides deletion behind a long-press. A desktop has no long-press,
          so it gets its own button — shown only where deleting is allowed, so
          the control never appears for an action that would be refused. */}
      {profile.slotId !== 'self' && (
        <button
          onClick={onDelete}
          disabled={disabled}
          aria-label={`Delete profile ${profile.displayName}`}
          title="Delete this profile"
          style={{
            background: 'none',
            border: 'none',
            cursor: disabled ? 'default' : 'pointer',
            padding: 12,
            marginRight: 6,
            opacity: hover ? 1 : 0.35,
          }}
        >
          <I.Trash size={16} color={t.danger} />
        </button>
      )}
    </div>
  );
}
