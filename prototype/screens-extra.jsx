// AegisLink — extra screens
// Profile, Contact (with MITM), Devices, Panic, Poll, Scheduled

const { I } = window;

// helper refs from screens.jsx
const btnIcon = (t) => ({
  background: 'transparent', border: 'none', color: t.textDim,
  cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
});

function TopBarX({ t, title, left, right, big }) {
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

function SectionX({ t, label, children, hint }) {
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

function ToggleX({ t, label, sub, value, onChange, noBorder }) {
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
        position: 'relative', flexShrink: 0, transition: 'background 0.15s',
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

// ─── 10. Your profile + multiple identities ──────────────────────────────
function ScreenProfile({ t, nav }) {
  const [identity, setIdentity] = React.useState('personal');
  const [photoVis, setPhotoVis] = React.useState('contacts');
  const [lastSeen, setLastSeen] = React.useState(false);
  const [typing, setTyping] = React.useState(true);

  const identities = [
    { id: 'personal', name: 'satoshi.local', tag: '7K9-PQ2M-X4VR', color: t.accent },
    { id: 'work',     name: 'cirrus.work',   tag: 'WK-1A4F-9D2B', color: '#8b5cf6' },
  ];
  const me = identities.find(i => i.id === identity);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBarX t={t} title="Profile" big
        left={<button onClick={() => nav('home')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 24px' }}>
        {/* identity card with switcher */}
        <div style={{
          margin: '0 18px 18px', padding: '20px 18px',
          background: t.surface, border: `1px solid ${t.borderStrong}`,
          borderRadius: t.radius,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <window.Avatar t={t} name={me.name} color={me.color} size={56}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: t.fontMono, fontWeight: 500, fontSize: 16,
                            color: t.text, whiteSpace: 'nowrap', overflow: 'hidden',
                            textOverflow: 'ellipsis' }}>{me.name}</div>
              <div style={{ fontFamily: t.fontMono, fontSize: 11, color: me.color,
                            letterSpacing: '0.04em', marginTop: 2 }}>{me.tag}</div>
            </div>
          </div>

          <div style={{
            display: 'flex', padding: 3, background: t.surface2,
            borderRadius: t.radiusS,
          }}>
            {identities.map(id => (
              <button key={id.id} onClick={() => setIdentity(id.id)} style={{
                flex: 1, padding: '8px 10px', border: 'none', cursor: 'pointer',
                background: identity === id.id ? t.surface : 'transparent',
                color: identity === id.id ? t.text : t.textDim,
                fontFamily: t.font, fontSize: 12, fontWeight: identity === id.id ? 600 : 400,
                borderRadius: t.radiusS - 1,
                boxShadow: identity === id.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                textTransform: 'capitalize',
              }}>{id.id === 'personal' ? 'Personal' : 'Work'}</button>
            ))}
            <button onClick={() => nav('onboarding')} style={{
              padding: '8px 10px', border: 'none', cursor: 'pointer',
              background: 'transparent', color: t.textFaint,
              fontFamily: t.font, fontSize: 12,
            }}>+</button>
          </div>

          <div style={{
            fontFamily: t.font, fontSize: 11, color: t.textDim,
            marginTop: 12, lineHeight: 1.45,
          }}>
            Identidades separadas, claves separadas. Tus contactos nunca pueden
            vincularlas entre sí.
          </div>
        </div>

        <SectionX t={t} label="STATUS">
          <div style={{ padding: '14px 16px' }}>
            <div style={{
              padding: '10px 14px', background: t.surface2,
              borderRadius: t.radiusS, fontFamily: t.font,
              fontSize: 14, color: t.text,
            }}>shipping the audit fixes · back fri</div>
          </div>
        </SectionX>

        <SectionX t={t} label="VISIBILIDAD" hint="QUÉ COMPARTES">
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px', borderBottom: `1px solid ${t.divider}`,
          }}>
            <div style={{ flex: 1, fontFamily: t.font, fontSize: 14 }}>Foto de perfil</div>
            <div style={{
              display: 'flex', padding: 2, background: t.surface2,
              borderRadius: 99,
            }}>
              {[
                { id: 'all',      l: 'Todos' },
                { id: 'contacts', l: 'Contactos' },
                { id: 'none',     l: 'Nadie' },
              ].map(o => (
                <button key={o.id} onClick={() => setPhotoVis(o.id)} style={{
                  padding: '5px 10px', border: 'none', cursor: 'pointer',
                  background: photoVis === o.id ? t.accent : 'transparent',
                  color: photoVis === o.id ? t.accentInk : t.textDim,
                  fontFamily: t.fontMono, fontSize: 10,
                  letterSpacing: '0.04em', borderRadius: 99,
                  fontWeight: photoVis === o.id ? 600 : 400,
                }}>{o.l.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <ToggleX t={t} label="Último acceso" sub="Mostrar a contactos cuándo estás conectado" value={lastSeen} onChange={setLastSeen}/>
          <ToggleX t={t} label="Indicador de escritura" value={typing} onChange={setTyping} noBorder/>
        </SectionX>

        <SectionX t={t} label="CUENTA">
          <RowX t={t} icon={<I.Key size={18}/>}    label="Identidades & claves"   onClick={() => nav('devices')}/>
          <RowX t={t} icon={<I.Phone size={18}/>}  label="Dispositivos vinculados" sub="3 activos" onClick={() => nav('devices')}/>
          <RowX t={t} icon={<I.Shield size={18}/>} label="Modo pánico"            sub="Configurar gesto + PIN" onClick={() => nav('panic')} accent/>
          <RowX t={t} icon={<I.Trash size={18}/>}  label="Eliminar esta identidad" danger noBorder onClick={() => nav('export')}/>
        </SectionX>
      </div>

      <window.TabBar t={t} nav={nav} current="settings"/>
    </div>
  );
}

function RowX({ t, icon, label, sub, onClick, danger, accent, noBorder, trailing }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', cursor: onClick ? 'pointer' : 'default',
      borderBottom: noBorder ? 'none' : `1px solid ${t.divider}`,
    }}>
      <span style={{ color: danger ? t.danger : accent ? t.accent : t.textDim,
                     display: 'flex' }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: t.font, fontSize: 14,
                      color: danger ? t.danger : t.text }}>{label}</div>
        {sub && <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{sub}</div>}
      </div>
      {trailing || <I.Chevron size={14} style={{ color: t.textFaint }}/>}
    </div>
  );
}

// ─── 11. Contact profile with MITM alert ─────────────────────────────────
function ScreenContact({ t, nav, contact }) {
  const c = contact || { name: '0xC3F…91A', color: '#06b6d4' };
  const keyChanged = c.id !== 1; // demo: alert state for non-satoshi
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBarX t={t} title="Contact"
        left={<button onClick={() => nav('home')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}
        right={<I.More size={20} style={{ color: t.textDim }}/>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0 22px' }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '14px 22px 18px',
        }}>
          <window.Avatar t={t} name={c.name} color={c.color} size={88}/>
          <div style={{
            fontFamily: c.name.includes('.') || c.name.startsWith('0x') ? t.fontMono : t.fontDisplay,
            fontSize: 24, marginTop: 14, color: t.text,
            fontStyle: t.italic && !c.name.includes('.') ? 'italic' : 'normal',
            fontWeight: t.displayWeight,
            letterSpacing: '-0.01em',
          }}>{c.name}</div>
          <div style={{
            fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
            letterSpacing: '0.04em', marginTop: 4,
          }}>aegis · added 14d ago</div>

          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <ContactAction t={t} icon={<I.Chat size={20}/>}  label="Chat"   onClick={() => nav('chat', c)}/>
            <ContactAction t={t} icon={<I.Phone size={20}/>} label="Call"   onClick={() => nav('call', c)}/>
            <ContactAction t={t} icon={<I.Video size={20}/>} label="Video"  onClick={() => nav('call', c)}/>
            <ContactAction t={t} icon={<I.Mute size={20}/>}  label="Mute"/>
          </div>
        </div>

        {keyChanged && (
          <div style={{
            margin: '0 18px 18px', padding: 14,
            background: t.dark ? 'rgba(255,107,107,0.08)' : 'rgba(184,68,42,0.06)',
            border: `1px solid ${t.danger}55`,
            borderRadius: t.radius,
            display: 'flex', gap: 12, alignItems: 'flex-start',
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: t.danger, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, fontFamily: t.font, fontWeight: 700, fontSize: 16,
            }}>!</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14,
                            color: t.danger, marginBottom: 4 }}>
                La clave de este contacto cambió
              </div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim,
                            lineHeight: 1.45, marginBottom: 10 }}>
                Pudo cambiar de dispositivo — o alguien intenta interponerse
                (MITM). Vuelve a verificar antes de enviar nada sensible.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => nav('verify')} style={{
                  background: t.danger, color: '#fff', border: 'none',
                  borderRadius: t.radiusS, padding: '7px 14px',
                  fontFamily: t.font, fontSize: 12, fontWeight: 600,
                  cursor: 'pointer',
                }}>Re-verificar</button>
                <button onClick={() => nav('chat')} style={{
                  background: 'transparent', color: t.text,
                  border: `1px solid ${t.borderStrong}`,
                  borderRadius: t.radiusS, padding: '7px 14px',
                  fontFamily: t.font, fontSize: 12, cursor: 'pointer',
                }}>Confiar igualmente</button>
              </div>
            </div>
          </div>
        )}

        <SectionX t={t} label="CLAVE PÚBLICA">
          <div style={{ padding: '14px 16px' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6,
            }}>
              {['9b41', 'd0c2', '7e3a', 'f51b', '8e07', '4cd3', 'a290', '6f1e'].map(f => (
                <div key={f} style={{
                  fontFamily: t.fontMono, fontSize: 12, color: t.text,
                  padding: '6px 4px', background: t.surface2,
                  borderRadius: t.radiusS, textAlign: 'center',
                }}>{f}</div>
              ))}
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginTop: 12,
            }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 10,
                             color: keyChanged ? t.danger : t.accent,
                             letterSpacing: '0.06em' }}>
                {keyChanged ? '⚠ CHANGED · 2H AGO' : '✓ VERIFIED IN PERSON · 8 DAYS AGO'}
              </span>
              <button onClick={() => nav('verify')} style={{
                background: 'transparent', border: `1px solid ${t.borderStrong}`,
                borderRadius: t.radiusS, padding: '4px 10px',
                fontFamily: t.fontMono, fontSize: 10, color: t.text, cursor: 'pointer',
                letterSpacing: '0.04em',
              }}>VERIFY</button>
            </div>
          </div>
        </SectionX>

        <SectionX t={t} label="ESTA CONVERSACIÓN">
          <RowX t={t} icon={<I.Timer size={18}/>} label="Mensajes que se queman" sub="Cada 24 horas" onClick={() => nav('ephemeral')}/>
          <RowX t={t} icon={<I.EyeOff size={18}/>} label="Modo confianza cero" sub="Bloquear envío si la clave cambia"/>
          <RowX t={t} icon={<I.Bell size={18}/>} label="Notificaciones"/>
          <RowX t={t} icon={<I.Trash size={18}/>} label="Vaciar y bloquear" danger noBorder/>
        </SectionX>
      </div>
    </div>
  );
}

