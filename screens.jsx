// AegisLink — all screen components, theme-driven.
// Every screen is a function that takes ({ t, nav, density }) and returns JSX.
// `t` is a VAULT or ATRIUM theme object.

const { I } = window;

// ─── Primitives ──────────────────────────────────────────────────────────
function Avatar({ t, name, color, size = 44 }) {
  const initials = name.split(' ').slice(0,2).map(s=>s[0]).join('').toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: t.radiusL,
      background: color || t.surface2,
      color: t.text, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: t.font, fontWeight: 600, fontSize: size * 0.36,
      flexShrink: 0, letterSpacing: '-0.02em',
    }}>{initials}</div>
  );
}

function SecuredBadge({ t, label = 'E2EE' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: t.fontMono, fontSize: 10, fontWeight: 500,
      color: t.accent, padding: '2px 6px',
      border: `1px solid ${t.accent}`,
      borderRadius: t.radiusS, letterSpacing: '0.04em',
      textTransform: 'uppercase',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: t.accent }}/>
      {label}
    </span>
  );
}

function TopBar({ t, title, left, right, mono, big }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
      borderBottom: big ? 'none' : `1px solid ${t.divider}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: t.text }}>
        {left}
        <span style={{
          fontFamily: mono ? t.fontMono : t.fontDisplay,
          fontWeight: t.displayWeight,
          fontStyle: t.italic && !mono ? 'italic' : 'normal',
          fontSize: big ? 28 : 18, letterSpacing: '-0.02em',
          color: t.text,
        }}>{title}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: t.textDim }}>
        {right}
      </div>
    </div>
  );
}

function Row({ t, children, onClick, noBorder }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 18px', cursor: onClick ? 'pointer' : 'default',
      borderBottom: noBorder ? 'none' : `1px solid ${t.divider}`,
    }}>{children}</div>
  );
}

// ─── 1. Onboarding ────────────────────────────────────────────────────────
function ScreenOnboarding({ t, nav }) {
  const [step, setStep] = React.useState(0);
  const idStr = '7K9-PQ2M-X4VR';
  const fingerprint = ['a7f3', '92e1', 'b4c8', '5d0a', '6f12', 'eb73', '8c9d', '1a45'];

  if (step === 0) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  padding: '64px 28px 32px', background: t.bg, color: t.text }}>
      <div style={{ marginTop: 40, marginBottom: 28 }}>
        <window.AegisMark t={t} size={56}/>
      </div>
      <div style={{
        fontFamily: t.fontDisplay, fontSize: 40, lineHeight: 1.02,
        fontWeight: t.displayWeight,
        fontStyle: t.italic ? 'italic' : 'normal',
        letterSpacing: '-0.03em', marginBottom: 16,
      }}>
        Messaging without a trace.
      </div>
      <div style={{
        fontFamily: t.font, fontSize: 16, lineHeight: 1.45,
        color: t.textDim, marginBottom: 'auto',
      }}>
        No phone number. No email. No metadata.
        Your identity is a key, generated and stored only on this device.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <PrimaryButton t={t} onClick={() => setStep(1)}>Generate my identity</PrimaryButton>
        <GhostButton t={t} onClick={() => nav('backup')}>Restore from backup</GhostButton>
      </div>
      <div style={{
        fontFamily: t.fontMono, fontSize: 10, color: t.textFaint,
        textAlign: 'center', marginTop: 18, letterSpacing: '0.06em',
      }}>v0.9.2 · OPEN SOURCE · AUDITED 2026 Q1</div>
    </div>
  );

  React.useEffect(() => {
    if (step === 1) {
      const timer = setTimeout(() => setStep(2), 3500);
      return () => clearTimeout(timer);
    }
  }, [step]);

  if (step === 1) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  padding: '80px 28px 40px', background: t.bg, color: t.text,
                  alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <KeySpinner t={t}/>
      <div style={{
        fontFamily: t.fontDisplay, fontSize: 24, marginTop: 36,
        fontStyle: t.italic ? 'italic' : 'normal',
        fontWeight: t.displayWeight,
        letterSpacing: '-0.02em',
      }}>Generating your keypair</div>
      <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                    marginTop: 12, letterSpacing: '0.04em' }}>
        Curve25519 · 256-bit · on-device
      </div>
      <div style={{ marginTop: 28, width: '100%' }}>
        <Progress t={t}/>
      </div>
      <button onClick={() => setStep(2)} style={{
        marginTop: 32, background: 'transparent', border: 'none',
        color: t.accent, fontFamily: t.fontMono, fontSize: 11,
        letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
      }}>SKIP ANIMATION ▸</button>
    </div>
  );

  // step 2 — show identity
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  padding: '64px 24px 28px', background: t.bg, color: t.text }}>
      <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent,
                    letterSpacing: '0.1em', marginBottom: 14 }}>YOUR IDENTITY</div>
      <div style={{
        fontFamily: t.fontDisplay, fontSize: 28, fontWeight: t.displayWeight,
        fontStyle: t.italic ? 'italic' : 'normal',
        letterSpacing: '-0.02em', marginBottom: 24,
      }}>
        This is yours.<br/>Nobody else has it.
      </div>

      <div style={{
        border: `1px solid ${t.borderStrong}`, borderRadius: t.radius,
        padding: 20, marginBottom: 16, background: t.surface,
      }}>
        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                      letterSpacing: '0.1em', marginBottom: 8 }}>AEGIS ID</div>
        <div style={{ fontFamily: t.fontMono, fontSize: 22, color: t.text, marginBottom: 14 }}>
          {idStr}
        </div>
        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                      letterSpacing: '0.1em', marginBottom: 8 }}>PUBLIC KEY FINGERPRINT</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
          {fingerprint.map(f => (
            <div key={f} style={{
              fontFamily: t.fontMono, fontSize: 12, color: t.text,
              padding: '6px 4px', background: t.surface2,
              borderRadius: t.radiusS, textAlign: 'center',
            }}>{f}</div>
          ))}
        </div>
      </div>

      <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim,
                    lineHeight: 1.5, marginBottom: 'auto' }}>
        Write this down or back it up encrypted. If you lose it, no one — not even us — can recover it.
      </div>

      <PrimaryButton t={t} onClick={() => nav('emptyHome')}>Enter AegisLink</PrimaryButton>
    </div>
  );
}

function KeySpinner({ t }) {
  return (
    <div style={{
      width: 96, height: 96, borderRadius: '50%',
      border: `2px solid ${t.surface3}`,
      borderTopColor: t.accent,
      animation: 'spin 1.4s linear infinite',
      position: 'relative',
    }}>
      <div style={{
        position: 'absolute', inset: 18, borderRadius: '50%',
        background: t.surface, display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: t.accent,
      }}>
        <I.Key size={26} stroke={1.8}/>
      </div>
    </div>
  );
}

function Progress({ t }) {
  return (
    <div style={{ height: 3, background: t.surface3, borderRadius: 99, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: '62%', background: t.accent,
                    borderRadius: 99, animation: 'pulse 2s ease-in-out infinite' }}/>
    </div>
  );
}

function PrimaryButton({ t, children, onClick, full = true }) {
  return (
    <button onClick={onClick} style={{
      background: t.accent, color: t.accentInk, border: 'none',
      borderRadius: t.radius, padding: '15px 20px',
      fontFamily: t.font, fontSize: 15, fontWeight: 600,
      cursor: 'pointer', width: full ? '100%' : 'auto',
      letterSpacing: t.italic ? '0' : '-0.01em',
    }}>{children}</button>
  );
}
function GhostButton({ t, children, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', color: t.text,
      border: `1px solid ${t.borderStrong}`,
      borderRadius: t.radius, padding: '14px 20px',
      fontFamily: t.font, fontSize: 14, fontWeight: 500,
      cursor: 'pointer', width: '100%',
    }}>{children}</button>
  );
}

// ─── 2. Home / chat list ──────────────────────────────────────────────────
const CHATS = [
  { id: 1, name: 'satoshi.eth',     last: 'Bridge confirmed. Sending the tx hash.',  time: '12:42', unread: 2, verified: true, color: '#8b5cf6' },
  { id: 2, name: 'Pseudonym 4B2',   last: 'I can hop on a call in five.',            time: '11:08', unread: 0, verified: true, color: '#5bf2b9' },
  { id: 3, name: 'DAO · Treasury',  last: 'Alex: multisig is signed by 3/5',         time: '09:30', unread: 5, group: true, color: '#f59e0b' },
  { id: 4, name: 'vitalik.lens',    last: 'You: thanks, will review the spec',       time: 'Tue',   unread: 0, verified: true, color: '#ec4899' },
  { id: 5, name: '0xC3F…91A',       last: 'attachment · keystore.json',              time: 'Tue',   unread: 0, ephemeral: true, color: '#06b6d4' },
  { id: 6, name: 'PrivacyOps',      last: 'Maya: rolling our new relay tomorrow',    time: 'Mon',   unread: 0, group: true, color: '#ef4444' },
  { id: 7, name: 'lex.cryptopunk',  last: 'You: see attached fingerprint',           time: 'Mon',   unread: 0, color: '#a78bfa' },
];

function ScreenHome({ t, nav, density }) {
  const pad = density === 'compact' ? 9 : density === 'comfy' ? 16 : 12;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      {/* Custom top bar — uses AegisWord lockup */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: t.text }}>
          <window.AegisMark t={t} size={26}/>
          <window.AegisWord t={t} size={26}/>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: t.textDim }}>
          <button onClick={() => nav('search')} style={btnIcon(t)}><I.Search size={20}/></button>
          <button onClick={() => nav('settings')} style={btnIcon(t)}><I.Settings size={20}/></button>
        </div>
      </div>

      <div style={{
        margin: '4px 18px 14px', padding: '10px 14px',
        background: t.surface, borderRadius: t.radius,
        border: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'center', gap: 10,
        fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
        letterSpacing: '0.04em',
      }}>
        <I.Lock size={14}/> <span>END-TO-END ENCRYPTED · ZERO METADATA</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {CHATS.map((c, i) => (
          <div key={c.id} onClick={() => nav('chat', c)} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: `${pad}px 18px`, cursor: 'pointer',
            borderBottom: `1px solid ${t.divider}`,
          }}>
            <Avatar t={t} name={c.name} color={c.color}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  fontFamily: c.name.includes('.') || c.name.startsWith('0x') ? t.fontMono : t.font,
                  fontWeight: 600, fontSize: 15, color: t.text,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{c.name}</span>
                {c.verified && <I.Check size={12} style={{ color: t.accent }}/>}
                {c.ephemeral && <I.Timer size={12} style={{ color: t.warn }}/>}
              </div>
              <div style={{
                fontFamily: t.font, fontSize: 13, color: t.textDim,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                marginTop: 2,
              }}>{c.last}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint }}>{c.time}</span>
              {c.unread > 0 && (
                <span style={{
                  background: t.accent, color: t.accentInk,
                  fontFamily: t.fontMono, fontSize: 10, fontWeight: 600,
                  padding: '2px 6px', borderRadius: 99, minWidth: 18, textAlign: 'center',
                }}>{c.unread}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <TabBar t={t} nav={nav} current="home"/>
    </div>
  );
}

function btnIcon(t) {
  return {
    background: 'transparent', border: 'none', color: t.textDim,
    cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
  };
}

function TabBar({ t, nav, current }) {
  const items = [
    { id: 'home',     label: 'Chats',   icon: I.Chat,  to: 'home' },
    { id: 'groups',   label: 'Groups',  icon: I.Users, to: 'groups' },
    { id: 'verify',   label: 'Verify',  icon: I.QR,    to: 'verify' },
    { id: 'settings', label: 'Privacy', icon: I.Shield,to: 'settings' },
  ];
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-around',
      padding: '10px 8px 16px', flexShrink: 0,
      borderTop: `1px solid ${t.divider}`, background: t.surface,
    }}>
      {items.map(it => {
        const active = current === it.id;
        return (
          <button key={it.id} onClick={() => nav(it.to)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            color: active ? t.accent : t.textFaint, padding: 4,
          }}>
            <it.icon size={20} stroke={active ? 2.2 : 1.8}/>
            <span style={{
              fontFamily: t.fontMono, fontSize: 9, letterSpacing: '0.08em',
              fontWeight: active ? 600 : 400,
            }}>{it.label.toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── 3. Chat conversation ────────────────────────────────────────────────
const MESSAGES = [
  { id: 1, me: false, text: 'Bridge confirmed.', time: '12:38' },
  { id: 2, me: false, text: 'Sending the tx hash now — give me a sec.', time: '12:38' },
  { id: 3, me: true,  text: 'standing by 👍', time: '12:39' },
  { id: 4, me: false, text: '0x4f8a…c21d  ·  signed by treasury multisig', time: '12:40', mono: true },
  { id: 5, me: true,  text: 'received. checking on-chain.', time: '12:41' },
  { id: 6, me: false, text: 'Also — moved our keys to the cold quorum. New fingerprint is in the verify tab.', time: '12:42', ephemeral: true },
];

function ScreenChat({ t, nav, density, contact }) {
  const c = contact || CHATS[0];
  const [msgs, setMsgs] = React.useState(MESSAGES);
  const [input, setInput] = React.useState('');
  const [moreOpen, setMoreOpen] = React.useState(false);
  const moreRef = React.useRef(null);
  const scrollRef = React.useRef(null);

  // Close "more" menu on outside click
  React.useEffect(() => {
    if (!moreOpen) return;
    const handler = (e) => { if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false); };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [moreOpen]);

  // Auto-scroll to bottom on new messages
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs.length]);

  const sendMessage = () => {
    const txt = input.trim();
    if (!txt) return;
    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    setMsgs(prev => [...prev, { id: Date.now(), me: true, text: txt, time }]);
    setInput('');
  };

  const moreMenuItems = [
    { label: 'Buscar en chat', icon: <I.Search size={16}/>, action: () => { setMoreOpen(false); nav('search'); } },
    { label: 'Info del contacto', icon: <I.Users size={16}/>, action: () => { setMoreOpen(false); nav(c.group ? 'groupadmin' : 'contact', c); } },
    { label: 'Mensajes efímeros', icon: <I.Timer size={16}/>, action: () => { setMoreOpen(false); nav('ephemeral'); } },
    { label: 'Silenciar', icon: <I.Mute size={16}/>, action: () => setMoreOpen(false) },
    { label: 'Vaciar chat', icon: <I.Trash size={16}/>, danger: true, action: () => { setMsgs([]); setMoreOpen(false); } },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
        borderBottom: `1px solid ${t.divider}`, flexShrink: 0,
      }}>
        <button onClick={() => nav('home')} style={btnIcon(t)}><I.ChevronL size={22}/></button>
        <div onClick={() => nav(c.group ? 'groupadmin' : 'contact', c)} style={{
          display: 'flex', alignItems: 'center', gap: 10, flex: 1, cursor: 'pointer', minWidth: 0,
        }}>
          <Avatar t={t} name={c.name} color={c.color} size={36}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: c.name.includes('.') || c.name.startsWith('0x') ? t.fontMono : t.font,
              fontWeight: 600, fontSize: 15, color: t.text,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{c.name}</div>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                          letterSpacing: '0.06em', marginTop: 1 }}>
              <I.Lock size={9} style={{ verticalAlign: '-1px', marginRight: 3 }}/>
              VERIFIED · KEY a7f3-92e1
            </div>
          </div>
        </div>
        <button onClick={() => nav('call', c)} style={btnIcon(t)}><I.Video size={20}/></button>
        <div ref={moreRef} style={{ position: 'relative' }}>
          <button onClick={() => setMoreOpen(o => !o)} style={btnIcon(t)}><I.More size={20}/></button>
          {moreOpen && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 6,
              background: t.surface, border: `1px solid ${t.borderStrong}`,
              borderRadius: t.radius, boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
              padding: 4, minWidth: 180, zIndex: 20,
            }}>
              {moreMenuItems.map((item, i) => (
                <button key={i} onClick={item.action} style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '9px 12px', border: 'none', background: 'transparent',
                  borderRadius: t.radiusS, cursor: 'pointer',
                  fontFamily: t.font, fontSize: 13, fontWeight: 500,
                  color: item.danger ? t.danger : t.text, textAlign: 'left',
                }}>
                  <span style={{ color: item.danger ? t.danger : t.textDim, display: 'flex' }}>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* system note */}
      <div style={{
        margin: '14px auto 8px', padding: '6px 12px',
        background: t.surface2, borderRadius: 99,
        fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
        letterSpacing: '0.06em',
      }}>
        <I.Lock size={9} style={{ verticalAlign: '-1px', marginRight: 4 }}/>
        END-TO-END ENCRYPTED · TODAY
      </div>

      {/* messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 14px',
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
              letterSpacing: m.mono ? 0 : '-0.005em',
              wordBreak: 'break-word',
            }}>
              {m.text}
              {m.ephemeral && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4, marginTop: 5,
                  fontFamily: t.fontMono, fontSize: 9, opacity: 0.7,
                  letterSpacing: '0.05em',
                }}>
                  <I.Timer size={10}/> BURNS IN 6H 12M
                </div>
              )}
            </div>
            <span style={{ fontFamily: t.fontMono, fontSize: 9.5,
                           color: t.textFaint, padding: '0 4px' }}>{m.time}</span>
          </div>
        ))}
      </div>

      {/* composer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px 14px', borderTop: `1px solid ${t.divider}`,
        background: t.surface, flexShrink: 0,
      }}>
        <button onClick={() => nav('attach')} style={btnIcon(t)}><I.Attach size={22}/></button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(); }}
          placeholder="Encrypted message…"
          style={{
            flex: 1, background: t.surface2, color: t.text,
            padding: '10px 14px', borderRadius: 99, border: 'none', outline: 'none',
            fontFamily: t.font, fontSize: 14,
          }}
        />
        <button onClick={() => nav('ephemeral')} style={btnIcon(t)}><I.Timer size={22}/></button>
        <button onClick={sendMessage} style={{
          background: t.accent, color: t.accentInk, border: 'none',
          borderRadius: '50%', width: 38, height: 38, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><I.Send size={18}/></button>
      </div>
    </div>
  );
}

// ─── 4. Contact verification (QR/fingerprint) ─────────────────────────────
function ScreenVerify({ t, nav }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBar t={t} title="Verify contact"
        left={<button onClick={() => nav('home')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}
        right={<I.More size={20} style={{ color: t.textDim }}/>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 22px 22px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim,
                      textAlign: 'center', lineHeight: 1.5, marginBottom: 22, maxWidth: 280 }}>
          Compare key fingerprints in person, by QR scan, or by reading 8 words.
        </div>

        <QRBlock t={t}/>

        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                      letterSpacing: '0.1em', margin: '24px 0 10px' }}>
          OR — VERIFY THE 8 SAFETY WORDS
        </div>

        <div style={{
          width: '100%', border: `1px solid ${t.borderStrong}`,
          borderRadius: t.radius, padding: 14, background: t.surface,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {['orbit', 'cedar', 'lantern', 'rhubarb', 'parallel', 'gust', 'cobalt', 'thicket'].map((w, i) => (
              <div key={w} style={{
                display: 'flex', alignItems: 'baseline', gap: 8,
                padding: '6px 8px', background: t.surface2,
                borderRadius: t.radiusS,
              }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint,
                               width: 14 }}>{(i+1).toString().padStart(2,'0')}</span>
                <span style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text,
                               fontWeight: 500 }}>{w}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, width: '100%' }}>
          <GhostButton t={t}>Scan QR</GhostButton>
          <PrimaryButton t={t}>Mark verified</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function QRBlock({ t }) {
  // Pseudo QR — fixed pattern of 21×21 squares
  const cells = [];
  const seed = 0x9c3a7;
  for (let i = 0; i < 441; i++) {
    const x = i % 21, y = Math.floor(i / 21);
    // finder corners
    const inFinder = (x<7 && y<7) || (x>13 && y<7) || (x<7 && y>13);
    const finderRing = inFinder && ((x===0||x===6||y===0||y===6) ||
                                    (x===14||x===20||(y===0&&x>13)) ||
                                    (y===14||y===20||(x===0&&y>13))) && inFinder;
    let on = false;
    if (inFinder) {
      const lx = x % 7, ly = y % 7 < 7 ? (y<7?y:y-14) : 0;
      const ax = x<7?x:(x-14), ay = y<7?y:(y-14);
      on = (ax===0||ax===6||ay===0||ay===6) || (ax>=2&&ax<=4&&ay>=2&&ay<=4);
    } else {
      // pseudo random
      on = ((x*73 + y*131 + seed) & 0x3) === 0 || ((x*x + y) & 0x7) === 1;
    }
    if (on) cells.push({ x, y });
  }
  return (
    <div style={{
      width: 220, height: 220, padding: 14,
      background: t === window.VAULT ? '#0a0e0d' : '#fff',
      borderRadius: t.radius, border: `1px solid ${t.borderStrong}`,
      position: 'relative',
    }}>
      <svg viewBox="0 0 21 21" width="192" height="192" style={{ display: 'block' }}>
        {cells.map((c, i) => (
          <rect key={i} x={c.x} y={c.y} width="1" height="1"
                fill={t === window.VAULT ? t.accent : t.text}/>
        ))}
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      }}>
        <div style={{
          width: 42, height: 42, borderRadius: 10,
          background: t.bg, border: `2px solid ${t === window.VAULT ? t.accent : t.text}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: t === window.VAULT ? t.accent : t.text,
        }}>
          <window.AegisMark t={t} size={22} mono/>
        </div>
      </div>
    </div>
  );
}

