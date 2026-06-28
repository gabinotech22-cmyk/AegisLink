// AegisLink — Sealed Public Channels screens
// Channels live INSIDE the Groups tab via a Groups/Channels segment.
// No new navbar tab. Theme-driven via `t`; each screen takes ({ t, nav, density, contact }).
// Design ref: docs/SEALED-PUBLIC-CHANNELS.md (Zerion-adapted wire protocol).

const { I: IC } = window;

const btnIconC = (t) => ({
  background: 'transparent', border: 'none', color: t.textDim,
  cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
});

function BarC({ t, title, left, right, big }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
      borderBottom: big ? 'none' : `1px solid ${t.divider}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: t.text }}>
        {left}
        <span style={{
          fontFamily: t.fontDisplay, fontWeight: t.displayWeight,
          fontStyle: t.italic ? 'italic' : 'normal',
          fontSize: big ? 28 : 18, letterSpacing: '-0.02em', color: t.text,
        }}>{title}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: t.textDim }}>{right}</div>
    </div>
  );
}

// "SEALED" badge — variant of the E2EE badge, signals always-encrypted posts.
function SealedBadge({ t, label = 'sealed' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontFamily: t.fontMono, fontSize: 9, fontWeight: 500, color: t.accent,
      padding: '1px 5px', border: `1px solid ${t.accent}`, borderRadius: t.radiusS,
      letterSpacing: '0.04em', textTransform: 'uppercase',
    }}>
      <IC.Lock size={9}/>{label}
    </span>
  );
}

// Local 3-tab bar — Verify was removed from the shipping nav (Chats · Groups · Privacy).
function TabBarC({ t, nav, current }) {
  const items = [
    { id: 'home',     label: 'Chats',   icon: IC.Chat,   to: 'home' },
    { id: 'groups',   label: 'Groups',  icon: IC.Users,  to: 'channels' },
    { id: 'settings', label: 'Privacy', icon: IC.Shield, to: 'settings' },
  ];
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-around', padding: '10px 8px 16px',
      flexShrink: 0, borderTop: `1px solid ${t.divider}`, background: t.surface,
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
            <span style={{ fontFamily: t.fontMono, fontSize: 9, letterSpacing: '0.08em',
                           fontWeight: active ? 600 : 400 }}>{it.label.toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Data ──────────────────────────────────────────────────────────────────
const SUBBED_CHANNELS = [
  { id: 'c1', name: 'Aegis Notes', last: 'Build 0.9.3 firmada y verificada…', count: '2', color: '#5bf2b9', sealed: true, type: 'readonly' },
  { id: 'c2', name: 'Privacy Daily', last: 'Análisis del leak de metadatos de…', count: '12k', color: '#a78bfa', type: 'open' },
  { id: 'c3', name: 'OpSec Field', last: 'Guía: rotación de claves en…', count: '847', color: '#f59e0b', type: 'moderated' },
];

const SUBBED_GROUPS = [
  { id: 'g1', name: 'DAO · Treasury', last: 'Votación anónima aprobada', count: '8', color: '#ec4899' },
  { id: 'g2', name: 'Squad Zurich', last: 'Bob: logs enviados', count: '5', color: '#5bf2b9' },
];

const DIRECTORY = [
  { id: 'd1', name: 'Privacy Daily', meta: '12k subs · abierto', type: 'open', color: '#a78bfa' },
  { id: 'd2', name: 'DAO Treasury', meta: '847 subs · moderado', type: 'moderated', color: '#ec4899' },
  { id: 'd3', name: 'OpSec Field', meta: 'privado · solicitar acceso', type: 'approval', color: '#f59e0b' },
  { id: 'd4', name: 'Crypto Signals', meta: '5.2k subs · abierto', type: 'open', color: '#5bf2b9' },
];

const FEED_POSTS = [
  { id: 'p1', author: 'admin · Aegis', role: 'admin', time: '12:42', color: '#5bf2b9',
    body: 'Build 0.9.3 firmada. Hash chain verificado en el dispositivo — el relay nunca vio quién publicó.', likes: 184, comments: 23 },
  { id: 'p2', author: 'editor · Mar', role: 'editor', time: '09:18', color: '#a78bfa',
    body: 'Delegación de editor activa. Publico sin la clave privada del canal.', likes: 92, comments: 7 },
];

// ─── 1. Groups tab with Groups/Channels segment ──────────────────────────────
function ScreenChannels({ t, nav }) {
  const [tab, setTab] = React.useState('channels');

  const segBtn = (id, label) => {
    const on = tab === id;
    return (
      <button onClick={() => setTab(id)} style={{
        flex: 1, border: 'none', cursor: 'pointer',
        fontFamily: t.font, fontSize: 12, fontWeight: 600, padding: '7px 0',
        borderRadius: t.radiusS, background: on ? t.accent : 'transparent',
        color: on ? t.accentInk : t.textDim, letterSpacing: '0.01em',
      }}>{label}</button>
    );
  };

  const channelRow = (c) => (
    <div key={c.id} onClick={() => nav('channelFeed', c)} style={{
      display: 'flex', alignItems: 'center', gap: 11, padding: '11px 15px',
      cursor: 'pointer', borderBottom: `1px solid ${t.divider}`,
    }}>
      <div style={{
        width: 42, height: 42, borderRadius: t.radiusL, flexShrink: 0,
        background: c.color + '22', color: c.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><IC.Globe size={20}/></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14, color: t.text,
                      display: 'flex', alignItems: 'center', gap: 6 }}>
          {c.name} {c.sealed && <SealedBadge t={t}/>}
        </div>
        <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.last}
        </div>
      </div>
      <div style={{ fontFamily: t.fontMono, fontSize: 9, padding: '2px 6px', borderRadius: 99,
                    background: t.surface2, color: t.textFaint }}>{c.count}</div>
    </div>
  );

  const groupRow = (g) => (
    <div key={g.id} onClick={() => nav('chat', { ...g, group: true })} style={{
      display: 'flex', alignItems: 'center', gap: 11, padding: '11px 15px',
      cursor: 'pointer', borderBottom: `1px solid ${t.divider}`,
    }}>
      <div style={{
        width: 42, height: 42, borderRadius: t.radiusL, flexShrink: 0,
        background: g.color + '22', color: g.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><IC.Users size={20}/></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14, color: t.text }}>{g.name}</div>
        <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2 }}>{g.last}</div>
      </div>
      <div style={{ fontFamily: t.fontMono, fontSize: 9, padding: '2px 6px', borderRadius: 99,
                    background: t.surface2, color: t.textFaint }}>{g.count}</div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarC t={t} title="Groups" big
        right={<button onClick={() => nav(tab === 'channels' ? 'channelCreate' : 'emptyGroups')} style={btnIconC(t)}><IC.Plus size={22}/></button>}/>

      <div style={{ display: 'flex', gap: 4, margin: '2px 14px 8px', background: t.surface,
                    border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 3 }}>
        {segBtn('groups', 'Groups')}
        {segBtn('channels', 'Channels')}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'channels' ? (
          <>
            {SUBBED_CHANNELS.map(channelRow)}
            <button onClick={() => nav('channelDiscover')} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              margin: '12px 15px', padding: 12, width: 'calc(100% - 30px)',
              border: `1px dashed ${t.borderStrong}`, borderRadius: t.radius, background: 'transparent',
              color: t.accent, fontFamily: t.font, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}><IC.Search size={16}/> Discover channels</button>
          </>
        ) : (
          <>
            {SUBBED_GROUPS.map(groupRow)}
            <button onClick={() => nav('emptyGroups')} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              margin: '12px 15px', padding: 12, width: 'calc(100% - 30px)',
              border: `1px dashed ${t.borderStrong}`, borderRadius: t.radius, background: 'transparent',
              color: t.accent, fontFamily: t.font, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}><IC.Plus size={16}/> New group</button>
          </>
        )}
      </div>

      <TabBarC t={t} nav={nav} current="groups"/>
    </div>
  );
}

// ─── 2. Channel feed (broadcast view) ────────────────────────────────────────
function ScreenChannelFeed({ t, nav, contact }) {
  const c = contact || SUBBED_CHANNELS[0];
  const typeLabel = { open: 'cualquiera publica', readonly: 'solo admins publican',
                      moderated: 'posts moderados', approval: 'acceso aprobado' }[c.type] || 'public';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px' }}>
        <button onClick={() => nav('channels')} style={btnIconC(t)}><IC.ChevronL size={22}/></button>
        <button onClick={() => nav('channelInfo', c)} style={btnIconC(t)}><IC.More size={22}/></button>
      </div>

      <div style={{ padding: '4px 15px 14px', borderBottom: `1px solid ${t.border}`, textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: t.radiusL, margin: '0 auto 9px',
          background: 'rgba(91,242,185,0.12)', color: t.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><IC.Globe size={26}/></div>
        <div style={{ fontFamily: t.fontDisplay, fontWeight: t.displayWeight,
                      fontStyle: t.italic ? 'italic' : 'normal', fontSize: 18, letterSpacing: '-0.01em',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          {c.name} <SealedBadge t={t}/>
        </div>
        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginTop: 5, letterSpacing: '0.03em' }}>
          PUBLIC · {c.count} subs · {typeLabel}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {FEED_POSTS.map(p => (
          <div key={p.id} style={{ padding: '12px 15px', borderBottom: `1px solid ${t.divider}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
              <div style={{ width: 24, height: 24, borderRadius: t.radiusS, flexShrink: 0,
                            background: p.color + '22', color: p.color,
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {p.role === 'editor' ? <IC.Key size={12}/> : <IC.Shield size={12}/>}
              </div>
              <span style={{ fontFamily: t.font, fontSize: 12, fontWeight: 600 }}>{p.author}</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, marginLeft: 'auto' }}>{p.time}</span>
            </div>
            <div style={{ fontFamily: t.font, fontSize: 13, lineHeight: 1.5, color: t.text }}>{p.body}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
              <span style={reactPill(t)}><IC.Check size={11}/> {p.likes}</span>
              <span style={reactPill(t)}><IC.Chat size={11}/> {p.comments}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function reactPill(t) {
  return {
    fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
    display: 'inline-flex', alignItems: 'center', gap: 4,
    border: `1px solid ${t.border}`, borderRadius: 99, padding: '2px 7px',
  };
}

// ─── 3. Discover (public directory) ──────────────────────────────────────────
function ScreenChannelDiscover({ t, nav }) {
  const typeChip = { open: 'Join', moderated: 'Join', approval: 'Apply' };
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarC t={t} title="Discover"
        left={<button onClick={() => nav('channels')} style={btnIconC(t)}><IC.ChevronL size={22}/></button>}
        right={<button style={btnIconC(t)}><IC.Search size={20}/></button>}/>

      <div style={{ padding: '12px 15px 8px', fontFamily: t.fontMono, fontSize: 10,
                    color: t.textFaint, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        Directorio público · manifests firmados
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {DIRECTORY.map(d => {
          const isApply = d.type === 'approval';
          return (
            <div key={d.id} onClick={() => nav('channelFeed', { ...d, count: d.meta.split(' ')[0] })} style={{
              display: 'flex', alignItems: 'center', gap: 11, padding: '11px 15px',
              cursor: 'pointer', borderBottom: `1px solid ${t.divider}`,
            }}>
              <div style={{ width: 42, height: 42, borderRadius: t.radiusL, flexShrink: 0,
                            background: d.color + '22', color: d.color,
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isApply ? <IC.Lock size={19}/> : <IC.Globe size={20}/>}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14, color: t.text,
                              display: 'flex', alignItems: 'center', gap: 6 }}>
                  {d.name}
                  {isApply && <span style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent,
                    border: `1px solid ${t.accent}`, borderRadius: t.radiusS, padding: '1px 4px',
                    letterSpacing: '0.04em', textTransform: 'uppercase' }}>aprob.</span>}
                </div>
                <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2 }}>{d.meta}</div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); nav('channelFeed', { ...d, count: d.meta.split(' ')[0] }); }}
                style={isApply ? {
                  fontFamily: t.font, fontSize: 11, fontWeight: 600, color: t.accent,
                  background: 'transparent', border: `1px solid ${t.borderStrong}`,
                  borderRadius: t.radiusS, padding: '5px 12px', cursor: 'pointer', flexShrink: 0,
                } : {
                  fontFamily: t.font, fontSize: 11, fontWeight: 600, color: t.accentInk,
                  background: t.accent, border: 'none', borderRadius: t.radiusS,
                  padding: '5px 12px', cursor: 'pointer', flexShrink: 0,
                }}>{typeChip[d.type]}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 4. Create channel ───────────────────────────────────────────────────────
