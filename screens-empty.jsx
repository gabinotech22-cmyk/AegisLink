// AegisLink — Empty + first-run states
// ScreenEmptyHome: chat list after onboarding (no contacts yet)
// ScreenEmptyGroups: groups list with no groups
// ScreenFirstContact: success state after adding first contact
// ScreenInviteAdd: how to add someone (3 ways)

const { I: IIII } = window;

const ibtnE = (t) => ({
  background: 'transparent', border: 'none', color: t.textDim,
  cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
});

// ─── Empty Home — first-run chat list ────────────────────────────────
function ScreenEmptyHome({ t, nav }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      {/* top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <window.AegisMark t={t} size={26}/>
          <window.AegisWord t={t} size={26}/>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: t.textDim }}>
          <button onClick={() => nav('search')} style={ibtnE(t)}><IIII.Search size={20}/></button>
          <button onClick={() => nav('settings')} style={ibtnE(t)}><IIII.Settings size={20}/></button>
        </div>
      </div>

      {/* welcome banner */}
      <div style={{
        margin: '4px 18px 14px', padding: '14px 16px',
        background: 'linear-gradient(135deg, rgba(91,242,185,0.06), rgba(91,242,185,0.02))',
        border: `1px solid ${t.accent}33`,
        borderRadius: t.radius,
        display: 'flex', gap: 12, alignItems: 'flex-start',
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: t.radiusS,
          background: t.accent + '22', color: t.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}><IIII.Check size={16}/></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 13, color: t.text }}>
            Identidad creada
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent,
                        letterSpacing: '0.04em', marginTop: 2 }}>
            7K9-PQ2M-X4VR · KEY a7f3-92e1
          </div>
        </div>
        <button onClick={() => nav('profile')} style={{
          background: 'transparent', border: 'none', color: t.accent,
          fontFamily: t.fontMono, fontSize: 10, letterSpacing: '0.06em',
          cursor: 'pointer',
        }}>VER ▸</button>
      </div>

      {/* empty illustration */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '0 32px', textAlign: 'center',
      }}>
        <EmptyKeyVisual t={t}/>

        <div style={{
          fontFamily: t.fontDisplay, fontSize: 26,
          fontStyle: t.italic ? 'italic' : 'normal',
          fontWeight: t.displayWeight,
          letterSpacing: '-0.02em', marginTop: 30, marginBottom: 12,
          maxWidth: 280,
        }}>
          Tu primera conversación empieza con una llave compartida.
        </div>
        <div style={{
          fontFamily: t.font, fontSize: 14, color: t.textDim,
          lineHeight: 1.5, maxWidth: 300, marginBottom: 28,
        }}>
          No hay descubrimiento automático aquí — no usamos tu agenda.
          Para hablar con alguien, intercambien Aegis IDs en persona,
          por QR, o por enlace.
        </div>

        <button onClick={() => nav('inviteAdd')} style={{
          background: t.accent, color: t.accentInk, border: 'none',
          padding: '14px 28px', borderRadius: t.radius,
          fontFamily: t.font, fontWeight: 600, fontSize: 14,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <IIII.Plus size={18}/> Añadir mi primer contacto
        </button>

        <div style={{
          display: 'flex', gap: 16, marginTop: 22,
          fontFamily: t.fontMono, fontSize: 10, color: t.textFaint,
          letterSpacing: '0.08em',
        }}>
          <span>QR · ENLACE · ID</span>
        </div>
      </div>

      <window.TabBar t={t} nav={nav} current="home"/>
    </div>
  );
}

