// AegisLink — Phase 2 screens
// Lock, IncomingCall, Search, AttachSheet, Location, ViewOnce,
// GroupAdmin (roles), Notifications, DataExport
//
// All theme-driven via `t`. Each screen takes ({ t, nav, density, contact, flipped, setFlipped }).

const { I: II } = window;

const btnIconP = (t) => ({
  background: 'transparent', border: 'none', color: t.textDim,
  cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
});

function BarP({ t, title, left, right, big }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
      borderBottom: big ? 'none' : `1px solid ${t.divider}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: t.text }}>
        {left}
        <span style={{
          fontFamily: t.fontDisplay,
          fontWeight: t.displayWeight,
          fontStyle: t.italic ? 'italic' : 'normal',
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

function SectP({ t, label, children, hint }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: '0 22px 6px',
      }}>
        <span style={{
          fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
          letterSpacing: '0.1em',
        }}>{label}</span>
        {hint && <span style={{
          fontFamily: t.fontMono, fontSize: 10, color: t.textFaint,
          letterSpacing: '0.06em',
        }}>{hint}</span>}
      </div>
      <div style={{
        margin: '0 18px', background: t.surface, borderRadius: t.radius,
        border: `1px solid ${t.border}`, overflow: 'hidden',
      }}>{children}</div>
    </div>
  );
}

function ToggleP({ t, label, sub, value, onChange, noBorder }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '11px 16px',
      borderBottom: noBorder ? 'none' : `1px solid ${t.divider}`,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{label}</div>
        {sub && <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{sub}</div>}
      </div>
      <button onClick={() => onChange(!value)} style={{
        width: 42, height: 24, borderRadius: 99,
        background: value ? t.accent : t.surface3, border: 'none', cursor: 'pointer',
        position: 'relative', flexShrink: 0,
      }}>
        <span style={{
          position: 'absolute', top: 3, left: value ? 21 : 3,
          width: 18, height: 18, borderRadius: '50%',
          background: value ? t.accentInk : '#fff',
          transition: 'left 0.15s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}/>
      </button>
    </div>
  );
}

function RowP({ t, icon, label, sub, onClick, trailing, danger, accent, noBorder }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', cursor: onClick ? 'pointer' : 'default',
      borderBottom: noBorder ? 'none' : `1px solid ${t.divider}`,
    }}>
      {icon && <span style={{ color: danger ? t.danger : accent ? t.accent : t.textDim,
                              display: 'flex' }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: t.font, fontSize: 14,
                      color: danger ? t.danger : t.text }}>{label}</div>
        {sub && <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{sub}</div>}
      </div>
      {trailing || (onClick && <II.Chevron size={14} style={{ color: t.textFaint }}/>)}
    </div>
  );
}

function ScreenLockSettings({ t, nav }) {
  const [appLock, setAppLock] = React.useState(true);
  const [hideScreen, setHideScreen] = React.useState(true);
  
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Pantalla de bloqueo" big
        left={<button onClick={() => nav('settings')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 24px' }}>
        <div style={{ padding: '0 28px 22px', textAlign: 'center' }}>
          <div style={{
            margin: '0 auto 16px', width: 76, height: 76, borderRadius: '50%',
            background: t.surface, border: `1px solid ${t.borderStrong}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: t.accent,
          }}><II.Lock size={32} stroke={1.8}/></div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 24,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight,
            letterSpacing: '-0.02em',
          }}>Seguridad local</div>
          <div style={{
            fontFamily: t.font, fontSize: 13, color: t.textDim,
            marginTop: 10, lineHeight: 1.5, maxWidth: 290, margin: '10px auto 0',
          }}>
            Protege el acceso a tus chats mediante los métodos biométricos de tu dispositivo o un PIN personalizado.
          </div>
        </div>

        <SectP t={t} label="BLOQUEO DE APLICACIÓN">
          <ToggleP t={t} label="Bloquear AegisLink" sub="Requiere Face ID o PIN para abrir" value={appLock} onChange={setAppLock}/>
          <RowP t={t} label="Tiempo de bloqueo" sub="Inmediatamente" onClick={() => {}}/>
          <RowP t={t} label="Cambiar PIN" onClick={() => {}} noBorder/>
        </SectP>

        <SectP t={t} label="PRIVACIDAD EN SISTEMA">
          <ToggleP t={t} label="Ocultar en multitarea" sub="Muestra una pantalla negra en el selector de apps" value={hideScreen} onChange={setHideScreen} noBorder/>
        </SectP>
        
        <SectP t={t} label="PRUEBA (DEV)">
          <RowP t={t} label="Probar pantalla de bloqueo" icon={<II.Lock size={18}/>} onClick={() => nav('lock')} noBorder/>
        </SectP>
      </div>
    </div>
  );
}