function ScreenChannelCreate({ t, nav }) {
  const [type, setType] = React.useState('open');
  const types = [
    { id: 'open', label: 'Abierto', desc: 'Cualquiera publica' },
    { id: 'readonly', label: 'Solo lectura', desc: 'Solo admins publican' },
    { id: 'moderated', label: 'Moderado', desc: 'Posts en cola de aprobación' },
    { id: 'approval', label: 'Privado', desc: 'Join requiere aprobación' },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <BarC t={t} title="New channel"
        left={<button onClick={() => nav('channels')} style={btnIconC(t)}><IC.ChevronL size={22}/></button>}/>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px 18px' }}>
        <div style={{ textAlign: 'center', margin: '8px 0 20px' }}>
          <div style={{ width: 64, height: 64, borderRadius: t.radiusL, margin: '0 auto',
            background: 'rgba(91,242,185,0.12)', color: t.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IC.Globe size={30}/></div>
        </div>

        <label style={lbl(t)}>NOMBRE</label>
        <input defaultValue="Aegis Notes" style={inp(t)}/>

        <label style={{ ...lbl(t), marginTop: 16 }}>DESCRIPCIÓN</label>
        <input defaultValue="Anuncios firmados del proyecto" style={inp(t)}/>

        <label style={{ ...lbl(t), marginTop: 16 }}>TIPO DE CANAL</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {types.map(ty => {
            const on = type === ty.id;
            return (
              <div key={ty.id} onClick={() => setType(ty.id)} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
                border: `1px solid ${on ? t.accent : t.border}`, borderRadius: t.radius,
                background: on ? 'rgba(91,242,185,0.07)' : t.surface, cursor: 'pointer',
              }}>
                <div style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                  border: `2px solid ${on ? t.accent : t.borderStrong}`,
                  background: on ? t.accent : 'transparent' }}/>
                <div>
                  <div style={{ fontFamily: t.font, fontSize: 13, fontWeight: 600 }}>{ty.label}</div>
                  <div style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 1 }}>{ty.desc}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 16,
          fontFamily: t.fontMono, fontSize: 10, color: t.textDim, lineHeight: 1.5 }}>
          <IC.Lock size={12}/>
          <span>Los posts se cifran siempre (CEK). El relay nunca ve el contenido ni quién publica.</span>
        </div>
      </div>

      <div style={{ padding: '0 18px 20px' }}>
        <window.PrimaryButton t={t} onClick={() => nav('channels')}>Crear canal</window.PrimaryButton>
      </div>
    </div>
  );
}

function lbl(t) {
  return { display: 'block', fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
           marginBottom: 6, letterSpacing: '0.04em' };
}
function inp(t) {
  return { width: '100%', padding: '12px 14px', background: t.surface, color: t.text,
           border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
           fontFamily: t.font, fontSize: 15, outline: 'none' };
}

Object.assign(window, {
  ScreenChannels, ScreenChannelFeed, ScreenChannelDiscover, ScreenChannelCreate,
});
