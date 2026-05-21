// AegisLink Work — enterprise admin dashboard (one per direction)

function WorkDashboard({ t }) {
  const teams = [
    { name: 'Engineering',   members: 24, devices: 41, mfa: '100%' },
    { name: 'Legal',         members: 8,  devices: 11, mfa: '100%' },
    { name: 'Treasury Ops',  members: 5,  devices: 7,  mfa: '100%' },
    { name: 'Field Research',members: 14, devices: 19, mfa: '92%'  },
    { name: 'External Audit',members: 3,  devices: 4,  mfa: '100%' },
  ];

  const incidents = [
    { time: '14:02', sev: 'info', msg: 'Key rotation completed for Treasury Ops (5 members)' },
    { time: '11:48', sev: 'warn', msg: 'Field Research · 1 device pending re-verification' },
    { time: '09:12', sev: 'info', msg: 'New relay deployed · zurich-3.aegis.swiss' },
    { time: '08:30', sev: 'ok',   msg: 'Daily attestation passed · all relays' },
  ];

  return (
    <div style={{
      width: 1280, minHeight: 820, background: t.bg, color: t.text,
      fontFamily: t.font, display: 'grid',
      gridTemplateColumns: '232px 1fr',
    }}>
      {/* sidebar */}
      <aside style={{
        background: t.surface, borderRight: `1px solid ${t.border}`,
        padding: '24px 18px', display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                      padding: '4px 4px 22px', borderBottom: `1px solid ${t.divider}`,
                      marginBottom: 16 }}>
          <window.AegisMark t={t} size={26}/>
          <div>
            <window.AegisWord t={t} size={15}/>
            <div style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent,
                          letterSpacing: '0.1em', marginTop: 3 }}>WORK · ADMIN</div>
          </div>
        </div>

        {[
          { i: window.I.Building, l: 'Overview', a: true },
          { i: window.I.Users,    l: 'Members & teams' },
          { i: window.I.Shield,   l: 'Devices' },
          { i: window.I.Key,      l: 'Keys & rotation' },
          { i: window.I.Globe,    l: 'Relays' },
          { i: window.I.Bell,     l: 'Audit log' },
          { i: window.I.Settings, l: 'Policy' },
        ].map(it => (
          <div key={it.l} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 10px', borderRadius: t.radiusS,
            color: it.a ? t.text : t.textDim,
            background: it.a ? t.surface2 : 'transparent',
            fontFamily: t.font, fontSize: 13,
            fontWeight: it.a ? 600 : 400, cursor: 'pointer',
          }}>
            <it.i size={16} stroke={1.8}/>
            <span>{it.l}</span>
          </div>
        ))}

        <div style={{ flex: 1 }}/>
        <div style={{
          padding: 14, border: `1px solid ${t.border}`, borderRadius: t.radius,
          background: t.surface2,
        }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                        letterSpacing: '0.1em', marginBottom: 6 }}>● SELF-HOSTED</div>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.text, lineHeight: 1.4 }}>
            zurich-prime · v0.9.2<br/>
            <span style={{ color: t.textDim }}>4 relays · 99.99% uptime</span>
          </div>
        </div>
      </aside>

      {/* main */}
      <main style={{ padding: '28px 36px', overflow: 'hidden' }}>
        {/* header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
          marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${t.divider}`,
        }}>
          <div>
            <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                          letterSpacing: '0.1em', marginBottom: 6 }}>ORGANIZATION · CIRRUS LABS AG</div>
            <div style={{
              fontFamily: t.fontDisplay, fontSize: 36,
              fontStyle: t.italic ? 'italic' : 'normal',
              fontWeight: t.displayWeight,
              letterSpacing: '-0.02em', lineHeight: 1,
            }}>Overview</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                           letterSpacing: '0.04em' }}>Updated 14:02 · CET</span>
            <button style={{
              background: t.accent, color: t.accentInk, border: 'none',
              borderRadius: t.radius, padding: '10px 18px',
              fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer',
            }}>+ Invite member</button>
          </div>
        </div>

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 28 }}>
          {[
            { l: 'ACTIVE MEMBERS',     v: '54',     d: '+3 this week' },
            { l: 'VERIFIED DEVICES',   v: '82',     d: 'of 82 enrolled' },
            { l: 'AVG. KEY AGE',       v: '21d',    d: 'policy: rotate <90d' },
            { l: 'METADATA STORED',    v: '0 B',    d: 'by design',  accent: true },
          ].map(k => (
            <div key={k.l} style={{
              padding: 20, border: `1px solid ${t.border}`,
              borderRadius: t.radius, background: t.surface,
            }}>
              <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                            letterSpacing: '0.1em', marginBottom: 14 }}>{k.l}</div>
              <div style={{
                fontFamily: t.fontDisplay, fontSize: 44,
                fontStyle: t.italic ? 'italic' : 'normal',
                fontWeight: t.displayWeight,
                letterSpacing: '-0.03em', lineHeight: 1,
                color: k.accent ? t.accent : t.text,
              }}>{k.v}</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 8 }}>
                {k.d}
              </div>
            </div>
          ))}
        </div>

        {/* two columns */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 18 }}>
          {/* Teams table */}
          <div style={{
            border: `1px solid ${t.border}`, borderRadius: t.radius,
            background: t.surface, overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '14px 18px', borderBottom: `1px solid ${t.divider}`,
            }}>
              <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>Teams</div>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                             letterSpacing: '0.06em' }}>{teams.length} TOTAL</span>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
              padding: '10px 18px', borderBottom: `1px solid ${t.divider}`,
              fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
              letterSpacing: '0.08em',
            }}>
              <span>TEAM</span><span>MEMBERS</span><span>DEVICES</span><span>2FA</span>
            </div>
            {teams.map((tm, i) => (
              <div key={tm.name} style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
                padding: '14px 18px', alignItems: 'center',
                borderBottom: i < teams.length - 1 ? `1px solid ${t.divider}` : 'none',
                fontFamily: t.font, fontSize: 14,
              }}>
                <span style={{ fontWeight: 500 }}>{tm.name}</span>
                <span style={{ fontFamily: t.fontMono, color: t.textDim }}>{tm.members}</span>
                <span style={{ fontFamily: t.fontMono, color: t.textDim }}>{tm.devices}</span>
                <span style={{
                  fontFamily: t.fontMono, fontSize: 12,
                  color: tm.mfa === '100%' ? t.accent : t.warn,
                }}>{tm.mfa}</span>
              </div>
            ))}
          </div>

          {/* Audit log */}
          <div style={{
            border: `1px solid ${t.border}`, borderRadius: t.radius,
            background: t.surface, overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '14px 18px', borderBottom: `1px solid ${t.divider}`,
            }}>
              <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>Audit log</div>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                             letterSpacing: '0.06em' }}>LIVE</span>
            </div>
            {incidents.map((it, i) => {
              const dot = it.sev === 'warn' ? t.warn : (it.sev === 'ok' ? t.accent : t.textDim);
              return (
                <div key={i} style={{
                  display: 'flex', gap: 10, padding: '12px 18px',
                  borderBottom: i < incidents.length - 1 ? `1px solid ${t.divider}` : 'none',
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', background: dot,
                    marginTop: 7, flexShrink: 0,
                  }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                                  letterSpacing: '0.06em', marginBottom: 3 }}>{it.time} CET</div>
                    <div style={{ fontFamily: t.font, fontSize: 13, color: t.text, lineHeight: 1.4 }}>
                      {it.msg}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* policy bar */}
        <div style={{
          marginTop: 18, padding: '14px 18px',
          border: `1px solid ${t.border}`, borderRadius: t.radius,
          background: t.surface, display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <window.I.Shield size={18} style={{ color: t.accent }}/>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.text, flex: 1 }}>
            <b>Policy enforced.</b> Devices require key verification before joining any group;
            messages older than 30 days are auto-burned for Treasury Ops.
          </span>
          <button style={{
            background: 'transparent', border: `1px solid ${t.borderStrong}`,
            borderRadius: t.radiusS, padding: '6px 12px',
            fontFamily: t.fontMono, fontSize: 11, color: t.text, cursor: 'pointer',
            letterSpacing: '0.04em',
          }}>EDIT POLICY</button>
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { WorkDashboard });