function ContactAction({ t, icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{
      width: 64, padding: '10px 0', cursor: 'pointer',
      background: t.surface, border: `1px solid ${t.border}`,
      borderRadius: t.radius, color: t.text,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      fontFamily: t.fontMono, fontSize: 9, letterSpacing: '0.06em',
    }}>
      <span style={{ color: t.accent }}>{icon}</span>
      <span>{label.toUpperCase()}</span>
    </button>
  );
}

// ─── 12. Linked devices ──────────────────────────────────────────────────
function ScreenDevices({ t, nav }) {
  const [devices, setDevices] = React.useState([
    { id: 1, name: 'iPhone 15 Pro',  os: 'iOS 18.4',    loc: 'Zurich, CH',  ago: 'now',       active: true,  this: true },
    { id: 2, name: 'MBP M3',         os: 'macOS 14.5',  loc: 'Zurich, CH',  ago: '8 min ago', active: true },
    { id: 3, name: 'iPad Air',       os: 'iPadOS 18.4', loc: 'Zurich, CH',  ago: '2 days ago' },
    { id: 4, name: 'Linux (Wayland)',os: 'Aegis 0.9.2', loc: 'Berlin, DE',  ago: '5 days ago' },
  ]);

  const revoke = (id) => {
    setDevices(prev => prev.filter(d => d.id !== id));
  };

  const revokeAllOthers = () => {
    setDevices(prev => prev.filter(d => d.this));
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBarX t={t} title="Devices" big
        left={<button onClick={() => nav('profile')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}
        right={<button onClick={() => nav('verify')} style={btnIcon(t)}><I.Plus size={22}/></button>}/>

      <div style={{
        margin: '0 18px 14px', padding: '12px 14px',
        background: t.surface, border: `1px solid ${t.border}`,
        borderRadius: t.radius, fontFamily: t.font, fontSize: 13,
        color: t.textDim, lineHeight: 1.5,
      }}>
        Cada dispositivo tiene su propia clave. Si pierdes uno, revócalo
        aquí — sus mensajes nuevos quedarán ilegibles al instante.
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 22px' }}>
        {devices.map((d) => (
          <div key={d.id} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 18px',
            borderBottom: `1px solid ${t.divider}`,
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: t.radius,
              background: t.surface2, color: t.text,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {d.name.startsWith('iPhone') ? <I.Phone size={18}/> :
               d.name.startsWith('iPad')   ? <I.Phone size={18}/> :
               <I.Building size={18}/>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>{d.name}</span>
                {d.this && <span style={{
                  fontFamily: t.fontMono, fontSize: 9, color: t.accent,
                  letterSpacing: '0.06em', padding: '1px 5px',
                  border: `1px solid ${t.accent}`, borderRadius: 99,
                }}>THIS DEVICE</span>}
              </div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                {d.os} · {d.loc} · {d.ago}
              </div>
            </div>
            {!d.this && (
              <button onClick={() => revoke(d.id)} style={{
                background: 'transparent', border: `1px solid ${t.danger}55`,
                color: t.danger, borderRadius: t.radiusS,
                padding: '5px 10px', fontFamily: t.fontMono, fontSize: 10,
                letterSpacing: '0.06em', cursor: 'pointer',
              }}>REVOKE</button>
            )}
            {d.active && d.this && (
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: t.accent,
              }}/>
            )}
          </div>
        ))}

        <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <window.PrimaryButton t={t} onClick={() => nav('verify')}>+ Vincular nuevo dispositivo</window.PrimaryButton>
          <window.GhostButton t={t} onClick={revokeAllOthers}>Cerrar todas las demás sesiones</window.GhostButton>
        </div>
      </div>
    </div>
  );
}

