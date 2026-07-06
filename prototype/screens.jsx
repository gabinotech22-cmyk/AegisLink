// AegisLink — all screen components, theme-driven.
// Every screen is a function that takes ({ t, nav, density }) and returns JSX.
// `t` is a VAULT or ATRIUM theme object.

const { I } = window;

// ─── Primitives ──────────────────────────────────────────────────────────
// Mirrors mobile/src/components/Identicon.tsx: FNV-1a hash + LCG PRNG,
// 5x5 grid with columns 0-2 mirrored to 3-4. Same seed → same drawing.
function identiconHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function Identicon({ seed, size = 44, color }) {
  const h = identiconHash(seed);
  let st = h >>> 0;
  const rnd = () => { st = (Math.imul(st, 1103515245) + 12345) >>> 0; return st / 4294967296; };
  const cells = [];
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 5; r++) {
      if (rnd() > 0.5) {
        cells.push([c, r]);
        if (4 - c !== c) cells.push([4 - c, r]);
      }
    }
  }
  const fill = color || `hsl(${h % 360}, 60%, 58%)`;
  const cell = size / 5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {cells.map(([c, r], i) => (
        <rect key={i} x={c * cell} y={r * cell} width={cell} height={cell} fill={fill}/>
      ))}
    </svg>
  );
}

