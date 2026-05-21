// AegisLink — extra connection / failure states
// ScreenChatOffline: chat with offline banner + failed message + queued message
// ScreenError: full-screen "cannot reach relays"

const { I: III } = window;

const ibtn = (t) => ({
  background: 'transparent', border: 'none', color: t.textDim,
  cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
});

// ─── Chat with offline state + failed + queued messages ─────────────────
function ScreenChatOffline({ t, nav, contact }) {
  const c = contact || { id: 1, name: 'satoshi.eth', color: '#8b5cf6', verified: true };
  const [msgs, setMsgs] = React.useState([
    { id: 1, me: false, text: 'Bridge confirmed.', time: '12:38', state: 'ok' },
    { id: 2, me: false, text: 'Sending the tx hash now — give me a sec.', time: '12:38', state: 'ok' },
    { id: 3, me: true,  text: 'standing by 👍', time: '12:39', state: 'ok' },
    { id: 4, me: true,  text: 'audit-final.pdf · 142 KB', time: '12:42', state: 'failed', mono: true },
    { id: 5, me: true,  text: 'try resending in a bit, my connection is patchy', time: '12:43', state: 'queued' },
    { id: 6, me: true,  text: 'standing by once we reconnect', time: '12:44', state: 'sending' },
  ]);
  const [input, setInput] = React.useState('');

  const retryMessage = (id) => {
    setMsgs(prev => prev.map(m => m.id === id ? { ...m, state: 'sending' } : m));
  };

  const sendMessage = () => {
    const txt = input.trim();
    if (!txt) return;
    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    setMsgs(prev => [...prev, { id: Date.now(), me: true, text: txt, time, state: 'queued' }]);
    setInput('');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
        borderBottom: `1px solid ${t.divider}`, flexShrink: 0,
      }}>
        <button onClick={() => nav('home')} style={ibtn(t)}><III.ChevronL size={22}/></button>
        <window.Avatar t={t} name={c.name} color={c.color} size={36}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: c.name.includes('.') || c.name.startsWith('0x') ? t.fontMono : t.font,
            fontWeight: 600, fontSize: 15, color: t.text,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{c.name}</div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            fontFamily: t.fontMono, fontSize: 10, color: t.warn,
            letterSpacing: '0.06em', marginTop: 1,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.warn }}/>
            DESCONECTADO · INTENTANDO RECONECTAR
          </div>
        </div>
        <button onClick={() => nav('call', c)} style={{...ibtn(t), opacity: 0.4, cursor: 'not-allowed'}}><III.Video size={20}/></button>
      </div>

      {/* offline banner */}
      <div style={{
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10,
        background: t.dark ? 'rgba(240,198,116,0.10)' : 'rgba(168,127,31,0.08)',
        borderBottom: `1px solid ${t.warn}33`,
        fontFamily: t.font, fontSize: 12, color: t.text, flexShrink: 0,
      }}>
        <div style={{
          width: 18, height: 18, borderRadius: '50%',
          background: t.warn, color: t.dark ? '#000' : '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: t.fontMono, fontWeight: 700, fontSize: 11, flexShrink: 0,
        }}>!</div>
        <div style={{ flex: 1, lineHeight: 1.35 }}>
          <b style={{ fontWeight: 600 }}>Sin conexión a los relays.</b>{' '}
          <span style={{ color: t.textDim }}>Los mensajes nuevos se cifran y se
          envían al reconectar. Nada queda en claro.</span>
        </div>
      </div>

      {/* system note */}
      <div style={{
        margin: '14px auto 4px', padding: '6px 12px',
        background: t.surface2, borderRadius: 99,
        fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
        letterSpacing: '0.06em',
      }}>
        <III.Lock size={9} style={{ verticalAlign: '-1px', marginRight: 4 }}/>
        END-TO-END ENCRYPTED · TODAY
      </div>

      {/* messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px',
                    display: 'flex', flexDirection: 'column', gap: 8 }}>
        {msgs.map(m => (
          <div key={m.id} style={{
            alignSelf: m.me ? 'flex-end' : 'flex-start',
            maxWidth: '78%', display: 'flex', flexDirection: 'column',
            alignItems: m.me ? 'flex-end' : 'flex-start', gap: 2,
          }}>
            <div style={{
              background: m.me ? t.bubbleOut : t.bubbleIn,
              color: m.me ? t.bubbleOutText : t.bubbleInText,
              padding: '10px 13px', borderRadius: t.radius,
              borderTopRightRadius: m.me ? t.radiusS : t.radius,
              borderTopLeftRadius: m.me ? t.radius : t.radiusS,
              fontFamily: m.mono ? t.fontMono : t.font,
              fontSize: m.mono ? 12 : 14, lineHeight: 1.35,
              opacity: m.state === 'queued' || m.state === 'sending' ? 0.55 : 1,
              border: m.state === 'failed' ? `1px solid ${t.danger}` : 'none',
              wordBreak: 'break-word',
              position: 'relative',
            }}>
              {m.mono && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 4,
                    background: m.me ? `${t.bubbleOutText}22` : t.surface3,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}><III.Attach size={12}/></span>
                  <span>{m.text}</span>
                </div>
              )}
              {!m.mono && m.text}
            </div>

            {/* state line */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px',
              fontFamily: t.fontMono, fontSize: 9.5, letterSpacing: '0.04em',
            }}>
              {m.state === 'failed' && (
                <>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    color: t.danger,
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%',
                                   background: t.danger }}/>
                    NO ENVIADO
                  </span>
                  <button onClick={() => retryMessage(m.id)} style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: t.accent, fontFamily: t.fontMono, fontSize: 9.5,
                    letterSpacing: '0.06em', padding: 0,
                    textDecoration: 'underline',
                  }}>TOCAR PARA REINTENTAR</button>
                </>
              )}
              {m.state === 'queued' && (
                <span style={{ color: t.warn, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <III.Timer size={10}/> EN COLA · SE ENVÍA AL VOLVER
                </span>
              )}
              {m.state === 'sending' && (
                <span style={{ color: t.textDim, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    width: 8, height: 8, border: `1.5px solid ${t.textDim}`,
                    borderTopColor: 'transparent', borderRadius: '50%',
                    animation: 'spin 0.9s linear infinite',
                  }}/>
                  ENVIANDO…
                </span>
              )}
              {m.state === 'ok' && (
                <span style={{ color: t.textFaint }}>{m.time}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* composer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px 14px', borderTop: `1px solid ${t.divider}`,
        background: t.surface, flexShrink: 0,
      }}>
        <button onClick={() => nav('attach')} style={ibtn(t)}><III.Attach size={22}/></button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(); }}
          placeholder="Mensaje (se enviará al reconectar)…"
          style={{
            flex: 1, background: t.surface2, color: t.text,
            padding: '10px 14px', borderRadius: 99, border: 'none', outline: 'none',
            fontFamily: t.font, fontSize: 14,
          }}
        />
        <button onClick={sendMessage} style={{
          background: t.surface3, color: t.textDim, border: 'none',
          borderRadius: '50%', width: 38, height: 38, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><III.Send size={18}/></button>
      </div>
    </div>
  );
}

