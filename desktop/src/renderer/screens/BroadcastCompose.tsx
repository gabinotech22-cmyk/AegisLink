/**
 * BroadcastComposeScreen — compositor de mensajes 1→N para una lista.
 *
 * Port fiel de mobile/src/screens/BroadcastCompose.tsx.
 * Envía un mensaje E2EE INDEPENDIENTE a cada destinatario en paralelo
 * (Promise.allSettled). Los destinatarios no se conocen entre sí — la lista
 * vive solo en el dispositivo del emisor.
 */

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { decodeBase64 } from 'tweetnacl-util';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { sendMessage } from '../socket/client';
import type { DistributionList } from '../store/distribution';

interface Props {
  list: DistributionList;
  onBack: () => void;
}

type SendState = 'idle' | 'sending' | 'done';

export function BroadcastComposeScreen({ list, onBack }: Props) {
  const { t } = useTheme();
  const { identity } = useIdentity();
  const contacts = useContacts((s) => s.contacts);

  const [text, setText] = useState('');
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sentCount, setSentCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [progressIndex, setProgressIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const total = list.members.length;

  async function handleSend() {
    const body = text.trim();
    if (!body) {
      setErrorMsg('Type a message before sending.');
      return;
    }
    if (!identity) {
      setErrorMsg('Identity not loaded. Please wait.');
      return;
    }
    setErrorMsg(null);

    setSendState('sending');
    setSentCount(0);
    setFailCount(0);
    setProgressIndex(0);

    let localSent = 0;
    let localFailed = 0;

    await Promise.allSettled(
      list.members.map(async (aegisId) => {
        const contact = contacts.find((c) => c.aegisId === aegisId);
        if (!contact) {
          localFailed += 1;
          setFailCount(localFailed);
          setProgressIndex((p) => p + 1);
          return;
        }
        try {
          await sendMessage({
            identity,
            recipientAegisId: aegisId,
            recipientPublicKey: decodeBase64(contact.publicKeyB64),
            plaintext: body,
          });
          localSent += 1;
          setSentCount(localSent);
        } catch {
          localFailed += 1;
          setFailCount(localFailed);
        } finally {
          setProgressIndex((p) => p + 1);
        }
      })
    );

    setSendState('done');
    setSentCount(localSent);
    setFailCount(localFailed);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title={list.name}
        left={
          <button onClick={onBack} aria-label="Go back" style={iconBtn}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Info row */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radius,
            padding: 14,
          }}
        >
          <I.Broadcast size={18} color={t.accent} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text, display: 'block' }}>
              {list.name}
            </span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, marginTop: 2, display: 'block' }}>
              {total} {total === 1 ? 'RECIPIENT' : 'RECIPIENTS'} · INDIVIDUAL MESSAGES
            </span>
          </div>
        </div>

        {/* Privacy note */}
        <div
          style={{
            padding: 12,
            backgroundColor: `${t.accent}0d`,
            border: `1px solid ${t.accent}22`,
            borderRadius: t.radiusS,
          }}
        >
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '18px' }}>
            Each recipient receives a separate encrypted message. Recipients cannot see each other.
          </span>
        </div>

        {/* Message input */}
        <div
          style={{
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radius,
            padding: 14,
            minHeight: 140,
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write your broadcast message…"
            disabled={sendState !== 'idle'}
            aria-label="Broadcast message"
            style={{
              fontFamily: t.font,
              fontSize: 15,
              color: t.text,
              width: '100%',
              minHeight: 112,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'vertical',
              padding: 0,
            }}
          />
        </div>

        {/* Inline error */}
        {errorMsg && (
          <div style={{ padding: '8px 12px', backgroundColor: `${t.danger}22`, borderRadius: t.radiusS }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger }}>{errorMsg}</span>
          </div>
        )}

        {/* Progress */}
        {sendState === 'sending' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              padding: 14,
              backgroundColor: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: t.radius,
            }}
          >
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                border: `2px solid ${t.accent}55`,
                borderTopColor: t.accent,
                animation: 'broadcastSpin 0.8s linear infinite',
              }}
            />
            <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, letterSpacing: 0.5 }}>
              SENDING TO {progressIndex}/{total} MEMBERS…
            </span>
            <style>{`
              @keyframes broadcastSpin {
                from { transform: rotate(0deg); }
                to   { transform: rotate(360deg); }
              }
            `}</style>
          </div>
        )}

        {/* Result */}
        {sendState === 'done' && (
          <div
            style={{
              padding: 14,
              backgroundColor: failCount === 0 ? `${t.accent}12` : `${t.warn}10`,
              border: `1px solid ${failCount === 0 ? `${t.accent}33` : `${t.warn}44`}`,
              borderRadius: t.radius,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <span
              style={{
                fontFamily: t.font,
                fontSize: 15,
                fontWeight: '600',
                color: failCount === 0 ? t.accent : t.warn,
              }}
            >
              {failCount === 0
                ? `Sent to ${sentCount} ${sentCount === 1 ? 'member' : 'members'}`
                : `Sent to ${sentCount}/${total} (${failCount} failed)`}
            </span>
            {failCount > 0 && (
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '18px' }}>
                Failed recipients may be offline. Try again later.
              </span>
            )}
          </div>
        )}

        {/* Send / Done button */}
        {sendState !== 'done' ? (
          <button
            onClick={() => void handleSend()}
            disabled={sendState === 'sending' || !text.trim()}
            aria-label={`Send to ${total} members`}
            style={{
              padding: '14px 0',
              backgroundColor:
                sendState === 'sending' || !text.trim() ? t.surface2 : t.accent,
              border: 'none',
              borderRadius: t.radiusL,
              cursor: sendState === 'sending' || !text.trim() ? 'not-allowed' : 'pointer',
              fontFamily: t.font,
              fontSize: 15,
              fontWeight: '600',
              color: text.trim() && sendState !== 'sending' ? t.accentInk : t.textFaint,
            }}
          >
            {sendState === 'sending'
              ? 'SENDING…'
              : `Send to ${total} ${total === 1 ? 'member' : 'members'}`}
          </button>
        ) : (
          <button
            onClick={onBack}
            aria-label="Done, go back"
            style={{
              padding: '14px 0',
              backgroundColor: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: t.radiusL,
              cursor: 'pointer',
              fontFamily: t.font,
              fontSize: 15,
              fontWeight: '600',
              color: t.text,
            }}
          >
            Done
          </button>
        )}
      </div>
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