// ─── 16. App Lock (Unlock screen) ────────────────────────────────────────
function ScreenLock({ t, nav }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      background: t.bg, color: t.text, overflow: 'hidden',
      alignItems: 'center', justifyContent: 'space-between',
      padding: '60px 28px 32px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: t.textDim,
                    fontFamily: t.fontMono, fontSize: 10, letterSpacing: '0.1em' }}>
        <II.Lock size={12}/> <span>BLOQUEADO · AEGISLINK</span>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 28,
      }}>
        {/* Big FaceID circle */}
        <div style={{
          position: 'relative', width: 130, height: 130,
        }}>
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            border: `2px solid ${t.accent}`, opacity: 0.25,
            animation: 'aegis-pulse 1.8s ease-in-out infinite',
          }}/>
          <div style={{
            position: 'absolute', inset: 12, borderRadius: '50%',
            border: `2px solid ${t.accent}`, opacity: 0.5,
            animation: 'aegis-pulse 1.8s ease-in-out infinite',
            animationDelay: '0.3s',
          }}/>
          <div style={{
            position: 'absolute', inset: 28, borderRadius: '50%',
            background: t.surface, border: `1px solid ${t.borderStrong}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: t.accent,
          }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="1.6"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 012-2h2M21 7V5a2 2 0 00-2-2h-2M3 17v2a2 2 0 002 2h2M21 17v2a2 2 0 01-2 2h-2"/>
              <circle cx="9" cy="11" r=".8" fill="currentColor"/>
              <circle cx="15" cy="11" r=".8" fill="currentColor"/>
              <path d="M9 16c.8.6 1.9 1 3 1s2.2-.4 3-1M12 10v4"/>
            </svg>
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 22,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight, letterSpacing: '-0.01em',
          }}>Mira el dispositivo</div>
          <div style={{
            fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
            letterSpacing: '0.06em', marginTop: 6,
          }}>FACE ID · CLAVE EN LOCAL · NUNCA SALE</div>
        </div>

        <button onClick={() => nav('home')} style={{
          background: 'transparent', border: `1px solid ${t.borderStrong}`,
          borderRadius: t.radius, padding: '10px 22px',
          fontFamily: t.font, fontSize: 13, color: t.text, cursor: 'pointer',
        }}>Usar PIN en su lugar</button>
      </div>

      <button onClick={() => nav('panic')} style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: t.danger, fontFamily: t.fontMono, fontSize: 11,
        letterSpacing: '0.08em',
      }}>EMERGENCIA · BORRADO RÁPIDO ▸</button>
    </div>
  );
}

// ─── 17. Incoming call ──────────────────────────────────────────────────
function ScreenIncoming({ t, nav, contact }) {
  const c = contact || { name: 'satoshi.eth', color: '#8b5cf6' };
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.dark ? '#000' : '#0a0a0a',
                  color: '#fff', position: 'relative', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 50% 30%, ${c.color}44, transparent 55%),
                     radial-gradient(circle at 50% 90%, ${t.accent}22, transparent 50%)`,
      }}/>

      <div style={{
        position: 'relative', zIndex: 2, flex: 1,
        display: 'flex', flexDirection: 'column',
        padding: '70px 28px 36px',
        alignItems: 'center',
      }}>
        {/* incoming badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 14px', background: 'rgba(0,0,0,0.4)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 99,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', background: t.accent,
            animation: 'aegis-pulse 1.5s ease-in-out infinite',
          }}/>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                         letterSpacing: '0.1em' }}>LLAMADA E2EE · CIFRADA</span>
        </div>

        <div style={{ marginTop: 28, marginBottom: 16 }}>
          <div style={{
            width: 132, height: 132, borderRadius: '50%',
            background: c.color, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: t.font, fontWeight: 600, fontSize: 48,
            letterSpacing: '-0.02em',
            boxShadow: `0 0 0 0 ${c.color}66`,
            animation: 'aegis-ring 2s ease-out infinite',
          }}>
            {c.name[0].toUpperCase()}
          </div>
        </div>

        <div style={{
          fontFamily: c.name.includes('.') || c.name.startsWith('0x') ? t.fontMono : t.fontDisplay,
          fontSize: 28, color: '#fff', textAlign: 'center',
          fontStyle: t.italic && !c.name.includes('.') ? 'italic' : 'normal',
          fontWeight: t.displayWeight, letterSpacing: '-0.02em',
        }}>{c.name}</div>
        <div style={{
          fontFamily: t.fontMono, fontSize: 12, color: 'rgba(255,255,255,0.6)',
          letterSpacing: '0.06em', marginTop: 6,
        }}>VIDEO · CURVE25519 · SRTP</div>

        <div style={{
          marginTop: 18, padding: '8px 14px',
          background: 'rgba(255,255,255,0.06)', borderRadius: t.radius,
          fontFamily: t.fontMono, fontSize: 11, color: 'rgba(255,255,255,0.7)',
          letterSpacing: '0.04em',
        }}>
          <II.Check size={11} style={{ verticalAlign: '-1px', marginRight: 6, color: t.accent }}/>
          Identidad verificada · 8 días
        </div>

        <div style={{ flex: 1 }}/>

        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          width: '100%', maxWidth: 320,
        }}>
          {/* Reject */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <button onClick={() => nav('home')} style={{
              width: 70, height: 70, borderRadius: '50%',
              background: '#e63946', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', transform: 'rotate(135deg)',
              boxShadow: '0 8px 24px rgba(230,57,70,0.4)',
            }}><II.Phone size={28}/></button>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.6)',
                           letterSpacing: '0.06em' }}>RECHAZAR</span>
          </div>

          {/* Message reply */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <button onClick={() => nav('chat', c)} style={{
              width: 50, height: 50, borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', backdropFilter: 'blur(8px)',
            }}><II.Chat size={20}/></button>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.4)',
                           letterSpacing: '0.06em' }}>RESPONDER</span>
          </div>

          {/* Accept */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <button onClick={() => nav('call', c)} style={{
              width: 70, height: 70, borderRadius: '50%',
              background: t.accent, border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: t.accentInk,
              boxShadow: `0 8px 24px ${t.accent}55`,
            }}><II.Phone size={28}/></button>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.6)',
                           letterSpacing: '0.06em' }}>ACEPTAR</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 18. Global search ──────────────────────────────────────────────────