// ─── 5. Active call ───────────────────────────────────────────────────────
function ScreenCall({ t, nav, contact }) {
  const c = contact || { name: 'satoshi.eth', color: '#8b5cf6' };
  const [muted, setMuted] = React.useState(false);
  const [videoOff, setVideoOff] = React.useState(false);
  const [sec, setSec] = React.useState(258); // 04:18

  React.useEffect(() => {
    const int = setInterval(() => setSec(s => s + 1), 1000);
    return () => clearInterval(int);
  }, []);

  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sc = (s % 60).toString().padStart(2, '0');
    return `${m}:${sc}`;
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: '#000', color: '#fff', position: 'relative', overflow: 'hidden' }}>
      {/* main video — placeholder gradient */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 30% 30%, ${c.color}55, #000 65%),
                     radial-gradient(circle at 70% 75%, ${t.accent}22, transparent 50%)`,
      }}/>
      {/* noise/striping */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `repeating-linear-gradient(0deg,
          rgba(255,255,255,0.02) 0 1px, transparent 1px 4px)`,
      }}/>

      <div style={{ position: 'relative', zIndex: 2, padding: '64px 22px 22px',
                    display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* top */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '4px 10px', background: 'rgba(0,0,0,0.5)',
                          borderRadius: 99, backdropFilter: 'blur(10px)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.accent }}/>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, letterSpacing: '0.08em',
                             color: t.accent }}>E2EE · CURVE25519 · SRTP</span>
            </div>
            <div style={{ fontFamily: t.fontDisplay, fontSize: 26, marginTop: 12,
                          fontStyle: t.italic ? 'italic' : 'normal',
                          fontWeight: t.displayWeight,
                          letterSpacing: '-0.02em' }}>{c.name}</div>
            <div style={{ fontFamily: t.fontMono, fontSize: 13, color: 'rgba(255,255,255,0.7)',
                          marginTop: 4 }}>{formatTime(sec)}</div>
          </div>

          {/* self preview */}
          <div style={{
            width: 90, height: 130, borderRadius: t.radius,
            background: `linear-gradient(135deg, ${t.accent}33, #222)`,
            border: '1px solid rgba(255,255,255,0.15)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
            padding: 6,
          }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 9,
                           color: 'rgba(255,255,255,0.7)' }}>
              {videoOff ? 'CAMERA OFF' : 'YOU'}
            </span>
          </div>
        </div>

        <div style={{ flex: 1 }}/>

        {/* fingerprint card */}
        <div style={{
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(14px)',
          borderRadius: t.radius, padding: '12px 14px', marginBottom: 18,
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.55)',
                           letterSpacing: '0.08em' }}>CALL FINGERPRINT</span>
            <I.Check size={14} style={{ color: t.accent }}/>
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 16, color: '#fff',
                        marginTop: 4, letterSpacing: '0.04em' }}>orbit · cedar · lantern · gust</div>
        </div>

        {/* controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0 4px' }}>
          {[
            { id: 'mute',  i: muted ? I.Mic : I.MicOff, label: muted ? 'Unmute' : 'Mute', bg: muted ? '#fff' : 'rgba(255,255,255,0.1)', fg: muted ? '#000' : '#fff' },
            { id: 'video', i: I.Video,  label: videoOff ? 'Start Vid' : 'Stop Vid', bg: videoOff ? 'rgba(255,255,255,0.1)' : '#fff', fg: videoOff ? '#fff' : '#000' },
            { id: 'flip',  i: I.Flip,   label: 'Flip', bg: 'rgba(255,255,255,0.1)', fg: '#fff' },
            { id: 'more',  i: I.More,   label: 'More', bg: 'rgba(255,255,255,0.1)', fg: '#fff' },
          ].map(b => (
            <div key={b.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <button onClick={() => {
                if (b.id === 'mute') setMuted(!muted);
                if (b.id === 'video') setVideoOff(!videoOff);
              }} style={{
                width: 54, height: 54, borderRadius: '50%',
                background: b.bg, border: '1px solid rgba(255,255,255,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: b.fg, backdropFilter: 'blur(8px)', cursor: 'pointer',
              }}><b.i size={22}/></button>
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.5)',
                             letterSpacing: '0.06em' }}>{b.label.toUpperCase()}</span>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <button onClick={() => nav('chat', c)} style={{
              width: 64, height: 64, borderRadius: '50%',
              background: '#e63946', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', transform: 'rotate(135deg)',
            }}><I.Phone size={26}/></button>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.5)',
                           letterSpacing: '0.06em' }}>END</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 6. Groups ────────────────────────────────────────────────────────────
const GROUPS = [
  { id: 1, name: 'DAO · Treasury',  members: 5,  desc: 'Multisig signers · 3-of-5', color: '#f59e0b' },
  { id: 2, name: 'PrivacyOps',      members: 11, desc: 'Relay infra & monitoring',   color: '#ef4444' },
  { id: 3, name: 'Audit Q2',        members: 4,  desc: 'External review · Cure53',   color: '#8b5cf6' },
  { id: 4, name: 'Family',          members: 6,  desc: 'Personal',                   color: '#06b6d4' },
  { id: 5, name: 'Cipher Reading',  members: 23, desc: 'Cryptography study group',   color: '#5bf2b9' },
];

function ScreenGroups({ t, nav }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBar t={t} title="Groups" big
        right={<button onClick={() => nav('emptyGroups')} style={btnIcon(t)}><I.Plus size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {GROUPS.map(g => (
          <div key={g.id} onClick={() => nav('chat', { ...g, group: true })} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 18px', cursor: 'pointer',
            borderBottom: `1px solid ${t.divider}`,
          }}>
            <div style={{
              width: 46, height: 46, borderRadius: t.radiusL,
              background: g.color + '22', color: g.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}><I.Users size={22}/></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 15, color: t.text }}>
                {g.name}
              </div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                {g.desc}
              </div>
            </div>
            <div style={{
              fontFamily: t.fontMono, fontSize: 11, color: t.textFaint,
              padding: '3px 7px', background: t.surface2, borderRadius: 99,
            }}>{g.members}</div>
          </div>
        ))}
      </div>

      <TabBar t={t} nav={nav} current="groups"/>
    </div>
  );
}

// ─── 7. Privacy settings ─────────────────────────────────────────────────
function ScreenSettings({ t, nav, flipped, setFlipped }) {
  const [readReceipts, setRR] = React.useState(false);
  const [typing, setTyping] = React.useState(false);
  const [screenshot, setSS] = React.useState(true);
  const [tor, setTor] = React.useState(true);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBar t={t} title="Privacy" big
        left={<button onClick={() => nav('home')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 24px' }}>
        {/* identity card */}
        <div onClick={() => nav('profile')} style={{
          margin: '4px 18px 22px', padding: 18,
          border: `1px solid ${t.borderStrong}`, borderRadius: t.radius,
          background: t.surface, cursor: 'pointer',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Avatar t={t} name="You" color={t.accent} size={52}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.fontDisplay, fontSize: 17,
                            fontStyle: t.italic ? 'italic' : 'normal',
                            fontWeight: t.displayWeight }}>You</div>
              <div style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent,
                            letterSpacing: '0.04em', marginTop: 2 }}>7K9-PQ2M-X4VR</div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </div>
        </div>

        <Section t={t} label="APPEARANCE">
          <ModePicker t={t} value={t.dark ? 'dark' : 'light'}
                      onChange={(v) => {
                        const targetIsDark = v === 'dark';
                        if (targetIsDark !== t.dark && setFlipped) setFlipped(f => !f);
                      }}/>
        </Section>

        <Section t={t} label="DATA SHARING">
          <Toggle t={t} label="Read receipts" sub="Confirm when you've read a message" value={readReceipts} onChange={setRR}/>
          <Toggle t={t} label="Typing indicator" sub="Let others see when you're typing" value={typing} onChange={setTyping}/>
          <Toggle t={t} label="Block screenshots" sub="App contents hidden in screen recording" value={screenshot} onChange={setSS}/>
        </Section>

        <Section t={t} label="NETWORK">
          <Toggle t={t} label="Route via Tor" sub="Hide your IP from AegisLink relays" value={tor} onChange={setTor}/>
          <Row t={t} onClick={() => nav('backup')}>
            <I.Cloud size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Encrypted backup</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Last sync · 14 min ago
              </div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </Row>
          <Row t={t} onClick={() => nav('ephemeral')} noBorder>
            <I.Timer size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Disappearing messages</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Default: off
              </div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </Row>
        </Section>

        <Section t={t} label="ALERTAS & DATOS">
          <Row t={t} onClick={() => nav('notifs')}>
            <I.Bell size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Notifications</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Master · keywords · summary
              </div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </Row>
          <Row t={t} onClick={() => nav('export')}>
            <I.Trash size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Tus datos</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Export · GDPR · eliminar cuenta
              </div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </Row>
          <Row t={t} onClick={() => nav('lockConfig')} noBorder>
            <I.Lock size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Pantalla de bloqueo</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Face ID · PIN · biometría
              </div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </Row>
        </Section>

        <Section t={t} label="ABOUT">
          <Row t={t}>
            <I.Shield size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Security audit</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Cure53 · 2026 Q1 · passed
              </div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </Row>
          <Row t={t} noBorder>
            <I.Globe size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Jurisdiction</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Zurich, Switzerland
              </div>
            </div>
          </Row>
        </Section>
      </div>

      <TabBar t={t} nav={nav} current="settings"/>
    </div>
  );
}

