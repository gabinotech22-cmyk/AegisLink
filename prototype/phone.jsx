// AegisLink Phone — iOS frame + internal screen navigation + light/dark mode flip
// Pass theme as `t`. Starts on `initial` (default 'home').

function Phone({ t: baseT, initial = 'home', density = 'regular', isWork: initialIsWork = true }) {
  const [stack, setStack] = React.useState([{ name: initial, payload: null }]);
  const [flipped, setFlipped] = React.useState(false);
  const [isWorkMode, setIsWorkMode] = React.useState(initialIsWork);
  const t = flipped ? window.flipMode(baseT) : baseT;

  const top = stack[stack.length - 1];

  const nav = (name, payload) => {
    setStack(s => {
      const idx = s.findIndex(x => x.name === name);
      if (idx >= 0) return s.slice(0, idx + 1);
      return [...s, { name, payload }];
    });
  };

  const screens = {
    onboarding: window.ScreenOnboarding,
    home:       window.ScreenHome,
    chat:       window.ScreenChat,
    verify:     window.ScreenVerify,
    call:       window.ScreenCall,
    groups:     window.ScreenGroups,
    settings:   window.ScreenSettings,
    ephemeral:  window.ScreenEphemeral,
    backup:     window.ScreenBackup,
    profile:    window.ScreenProfile,
    contact:    window.ScreenContact,
    devices:    window.ScreenDevices,
    panic:      window.ScreenPanic,
    poll:       window.ScreenPoll,
    scheduled:  window.ScreenScheduled,
    lock:       window.ScreenLock,
    lockConfig: window.ScreenLockSettings,
    incoming:   window.ScreenIncoming,
    search:     window.ScreenSearch,
    attach:     window.ScreenAttachSheet,
    location:   window.ScreenLocation,
    viewonce:   window.ScreenViewOnce,
    viewoncesend: window.ScreenViewOnceSend,
    groupadmin: window.ScreenGroupAdmin,
    notifs:     window.ScreenNotifications,
    export:     window.ScreenDataExport,
    offline:    window.ScreenChatOffline,
    netError:   window.ScreenNetworkError,
    emptyHome:  window.ScreenEmptyHome,
    emptyGroups:window.ScreenEmptyGroups,
    inviteAdd:  window.ScreenInviteAdd,
    firstContact: window.ScreenFirstContact,
  };
  const Cmp = screens[top.name] || window.ScreenHome;

  return (
    <window.IOSDevice dark={t.dark} width={372} height={808}>
      <div style={{
        position: 'absolute', inset: 0,
        background: t.bg, color: t.text,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        paddingTop: 50,
        transition: 'background 0.25s ease, color 0.25s ease',
      }}>
        <Cmp t={t} nav={nav} density={density}
             contact={top.payload}
             flipped={flipped} setFlipped={setFlipped}
             isWorkMode={isWorkMode} setIsWorkMode={setIsWorkMode}
             key={top.name + (top.payload?.id || '')}/>
      </div>
    </window.IOSDevice>
  );
}


Object.assign(window, { Phone });