// Mirrors mobile/src/components/Avatar.tsx: no photo → deterministic identicon
// on a surface2 circle (in the app the seed is the contact's pubkey; the name
// stands in here). A tint equal to surface2 would vanish — fall back to the
// seed-derived hue, same guard as the app.
function Avatar({ t, name, color, size = 44, seed }) {
  const tint = color && color !== t.surface2 ? color : undefined;
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: t.surface2, overflow: 'hidden', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Identicon seed={seed || name} size={size} color={tint}/>
    </div>
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
// Mirrors mobile/src/screens/Onboarding.tsx (personal flow, es strings):
// welcome → generating → show identity → optional nickname. No org, no
// enrolment, no invitation code — identity is generated on device.
function ScreenOnboarding({ t, nav }) {
  const [step, setStep] = React.useState(0);
  const [nickname, setNickname] = React.useState('');
  const [selectedColor, setSelectedColor] = React.useState('#5bf2b9');
  const fingerprint = ['a7f3', '92e1', 'b4c8', '5d0a', '6f12', 'eb73', '8c9d', '1a45'];
  const aegisId = 'AEGIS-K4T2-9XR7';
  const defaultName = 'aegisk4t29xr7';
  const swatches = ['#5bf2b9', '#3ba3f0', '#8b7cf6', '#f06fb0', '#f0a93b', '#f0664b'];

  // App enforces a 2s minimum on the generating animation — mirror it.
  React.useEffect(() => {
    if (step === 1) {
      const id = setTimeout(() => setStep(2), 2400);
      return () => clearTimeout(id);
    }
  }, [step]);

  // Step 0: Welcome
  if (step === 0) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  padding: '64px 28px 32px', background: t.bg, color: t.text }}>
      <div style={{ marginTop: 40, marginBottom: 28, display: 'flex', alignItems: 'center', gap: 12 }}>
        <window.AegisMark t={t} size={56}/>
        <window.AegisWord t={t} size={30}/>
      </div>
      <div style={{
        fontFamily: t.fontDisplay, fontSize: 36, lineHeight: 1.05,
        fontWeight: t.displayWeight,
        fontStyle: t.italic ? 'italic' : 'normal',
        letterSpacing: '-0.03em', marginBottom: 16,
      }}>
        Mensajería sin rastros.
      </div>
      <div style={{
        fontFamily: t.font, fontSize: 15, lineHeight: 1.45,
        color: t.textDim, marginBottom: 'auto',
      }}>
        Sin número de teléfono. Sin correo. Sin metadatos. Tu identidad es una
        clave, generada y guardada únicamente en este dispositivo.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <PrimaryButton t={t} onClick={() => setStep(1)}>Generar mi identidad</PrimaryButton>
        <GhostButton t={t}>Restaurar desde copia de seguridad</GhostButton>
      </div>
      <div style={{
        fontFamily: t.fontMono, fontSize: 10, color: t.textFaint,
        textAlign: 'center', marginTop: 18, letterSpacing: '0.06em',
      }}>V0.1.0 · CÓDIGO ABIERTO</div>
    </div>
  );

  // Step 1: Generating keypair on device
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
      }}>Generando tu par de claves</div>
      <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                    marginTop: 12, letterSpacing: '0.04em' }}>
        CURVE25519 · 256-BIT · EN DISPOSITIVO
      </div>
      <div style={{ marginTop: 28, width: '100%' }}>
        <Progress t={t}/>
      </div>
      <button onClick={() => setStep(2)} style={{
        marginTop: 32, background: 'transparent', border: 'none',
        color: t.accent, fontFamily: t.fontMono, fontSize: 11,
        letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
      }}>SALTAR ANIMACIÓN ▸</button>
    </div>
  );

  // Step 2: Show identity (AegisID + public key fingerprint)
  if (step === 2) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  padding: '64px 24px 28px', background: t.bg, color: t.text }}>
      <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent,
                    letterSpacing: '0.1em', marginBottom: 14 }}>TU IDENTIDAD</div>
      <div style={{
        fontFamily: t.fontDisplay, fontSize: 28, fontWeight: t.displayWeight,
        fontStyle: t.italic ? 'italic' : 'normal',
        letterSpacing: '-0.02em', marginBottom: 24, lineHeight: 1.15,
      }}>
        Esta es tuya.<br/>Nadie más la tiene.
      </div>

      <div style={{
        border: `1px solid ${t.borderStrong}`, borderRadius: t.radius,
        padding: 20, marginBottom: 16, background: t.surface,
      }}>
        <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.06em' }}>AEGIS ID</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 22, color: t.text, marginTop: 2 }}>{aegisId}</div>
          <I.Copy size={16} style={{ color: t.textDim }}/>
        </div>
        <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: '0.06em', marginBottom: 8 }}>HUELLA DIGITAL DE CLAVE PÚBLICA</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {fingerprint.map((f, i) => (
            <div key={i} style={{
              width: '23.5%', background: t.surface2, borderRadius: t.radiusS,
              padding: '6px 0', textAlign: 'center',
              fontFamily: t.fontMono, fontSize: 12, color: t.text,
            }}>{f}</div>
          ))}
        </div>
      </div>

      <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim,
                    lineHeight: 1.5, marginBottom: 'auto' }}>
        Apúntalo o haz una copia de seguridad cifrada. Si lo pierdes, nadie —
        ni nosotros — podrá recuperarlo.
      </div>

      <PrimaryButton t={t} onClick={() => setStep(3)}>Continuar</PrimaryButton>
    </div>
  );

  // Step 3: Optional nickname + identicon tint
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  padding: '64px 24px 28px', background: t.bg, color: t.text }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <window.AegisMark t={t} size={28}/>
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: '0.1em' }}>CASI LISTO</span>
      </div>

      <div style={{
        fontFamily: t.fontDisplay, fontSize: 28, fontWeight: t.displayWeight,
        fontStyle: t.italic ? 'italic' : 'normal',
        letterSpacing: '-0.02em', marginBottom: 10,
      }}>¿Cómo te llamamos?</div>
      <div style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: 1.45, marginBottom: 24 }}>
        Tu avatar se genera de tu clave. Puedes teñirlo, o subir una foto luego
        en tu perfil. Todo es opcional; sigues siendo anónimo.
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <Avatar t={t} name={aegisId} seed={aegisId} color={selectedColor} size={64}/>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 24 }}>
        {swatches.map(c => (
          <button key={c} onClick={() => setSelectedColor(c)} style={{
            width: 30, height: 30, borderRadius: '50%', background: c,
            border: c === selectedColor ? `2px solid ${t.accent}` : 'none',
            cursor: 'pointer', padding: 0,
          }}/>
        ))}
      </div>

      <label style={{ display: 'block', fontSize: 10, fontFamily: t.fontMono, color: t.textDim, marginBottom: 6, letterSpacing: '0.04em' }}>NOMBRE VISIBLE (OPCIONAL)</label>
      <input
        type="text"
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        placeholder={defaultName}
        maxLength={20}
        style={{
          width: '100%', padding: 12, background: t.surface, color: t.text,
          border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
          fontFamily: t.font, fontSize: 15, outline: 'none', marginBottom: 8,
        }}
      />
      <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint,
                    letterSpacing: '0.04em', marginBottom: 'auto' }}>
        Por defecto: {defaultName}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <PrimaryButton t={t} onClick={() => nav('home')}>Continuar</PrimaryButton>
        <GhostButton t={t} onClick={() => nav('home')}>Omitir por ahora</GhostButton>
      </div>
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
  { id: 101, name: 'vesper',          last: 'Las fotos del viaje ya están, todas cifradas 📷', time: '12:42', unread: 1, verified: true, color: '#8b5cf6' },
  { id: 102, name: 'milo',            last: '¿Te va una llamada esta tarde?',                   time: '11:08', unread: 0, verified: true, color: '#5bf2b9' },
  { id: 103, name: 'ada',             last: 'Te compartí mi ubicación temporal · expira en 1 h', time: '09:30', unread: 0, verified: true, color: '#f59e0b' },
  { id: 104, name: 'Club de lectura', last: 'Encuesta anónima: ¿próximo libro del mes?',        time: 'mar',   unread: 2, group: true, color: '#ec4899' },
];