function Section({ t, label, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
        letterSpacing: '0.1em', padding: '0 22px 6px',
      }}>{label}</div>
      <div style={{
        margin: '0 18px', background: t.surface, borderRadius: t.radius,
        border: `1px solid ${t.border}`, overflow: 'hidden',
      }}>{children}</div>
    </div>
  );
}

function ModePicker({ t, value, onChange }) {
  const opts = [
    { id: 'light', label: 'Claro', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4"/>
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
      </svg>
    )},
    { id: 'dark', label: 'Oscuro', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>
      </svg>
    )},
  ];
  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{
        display: 'flex', gap: 6, padding: 4,
        background: t.surface2, borderRadius: t.radius,
      }}>
        {opts.map(o => {
          const active = o.id === value;
          return (
            <button key={o.id} onClick={() => onChange(o.id)} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '10px 12px', border: 'none', cursor: 'pointer',
              borderRadius: Math.max(t.radius - 4, 4),
              background: active ? t.surface : 'transparent',
              color: active ? t.text : t.textDim,
              fontFamily: t.font, fontSize: 13,
              fontWeight: active ? 600 : 500,
              boxShadow: active ? '0 1px 3px rgba(0,0,0,0.10)' : 'none',
              transition: 'background 0.15s, color 0.15s, box-shadow 0.15s',
            }}>
              {o.icon}<span>{o.label}</span>
            </button>
          );
        })}
      </div>
      <div style={{
        fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 8, lineHeight: 1.4,
      }}>
        Cambia los colores manteniendo la identidad <b style={{ color: t.text, fontWeight: 600 }}>{t.name}</b>. Tipos, formas y acentos se preservan.
      </div>
    </div>
  );
}