// ─── 13. Panic mode setup ────────────────────────────────────────────────
function ScreenPanic({ t, nav }) {
  const [gesture, setGesture] = React.useState('shake');
  const [duressPin, setDuressPin] = React.useState(true);
  const [autoWipe, setAutoWipe] = React.useState(false);
  const [hidePin, setHidePin] = React.useState(false);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBarX t={t} title="Modo pánico"
        left={<button onClick={() => nav('profile')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0 22px' }}>
        <div style={{ padding: '14px 28px 22px', textAlign: 'center' }}>
          <div style={{
            margin: '0 auto 16px', width: 76, height: 76, borderRadius: '50%',
            background: t.dark ? 'rgba(255,107,107,0.12)' : 'rgba(184,68,42,0.08)',
            border: `1px solid ${t.danger}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: t.danger,
          }}><I.Shield size={32} stroke={1.8}/></div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 24,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight,
            letterSpacing: '-0.02em',
          }}>Si te obligan a abrir la app</div>
          <div style={{
            fontFamily: t.font, fontSize: 13, color: t.textDim,
            marginTop: 10, lineHeight: 1.5, maxWidth: 290, margin: '10px auto 0',
          }}>
            AegisLink puede borrar tus chats al instante, o mostrar una
            cuenta vacía bajo un PIN de coacción.
          </div>
        </div>

        <SectionX t={t} label="GESTO DE PÁNICO">
          {[
            { id: 'off',   l: 'Desactivado',         s: 'Sin gesto' },
            { id: 'shake', l: 'Sacudir 3 veces',     s: 'Funciona con pantalla apagada' },
            { id: 'volume',l: 'Volumen-volumen+volumen−', s: 'Botones físicos · 3s' },
            { id: 'tap',   l: 'Triple toque al logo', s: 'Discreto' },
          ].map((o, i, arr) => (
            <div key={o.id} onClick={() => setGesture(o.id)} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 16px', cursor: 'pointer',
              borderBottom: i < arr.length - 1 ? `1px solid ${t.divider}` : 'none',
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: '50%',
                border: `2px solid ${gesture === o.id ? t.danger : t.borderStrong}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {gesture === o.id && <div style={{
                  width: 9, height: 9, borderRadius: '50%', background: t.danger,
                }}/>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: t.font, fontSize: 14,
                              fontWeight: gesture === o.id ? 600 : 400 }}>{o.l}</div>
                <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                  {o.s}
                </div>
              </div>
            </div>
          ))}
        </SectionX>

        <SectionX t={t} label="PIN DE COACCIÓN">
          <ToggleX t={t} label="Activar PIN señuelo" sub="Abre una cuenta limpia. Lo que ven los demás: nada." value={duressPin} onChange={setDuressPin}/>
          {duressPin && !hidePin && (
            <div style={{ padding: '0 16px 12px' }}>
              <div style={{
                fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                letterSpacing: '0.06em', marginBottom: 8,
              }}>PIN ACTUAL</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {['●','●','●','●','●','●'].map((d, i) => (
                  <div key={i} style={{
                    flex: 1, height: 38, background: t.surface2,
                    borderRadius: t.radiusS, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    color: t.text, fontSize: 18,
                  }}>{d}</div>
                ))}
              </div>
            </div>
          )}
          {duressPin && (
            <ToggleX t={t} label="Ocultar longitud del PIN" sub="No muestra los puntos" value={hidePin} onChange={setHidePin}/>
          )}
          <RowX t={t} label="Cambiar PIN señuelo" onClick={() => {}} noBorder/>
        </SectionX>

        <SectionX t={t} label="BORRADO AUTOMÁTICO">
          <ToggleX t={t} label="Auto-wipe tras intentos fallidos" sub="10 PINs incorrectos seguidos" value={autoWipe} onChange={setAutoWipe} noBorder/>
        </SectionX>

        <div style={{ padding: '0 18px' }}>
          <button onClick={() => nav('lock')} style={{
            width: '100%', background: t.danger, color: '#fff',
            border: 'none', borderRadius: t.radius, padding: '14px',
            fontFamily: t.font, fontWeight: 600, fontSize: 14,
            cursor: 'pointer', letterSpacing: '-0.01em',
          }}>Probar gesto ahora</button>
        </div>
      </div>
    </div>
  );
}