function ScreenSearch({ t, nav }) {
  const [q, setQ] = React.useState('multisig');
  const [filter, setFilter] = React.useState('all');

  const recents = ['audit Q3', '0xC3F…91A', 'keystore.json'];

  const db = [
    { type: 'message', from: 'satoshi.eth', text: 'Bridge confirmed. Sending the tx hash with multisig sigs', time: '12:42' },
    { type: 'message', from: 'DAO · Treasury', text: 'multisig is signed by 3/5 — Alex pushed last', time: '09:30' },
    { type: 'file',    name: 'multisig-config.json', size: '14 KB', from: 'satoshi.eth', time: 'Lun' },
    { type: 'person',  name: '0xC3F…91A', sub: 'Treasury multisig signer · verified' },
    { type: 'group',   name: 'DAO · Treasury', sub: '5 members · MLS encrypted' },
  ];

  const results = db.filter(r => {
    // 1. Filter by category
    if (filter === 'messages' && r.type !== 'message') return false;
    if (filter === 'files' && r.type !== 'file') return false;
    if (filter === 'people' && r.type !== 'person') return false;
    if (filter === 'groups' && r.type !== 'group') return false;

    // 2. Filter by search text
    const searchString = [r.name, r.text, r.from].join(' ').toLowerCase();
    if (q && !searchString.includes(q.toLowerCase())) return false;
    
    return true;
  });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 18px 12px', flexShrink: 0,
      }}>
        <button onClick={() => nav('home')} style={btnIconP(t)}><II.ChevronL size={22}/></button>
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', background: t.surface2,
          borderRadius: 99,
        }}>
          <II.Search size={16} style={{ color: t.textDim }}/>
          <input value={q} onChange={(e) => setQ(e.target.value)} style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent',
            color: t.text, fontFamily: t.font, fontSize: 14,
          }}/>
        </div>
      </div>

      {/* Filter chips */}
      <div style={{
        display: 'flex', gap: 6, padding: '6px 14px 14px',
        overflowX: 'auto', flexShrink: 0,
      }}>
        {['Todo', 'Mensajes', 'Archivos', 'Personas', 'Grupos'].map((f, i) => {
          const key = ['all','messages','files','people','groups'][i];
          const active = filter === key;
          return (
            <button key={f} onClick={() => setFilter(key)} style={{
              padding: '6px 12px', borderRadius: 99, cursor: 'pointer',
              background: active ? t.accent : t.surface2,
              border: 'none',
              color: active ? t.accentInk : t.textDim,
              fontFamily: t.fontMono, fontSize: 10,
              letterSpacing: '0.06em', whiteSpace: 'nowrap',
              fontWeight: active ? 600 : 500,
            }}>{f.toUpperCase()}</button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Recents */}
        <div style={{ padding: '0 22px 10px' }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                        letterSpacing: '0.1em', marginBottom: 6 }}>RECIENTES</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {recents.map(r => (
              <button key={r} onClick={() => setQ(r)} style={{
                padding: '5px 10px', background: t.surface,
                border: `1px solid ${t.border}`, borderRadius: t.radiusS,
                fontFamily: t.fontMono, fontSize: 11, color: t.text, cursor: 'pointer',
              }}>{r}</button>
            ))}
          </div>
        </div>

        {/* Results */}
        <div style={{
          fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
          letterSpacing: '0.1em', padding: '12px 22px 8px',
        }}>{results.length} RESULTADOS</div>

        {results.map((r, i) => (
          <SearchResult key={i} t={t} r={r}/>
        ))}
      </div>
    </div>
  );
}

function SearchResult({ t, r }) {
  if (r.type === 'message')
    return (
      <div style={{
        display: 'flex', gap: 12, padding: '12px 18px',
        borderBottom: `1px solid ${t.divider}`,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: t.radius,
          background: t.surface2, color: t.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}><II.Chat size={16}/></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', gap: 8,
            fontFamily: t.font, fontSize: 13, fontWeight: 600, color: t.text,
            marginBottom: 2,
          }}>
            <span>{r.from}</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{r.time}</span>
          </div>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 1.4 }}>
            {r.text}
          </div>
        </div>
      </div>
    );
  if (r.type === 'file')
    return (
      <div style={{
        display: 'flex', gap: 12, padding: '12px 18px',
        borderBottom: `1px solid ${t.divider}`,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: t.radius,
          background: t.surface2, color: t.warn,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}><II.Attach size={16}/></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 13, fontWeight: 500, color: t.text }}>
            {r.name}
          </div>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
            {r.size} · de {r.from} · {r.time}
          </div>
        </div>
      </div>
    );
  if (r.type === 'person')
    return (
      <div style={{
        display: 'flex', gap: 12, padding: '12px 18px', alignItems: 'center',
        borderBottom: `1px solid ${t.divider}`,
      }}>
        <window.Avatar t={t} name={r.name} color={t.accent} size={32}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 13, fontWeight: 600, color: t.text }}>
            {r.name}
          </div>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
            {r.sub}
          </div>
        </div>
      </div>
    );
  // group
  return (
    <div style={{
      display: 'flex', gap: 12, padding: '12px 18px', alignItems: 'center',
      borderBottom: `1px solid ${t.divider}`,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: t.radiusL,
        background: '#f59e0b22', color: '#f59e0b',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><II.Users size={16}/></div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: t.font, fontSize: 13, fontWeight: 600, color: t.text }}>
          {r.name}
        </div>
        <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
          {r.sub}
        </div>
      </div>
    </div>
  );
}