function ScreenHome({ t, nav, density, isWorkMode }) {
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
          <window.AegisWord t={t} size={18}/>
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
        <I.Shield size={14} color={t.accent}/> <span style={{ color: t.accent, fontWeight: 600 }}>CIFRADO EXTREMO A EXTREMO · CERO METADATOS</span>
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

// Mirrors mobile/src/components/TabBar.tsx: 3 tabs (Verify left the shipping
// nav — it's reached from the chat, not a tab), es labels from i18n
// (tabBar.chats/groups/privacy), unread badges on Chats/Comunidades.
function TabBar({ t, nav, current, badges = { home: 1, groups: 2 } }) {
  const items = [
    { id: 'home',     label: 'Chats',       icon: I.Chat,   to: 'home' },
    { id: 'groups',   label: 'Comunidades', icon: I.Users,  to: 'groups' },
    { id: 'settings', label: 'Privacidad',  icon: I.Shield, to: 'settings' },
  ];
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-around',
      padding: '10px 8px 16px', flexShrink: 0,
      borderTop: `1px solid ${t.divider}`, background: t.surface,
    }}>
      {items.map(it => {
        const active = current === it.id;
        const badge = badges[it.id] || 0;
        return (
          <button key={it.id} onClick={() => nav(it.to)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            color: active ? t.accent : t.textFaint, padding: '4px 8px',
          }}>
            <span style={{ position: 'relative', display: 'flex' }}>
              <it.icon size={20} stroke={active ? 2.2 : 1.8}/>
              {badge > 0 && (
                <span style={{
                  position: 'absolute', top: -5, right: -10,
                  minWidth: 16, height: 16, borderRadius: 8,
                  padding: '0 4px', boxSizing: 'border-box',
                  background: t.accent, color: t.accentInk,
                  border: `1.5px solid ${t.surface}`,
                  fontFamily: t.fontMono, fontSize: 9, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{badge > 99 ? '99+' : badge}</span>
              )}
            </span>
            <span style={{
              fontFamily: t.fontMono, fontSize: 9, letterSpacing: '0.8px',
              fontWeight: active ? 600 : 400,
            }}>{it.label.toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── 3. Chat conversation ────────────────────────────────────────────────
const CHAT_MESSAGES = [
  { id: 1, me: false, text: 'Ya subí las fotos del viaje al chat. Van cifradas de extremo a extremo, como todo aquí 😄', time: '12:38' },
  { id: 2, me: true,  text: 'Se ven geniales. ¿Verificamos claves cuando nos veamos? Así el candado queda en verde.', time: '12:39' },
  { id: 3, me: false, text: 'Hecho. Escaneamos el QR el sábado y listo.', time: '12:40' },
  { id: 4, me: true,  text: 'Te mando la dirección por aquí, con ubicación temporal que expira en una hora.', time: '12:41' },
  { id: 5, me: false, text: 'Perfecto. Este mensaje se quema en 24 h, por cierto 🔥', time: '12:42', ephemeral: true },
];

function ScreenChat({ t, nav, density, contact, isWorkMode }) {
  const c = contact || CHATS[0];
  const [msgs, setMsgs] = React.useState(CHAT_MESSAGES);
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

      {/* policy banner */}
      <div style={{
        padding: '8px 14px', background: `${t.danger}15`,
        borderBottom: `1px solid ${t.danger}33`,
        fontFamily: t.fontMono, fontSize: 10, color: t.danger,
        textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      }}>
        <I.Shield size={12} stroke={2}/>
        <span>🔒 DIRECTIVA ACTIVA: CAPTURAS BLOQUEADAS · BORRADO EN 30 DÍAS</span>
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
  { id: 'g1', name: 'Club de lectura', members: 8,  last: 'ada: Encuesta anónima: ¿próximo libro?',  time: '12:10', unread: 2, color: '#ec4899' },
  { id: 'g2', name: 'Familia',         members: 6,  last: 'milo: Foto del domingo 📷',               time: '10:44', unread: 0, color: '#06b6d4' },
  { id: 'g3', name: 'Senderismo',      members: 12, last: 'vesper: Ruta del sábado, ubicación temporal', time: 'lun', unread: 0, color: '#f59e0b' },
  { id: 'g4', name: 'Cipher Reading',  members: 23, last: 'kes: Capítulo 4 de Serious Cryptography',  time: 'dom',  unread: 0, color: '#5bf2b9' },
];

const CHANNELS = [
  { id: 'c1', name: 'Aegis Notes',   last: 'Build 0.9.3 firmada y verificada',        time: '11:02', owned: true,  color: '#5bf2b9' },
  { id: 'c2', name: 'Privacy Daily', last: 'Análisis del leak de metadatos de ayer',  time: '09:15', owned: false, color: '#a78bfa' },
  { id: 'c3', name: 'OpSec Field',   last: 'Guía: rotación de claves en dispositivos', time: 'lun',  owned: false, color: '#f59e0b' },
];

// Mirrors mobile/src/screens/Groups.tsx: one "Comunidades" tab holding a
// Grupos | Canales segment pager (channels are sealed public broadcasts).
function ScreenGroups({ t, nav }) {
  const [seg, setSeg] = React.useState('groups');
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBar t={t} title={seg === 'channels' ? 'Canales' : 'Grupos'} big
        right={<button onClick={() => nav('emptyGroups')} style={btnIcon(t)}><I.Plus size={22} color={t.accent}/></button>}/>

      {/* Grupos | Canales segment — same pill control as the app */}
      <div style={{
        display: 'flex', gap: 4, margin: '2px 14px 8px', padding: 3,
        background: t.surface, border: `1px solid ${t.border}`,
        borderRadius: t.radius, flexShrink: 0,
      }}>
        {[['groups', 'Grupos'], ['channels', 'Canales']].map(([id, label]) => {
          const on = seg === id;
          return (
            <button key={id} onClick={() => setSeg(id)} style={{
              flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer',
              borderRadius: t.radiusS, background: on ? t.accent : 'transparent',
              fontFamily: t.font, fontSize: 12, fontWeight: 600,
              color: on ? t.accentInk : t.textDim,
            }}>{label}</button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {seg === 'groups' ? GROUPS.map(g => (
          <div key={g.id} onClick={() => nav('chat', { ...g, group: true })} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 18px', cursor: 'pointer',
            borderBottom: `1px solid ${t.divider}`,
          }}>
            <Avatar t={t} name={g.name} seed={g.id} color={g.color} size={44}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: t.font, fontWeight: 600, fontSize: 15, color: t.text,
                               whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {g.name}
                </span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{g.time}</span>
              </div>
              <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 4,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {g.last}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <I.Lock size={10} color={t.accent}/>
                <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: '0.05em' }}>
                  E2EE · {g.members} MIEMBROS
                </span>
              </div>
            </div>
            {g.unread > 0 && (
              <span style={{
                minWidth: 20, height: 20, borderRadius: 10, padding: '0 4px',
                background: t.accent, color: t.accentInk, boxSizing: 'border-box',
                fontFamily: t.fontMono, fontSize: 11, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{g.unread}</span>
            )}
          </div>
        )) : CHANNELS.map(c => (
          <div key={c.id} style={{
            display: 'flex', alignItems: 'center', gap: 11,
            padding: '11px 15px', cursor: 'pointer',
            borderBottom: `1px solid ${t.divider}`,
          }}>
            <Avatar t={t} name={c.name} seed={c.id} color={c.color} size={42}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14, color: t.text,
                               whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.name}
                </span>
                {c.owned && <I.Key size={12} style={{ color: t.accent }}/>}
              </div>
              <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 2,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.last}
              </div>
            </div>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint }}>{c.time}</span>
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

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBar t={t} title="Privacidad" big
        left={<button onClick={() => nav('home')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 24px' }}>
        {/* identity card */}
        <div onClick={() => nav('profile')} style={{
          margin: '4px 18px 22px', padding: 18,
          border: `1px solid ${t.borderStrong}`, borderRadius: t.radius,
          background: t.surface, cursor: 'pointer',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Avatar t={t} name="AEGIS-K4T2-9XR7" seed="AEGIS-K4T2-9XR7" color={t.accent} size={52}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.fontDisplay, fontSize: 17,
                            fontStyle: t.italic ? 'italic' : 'normal',
                            fontWeight: t.displayWeight }}>aegisk4t29xr7</div>
              <div style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent,
                            letterSpacing: '0.04em', marginTop: 2 }}>AEGIS-K4T2-9XR7</div>
              <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2 }}>Identidad local · solo en este dispositivo</div>
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
          
          {/* Forced Policy Switch: Block Screenshots */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px', borderBottom: `1px solid ${t.divider}`,
            opacity: 0.85
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>Block screenshots</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                App contents hidden in screen recording
              </div>
              <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, marginTop: 4, fontWeight: 500 }}>
                Siempre activo · FLAG_SECURE
              </div>
            </div>
            <button disabled style={{
              width: 44, height: 26, borderRadius: 99,
              background: t.accent, border: 'none', cursor: 'not-allowed',
              position: 'relative', flexShrink: 0, opacity: 0.6
            }}>
              <span style={{
                position: 'absolute', top: 3, left: 21,
                width: 20, height: 20, borderRadius: '50%',
                background: t.accentInk,
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }}/>
            </button>
          </div>
        </Section>

        <Section t={t} label="NETWORK">
          {/* Forced Policy Switch: Route via Swiss Relay */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px', borderBottom: `1px solid ${t.divider}`,
            opacity: 0.85
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>Ruta vía Tor</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                El buzón se consulta a través de Tor embebido
              </div>
              <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, marginTop: 4, fontWeight: 500 }}>
                Sealed sender · el relay no ve el emisor
              </div>
            </div>
            <button disabled style={{
              width: 44, height: 26, borderRadius: 99,
              background: t.accent, border: 'none', cursor: 'not-allowed',
              position: 'relative', flexShrink: 0, opacity: 0.6
            }}>
              <span style={{
                position: 'absolute', top: 3, left: 21,
                width: 20, height: 20, borderRadius: '50%',
                background: t.accentInk,
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }}/>
            </button>
          </div>

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
          
          {/* Forced Policy Value: Disappearing messages */}
          <Row t={t} noBorder>
            <I.Timer size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Disappearing messages</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.accent, marginTop: 2 }}>
                30 días (Fijo por directiva corporativa)
              </div>
            </div>
            <span style={{ fontSize: 10, fontFamily: t.fontMono, color: t.textFaint }}>BLOQUEADO</span>
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
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Auditoría de seguridad</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Pendiente · auditoría independiente en curso
              </div>
            </div>
            <I.Chevron size={16} style={{ color: t.textFaint }}/>
          </Row>
          <Row t={t} noBorder>
            <I.Globe size={20} style={{ color: t.textDim }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontSize: 14 }}>Código abierto</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                Toda la criptografía es verificable · repositorio público
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