// ─── 14. Anonymous poll inside a group ───────────────────────────────────
function ScreenPoll({ t, nav }) {
  const [voted, setVoted] = React.useState(null);
  const [options, setOptions] = React.useState([
    { id: 'a', l: 'Cure53',             votes: 9 },
    { id: 'b', l: 'Trail of Bits',      votes: 6 },
    { id: 'c', l: 'Quarkslab',          votes: 4 },
    { id: 'd', l: 'NCC Group',          votes: 2 },
  ]);

  const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);

  const handleVote = (id) => {
    if (voted) return; // Only allow one vote
    setVoted(id);
    setOptions(prev => prev.map(o => o.id === id ? { ...o, votes: o.votes + 1 } : o));
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
        borderBottom: `1px solid ${t.divider}`, flexShrink: 0,
      }}>
        <button onClick={() => nav('groups')} style={btnIcon(t)}><I.ChevronL size={22}/></button>
        <div style={{
          width: 36, height: 36, borderRadius: t.radiusL,
          background: '#f59e0b22', color: '#f59e0b',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><I.Users size={18}/></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 15 }}>DAO · Treasury</div>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                        letterSpacing: '0.06em', marginTop: 1 }}>
            <I.Lock size={9} style={{ verticalAlign: '-1px', marginRight: 3 }}/>
            E2EE · MLS · 5 MEMBERS
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 22px' }}>
        {/* poll card */}
        <div style={{
          background: t.surface, borderRadius: t.radius,
          border: `1px solid ${t.borderStrong}`, padding: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <span style={{
              fontFamily: t.fontMono, fontSize: 10, color: t.accent,
              letterSpacing: '0.08em', padding: '2px 7px',
              border: `1px solid ${t.accent}`, borderRadius: 99,
            }}>ANONYMOUS POLL</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                           letterSpacing: '0.04em' }}>· VOTES MIXED</span>
          </div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 20,
            fontStyle: t.italic ? 'italic' : 'normal',
            fontWeight: t.displayWeight,
            letterSpacing: '-0.01em', lineHeight: 1.2, marginBottom: 14,
          }}>¿Qué firma para el audit Q3?</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {options.map(o => {
              const sel = voted === o.id;
              const pct = totalVotes > 0 ? Math.round((o.votes / totalVotes) * 100) : 0;
              return (
                <button key={o.id} onClick={() => handleVote(o.id)} style={{
                  position: 'relative', overflow: 'hidden',
                  padding: '10px 14px', background: t.surface2,
                  border: `1px solid ${sel ? t.accent : t.border}`,
                  borderRadius: t.radius, cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 10, color: t.text,
                }}>
                  {voted && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      width: `${pct}%`,
                      background: sel ? t.accent + '33' : t.accent + '12',
                    }}/>
                  )}
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: '50%',
                      border: `2px solid ${sel ? t.accent : t.borderStrong}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {sel && <div style={{ width: 7, height: 7, borderRadius: '50%', background: t.accent }}/>}
                    </div>
                    <span style={{ fontFamily: t.font, fontSize: 14, fontWeight: sel ? 600 : 400 }}>{o.l}</span>
                  </div>
                  {voted && (
                    <span style={{
                      position: 'relative', fontFamily: t.fontMono, fontSize: 12,
                      color: t.textDim,
                    }}>{o.pct}% · {o.votes}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={{
            marginTop: 14, padding: '10px 12px',
            background: t.surface2, borderRadius: t.radiusS,
            display: 'flex', alignItems: 'center', gap: 8,
            fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
            letterSpacing: '0.04em',
          }}>
            <I.EyeOff size={13}/>
            <span>Tu voto no se vincula a tu identidad. Solo se cuenta el total.</span>
          </div>
        </div>

        {/* a couple of context messages */}
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { name: 'Alex',  text: 'Pueden empezar en julio. Presupuesto cubierto.' },
            { name: 'Maya',  text: 'Voto ya. Cerramos antes del viernes?' },
          ].map((m, i) => (
            <div key={i} style={{
              alignSelf: 'flex-start', maxWidth: '78%',
              padding: '8px 12px', background: t.bubbleIn,
              borderRadius: t.radius, color: t.bubbleInText,
              fontFamily: t.font, fontSize: 13,
            }}>
              <div style={{ fontFamily: t.fontMono, fontSize: 10,
                            color: t.accent, letterSpacing: '0.04em', marginBottom: 2 }}>
                {m.name.toUpperCase()}
              </div>
              {m.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 15. Scheduled messages ──────────────────────────────────────────────
function ScreenScheduled({ t, nav }) {
  const items = [
    { to: 'satoshi.eth',     text: 'Recordatorio: firmar el multisig antes de las 18:00', when: 'Hoy 17:30',  in: 'en 4h 12m' },
    { to: 'DAO · Treasury',  text: 'Reunión semanal en 15min. Agenda en el thread.',       when: 'Mañana 09:45', in: 'mañana' },
    { to: 'vitalik.lens',    text: 'Spec revisada. Comentarios en p. 14 y 22.',           when: 'Lun 08:00',  in: 'lun' },
    { to: '0xC3F…91A',       text: 'attachment · audit-report-final.pdf',                  when: '01.06 12:00', in: 'jun 1' },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: t.bg, color: t.text, overflow: 'hidden' }}>
      <TopBarX t={t} title="Programados" big
        left={<button onClick={() => nav('home')} style={btnIcon(t)}><I.ChevronL size={22}/></button>}
        right={<button onClick={() => nav('chat')} style={btnIcon(t)}><I.Plus size={22}/></button>}/>

      <div style={{
        margin: '0 18px 14px', padding: '12px 14px',
        background: t.surface, border: `1px solid ${t.border}`,
        borderRadius: t.radius, fontFamily: t.font, fontSize: 13,
        color: t.textDim, lineHeight: 1.5,
      }}>
        Se cifran y envían a la hora exacta. Hasta entonces se guardan
        sólo aquí, en tu dispositivo.
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 22px' }}>
        {items.map((it, i) => (
          <div key={i} style={{
            display: 'flex', gap: 12,
            padding: '14px 18px',
            borderBottom: `1px solid ${t.divider}`,
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: t.radius,
              background: t.surface2, color: t.accent,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}><I.Timer size={18}/></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'baseline', gap: 8, marginBottom: 4,
              }}>
                <span style={{
                  fontFamily: it.to.includes('.') || it.to.startsWith('0x') ? t.fontMono : t.font,
                  fontWeight: 600, fontSize: 13, color: t.text,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{it.to}</span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                               letterSpacing: '0.04em', flexShrink: 0 }}>{it.in.toUpperCase()}</span>
              </div>
              <div style={{
                fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 1.4,
              }}>{it.text}</div>
              <div style={{
                fontFamily: t.fontMono, fontSize: 10, color: t.textFaint,
                marginTop: 4, letterSpacing: '0.06em',
              }}>{it.when.toUpperCase()}</div>
            </div>
          </div>
        ))}

        <div style={{ padding: '14px 18px' }}>
          <window.GhostButton t={t}>+ Nuevo mensaje programado</window.GhostButton>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  ScreenProfile, ScreenContact, ScreenDevices, ScreenPanic, ScreenPoll, ScreenScheduled,
});