// ─── 19. Attachment sheet (composer +) ──────────────────────────────────
function ScreenAttachSheet({ t, nav }) {
  const [active, setActive] = React.useState(null);

  const opts = [
    { id: 'photo',  icon: <II.Eye size={22}/>,    label: 'Foto',          sub: 'Galería' },
    { id: 'camera', icon: <II.Video size={22}/>,  label: 'Cámara',        sub: 'EXIF eliminado' },
    { id: 'file',   icon: <II.Attach size={22}/>, label: 'Archivo',       sub: 'Cualquier tipo' },
    { id: 'voice',  icon: <II.Mic size={22}/>,    label: 'Audio',         sub: 'Efímero', accent: true },
    { id: 'once',   icon: <II.EyeOff size={22}/>, label: 'Ver una vez',   sub: 'No guardable', accent: true, goTo: 'viewoncesend' },
    { id: 'sched',  icon: <II.Timer size={22}/>,  label: 'Programado',    sub: 'Envío diferido', goTo: 'scheduled' },
    { id: 'loc',    icon: <II.Globe size={22}/>,  label: 'Ubicación',     sub: 'Temporal', goTo: 'location' },
    { id: 'contact',icon: <II.Users size={22}/>,  label: 'Contacto',      sub: 'Compartir ID' },
  ];

  const handleClick = (o) => {
    if (o.goTo) { nav(o.goTo); return; }
    setActive(o.id);
  };

  // — Inline: Photo gallery picker —
  if (active === 'photo') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Seleccionar foto"
        left={<button onClick={() => setActive(null)} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
          {['#8b5cf6','#06b6d4','#ec4899','#f59e0b','#5bf2b9','#a78bfa','#ef4444','#3b82f6','#10b981'].map((c,i) => (
            <div key={i} style={{ aspectRatio: '1', borderRadius: t.radiusS,
              background: `linear-gradient(135deg, ${c}44, ${c}aa)`, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><II.Eye size={20} style={{ color: '#fff', opacity: 0.5 }}/></div>
          ))}
        </div>
        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, textAlign: 'center',
                      letterSpacing: '0.06em', marginTop: 12 }}>EXIF Y METADATOS SE ELIMINAN ANTES DE ENVIAR</div>
      </div>
      <div style={{ padding: '12px 18px 20px' }}>
        <window.PrimaryButton t={t} onClick={() => nav('chat')}>Enviar foto</window.PrimaryButton>
      </div>
    </div>
  );

  // — Inline: Camera viewfinder —
  if (active === 'camera') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#000', color: '#fff', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 18px', zIndex: 2 }}>
        <button onClick={() => setActive(null)} style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.15)',
          color: '#fff', padding: '6px 14px', borderRadius: 99, fontFamily: t.fontMono, fontSize: 10,
          letterSpacing: '0.06em', cursor: 'pointer' }}>CANCELAR</button>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
          background: 'rgba(0,0,0,0.4)', borderRadius: 99 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.accent }}/>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: '0.06em' }}>EXIF OFF</span>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #1a2326, #0a0a0a)' }}>
        <div style={{ fontFamily: t.fontMono, fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center',
          letterSpacing: '0.08em' }}>[ CÁMARA ]<br/><span style={{ fontSize: 9 }}>VISOR DE CAPTURA</span></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0 32px' }}>
        <button onClick={() => nav('chat')} style={{ width: 64, height: 64, borderRadius: '50%',
          background: t.accent, border: 'none', cursor: 'pointer', color: t.accentInk,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <II.Eye size={26}/>
        </button>
      </div>
    </div>
  );

  // — Inline: File browser —
  if (active === 'file') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Seleccionar archivo"
        left={<button onClick={() => setActive(null)} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {['audit-report-v3.pdf','keystore-backup.json','treasury-q2.xlsx','meeting-notes.md','config.toml'].map((f,i) => (
          <div key={i} onClick={() => nav('chat')} style={{ display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 18px', borderBottom: `1px solid ${t.divider}`, cursor: 'pointer' }}>
            <div style={{ width: 36, height: 36, borderRadius: t.radiusS, background: t.surface2,
              color: t.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <II.Attach size={18}/>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.fontMono, fontSize: 13, fontWeight: 500 }}>{f}</div>
              <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2 }}>
                {[14, 8, 42, 3, 1][i]} KB
              </div>
            </div>
            <II.Chevron size={14} style={{ color: t.textFaint }}/>
          </div>
        ))}
      </div>
    </div>
  );

  // — Inline: Voice recorder —
  if (active === 'voice') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Nota de voz"
        left={<button onClick={() => setActive(null)} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 24, padding: '0 28px' }}>
        <div style={{ width: 100, height: 100, borderRadius: '50%', background: t.surface,
          border: `2px solid ${t.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: t.accent }}>
          <II.Mic size={36}/>
        </div>
        <div style={{ fontFamily: t.fontDisplay, fontSize: 20, fontStyle: t.italic ? 'italic' : 'normal',
          fontWeight: t.displayWeight }}>Grabando…</div>
        <div style={{ fontFamily: t.fontMono, fontSize: 22, color: t.accent }}>00:04</div>
        <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, textAlign: 'center', lineHeight: 1.5 }}>
          El audio se cifra on-device y se envía como mensaje efímero.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '12px 18px 20px' }}>
        <window.GhostButton t={t} onClick={() => setActive(null)}>Cancelar</window.GhostButton>
        <window.PrimaryButton t={t} onClick={() => nav('chat')}>Enviar</window.PrimaryButton>
      </div>
    </div>
  );

  // — Inline: Contact share picker —
  if (active === 'contact') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Compartir contacto"
        left={<button onClick={() => setActive(null)} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {[
          { name: 'satoshi.eth', tag: '7K9-PQ2M', color: '#8b5cf6' },
          { name: 'vitalik.lens', tag: 'VK-3A1F', color: '#ec4899' },
          { name: '0xC3F…91A', tag: 'C3-F091A', color: '#06b6d4' },
          { name: 'lex.cryptopunk', tag: 'LX-8B2C', color: '#a78bfa' },
        ].map((ct,i) => (
          <div key={i} onClick={() => nav('chat')} style={{ display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 18px', borderBottom: `1px solid ${t.divider}`, cursor: 'pointer' }}>
            <window.Avatar t={t} name={ct.name} color={ct.color} size={38}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: ct.name.includes('.') ? t.fontMono : t.font,
                fontWeight: 600, fontSize: 14 }}>{ct.name}</div>
              <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                letterSpacing: '0.04em', marginTop: 2 }}>{ct.tag}</div>
            </div>
            <II.Chevron size={14} style={{ color: t.textFaint }}/>
          </div>
        ))}
      </div>
    </div>
  );

  // — Main grid view —
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Adjuntar"
        left={<button onClick={() => nav('chat')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 22px' }}>
        <div style={{
          padding: '12px 14px', background: t.surface,
          border: `1px solid ${t.border}`, borderRadius: t.radius,
          fontFamily: t.font, fontSize: 13, color: t.textDim,
          lineHeight: 1.45, marginBottom: 18,
        }}>
          Todo se cifra antes de salir del dispositivo. Los EXIF y metadatos
          de archivos se eliminan automáticamente.
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10,
        }}>
          {opts.map(o => (
            <button key={o.id} onClick={() => handleClick(o)} style={{
              padding: '16px 14px', cursor: 'pointer',
              background: t.surface,
              border: `1px solid ${o.accent ? t.accent + '44' : t.border}`,
              borderRadius: t.radius, color: t.text, textAlign: 'left',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <span style={{ color: o.accent ? t.accent : t.textDim }}>{o.icon}</span>
              <div>
                <div style={{ fontFamily: t.font, fontSize: 14, fontWeight: 600 }}>{o.label}</div>
                <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                              letterSpacing: '0.04em', marginTop: 3 }}>{o.sub.toUpperCase()}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 20. Temporary location sharing ─────────────────────────────────────
function ScreenLocation({ t, nav }) {
  const [dur, setDur] = React.useState('1h');
  const [precise, setPrecise] = React.useState(true);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Ubicación temporal"
        left={<button onClick={() => nav('chat')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      {/* map preview */}
      <div style={{
        margin: '8px 18px 16px', height: 200,
        position: 'relative', borderRadius: t.radius,
        overflow: 'hidden', border: `1px solid ${t.border}`,
        background: t.dark
          ? `linear-gradient(135deg, #1a2326 0%, #243033 100%)`
          : `linear-gradient(135deg, #e8e5dc 0%, #d8d4c6 100%)`,
      }}>
        {/* grid lines as map mock */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `linear-gradient(${t.borderStrong} 1px, transparent 1px),
                           linear-gradient(90deg, ${t.borderStrong} 1px, transparent 1px)`,
          backgroundSize: '32px 32px',
          opacity: 0.25,
        }}/>
        {/* fake roads */}
        <svg viewBox="0 0 280 200" width="100%" height="100%" style={{ position: 'absolute' }}>
          <path d="M0 80 Q140 60 280 100" stroke={t.borderStrong} strokeWidth="6" fill="none" opacity="0.5"/>
          <path d="M120 0 L160 200" stroke={t.borderStrong} strokeWidth="6" fill="none" opacity="0.5"/>
          <path d="M0 150 L280 140" stroke={t.borderStrong} strokeWidth="3" fill="none" opacity="0.4"/>
        </svg>
        {/* pin */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -100%)',
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%',
            background: t.accent,
            border: `3px solid ${t.bg}`,
            boxShadow: `0 4px 12px ${t.accent}66`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: t.accentInk,
          }}><II.Shield size={18}/></div>
        </div>
        {/* pulse */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 100, height: 100, borderRadius: '50%',
          background: `${t.accent}22`,
          animation: 'aegis-pulse 2s ease-in-out infinite',
        }}/>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 22px' }}>
        <div style={{ padding: '0 22px 12px' }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                        letterSpacing: '0.08em', marginBottom: 4 }}>
            ZURICH · BAHNHOFSTRASSE
          </div>
          <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 1.45 }}>
            Tu ubicación se comparte cifrada con <b style={{ color: t.text }}>satoshi.eth</b> y se borra
            automáticamente al expirar el tiempo.
          </div>
        </div>

        <SectP t={t} label="DURACIÓN">
          {[
            { id: '15m', l: '15 minutos',  s: 'Para encontrarse ya' },
            { id: '1h',  l: '1 hora',      s: 'Recomendado' },
            { id: '8h',  l: '8 horas',     s: 'Jornada' },
            { id: 'eod', l: 'Hasta media noche', s: 'Se borra a las 00:00' },
          ].map((o, i, arr) => (
            <div key={o.id} onClick={() => setDur(o.id)} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 16px', cursor: 'pointer',
              borderBottom: i < arr.length - 1 ? `1px solid ${t.divider}` : 'none',
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: '50%',
                border: `2px solid ${dur === o.id ? t.accent : t.borderStrong}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {dur === o.id && <div style={{ width: 9, height: 9, borderRadius: '50%', background: t.accent }}/>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: t.font, fontSize: 14, fontWeight: dur === o.id ? 600 : 400 }}>{o.l}</div>
                <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{o.s}</div>
              </div>
            </div>
          ))}
        </SectP>

        <SectP t={t} label="PRECISIÓN">
          <ToggleP t={t} label="Ubicación exacta" sub="Si está apagado, sólo el barrio (~500m)" value={precise} onChange={setPrecise} noBorder/>
        </SectP>

        <div style={{ padding: '0 18px' }}>
          <window.PrimaryButton t={t} onClick={() => nav('chat')}>Compartir ubicación</window.PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─── 21. View-once media (preview) ──────────────────────────────────────
function ScreenViewOnce({ t, nav }) {
  const [opened, setOpened] = React.useState(false);

  if (opened) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: '#000', color: '#fff', position: 'relative',
                  overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: `linear-gradient(135deg, #1a1f2e 0%, #2d1b3d 50%, #3d1a2e 100%)`,
        backgroundSize: '200% 200%',
        animation: 'aegis-bg 8s ease-in-out infinite',
      }}/>
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `repeating-linear-gradient(45deg,
          rgba(255,255,255,0.03) 0 2px, transparent 2px 6px)`,
      }}/>

      <div style={{
        position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'space-between',
        padding: '20px 22px', alignItems: 'center',
      }}>
        <button onClick={() => nav('chat')} style={{
          background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.15)',
          color: '#fff', padding: '6px 12px', borderRadius: 99,
          fontFamily: t.fontMono, fontSize: 10, letterSpacing: '0.06em', cursor: 'pointer',
        }}>CERRAR</button>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', background: 'rgba(230,57,70,0.2)',
          border: '1px solid rgba(230,57,70,0.4)',
          borderRadius: 99,
        }}>
          <II.Timer size={11}/>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: '#ff8b95',
                         letterSpacing: '0.06em' }}>SE BORRA EN 4S</span>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative', zIndex: 2,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          fontFamily: t.fontMono, fontSize: 11, color: 'rgba(255,255,255,0.4)',
          letterSpacing: '0.1em', textAlign: 'center',
        }}>
          [ IMAGEN VER-UNA-VEZ ]<br/>
          <span style={{ fontSize: 9 }}>SIN CAPTURA · SIN GUARDADO</span>
        </div>
      </div>

      <div style={{
        position: 'relative', zIndex: 2, padding: '0 22px 28px',
      }}>
        <div style={{ height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 99 }}>
          <div style={{
            height: '100%', width: '40%', background: t.danger,
            borderRadius: 99,
            animation: 'aegis-burn 5s linear forwards',
          }}/>
        </div>
        <div style={{
          fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.4)',
          letterSpacing: '0.08em', marginTop: 8, textAlign: 'center',
        }}>NO SE PUEDE REENVIAR · NO SE GUARDA EN GALERÍA</div>
      </div>
    </div>
  );

  // Preview screen — before opening
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Ver una vez"
        left={<button onClick={() => nav('chat')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 22px 22px' }}>
        <div style={{
          margin: '0 auto', padding: 28,
          background: t.surface, border: `1px solid ${t.borderStrong}`,
          borderRadius: t.radius, textAlign: 'center',
          maxWidth: 320,
        }}>
          <div style={{
            margin: '0 auto 18px', width: 80, height: 80, borderRadius: '50%',
            background: t.surface2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: t.accent, border: `1px solid ${t.borderStrong}`,
          }}><II.EyeOff size={36} stroke={1.6}/></div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 22,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight, letterSpacing: '-0.02em', marginBottom: 8,
          }}>satoshi.eth te envió un medio ver-una-vez</div>
          <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 1.5 }}>
            Lo verás durante 5 segundos. Después se borra del dispositivo y del
            servidor — no se puede reenviar ni guardar.
          </div>
        </div>
      </div>

      <div style={{ padding: '0 22px 24px' }}>
        <window.PrimaryButton t={t} onClick={() => setOpened(true)}>Ver ahora</window.PrimaryButton>
      </div>
    </div>
  );
}

