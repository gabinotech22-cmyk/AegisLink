import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import type { StoredContact } from '../db/local';

interface Props {
  contact: StoredContact;
  onOpenChat: () => void;
  onAddAnother: () => void;
}

export function FirstContactScreen({ contact, onOpenChat, onAddAnother }: Props) {
  const { t } = useTheme();

  const initials = contact.name.trim()[0]?.toUpperCase() ?? '?';
  const keyPart1 = contact.publicKeyB64.slice(0, 4);
  const keyPart2 = contact.publicKeyB64.slice(4, 8);

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        backgroundColor: t.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 28px 32px',
        boxSizing: 'border-box',
      }}
    >
      {/* Success ring */}
      <div style={{ width: 130, height: 130, position: 'relative', marginBottom: 32, flexShrink: 0 }}>
        <svg viewBox="0 0 130 130" width={130} height={130} style={{ position: 'absolute', inset: 0 }}>
          <circle cx={65} cy={65} r={60} fill={`${t.accent}1A`} />
          <circle cx={65} cy={65} r={48} fill={t.accent} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <I.Check size={56} color={t.accentInk} />
        </div>
      </div>

      <span
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 30,
          fontWeight: '700',
          letterSpacing: -0.5,
          color: t.text,
          textAlign: 'center',
          marginBottom: 20,
          maxWidth: 280,
          display: 'block',
        }}
      >
        First contact verified
      </span>

      {/* Contact card */}
      <div
        style={{
          width: '100%',
          maxWidth: 320,
          backgroundColor: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          padding: 14,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          marginBottom: 20,
          boxSizing: 'border-box',
        }}
      >
        {contact.avatarImage ? (
          <img
            src={contact.avatarImage}
            alt={contact.name}
            style={{ width: 42, height: 42, borderRadius: 21, objectFit: 'cover', flexShrink: 0 }}
          />
        ) : (
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 21,
              backgroundColor: (contact.color ?? t.accent) + '33',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ fontFamily: t.fontMono, fontSize: 16, fontWeight: '700', color: contact.color ?? t.accent }}>
              {initials}
            </span>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>
            {contact.name}
          </span>
          <span
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.accent,
              letterSpacing: 0.6,
              marginTop: 2,
              display: 'block',
            }}
          >
            {`◆ KEY ${keyPart1}-${keyPart2} · VERIFIED`}
          </span>
        </div>
      </div>

      <span
        style={{
          fontFamily: t.font,
          fontSize: 14,
          color: t.textDim,
          lineHeight: '21px',
          textAlign: 'center',
          maxWidth: 320,
          marginBottom: 'auto',
          display: 'block',
        }}
      >
        Their key fingerprints match. What is sent in this chat will only be decrypted by the owner of that key — neither AegisLink nor anyone else.
      </span>

      <div style={{ width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
        <button
          onClick={onOpenChat}
          aria-label="Open chat"
          style={{
            width: '100%',
            padding: '14px 0',
            backgroundColor: t.accent,
            border: 'none',
            borderRadius: t.radius,
            cursor: 'pointer',
            fontFamily: t.font,
            fontWeight: '700',
            fontSize: 14,
            color: t.accentInk,
          }}
        >
          Open chat
        </button>
        <button
          onClick={onAddAnother}
          aria-label="Add another contact"
          style={{
            width: '100%',
            padding: '13px 0',
            backgroundColor: 'transparent',
            border: `1px solid ${t.borderStrong}`,
            borderRadius: t.radius,
            cursor: 'pointer',
            fontFamily: t.font,
            fontWeight: '500',
            fontSize: 14,
            color: t.text,
          }}
        >
          Add another contact
        </button>
      </div>
    </div>
  );
}