function EmptyKeyVisual({ t }) {
  return (
    <div style={{
      position: 'relative', width: 140, height: 140,
    }}>
      {/* expanding rings */}
      {[0, 0.4, 0.8].map(d => (
        <div key={d} style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          border: `1px solid ${t.accent}`,
          opacity: 0.3,
          animation: `aegis-ring-out 2.4s ease-out infinite`,
          animationDelay: `${d}s`,
        }}/>
      ))}
      {/* center mark */}
      <div style={{
        position: 'absolute', inset: 38,
        borderRadius: '50%', background: t.surface,
        border: `1px solid ${t.borderStrong}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: t.accent,
      }}>
        <window.AegisMark t={t} size={36} mono/>
      </div>
    </div>
  );
}

// ─── Empty Groups ────────────────────────────────────────────────────
function ScreenEmptyGroups({ t, nav }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
      }}>
        <span style={{
          fontFamily: t.fontDisplay, fontSize: 28,
          fontStyle: t.italic ? 'italic' : 'normal',
          fontWeight: t.displayWeight,
          letterSpacing: '-0.02em', color: t.text,
        }}>Groups</span>
        <button onClick={() => nav('inviteAdd')} style={ibtnE(t)}><IIII.Plus size={22}/></button>
      </div>

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '0 32px', textAlign: 'center',
      }}>
        {/* group constellation illustration */}
        <div style={{
          position: 'relative', width: 180, height: 140, marginBottom: 24,
        }}>
          <svg viewBox="0 0 180 140" width="180" height="140">
            {/* dashed connecting lines */}
            <line x1="50" y1="40" x2="90" y2="70" stroke={t.borderStrong} strokeWidth="1" strokeDasharray="2 4"/>
            <line x1="130" y1="40" x2="90" y2="70" stroke={t.borderStrong} strokeWidth="1" strokeDasharray="2 4"/>
            <line x1="40" y1="100" x2="90" y2="70" stroke={t.borderStrong} strokeWidth="1" strokeDasharray="2 4"/>
            <line x1="140" y1="100" x2="90" y2="70" stroke={t.borderStrong} strokeWidth="1" strokeDasharray="2 4"/>
            {/* outer dots */}
            <circle cx="50" cy="40" r="14" fill={t.surface} stroke={t.borderStrong} strokeWidth="1" strokeDasharray="3 3"/>
            <circle cx="130" cy="40" r="14" fill={t.surface} stroke={t.borderStrong} strokeWidth="1" strokeDasharray="3 3"/>
            <circle cx="40" cy="100" r="14" fill={t.surface} stroke={t.borderStrong} strokeWidth="1" strokeDasharray="3 3"/>
            <circle cx="140" cy="100" r="14" fill={t.surface} stroke={t.borderStrong} strokeWidth="1" strokeDasharray="3 3"/>
            {/* center accent */}
            <circle cx="90" cy="70" r="22" fill={t.accent + '22'} stroke={t.accent} strokeWidth="1.5"/>
            <g transform="translate(78,58)">
              <path d="M12 0 L21 6 L21 18 L12 24 L3 18 L3 6 Z"
                    fill="none" stroke={t.accent} strokeWidth="1.6" strokeLinejoin="round"/>
            </g>
          </svg>
        </div>

        <div style={{
          fontFamily: t.fontDisplay, fontSize: 24,
          fontStyle: t.italic ? 'italic' : 'normal',
          fontWeight: t.displayWeight,
          letterSpacing: '-0.02em', marginBottom: 10,
        }}>Sin grupos aún</div>
        <div style={{
          fontFamily: t.font, fontSize: 14, color: t.textDim,
          lineHeight: 1.5, maxWidth: 280, marginBottom: 26,
        }}>
          Crea un grupo cifrado con MLS. Hasta 256 miembros, roles admin/mod/member,
          temas privados, encuestas anónimas.
        </div>

        <button onClick={() => nav('groupadmin')} style={{
          background: t.accent, color: t.accentInk, border: 'none',
          padding: '13px 24px', borderRadius: t.radius,
          fontFamily: t.font, fontWeight: 600, fontSize: 14,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 10,
        }}>
          <IIII.Plus size={18}/> Crear grupo
        </button>
        <button onClick={() => nav('verify')} style={{
          background: 'transparent', color: t.text,
          border: `1px solid ${t.borderStrong}`,
          padding: '12px 24px', borderRadius: t.radius,
          fontFamily: t.font, fontWeight: 500, fontSize: 14,
          cursor: 'pointer',
        }}>Unirse por enlace</button>
      </div>

      <window.TabBar t={t} nav={nav} current="groups"/>
    </div>
  );
}

// ─── Invite / Add Contact ────────────────────────────────────────────
function ScreenInviteAdd({ t, nav }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
      }}>
        <button onClick={() => nav('home')} style={ibtnE(t)}><IIII.ChevronL size={22}/></button>
        <span style={{
          fontFamily: t.fontDisplay, fontSize: 18,
          fontStyle: t.italic ? 'italic' : 'normal',
          fontWeight: t.displayWeight,
          letterSpacing: '-0.02em', color: t.text,
        }}>Añadir contacto</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 22px' }}>
        <div style={{
          fontFamily: t.font, fontSize: 13, color: t.textDim,
          lineHeight: 1.5, marginBottom: 22, textAlign: 'center',
        }}>
          AegisLink nunca lee tu agenda. Elige cómo intercambiar identidades.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Method t={t}
            icon={<IIII.QR size={26}/>}
            label="En persona — QR"
            sub="Lo más seguro. Tu QR se muestra solo a quien tienes delante."
            cta="Mostrar mi QR"
            badge="RECOMMENDED"
            primary
            onClick={() => nav('verify')}/>
          <Method t={t}
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>
            </svg>}
            label="Enlace de invitación"
            sub="Genera un enlace de un solo uso que expira en 24h."
            cta="Generar enlace"/>
          <Method t={t}
            icon={<IIII.Key size={24}/>}
            label="Por Aegis ID"
            sub="Pega el ID de 12 caracteres del contacto. Después verifica la huella."
            cta="Introducir ID"/>
        </div>

        <div style={{
          marginTop: 28, padding: 14, background: t.surface,
          border: `1px solid ${t.border}`, borderRadius: t.radius,
          display: 'flex', gap: 12, alignItems: 'flex-start',
        }}>
          <IIII.Shield size={18} style={{ color: t.warn, flexShrink: 0, marginTop: 2 }}/>
          <div>
            <div style={{ fontFamily: t.font, fontSize: 12, fontWeight: 600, color: t.text }}>
              Verifica antes de hablar.
            </div>
            <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 1.45, marginTop: 4 }}>
              Cualquier método sirve para iniciar — pero comparen las 8 palabras
              de seguridad antes de enviar algo sensible.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Method({ t, icon, label, sub, cta, badge, primary, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: 16, background: t.surface,
      border: `1px solid ${primary ? t.accent + '66' : t.border}`,
      borderRadius: t.radius, cursor: 'pointer', textAlign: 'left',
      display: 'flex', alignItems: 'center', gap: 14,
      color: t.text,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: t.radius,
        background: primary ? t.accent + '22' : t.surface2,
        color: primary ? t.accent : t.text,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: 600, color: t.text }}>{label}</span>
          {badge && <span style={{
            fontFamily: t.fontMono, fontSize: 8, color: t.accent,
            letterSpacing: '0.08em', padding: '1px 5px',
            border: `1px solid ${t.accent}`, borderRadius: 99,
          }}>{badge}</span>}
        </div>
        <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim,
                      lineHeight: 1.4, marginTop: 3 }}>{sub}</div>
      </div>
      <span style={{
        fontFamily: t.fontMono, fontSize: 10, color: primary ? t.accent : t.textDim,
        letterSpacing: '0.06em', whiteSpace: 'nowrap', fontWeight: 600,
      }}>{cta.toUpperCase()} →</span>
    </button>
  );
}

// ─── First Contact Added — success state ─────────────────────────────
function ScreenFirstContact({ t, nav }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden',
                  alignItems: 'center', justifyContent: 'center',
                  padding: '60px 28px 32px', textAlign: 'center' }}>

      {/* success ring */}
      <div style={{
        position: 'relative', width: 130, height: 130, marginBottom: 32,
      }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          background: `radial-gradient(circle, ${t.accent}33, transparent 70%)`,
        }}/>
        <div style={{
          position: 'absolute', inset: 16, borderRadius: '50%',
          background: t.accent, color: t.accentInk,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 40px ${t.accent}88`,
        }}>
          <IIII.Check size={56} stroke={2.5}/>
        </div>
      </div>

      <div style={{
        fontFamily: t.fontDisplay, fontSize: 30,
        fontStyle: t.italic ? 'italic' : 'normal',
        fontWeight: t.displayWeight,
        letterSpacing: '-0.02em', marginBottom: 14, maxWidth: 280,
      }}>
        Primer contacto verificado
      </div>

      <div style={{
        padding: '14px 18px', background: t.surface,
        border: `1px solid ${t.border}`, borderRadius: t.radius,
        display: 'flex', alignItems: 'center', gap: 14,
        marginBottom: 16, width: '100%', maxWidth: 320,
      }}>
        <div style={{
          width: 42, height: 42, borderRadius: t.radiusL,
          background: '#8b5cf6', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: t.font, fontWeight: 600, fontSize: 18,
        }}>S</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 14, fontWeight: 600 }}>
            satoshi.eth
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                        letterSpacing: '0.06em', marginTop: 2 }}>
            ◆ KEY a7f3-92e1 · VERIFIED
          </div>
        </div>
      </div>

      <div style={{
        fontFamily: t.font, fontSize: 14, color: t.textDim,
        lineHeight: 1.55, marginBottom: 'auto', maxWidth: 320,
      }}>
        Sus huellas de clave coinciden. Lo que se envíe en este chat
        sólo lo descifrará el dueño de esa llave — ni AegisLink ni nadie más.
      </div>

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button onClick={() => nav('chat')} style={{
          background: t.accent, color: t.accentInk, border: 'none',
          padding: '15px 20px', borderRadius: t.radius,
          fontFamily: t.font, fontWeight: 600, fontSize: 15, cursor: 'pointer',
        }}>Abrir chat</button>
        <button onClick={() => nav('inviteAdd')} style={{
          background: 'transparent', color: t.text,
          border: `1px solid ${t.borderStrong}`,
          padding: '14px 20px', borderRadius: t.radius,
          fontFamily: t.font, fontWeight: 500, fontSize: 14, cursor: 'pointer',
        }}>Añadir otro contacto</button>
      </div>
    </div>
  );
}

// ─── animations style ────────────────────────────────────────────────
if (!document.getElementById('aegis-empty-anim')) {
  const s = document.createElement('style');
  s.id = 'aegis-empty-anim';
  s.textContent = `
    @keyframes aegis-ring-out {
      0%   { transform: scale(0.5); opacity: 0.6; }
      100% { transform: scale(1.3); opacity: 0; }
    }
  `;
  document.head.appendChild(s);
}

Object.assign(window, {
  ScreenEmptyHome, ScreenEmptyGroups, ScreenInviteAdd, ScreenFirstContact,
});