// ─── 22. Group admin (roles & permissions) ──────────────────────────────
function ScreenGroupAdmin({ t, nav }) {
  const members = [
    { name: 'You',           role: 'admin', online: true,  color: t.accent },
    { name: 'satoshi.eth',   role: 'admin', online: true,  color: '#8b5cf6' },
    { name: 'Alex',          role: 'mod',   online: true,  color: '#06b6d4' },
    { name: 'Maya',          role: 'mod',   online: false, color: '#ec4899' },
    { name: '0xC3F…91A',     role: 'member', online: false, color: '#f59e0b' },
  ];

  const RoleBadge = ({ role }) => {
    const palette = role === 'admin' ? t.accent
                  : role === 'mod'   ? t.warn
                  : t.textDim;
    return (
      <span style={{
        fontFamily: t.fontMono, fontSize: 9, color: palette,
        letterSpacing: '0.08em', padding: '2px 6px',
        border: `1px solid ${palette}66`, borderRadius: 99,
      }}>{role.toUpperCase()}</span>
    );
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Group info"
        left={<button onClick={() => nav('groups')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}
        right={<II.More size={20} style={{ color: t.textDim }}/>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 24px' }}>
        {/* group header */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '14px 22px 18px',
        }}>
          <div style={{
            width: 76, height: 76, borderRadius: t.radiusL,
            background: '#f59e0b22', color: '#f59e0b',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><II.Users size={34}/></div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 22, marginTop: 12,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight, letterSpacing: '-0.01em',
          }}>DAO · Treasury</div>
          <div style={{
            fontFamily: t.fontMono, fontSize: 11, color: t.accent,
            letterSpacing: '0.06em', marginTop: 4,
          }}>MLS · 5 MIEMBROS · CREADO HACE 14 D</div>
          <div style={{
            fontFamily: t.font, fontSize: 13, color: t.textDim,
            marginTop: 10, textAlign: 'center', lineHeight: 1.45, maxWidth: 280,
          }}>Multisig signers · 3-of-5. Coordinación on-chain y firma de propuestas.</div>
        </div>

        <SectP t={t} label="MIEMBROS · 5" hint="ARRASTRA PARA REORDENAR ROLES">
          {members.map((m, i) => (
            <div key={m.name} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 16px',
              borderBottom: i < members.length - 1 ? `1px solid ${t.divider}` : 'none',
            }}>
              <div style={{ position: 'relative' }}>
                <window.Avatar t={t} name={m.name} color={m.color} size={38}/>
                {m.online && <span style={{
                  position: 'absolute', bottom: -1, right: -1,
                  width: 11, height: 11, borderRadius: '50%',
                  background: t.accent, border: `2px solid ${t.surface}`,
                }}/>}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: m.name.includes('.') || m.name.startsWith('0x') ? t.fontMono : t.font,
                  fontWeight: 600, fontSize: 14, color: t.text,
                }}>{m.name}</div>
                <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2 }}>
                  {m.online ? 'online · key a7f3' : 'offline · 2h ago'}
                </div>
              </div>
              <RoleBadge role={m.role}/>
            </div>
          ))}
          <div onClick={() => nav('verify')} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px', cursor: 'pointer',
            color: t.accent,
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: '50%',
              background: t.surface2, color: t.accent,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px dashed ${t.accent}66`,
            }}><II.Plus size={20}/></div>
            <div style={{ flex: 1, fontFamily: t.font, fontSize: 14, fontWeight: 500 }}>
              Invitar miembro
            </div>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                           letterSpacing: '0.06em' }}>QR · ENLACE · ID</span>
          </div>
        </SectP>

        <SectP t={t} label="PERMISOS">
          <ToggleP t={t} label="Sólo admin invita" sub="Cerrar el grupo a invitaciones externas" value={true} onChange={() => {}}/>
          <ToggleP t={t} label="Aprobar mensajes de nuevos miembros" sub="48h de moderación tras unirse" value={false} onChange={() => {}}/>
          <ToggleP t={t} label="Bloquear capturas en este grupo" value={true} onChange={() => {}} noBorder/>
        </SectP>

        <SectP t={t} label="TEMAS · 3">
          <RowP t={t} icon={<II.Chat size={18}/>} label="general" sub="público · 5 miembros" onClick={() => nav('chat')}/>
          <RowP t={t} icon={<II.Lock size={18}/>} label="signers-only" sub="privado · admin+mod" onClick={() => nav('chat')}/>
          <RowP t={t} icon={<II.Bell size={18}/>} label="alertas" sub="solo-lectura · automático" onClick={() => nav('notifs')} noBorder/>
        </SectP>

        <SectP t={t} label="ZONA DE PELIGRO">
          <RowP t={t} icon={<II.X size={18}/>} label="Abandonar grupo" danger onClick={() => nav('groups')}/>
          <RowP t={t} icon={<II.Trash size={18}/>} label="Vaciar historial local" danger onClick={() => nav('groups')} noBorder/>
        </SectP>
      </div>
    </div>
  );
}

// ─── 23. Notifications ──────────────────────────────────────────────────
function ScreenNotifications({ t, nav }) {
  const [master, setMaster] = React.useState(true);
  const [preview, setPreview] = React.useState(false);
  const [sound, setSound] = React.useState(true);
  const [badge, setBadge] = React.useState(true);
  const [summary, setSummary] = React.useState(true);

  const [keywords, setKeywords] = React.useState(['urgente', 'multisig', 'audit', 'mi nombre']);
  const [muted, setMuted] = React.useState([
    { id: 1, name: 'PrivacyOps',     until: 'jue · 18:00' },
    { id: 2, name: 'Cipher Reading', until: 'siempre' },
  ]);

  const removeKeyword = (k) => setKeywords(prev => prev.filter(x => x !== k));
  const unmute = (id) => setMuted(prev => prev.filter(x => x.id !== id));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Notifications" big
        left={<button onClick={() => nav('settings')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 22px' }}>
        <SectP t={t} label="GENERAL">
          <ToggleP t={t} label="Notificaciones" sub="Maestro · apaga todo" value={master} onChange={setMaster}/>
          <ToggleP t={t} label="Mostrar contenido"
                   sub="Si está apagado, sólo dice «nuevo mensaje cifrado»"
                   value={preview} onChange={setPreview}/>
          <ToggleP t={t} label="Sonido" value={sound} onChange={setSound}/>
          <ToggleP t={t} label="Insignia (badge)" sub="Contador rojo en el icono" value={badge} onChange={setBadge} noBorder/>
        </SectP>

        <SectP t={t} label="PALABRAS CLAVE · PRIORIDAD">
          <div style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {keywords.map(k => (
                <span key={k} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 4px 4px 10px',
                  background: t.surface2, borderRadius: 99,
                  fontFamily: t.fontMono, fontSize: 11, color: t.text,
                }}>
                  {k}
                  <button onClick={() => removeKeyword(k)} style={{
                    width: 16, height: 16, borderRadius: '50%',
                    background: t.surface3, color: t.textDim,
                    border: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, cursor: 'pointer',
                  }}>×</button>
                </span>
              ))}
              <button onClick={() => nav('search')} style={{
                padding: '4px 12px', background: 'transparent',
                border: `1px dashed ${t.borderStrong}`, borderRadius: 99,
                color: t.textDim, fontFamily: t.fontMono, fontSize: 11,
                cursor: 'pointer',
              }}>+ añadir</button>
            </div>
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 1.4 }}>
              Aunque silencies un chat, estos mensajes <i>te</i> notificarán igual.
            </div>
          </div>
        </SectP>

        <SectP t={t} label="RESUMEN DIARIO">
          <ToggleP t={t} label="Generar resumen local" sub="Procesado on-device · 19:30" value={summary} onChange={setSummary} noBorder/>
        </SectP>

        <SectP t={t} label="SILENCIADOS · 2">
          {muted.map((m, i) => (
            <div key={m.name} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 16px',
              borderBottom: i < muted.length - 1 ? `1px solid ${t.divider}` : 'none',
            }}>
              <II.Mute size={18} style={{ color: t.textDim }}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: t.font, fontSize: 14 }}>{m.name}</div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                              letterSpacing: '0.04em', marginTop: 2 }}>
                  HASTA {m.until.toUpperCase()}
                </div>
              </div>
              <button onClick={() => nav('chat')} style={{
                background: 'transparent', border: `1px solid ${t.borderStrong}`,
                color: t.text, borderRadius: t.radiusS,
                padding: '4px 10px', fontFamily: t.fontMono, fontSize: 10,
                letterSpacing: '0.04em', cursor: 'pointer',
              }}>REACTIVAR</button>
            </div>
          ))}
        </SectP>
      </div>
    </div>
  );
}

// ─── 24. Data export & account deletion (GDPR) ──────────────────────────
function ScreenDataExport({ t, nav }) {
  const [pick, setPick] = React.useState({ messages: true, media: true, contacts: true, settings: false });
  const set = (k, v) => setPick(p => ({ ...p, [k]: v }));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Tus datos" big
        left={<button onClick={() => nav('settings')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 24px' }}>
        <div style={{
          margin: '0 18px 16px', padding: 14,
          background: t.surface, border: `1px solid ${t.border}`,
          borderRadius: t.radius, fontFamily: t.font, fontSize: 13,
          color: t.textDim, lineHeight: 1.5,
        }}>
          AegisLink no guarda nada en servidor más allá de cifrados opacos.
          Aquí controlas lo que sale del dispositivo — y cómo borrarlo todo si te marchas.
        </div>

        <SectP t={t} label="EXPORTAR · ARCHIVO CIFRADO">
          <ToggleP t={t} label="Mensajes" sub="2,419 mensajes · todos los chats" value={pick.messages} onChange={(v) => set('messages', v)}/>
          <ToggleP t={t} label="Multimedia" sub="312 archivos · 142 MB" value={pick.media} onChange={(v) => set('media', v)}/>
          <ToggleP t={t} label="Contactos" sub="47 entradas · sólo IDs públicos" value={pick.contacts} onChange={(v) => set('contacts', v)}/>
          <ToggleP t={t} label="Ajustes" sub="Preferencias y palabras clave" value={pick.settings} onChange={(v) => set('settings', v)} noBorder/>
        </SectP>

        <div style={{
          margin: '0 18px 18px', padding: 14,
          background: t.surface, border: `1px solid ${t.border}`,
          borderRadius: t.radius, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                           letterSpacing: '0.1em' }}>FORMATO</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent,
                           letterSpacing: '0.04em' }}>.AEGIS · AES-256-GCM</span>
          </div>
          <div style={{ height: 1, background: t.divider }}/>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                           letterSpacing: '0.1em' }}>TAMAÑO ESTIMADO</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text }}>148 MB</span>
          </div>
        </div>

        <div style={{ padding: '0 18px 28px' }}>
          <window.PrimaryButton t={t} onClick={() => nav('home')}>Generar archivo cifrado</window.PrimaryButton>
        </div>

        <div style={{
          margin: '0 18px 14px', height: 1, background: t.divider,
        }}/>

        <SectP t={t} label="ELIMINAR CUENTA" hint="IRREVERSIBLE">
          <div style={{ padding: 14 }}>
            <div style={{
              fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 1.5,
            }}>
              Al eliminar tu cuenta se borran <b style={{ color: t.text }}>tus claves locales</b> y se envía
              una señal de revocación a todos los relays. Los mensajes que ya
              recibieron tus contactos quedan en sus dispositivos — pero nadie
              podrá descifrarlos hacia ti nunca más.
            </div>
          </div>
        </SectP>

        <div style={{ padding: '0 18px' }}>
          <button onClick={() => nav('onboarding')} style={{
            width: '100%', background: 'transparent',
            color: t.danger, border: `1px solid ${t.danger}66`,
            borderRadius: t.radius, padding: '14px',
            fontFamily: t.font, fontWeight: 600, fontSize: 14,
            cursor: 'pointer',
          }}>Eliminar mi cuenta para siempre</button>
        </div>
      </div>
    </div>
  );
}

// ─── 25. View-once SEND flow (from attach sheet) ────────────────────────
function ScreenViewOnceSend({ t, nav }) {
  const [selected, setSelected] = React.useState(false);

  if (selected) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Ver una vez · Enviar"
        left={<button onClick={() => setSelected(false)} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 20, padding: '0 28px' }}>
        <div style={{
          width: 200, height: 200, borderRadius: t.radius,
          background: `linear-gradient(135deg, #8b5cf644, #ec489944)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `2px dashed ${t.accent}66`,
        }}>
          <II.EyeOff size={48} style={{ color: t.accent, opacity: 0.6 }}/>
        </div>
        <div style={{ fontFamily: t.fontDisplay, fontSize: 18, fontStyle: t.italic ? 'italic' : 'normal',
          fontWeight: t.displayWeight, textAlign: 'center' }}>Vista previa</div>
        <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, textAlign: 'center', lineHeight: 1.5 }}>
          El destinatario podrá ver el contenido sólo una vez. No podrá guardar, capturar ni reenviar.
        </div>
        <div style={{
          padding: '8px 14px', background: t.surface, borderRadius: t.radiusS,
          border: `1px solid ${t.border}`, fontFamily: t.fontMono, fontSize: 10,
          color: t.textDim, letterSpacing: '0.06em',
        }}>
          <II.Timer size={10} style={{ verticalAlign: '-1px', marginRight: 4 }}/>
          AUTO-DESTRUCCIÓN · 5 SEGUNDOS
        </div>
      </div>
      <div style={{ padding: '12px 22px 22px' }}>
        <window.PrimaryButton t={t} onClick={() => nav('chat')}>Enviar ver-una-vez</window.PrimaryButton>
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarP t={t} title="Ver una vez"
        left={<button onClick={() => nav('attach')} style={btnIconP(t)}><II.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 22px' }}>
        <div style={{
          padding: 22, textAlign: 'center', marginBottom: 18,
        }}>
          <div style={{
            margin: '0 auto 16px', width: 72, height: 72, borderRadius: '50%',
            background: t.surface, border: `1px solid ${t.borderStrong}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: t.accent,
          }}><II.EyeOff size={32} stroke={1.6}/></div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 20,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight, letterSpacing: '-0.02em',
          }}>Enviar contenido efímero</div>
          <div style={{
            fontFamily: t.font, fontSize: 13, color: t.textDim,
            marginTop: 8, lineHeight: 1.5, maxWidth: 280, margin: '8px auto 0',
          }}>
            Selecciona una foto o vídeo. El destinatario solo podrá verlo una vez — después se borra de todos lados.
          </div>
        </div>

        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
          letterSpacing: '0.1em', marginBottom: 10, padding: '0 4px' }}>SELECCIONAR MEDIO</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
          {['#8b5cf6','#06b6d4','#ec4899','#f59e0b','#5bf2b9','#a78bfa'].map((c,i) => (
            <div key={i} onClick={() => setSelected(true)} style={{
              aspectRatio: '1', borderRadius: t.radiusS,
              background: `linear-gradient(135deg, ${c}44, ${c}aa)`,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><II.Eye size={18} style={{ color: '#fff', opacity: 0.4 }}/></div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── animations once ────────────────────────────────────────────────────
if (!document.getElementById('aegis-anim-p2')) {
  const s = document.createElement('style');
  s.id = 'aegis-anim-p2';
  s.textContent = `
    @keyframes aegis-pulse { 0%, 100% { transform: scale(1); opacity: 0.8; } 50% { transform: scale(1.18); opacity: 0.3; } }
    @keyframes aegis-ring { 0% { box-shadow: 0 0 0 0 rgba(91,242,185,0.35); } 100% { box-shadow: 0 0 0 30px rgba(91,242,185,0); } }
    @keyframes aegis-bg { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
    @keyframes aegis-burn { from { width: 100%; } to { width: 0%; } }
  `;
  document.head.appendChild(s);
}

Object.assign(window, {
  ScreenLock, ScreenIncoming, ScreenSearch, ScreenAttachSheet,
  ScreenLocation, ScreenViewOnce, ScreenViewOnceSend, ScreenGroupAdmin,
  ScreenNotifications, ScreenDataExport, ScreenLockSettings,
});

