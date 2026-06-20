// AegisLink — brand identity sheet
// Renders one theme's identity (logo, palette, type, principles).

function BrandSheet({ t }) {
  const swatches = [
    { name: 'Background', val: t.bg },
    { name: 'Surface',    val: t.surface },
    { name: 'Surface 2',  val: t.surface2 },
    { name: 'Text',       val: t.text },
    { name: 'Accent',     val: t.accent },
    { name: 'Accent ink', val: t.accentInk },
  ];

  return (
    <div style={{
      width: 720, padding: '48px 56px', background: t.bg, color: t.text,
      fontFamily: t.font, boxShadow: '0 1px 0 rgba(0,0,0,0.04)',
      minHeight: 900, display: 'flex', flexDirection: 'column', gap: 36,
    }}>
      {/* header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        paddingBottom: 22, borderBottom: `1px solid ${t.border}`,
      }}>
        <div>
          <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent,
                        letterSpacing: '0.1em', marginBottom: 6 }}>
            DIRECTION · {t.name.toUpperCase()}
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{
              fontFamily: '"EB Garamond", Garamond, serif',
              fontWeight: 500, fontSize: 84,
              letterSpacing: '-0.01em', lineHeight: 0.95, color: t.text,
            }}>AegisLink</span>
          </div>
          <div style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, maxWidth: 460 }}>
            {t.tag}
          </div>
        </div>
        <window.AegisMark t={t} size={64}/>
      </div>

      {/* mark variations */}
      <Block t={t} label="MARK">
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <MarkCard t={t} bg={t.bg} label="On dark/light">
            <window.AegisMark t={t} size={72}/>
          </MarkCard>
          <MarkCard t={t} bg={t.surface} label="On surface">
            <window.AegisMark t={t} size={72}/>
          </MarkCard>
          <MarkCard t={t} bg={t.accent} label="Inverted">
            <div style={{ color: t.accentInk }}><window.AegisMark t={t} size={72} mono/></div>
          </MarkCard>
          <MarkCard t={t} bg={t.bg} label="Wordmark + mark">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <window.AegisMark t={t} size={28}/>
              <window.AegisWord t={t} size={22}/>
            </div>
          </MarkCard>
        </div>
      </Block>

      {/* palette */}
      <Block t={t} label="PALETTE">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 10 }}>
          {swatches.map(s => (
            <div key={s.name}>
              <div style={{
                height: 78, background: s.val,
                border: `1px solid ${t.border}`, borderRadius: t.radius,
              }}/>
              <div style={{
                fontFamily: t.fontMono, fontSize: 10, color: t.text,
                marginTop: 8, letterSpacing: '0.04em',
              }}>{s.name}</div>
              <div style={{
                fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                letterSpacing: '0.04em',
              }}>{s.val}</div>
            </div>
          ))}
        </div>
      </Block>

      {/* type */}
      <Block t={t} label="TYPOGRAPHY">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                          letterSpacing: '0.1em', marginBottom: 8 }}>DISPLAY</div>
            <div style={{
              fontFamily: t.fontDisplay, fontSize: 48,
              fontStyle: t.italic ? 'italic' : 'normal',
              fontWeight: t.displayWeight,
              letterSpacing: '-0.03em', lineHeight: 1,
            }}>Privacy.</div>
            <div style={{
              fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
              marginTop: 6, letterSpacing: '0.04em',
            }}>{t.fontDisplay.split(',')[0].replace(/"/g,'')}</div>
          </div>
          <div>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                          letterSpacing: '0.1em', marginBottom: 8 }}>BODY</div>
            <div style={{ fontFamily: t.font, fontSize: 16, lineHeight: 1.45,
                          color: t.text, marginBottom: 4 }}>
              End-to-end encrypted messaging, anchored to your device key.
            </div>
            <div style={{
              fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
              marginTop: 8, letterSpacing: '0.04em',
            }}>{t.font.split(',')[0].replace(/"/g,'')}</div>
          </div>
          <div>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                          letterSpacing: '0.1em', marginBottom: 8 }}>MONO</div>
            <div style={{ fontFamily: t.fontMono, fontSize: 16, color: t.text }}>
              7K9-PQ2M-X4VR<br/>
              a7f3·92e1·b4c8·5d0a
            </div>
            <div style={{
              fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
              marginTop: 8, letterSpacing: '0.04em',
            }}>{t.fontMono.split(',')[0].replace(/"/g,'')}</div>
          </div>
          <div>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                          letterSpacing: '0.1em', marginBottom: 8 }}>SCALE</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 34 }}>34</span>
              <span style={{ fontFamily: t.fontDisplay, fontSize: 22 }}>22</span>
              <span style={{ fontFamily: t.font, fontSize: 16 }}>16</span>
              <span style={{ fontFamily: t.font, fontSize: 13 }}>13</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 11 }}>11</span>
            </div>
          </div>
        </div>
      </Block>

      {/* principles */}
      <Block t={t} label="PRINCIPLES">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {[
            { n: '01', h: 'Anonymous by default', b: 'No phone, no email — only a locally-generated keypair.' },
            { n: '02', h: 'Zero metadata',         b: 'Servers never see who talks to whom, or when.' },
            { n: '03', h: 'Open & audited',        b: 'Source public, infrastructure ours, Swiss jurisdiction.' },
            { n: '04', h: 'Verify the person',     b: 'Trust is established by comparing key fingerprints.' },
          ].map(p => (
            <div key={p.n} style={{
              padding: 16, border: `1px solid ${t.border}`,
              borderRadius: t.radius, background: t.surface,
            }}>
              <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent,
                            letterSpacing: '0.1em', marginBottom: 6 }}>{p.n}</div>
              <div style={{
                fontFamily: t.fontDisplay, fontSize: 18,
                fontStyle: t.italic ? 'italic' : 'normal',
                fontWeight: t.displayWeight,
                letterSpacing: '-0.01em', marginBottom: 4,
              }}>{p.h}</div>
              <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 1.45 }}>
                {p.b}
              </div>
            </div>
          ))}
        </div>
      </Block>
    </div>
  );
}

function Block({ t, label, children }) {
  return (
    <div>
      <div style={{
        fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
        letterSpacing: '0.12em', marginBottom: 14,
      }}>{label}</div>
      {children}
    </div>
  );
}

function MarkCard({ t, bg, label, children }) {
  return (
    <div>
      <div style={{
        width: 140, height: 110, background: bg,
        border: `1px solid ${t.border}`, borderRadius: t.radius,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{children}</div>
      <div style={{
        fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
        marginTop: 8, letterSpacing: '0.04em',
      }}>{label}</div>
    </div>
  );
}

Object.assign(window, { BrandSheet });