function Toggle({ t, label, sub, value, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', borderBottom: `1px solid ${t.divider}`,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{label}</div>
        {sub && <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{sub}</div>}
      </div>
      <button onClick={() => onChange(!value)} style={{
        width: 44, height: 26, borderRadius: 99,
        background: value ? t.accent : t.surface3, border: 'none', cursor: 'pointer',
        position: 'relative', flexShrink: 0, transition: 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: 3, left: value ? 21 : 3,
          width: 20, height: 20, borderRadius: '50%',
          background: value ? t.accentInk : '#fff',
          transition: 'left 0.15s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}/>
      </button>
    </div>
  );
}

// ─── 8. Ephemeral / disappearing messages ────────────────────────────────
function ScreenEphemeral({ t, nav }) {
  const [pick, setPick] = React.useState('1d');
  const opts = [
    { id: 'off', label: 'Off',       sub: 'Messages stay forever' },
    { id: '30s', label: '30 seconds', sub: 'For verifying small data' },
    { id: '5m',  label: '5 minutes',  sub: 'Quick context' },
    { id: '1h',  label: '1 hour',     sub: 'Work in progress' },
    { id: '1d',  label: '24 hours',   sub: 'Recommended default' },
    { id: '7d',  label: '7 days',     sub: 'Standard rotation' },
    { id: '30d', label: '30 days',    sub: 'Compliance window' },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBar t={t} title="Disappearing"
        left={<button onClick={() => nav('chat')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 22px' }}>
        <div style={{
          padding: 22, textAlign: 'center', marginBottom: 14,
        }}>
          <div style={{
            margin: '0 auto 16px', width: 72, height: 72, borderRadius: '50%',
            background: t.surface, border: `1px solid ${t.borderStrong}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: t.accent,
          }}><I.Timer size={32} stroke={1.6}/></div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 22,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight,
            letterSpacing: '-0.02em',
          }}>Messages burn themselves</div>
          <div style={{
            fontFamily: t.font, fontSize: 13, color: t.textDim,
            marginTop: 8, lineHeight: 1.5, maxWidth: 280, margin: '8px auto 0',
          }}>
            New messages in this chat will delete from every device after the timer.
          </div>
        </div>

        <div style={{
          background: t.surface, borderRadius: t.radius,
          border: `1px solid ${t.border}`, overflow: 'hidden',
        }}>
          {opts.map((o, i) => (
            <div key={o.id} onClick={() => setPick(o.id)} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 16px', cursor: 'pointer',
              borderBottom: i < opts.length - 1 ? `1px solid ${t.divider}` : 'none',
              background: pick === o.id ? (t.dark ? 'rgba(91,242,185,0.06)' : 'rgba(43,47,122,0.04)') : 'transparent',
            }}>
              <div style={{
                width: 20, height: 20, borderRadius: '50%',
                border: `2px solid ${pick === o.id ? t.accent : t.borderStrong}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {pick === o.id && <div style={{
                  width: 10, height: 10, borderRadius: '50%', background: t.accent,
                }}/>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: t.font, fontSize: 14, fontWeight: pick === o.id ? 600 : 400 }}>
                  {o.label}
                </div>
                <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                  {o.sub}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: '16px 0 0' }}>
          <PrimaryButton t={t} onClick={() => nav('chat')}>
            {pick === 'off' ? 'Desactivar mensajes efímeros' : `Aplicar · ${opts.find(o => o.id === pick)?.label}`}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─── 9. Backup ───────────────────────────────────────────────────────────
function ScreenBackup({ t, nav }) {
  const [revealed, setRevealed] = React.useState(false);
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBar t={t} title="Encrypted backup"
        left={<button onClick={() => nav('settings')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 22px' }}>
        <div style={{
          padding: 22, border: `1px solid ${t.borderStrong}`,
          borderRadius: t.radius, background: t.surface, marginBottom: 16,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 16,
          }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                           letterSpacing: '0.1em' }}>● ACTIVE</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim }}>14 MIN AGO</span>
          </div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 32,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight,
            letterSpacing: '-0.02em',
          }}>2,419 messages</div>
          <div style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim, marginTop: 2 }}>
            142 MB · client-side encrypted
          </div>

          <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Stat t={t} label="CONVERSATIONS" val="47"/>
            <Stat t={t} label="MEDIA FILES" val="312"/>
            <Stat t={t} label="GROUPS" val="9"/>
            <Stat t={t} label="DEVICES" val="3"/>
          </div>
        </div>

        <div style={{
          padding: 16, background: t.surface, borderRadius: t.radius,
          border: `1px solid ${t.border}`, marginBottom: 14,
        }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                        letterSpacing: '0.1em', marginBottom: 8 }}>RECOVERY PHRASE</div>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text,
                           letterSpacing: '0.04em' }}>
              {revealed ? 'bridge tower quantum ...' : '●● ●● ●● ●● ●● ●● ●● ●●'}
            </span>
            <button onClick={() => setRevealed(!revealed)} style={{
              background: 'transparent', border: `1px solid ${t.borderStrong}`,
              borderRadius: t.radiusS, padding: '4px 10px',
              fontFamily: t.fontMono, fontSize: 10, color: t.text, cursor: 'pointer',
              letterSpacing: '0.06em',
            }}>{revealed ? 'HIDE' : 'REVEAL'}</button>
          </div>
        </div>

        <PrimaryButton t={t} onClick={() => nav('home')}>Back up now</PrimaryButton>
        <div style={{ height: 10 }}/>
        <GhostButton t={t} onClick={() => nav('home')}>Restore from phrase</GhostButton>
      </div>
    </div>
  );
}

function Stat({ t, label, val }) {
  return (
    <div style={{
      padding: 12, background: t.surface2, borderRadius: t.radiusS,
    }}>
      <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim,
                    letterSpacing: '0.1em' }}>{label}</div>
      <div style={{ fontFamily: t.fontDisplay, fontSize: 22, color: t.text, marginTop: 2,
                    fontStyle: t.italic ? 'italic' : 'normal',
                    fontWeight: t.displayWeight }}>{val}</div>
    </div>
  );
}

// ─── inject animations once ────────────────────────────────────────────
if (!document.getElementById('aegis-anim')) {
  const s = document.createElement('style');
  s.id = 'aegis-anim';
  s.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%,100% { width: 30%; } 50% { width: 80%; } }
  `;
  document.head.appendChild(s);
}

Object.assign(window, {
  ScreenOnboarding, ScreenHome, ScreenChat, ScreenVerify, ScreenCall,
  ScreenGroups, ScreenSettings, ScreenEphemeral, ScreenBackup,
  TabBar, Avatar, SecuredBadge, PrimaryButton, GhostButton,
});