// ─── Network/relay error full-screen ───────────────────────────────────
function ScreenNetworkError({ t, nav }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      background: t.bg, color: t.text, overflow: 'hidden',
      padding: '60px 28px 32px', alignItems: 'center', textAlign: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: t.warn,
                    fontFamily: t.fontMono, fontSize: 10, letterSpacing: '0.1em',
                    marginBottom: 'auto', paddingTop: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.warn,
                       animation: 'aegis-pulse 1.4s ease-in-out infinite' }}/>
        SIN ACCESO A RELAYS
      </div>

      <div style={{
        position: 'relative', width: 140, height: 140, marginBottom: 30,
      }}>
        {/* broken-link visual */}
        <svg viewBox="0 0 140 140" width="140" height="140">
          {/* outer ring */}
          <circle cx="70" cy="70" r="60" fill="none"
                  stroke={t.borderStrong} strokeWidth="1.5"
                  strokeDasharray="4 6" opacity="0.5"/>
          {/* hex with break */}
          <path d="M70 18 L114 42 L114 92 L70 116 L26 92 L26 42 Z"
                fill="none" stroke={t.warn} strokeWidth="2.5" strokeLinejoin="round"/>
          {/* slash across */}
          <line x1="36" y1="36" x2="104" y2="104"
                stroke={t.danger} strokeWidth="3" strokeLinecap="round"/>
        </svg>
      </div>

      <div style={{
        fontFamily: t.fontDisplay, fontSize: 26,
        fontStyle: t.italic ? 'italic' : 'normal',
        fontWeight: t.displayWeight, letterSpacing: '-0.02em',
        marginBottom: 12, maxWidth: 280,
      }}>No podemos llegar a ningún relay</div>
      <div style={{
        fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: 1.55,
        maxWidth: 320, marginBottom: 20,
      }}>
        Sin red. Tus mensajes nuevos se cifran y se quedan en cola hasta
        recuperar conexión. Las claves nunca abandonan este dispositivo.
      </div>

      {/* status grid */}
      <div style={{
        width: '100%', padding: 14, background: t.surface,
        border: `1px solid ${t.border}`, borderRadius: t.radius,
        marginBottom: 22,
      }}>
        <RelayStat t={t} label="zurich-1.aegis"  state="down"   detail="timeout · 12s"/>
        <RelayStat t={t} label="zurich-2.aegis"  state="down"   detail="timeout · 9s"/>
        <RelayStat t={t} label="zurich-3.aegis"  state="probing" detail="re-handshake…"/>
        <RelayStat t={t} label="berlin-1.aegis"  state="down"   detail="timeout · 14s" last/>
      </div>

      <window.PrimaryButton t={t} onClick={() => nav('home')}>Reintentar ahora</window.PrimaryButton>
      <div style={{ height: 10 }}/>
      <button onClick={() => nav('settings')} style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: t.textDim, fontFamily: t.fontMono, fontSize: 11,
        letterSpacing: '0.06em', padding: '8px 12px',
      }}>USAR RELAY DE EMERGENCIA · ENLACE TOR ▸</button>
    </div>
  );
}

function RelayStat({ t, label, state, detail, last }) {
  const c = state === 'down' ? t.danger : state === 'probing' ? t.warn : t.accent;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 0', borderBottom: last ? 'none' : `1px solid ${t.divider}`,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c,
                     animation: state === 'probing' ? 'aegis-pulse 1.4s ease-in-out infinite' : 'none' }}/>
      <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text, flex: 1, textAlign: 'left' }}>
        {label}
      </span>
      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: c,
                     letterSpacing: '0.04em', textAlign: 'right' }}>
        {state.toUpperCase()} · {detail}
      </span>
    </div>
  );
}

Object.assign(window, { ScreenChatOffline, ScreenNetworkError });
