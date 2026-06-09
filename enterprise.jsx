// AegisLink Work — enterprise admin dashboard (one per direction)

function WorkDashboard({ t }) {
  // Navigation State
  const [activeTab, setActiveTab] = React.useState('overview');

  // Members State
  const [members, setMembers] = React.useState([
    { aegisId: 'CKT-30J2-M3EE', name: 'Alice (Lead)', team: 'Engineering', role: 'Admin', status: 'Active', lastActive: 'En vivo' },
    { aegisId: '9ZB-VAMY-XV1K', name: 'Bob', team: 'Engineering', role: 'Member', status: 'Active', lastActive: 'hace 5 min' },
    { aegisId: 'FND-05AC-992A', name: 'Carol (Legal)', team: 'Legal', role: 'Mod', status: 'Active', lastActive: 'hace 1 hora' },
    { aegisId: 'X3D-8821-BBA0', name: 'Dave', team: 'Field Research', role: 'Member', status: 'Pending', lastActive: '—' },
    { aegisId: 'T8X-9901-AA32', name: 'Eve (Treasury)', team: 'Treasury Ops', role: 'Admin', status: 'Active', lastActive: 'hace 2 min' },
    { aegisId: 'PLT-5511-CC98', name: 'Frank', team: 'External Audit', role: 'Member', status: 'Active', lastActive: 'hace 10 min' },
    { aegisId: 'K9Y-7731-ZZ54', name: 'Grace', team: 'Engineering', role: 'Member', status: 'Active', lastActive: 'hace 24 min' },
    { aegisId: 'V9P-0012-QQ88', name: 'Heidi', team: 'Field Research', role: 'Member', status: 'Revoked', lastActive: 'hace 3 días' },
  ]);

  // Devices State
  const [devices, setDevices] = React.useState([
    { id: 'dev-1', name: 'Alice iPhone 15 Pro', owner: 'Alice (Lead)', aegisId: 'CKT-30J2-M3EE', status: 'Verified', enrolled: '2026-05-10', os: 'iOS 18.1' },
    { id: 'dev-2', name: 'Alice MacBook M3', owner: 'Alice (Lead)', aegisId: 'CKT-30J2-M3EE', status: 'Verified', enrolled: '2026-05-12', os: 'macOS 15.0' },
    { id: 'dev-3', name: 'Bob Pixel 8 Pro', owner: 'Bob', aegisId: '9ZB-VAMY-XV1K', status: 'Verified', enrolled: '2026-05-15', os: 'Android 14' },
    { id: 'dev-4', name: 'Bob Linux ThinkPad', owner: 'Bob', aegisId: '9ZB-VAMY-XV1K', status: 'Verified', enrolled: '2026-05-16', os: 'Linux 6.8' },
    { id: 'dev-5', name: 'Carol iPad Pro', owner: 'Carol (Legal)', aegisId: 'FND-05AC-992A', status: 'Verified', enrolled: '2026-05-20', os: 'iPadOS 18.0' },
    { id: 'dev-6', name: 'Eve iPhone 14', owner: 'Eve (Treasury)', aegisId: 'T8X-9901-AA32', status: 'Verified', enrolled: '2026-05-22', os: 'iOS 17.5' },
    { id: 'dev-7', name: 'Frank Windows PC', owner: 'Frank', aegisId: 'PLT-5511-CC98', status: 'Verified', enrolled: '2026-05-25', os: 'Windows 11' },
    { id: 'dev-8', name: 'Grace iPhone SE', owner: 'Grace', aegisId: 'K9Y-7731-ZZ54', status: 'Verified', enrolled: '2026-05-27', os: 'iOS 17.6' },
    { id: 'dev-9', name: 'Dave Galaxy S23', owner: 'Dave', aegisId: 'X3D-8821-BBA0', status: 'Pending', enrolled: '2026-06-05', os: 'Android 14' },
    { id: 'dev-10', name: 'Heidi iPhone 13', owner: 'Heidi', aegisId: 'V9P-0012-QQ88', status: 'Revoked', enrolled: '2026-05-11', os: 'iOS 17.0' },
  ]);

  // Relays State
  const [relays, setRelays] = React.useState([
    { name: 'zurich-prime.aegis.swiss', type: 'Primary Relay', status: 'Active', cpu: '18%', mem: '42%', activeConns: 542, bandwidth: '4.2 MB/s', region: 'eu-north-1', isMaint: false },
    { name: 'zurich-2.aegis.swiss', type: 'Secondary Relay', status: 'Active', cpu: '12%', mem: '38%', activeConns: 310, bandwidth: '2.1 MB/s', region: 'eu-north-1', isMaint: false },
    { name: 'geneva-1.aegis.swiss', type: 'Failover Relay', status: 'Active', cpu: '4%', mem: '28%', activeConns: 45, bandwidth: '0.3 MB/s', region: 'eu-west-2', isMaint: false },
    { name: 'ny-relay.aegis.swiss', type: 'External Bridge', status: 'Degraded', cpu: '85%', mem: '91%', activeConns: 890, bandwidth: '12.4 MB/s', region: 'us-east-1', isMaint: false }
  ]);

  // Incidents State
  const [incidents, setIncidents] = React.useState([
    { time: '14:02', sev: 'info', category: 'Security', msg: 'Rotación de claves completada para Treasury Ops', operator: 'Eve (Treasury)' },
    { time: '11:48', sev: 'warn', category: 'Devices', msg: 'Field Research · 1 dispositivo pendiente de re-verificación', operator: 'Dave' },
    { time: '09:12', sev: 'info', category: 'Relays', msg: 'Nuevo relay desplegado · zurich-3.aegis.swiss', operator: 'System' },
    { time: '08:30', sev: 'ok', category: 'Relays', msg: 'Test de atestación diario aprobado en todos los relays', operator: 'System' },
    { time: '07:15', sev: 'info', category: 'Members', msg: 'Nuevo miembro invitado a External Audit', operator: 'Alice (Lead)' },
    { time: 'Ayer', sev: 'error', category: 'Security', msg: 'Dispositivo revocado para Heidi por reporte de pérdida', operator: 'Alice (Lead)' }
  ]);

  // Policy Config State
  const [policy, setPolicy] = React.useState({
    enforceMfa: true,
    preventScreenshots: true,
    keyAgeLimit: '90d',
    ephemeralLifespan: '30d',
    allowAudio: true,
    allowVideo: true,
    allowImages: true,
    allowFiles: false,
    relayPinning: 'strict'
  });

  // Modal / Interaction States
  const [showInviteModal, setShowInviteModal] = React.useState(false);
  const [inviteName, setInviteName] = React.useState('');
  const [inviteAegisId, setInviteAegisId] = React.useState('');
  const [inviteTeam, setInviteTeam] = React.useState('Engineering');
  const [inviteRole, setInviteRole] = React.useState('Member');

  const [rotationProgress, setRotationProgress] = React.useState(-1); // -1 = idle
  const [rotationStep, setRotationStep] = React.useState('');
  const [selectedRotationTeam, setSelectedRotationTeam] = React.useState('All');

  const [savingPolicy, setSavingPolicy] = React.useState(false);
  const [policySuccess, setPolicySuccess] = React.useState(false);
  const [toast, setToast] = React.useState('');

  // Search/Filters
  const [memberSearch, setMemberSearch] = React.useState('');
  const [memberTeamFilter, setMemberTeamFilter] = React.useState('All');
  const [memberStatusFilter, setMemberStatusFilter] = React.useState('All');

  const [deviceSearch, setDeviceSearch] = React.useState('');
  const [deviceStatusFilter, setDeviceStatusFilter] = React.useState('All');

  const [auditFilter, setAuditFilter] = React.useState('All');

  // Trigger temporary toast notifications
  const triggerToast = (msg) => {
    setToast(msg);
    setTimeout(() => {
      setToast('');
    }, 4000);
  };

  // Derived counts
  const getActiveDevicesCount = (aegisId) => {
    return devices.filter(d => d.aegisId === aegisId && d.status === 'Verified').length;
  };

  const getTeamMemberCount = (teamName) => {
    return members.filter(m => m.team === teamName && m.status !== 'Revoked').length;
  };

  const getTeamDeviceCount = (teamName) => {
    const teamAegisIds = members.filter(m => m.team === teamName && m.status !== 'Revoked').map(m => m.aegisId);
    return devices.filter(d => teamAegisIds.includes(d.aegisId) && d.status === 'Verified').length;
  };

  // Invite member submission
  const handleInvite = (e) => {
    e.preventDefault();
    if (!inviteName || !inviteAegisId) {
      alert('Por favor, ingresa el nombre e ID de AegisLink');
      return;
    }
    const cleanId = inviteAegisId.trim().toUpperCase();
    const newMember = {
      aegisId: cleanId,
      name: inviteName.trim(),
      team: inviteTeam,
      role: inviteRole,
      status: 'Pending',
      lastActive: '—'
    };
    setMembers([newMember, ...members]);
    
    // Add to audit log
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setIncidents([
      { time: now, sev: 'info', category: 'Members', msg: `Miembro ${inviteName} invitado a ${inviteTeam}`, operator: 'Alice (Lead)' },
      ...incidents
    ]);

    setShowInviteModal(false);
    setInviteName('');
    setInviteAegisId('');
    triggerToast(`Invitación enviada a ${inviteName} (${cleanId}) exitosamente.`);
  };

  // Device revocation
  const handleRevokeDevice = (deviceId, deviceName, ownerName) => {
    setDevices(devices.map(d => d.id === deviceId ? { ...d, status: 'Revoked' } : d));
    
    // Add to audit log
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setIncidents([
      { time: now, sev: 'error', category: 'Security', msg: `Dispositivo '${deviceName}' revocado para ${ownerName}`, operator: 'Alice (Lead)' },
      ...incidents
    ]);
    triggerToast(`Dispositivo "${deviceName}" revocado correctamente.`);
  };

  // Device verification
  const handleVerifyDevice = (deviceId, deviceName, ownerName) => {
    setDevices(devices.map(d => d.id === deviceId ? { ...d, status: 'Verified' } : d));
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setIncidents([
      { time: now, sev: 'ok', category: 'Devices', msg: `Dispositivo '${deviceName}' verificado para ${ownerName}`, operator: 'Alice (Lead)' },
      ...incidents
    ]);
    triggerToast(`Dispositivo "${deviceName}" verificado con éxito.`);
  };

  // Member approval
  const handleApproveMember = (aegisId, name) => {
    setMembers(members.map(m => m.aegisId === aegisId ? { ...m, status: 'Active', lastActive: 'En vivo' } : m));
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setIncidents([
      { time: now, sev: 'ok', category: 'Members', msg: `Identidad aprobada para ${name}`, operator: 'Alice (Lead)' },
      ...incidents
    ]);
    triggerToast(`Miembro "${name}" activado en el sistema.`);
  };

  // Member revocation
  const handleRevokeMember = (aegisId, name) => {
    setMembers(members.map(m => m.aegisId === aegisId ? { ...m, status: 'Revoked' } : m));
    // Also revoke all their devices
    setDevices(devices.map(d => d.aegisId === aegisId ? { ...d, status: 'Revoked' } : d));
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setIncidents([
      { time: now, sev: 'error', category: 'Security', msg: `Miembro ${name} y todos sus dispositivos vinculados revocados`, operator: 'Alice (Lead)' },
      ...incidents
    ]);
    triggerToast(`Miembro ${name} revocado.`);
  };

  // Relay maintenance toggle
  const handleToggleMaint = (relayName) => {
    setRelays(relays.map(r => {
      if (r.name === relayName) {
        const nextMaint = !r.isMaint;
        return {
          ...r,
          isMaint: nextMaint,
          status: nextMaint ? 'Offline' : 'Active',
          cpu: nextMaint ? '0%' : '14%',
          mem: nextMaint ? '10%' : '35%',
          activeConns: nextMaint ? 0 : 280
        };
      }
      return r;
    }));
    triggerToast(`Estado de mantenimiento actualizado para ${relayName}`);
  };

  // Key rotation simulation
  const handleTriggerRotation = () => {
    setRotationProgress(0);
    setRotationStep('1/5: Generando nuevo pool de claves efímeras prekeys...');
    
    setTimeout(() => {
      setRotationProgress(25);
      setRotationStep('2/5: Firmando credenciales de claves con clave raíz Ed25519...');
      
      setTimeout(() => {
        setRotationProgress(50);
        setRotationStep('3/5: Difundiendo paquetes de prekeys firmadas a relays activos...');
        
        setTimeout(() => {
          setRotationProgress(75);
          setRotationStep('4/5: Reiniciando estados local Double Ratchet en clientes...');
          
          setTimeout(() => {
            setRotationProgress(100);
            setRotationStep('5/5: ¡Rotación completa! Atestación exitosa de la org.');
            
            setTimeout(() => {
              setRotationProgress(-1);
              const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              setIncidents([
                { time: now, sev: 'info', category: 'Security', msg: `Rotación preventiva de claves para el grupo: ${selectedRotationTeam === 'All' ? 'Toda la organización' : selectedRotationTeam}`, operator: 'Alice (Lead)' },
                ...incidents
              ]);
              triggerToast(`Rotación de claves completada con éxito.`);
            }, 1000);
          }, 1200);
        }, 1000);
      }, 1000);
    }, 1000);
  };

  // Save Policy simulation
  const handleSavePolicy = () => {
    setSavingPolicy(true);
    setPolicySuccess(false);
    setTimeout(() => {
      setSavingPolicy(false);
      setPolicySuccess(true);
      
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setIncidents([
        { time: now, sev: 'info', category: 'Policy', msg: 'Políticas de seguridad de la organización actualizadas', operator: 'Alice (Lead)' },
        ...incidents
      ]);
      triggerToast('Políticas guardadas y aplicadas.');
      setTimeout(() => setPolicySuccess(false), 3000);
    }, 1200);
  };

  // Sidebar Tabs Config
  const tabs = [
    { id: 'overview', i: window.I.Building, l: 'Resumen general' },
    { id: 'members',  i: window.I.Users,    l: 'Miembros y equipos' },
    { id: 'devices',  i: window.I.Shield,   l: 'Dispositivos' },
    { id: 'keys',     i: window.I.Key,      l: 'Claves y rotación' },
    { id: 'relays',   i: window.I.Globe,    l: 'Servidores y red' },
    { id: 'audit',    i: window.I.Bell,     l: 'Auditoría de eventos' },
    { id: 'policy',   i: window.I.Settings, l: 'Políticas de seguridad' },
  ];

  // Teams definitions for loops
  const teams = [
    { name: 'Engineering',   mfa: '100%' },
    { name: 'Legal',         mfa: '100%' },
    { name: 'Treasury Ops',  mfa: '100%' },
    { name: 'Field Research',mfa: '92%'  },
    { name: 'External Audit',mfa: '100%' },
  ];

  return (
    <div style={{
      width: 1280, minHeight: 820, background: t.bg, color: t.text,
      fontFamily: t.font, display: 'grid',
      gridTemplateColumns: '236px 1fr',
      position: 'relative',
    }}>
      {/* Toast Alert System */}
      {toast && (
        <div style={{
          position: 'absolute', top: 20, right: 20,
          background: t.dark ? t.surface3 : '#fff',
          color: t.text, border: `1px solid ${t.accent}`,
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          borderRadius: t.radiusS, padding: '12px 20px', zIndex: 1000,
          fontFamily: t.font, fontSize: 13, fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: 10,
          animation: 'fadein 0.3s ease-out'
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.accent }}/>
          <span>{toast}</span>
        </div>
      )}

      {/* Sidebar Navigation */}
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

        {tabs.map(it => (
          <div key={it.id} 
            onClick={() => setActiveTab(it.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: t.radiusS,
              color: activeTab === it.id ? t.text : t.textDim,
              background: activeTab === it.id ? t.surface2 : 'transparent',
              fontFamily: t.font, fontSize: 13,
              fontWeight: activeTab === it.id ? 600 : 400, cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s'
            }}>
            <it.i size={16} stroke={1.8} color={activeTab === it.id ? t.accent : t.textDim} />
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
            <span style={{ color: t.textDim }}>{relays.filter(r => r.status === 'Active').length} relays · 99.99% uptime</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main style={{ padding: '28px 36px', overflowY: 'auto', maxHeight: 820, display: 'flex', flexDirection: 'column' }}>
        
        {/* VIEW 1: Overview */}
        {activeTab === 'overview' && (
          <div>
            {/* Header */}
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
                               letterSpacing: '0.04em' }}>Actualizado 14:02 · CET</span>
                <button 
                  onClick={() => setShowInviteModal(true)}
                  style={{
                    background: t.accent, color: t.accentInk, border: 'none',
                    borderRadius: t.radius, padding: '10px 18px',
                    fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer',
                  }}>+ Invitar miembro</button>
              </div>
            </div>

            {/* KPI cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 28 }}>
              {[
                { l: 'MIEMBROS ACTIVOS',     v: String(members.filter(m => m.status === 'Active').length),     d: `+${members.filter(m => m.status === 'Pending').length} pendientes`, tab: 'members' },
                { l: 'DISPOSITIVOS VERIFICADOS',   v: String(devices.filter(d => d.status === 'Verified').length),     d: 'de todos los registrados', tab: 'devices' },
                { l: 'EDAD PROMEDIO DE LLAVES',       v: '21d',    d: 'política: rotar <90d', tab: 'keys' },
                { l: 'METADATA ALMACENADA',    v: '0 B',    d: 'por diseño (E2EE total)',  accent: true, tab: 'policy' },
              ].map(k => (
                <div key={k.l} 
                  onClick={() => setActiveTab(k.tab)}
                  style={{
                    padding: 20, border: `1px solid ${t.border}`,
                    borderRadius: t.radius, background: t.surface, cursor: 'pointer',
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = t.accent}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = t.border}>
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
                  <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>Equipos</div>
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                                 letterSpacing: '0.06em' }}>{teams.length} TOTAL</span>
                </div>
                <div style={{
                  display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
                  padding: '10px 18px', borderBottom: `1px solid ${t.divider}`,
                  fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                  letterSpacing: '0.08em',
                }}>
                  <span>EQUIPO</span><span>MIEMBROS</span><span>DISPOSITIVOS</span><span>MFA Enforced</span>
                </div>
                {teams.map((tm, i) => (
                  <div key={tm.name} 
                    onClick={() => {
                      setMemberTeamFilter(tm.name);
                      setActiveTab('members');
                    }}
                    style={{
                      display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
                      padding: '14px 18px', alignItems: 'center', cursor: 'pointer',
                      borderBottom: i < teams.length - 1 ? `1px solid ${t.divider}` : 'none',
                      fontFamily: t.font, fontSize: 14,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = t.surface2}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <span style={{ fontWeight: 500 }}>{tm.name}</span>
                    <span style={{ fontFamily: t.fontMono, color: t.textDim }}>{getTeamMemberCount(tm.name)}</span>
                    <span style={{ fontFamily: t.fontMono, color: t.textDim }}>{getTeamDeviceCount(tm.name)}</span>
                    <span style={{
                      fontFamily: t.fontMono, fontSize: 12,
                      color: tm.mfa === '100%' ? t.accent : t.warn,
                    }}>{tm.mfa}</span>
                  </div>
                ))}
              </div>

              {/* Audit log preview */}
              <div style={{
                border: `1px solid ${t.border}`, borderRadius: t.radius,
                background: t.surface, overflow: 'hidden',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '14px 18px', borderBottom: `1px solid ${t.divider}`,
                }}>
                  <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>Auditoría en vivo</div>
                  <span onClick={() => setActiveTab('audit')} style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent,
                                 letterSpacing: '0.06em', cursor: 'pointer' }}>VER COMPLETO →</span>
                </div>
                {incidents.slice(0, 4).map((it, i) => {
                  const dot = it.sev === 'warn' ? t.warn : (it.sev === 'error' ? t.danger : (it.sev === 'ok' ? t.accent : t.textDim));
                  return (
                    <div key={i} style={{
                      display: 'flex', gap: 10, padding: '12px 18px',
                      borderBottom: i < 3 ? `1px solid ${t.divider}` : 'none',
                    }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', background: dot,
                        marginTop: 7, flexShrink: 0,
                      }}/>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim,
                                        letterSpacing: '0.06em', marginBottom: 3 }}>{it.time} CET</span>
                          <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint }}>{it.category}</span>
                        </div>
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
                <b>Política corporativa activada.</b> Los dispositivos requieren verificación de llave criptográfica antes de ingresar a canales de conversación; borrado automático configurado para {policy.ephemeralLifespan} en mensajes de Treasury Ops.
              </span>
              <button 
                onClick={() => setActiveTab('policy')}
                style={{
                  background: 'transparent', border: `1px solid ${t.borderStrong}`,
                  borderRadius: t.radiusS, padding: '6px 12px',
                  fontFamily: t.fontMono, fontSize: 11, color: t.text, cursor: 'pointer',
                  letterSpacing: '0.04em',
                }}>EDITAR POLÍTICAS</button>
            </div>
          </div>
        )}

        {/* VIEW 2: Members & teams */}
        {activeTab === 'members' && (
          <div>
            {/* Header */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
              marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${t.divider}`,
            }}>
              <div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                              letterSpacing: '0.1em', marginBottom: 6 }}>GESTIÓN DE PERSONAL</div>
                <div style={{
                  fontFamily: t.fontDisplay, fontSize: 36,
                  fontWeight: t.displayWeight,
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>Miembros y equipos</div>
              </div>
              <button 
                onClick={() => setShowInviteModal(true)}
                style={{
                  background: t.accent, color: t.accentInk, border: 'none',
                  borderRadius: t.radius, padding: '10px 18px',
                  fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer',
                }}>+ Invitar miembro</button>
            </div>

            {/* Filter Panel */}
            <div style={{
              display: 'flex', gap: 14, padding: 16, background: t.surface,
              borderRadius: t.radius, border: `1px solid ${t.border}`, marginBottom: 20
            }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 6 }}>BUSCAR ID O NOMBRE</label>
                <input 
                  type="text" 
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Ej: Alice, CKT..."
                  style={{
                    width: '100%', padding: '8px 12px', background: t.bg, color: t.text,
                    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                    fontFamily: t.font, fontSize: 13, outline: 'none'
                  }}
                />
              </div>
              <div style={{ width: 180 }}>
                <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 6 }}>FILTRAR EQUIPO</label>
                <select
                  value={memberTeamFilter}
                  onChange={(e) => setMemberTeamFilter(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', background: t.bg, color: t.text,
                    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                    fontFamily: t.font, fontSize: 13, outline: 'none'
                  }}>
                  <option value="All">Todos los equipos</option>
                  <option value="Engineering">Engineering</option>
                  <option value="Legal">Legal</option>
                  <option value="Treasury Ops">Treasury Ops</option>
                  <option value="Field Research">Field Research</option>
                  <option value="External Audit">External Audit</option>
                </select>
              </div>
              <div style={{ width: 150 }}>
                <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 6 }}>FILTRAR ESTADO</label>
                <select
                  value={memberStatusFilter}
                  onChange={(e) => setMemberStatusFilter(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', background: t.bg, color: t.text,
                    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                    fontFamily: t.font, fontSize: 13, outline: 'none'
                  }}>
                  <option value="All">Todos</option>
                  <option value="Active">Activos</option>
                  <option value="Pending">Pendientes</option>
                  <option value="Revoked">Revocados</option>
                </select>
              </div>
            </div>

            {/* Members Table */}
            <div style={{
              border: `1px solid ${t.border}`, borderRadius: t.radius,
              background: t.surface, overflow: 'hidden',
            }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1.5fr',
                padding: '12px 18px', borderBottom: `1px solid ${t.divider}`,
                fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                letterSpacing: '0.08em',
              }}>
                <span>MIEMBROS</span><span>EQUIPO</span><span>ROL</span><span>ESTADO</span><span>DISPOSITIVOS</span><span>ACCIONES</span>
              </div>
              {members
                .filter(m => {
                  const matchQuery = m.name.toLowerCase().includes(memberSearch.toLowerCase()) || m.aegisId.toLowerCase().includes(memberSearch.toLowerCase());
                  const matchTeam = memberTeamFilter === 'All' || m.team === memberTeamFilter;
                  const matchStatus = memberStatusFilter === 'All' || m.status === memberStatusFilter;
                  return matchQuery && matchTeam && matchStatus;
                })
                .map((m, idx, arr) => {
                  const devCount = getActiveDevicesCount(m.aegisId);
                  const isPending = m.status === 'Pending';
                  const isActive = m.status === 'Active';
                  return (
                    <div key={m.aegisId} style={{
                      display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1.5fr',
                      padding: '14px 18px', alignItems: 'center',
                      borderBottom: idx < arr.length - 1 ? `1px solid ${t.divider}` : 'none',
                      fontFamily: t.font, fontSize: 13,
                    }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</span>
                        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2 }}>{m.aegisId}</span>
                      </div>
                      <span>{m.team}</span>
                      <span>
                        <span style={{
                          fontFamily: t.fontMono, fontSize: 10, padding: '3px 8px',
                          background: m.role === 'Admin' ? `${t.accent}22` : (m.role === 'Mod' ? `${t.warn}22` : 'rgba(255,255,255,0.04)'),
                          border: `1px solid ${m.role === 'Admin' ? t.accent : (m.role === 'Mod' ? t.warn : t.border)}`,
                          color: m.role === 'Admin' ? t.accent : (m.role === 'Mod' ? t.warn : t.textDim),
                          borderRadius: 99
                        }}>{m.role}</span>
                      </span>
                      <span>
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          display: 'inline-block', marginRight: 6,
                          background: m.status === 'Active' ? t.accent : (m.status === 'Pending' ? t.warn : t.danger)
                        }}/>
                        <span style={{
                          fontFamily: t.fontMono, fontSize: 11,
                          color: m.status === 'Active' ? t.accent : (m.status === 'Pending' ? t.warn : t.danger)
                        }}>{m.status}</span>
                      </span>
                      <span style={{ fontFamily: t.fontMono }}>{devCount} / {m.aegisId === 'CKT-30J2-M3EE' ? 3 : (m.status === 'Revoked' ? 0 : 2)}</span>
                      <div>
                        {isPending && (
                          <button 
                            onClick={() => handleApproveMember(m.aegisId, m.name)}
                            style={{
                              background: t.accent, color: t.accentInk, border: 'none',
                              borderRadius: t.radiusS, padding: '4px 10px',
                              fontFamily: t.font, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            }}>Aprobar</button>
                        )}
                        {isActive && m.aegisId !== 'CKT-30J2-M3EE' && (
                          <button 
                            onClick={() => handleRevokeMember(m.aegisId, m.name)}
                            style={{
                              background: 'transparent', color: t.danger, border: `1px solid ${t.danger}44`,
                              borderRadius: t.radiusS, padding: '4px 10px',
                              fontFamily: t.font, fontSize: 11, fontWeight: 500, cursor: 'pointer',
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = `${t.danger}22`}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>Revocar</button>
                        )}
                        {m.aegisId === 'CKT-30J2-M3EE' && (
                          <span style={{ color: t.textFaint, fontStyle: 'italic', fontSize: 12 }}>Propietario</span>
                        )}
                        {m.status === 'Revoked' && (
                          <span style={{ color: t.danger, fontFamily: t.fontMono, fontSize: 11 }}>Acceso Cerrado</span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* VIEW 3: Devices */}
        {activeTab === 'devices' && (
          <div>
            {/* Header */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
              marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${t.divider}`,
            }}>
              <div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                              letterSpacing: '0.1em', marginBottom: 6 }}>DISPOSITIVOS ENROLADOS</div>
                <div style={{
                  fontFamily: t.fontDisplay, fontSize: 36,
                  fontWeight: t.displayWeight,
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>Dispositivos autorizados</div>
              </div>
            </div>

            {/* Filter controls */}
            <div style={{
              display: 'flex', gap: 14, padding: 16, background: t.surface,
              borderRadius: t.radius, border: `1px solid ${t.border}`, marginBottom: 20
            }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 6 }}>FILTRAR POR PROPIETARIO</label>
                <input 
                  type="text" 
                  value={deviceSearch}
                  onChange={(e) => setDeviceSearch(e.target.value)}
                  placeholder="Ej: Alice, Bob..."
                  style={{
                    width: '100%', padding: '8px 12px', background: t.bg, color: t.text,
                    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                    fontFamily: t.font, fontSize: 13, outline: 'none'
                  }}
                />
              </div>
              <div style={{ width: 200 }}>
                <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 6 }}>ESTADO DEL DISPOSITIVO</label>
                <select
                  value={deviceStatusFilter}
                  onChange={(e) => setDeviceStatusFilter(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', background: t.bg, color: t.text,
                    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                    fontFamily: t.font, fontSize: 13, outline: 'none'
                  }}>
                  <option value="All">Todos los estados</option>
                  <option value="Verified">Verificados (Activos)</option>
                  <option value="Pending">Pendiente de atestación</option>
                  <option value="Revoked">Revocados</option>
                </select>
              </div>
            </div>

            {/* Devices grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
              {devices
                .filter(d => {
                  const matchQuery = d.owner.toLowerCase().includes(deviceSearch.toLowerCase()) || d.name.toLowerCase().includes(deviceSearch.toLowerCase());
                  const matchStatus = deviceStatusFilter === 'All' || d.status === deviceStatusFilter;
                  return matchQuery && matchStatus;
                })
                .map(d => {
                  const isVerified = d.status === 'Verified';
                  const isPending = d.status === 'Pending';
                  const isRevoked = d.status === 'Revoked';
                  return (
                    <div key={d.id} style={{
                      background: t.surface, border: `1px solid ${isPending ? t.warn : t.border}`,
                      borderRadius: t.radius, padding: 18,
                      display: 'flex', flexDirection: 'column', gap: 12
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 15 }}>{d.name}</div>
                          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginTop: 2 }}>{d.os} · Enrolado {d.enrolled}</div>
                        </div>
                        <span style={{
                          fontFamily: t.fontMono, fontSize: 9, padding: '3px 8px',
                          background: isVerified ? `${t.accent}22` : (isPending ? `${t.warn}22` : `${t.danger}22`),
                          border: `1px solid ${isVerified ? t.accent : (isPending ? t.warn : t.danger)}`,
                          color: isVerified ? t.accent : (isPending ? t.warn : t.danger),
                          borderRadius: 99
                        }}>{d.status}</span>
                      </div>
                      
                      <div style={{
                        borderTop: `1px solid ${t.divider}`, paddingTop: 10,
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                      }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textFaint }}>PROPIETARIO</span>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{d.owner} ({d.aegisId.slice(0, 8)}...)</span>
                        </div>
                        <div>
                          {isPending && (
                            <button 
                              onClick={() => handleVerifyDevice(d.id, d.name, d.owner)}
                              style={{
                                background: t.accent, color: t.accentInk, border: 'none',
                                borderRadius: t.radiusS, padding: '6px 12px',
                                fontFamily: t.font, fontSize: 11, fontWeight: 600, cursor: 'pointer'
                              }}>Confirmar</button>
                          )}
                          {isVerified && (
                            <button 
                              onClick={() => handleRevokeDevice(d.id, d.name, d.owner)}
                              style={{
                                background: 'transparent', color: t.danger, border: `1px solid ${t.danger}44`,
                                borderRadius: t.radiusS, padding: '6px 12px',
                                fontFamily: t.font, fontSize: 11, fontWeight: 500, cursor: 'pointer'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.background = `${t.danger}22`}
                              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>Revocar</button>
                          )}
                          {isRevoked && (
                            <span style={{ color: t.danger, fontFamily: t.fontMono, fontSize: 11 }}>Acceso Revocado</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* VIEW 4: Keys & rotation */}
        {activeTab === 'keys' && (
          <div>
            {/* Header */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
              marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${t.divider}`,
            }}>
              <div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                              letterSpacing: '0.1em', marginBottom: 6 }}>ATTESTACIÓN Y LLAVES</div>
                <div style={{
                  fontFamily: t.fontDisplay, fontSize: 36,
                  fontWeight: t.displayWeight,
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>Claves criptográficas y rotación</div>
              </div>
            </div>

            {/* Cryptographic KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 28 }}>
              {[
                { l: 'POOL DE PREKEYS', v: '99.8%', d: 'Saludable · 2500 OPK' },
                { l: 'LLAVES FIRMADAS SPK', v: '82', d: 'Enlazadas a attestation' },
                { l: 'ATTESTACIÓN GLOBAL', v: 'OK', d: 'Firmado con Ed25519' },
                { l: 'FINGERPRINT DE LA ORG', v: '8F9E-3DA4', d: 'Verificación anti-MITM', mono: true }
              ].map(k => (
                <div key={k.l} style={{
                  padding: 20, border: `1px solid ${t.border}`,
                  borderRadius: t.radius, background: t.surface,
                }}>
                  <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                                letterSpacing: '0.1em', marginBottom: 14 }}>{k.l}</div>
                  <div style={{
                    fontFamily: k.mono ? t.fontMono : t.fontDisplay, 
                    fontSize: k.mono ? 28 : 44,
                    fontWeight: t.displayWeight,
                    letterSpacing: '-0.03em', lineHeight: 1,
                    color: t.accent,
                  }}>{k.v}</div>
                  <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 8 }}>
                    {k.d}
                  </div>
                </div>
              ))}
            </div>

            {/* Key rotation control */}
            <div style={{
              background: t.surface, border: `1px solid ${t.border}`,
              borderRadius: t.radius, padding: 24, marginBottom: 20
            }}>
              <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 18, marginBottom: 12 }}>
                Forzar Rotación de Claves Criptográficas
              </div>
              <p style={{ fontSize: 13, color: t.textDim, lineHeight: 1.5, marginBottom: 20, maxWidth: 800 }}>
                La rotación de claves invalida las pre-claves actuales en los servidores y fuerza a todos los clientes a realizar un intercambio de claves Diffie-Hellman efímero en su próxima conexión (Double Ratchet Reset). Esto previene la posibilidad de descifrado histórico si un dispositivo fuese vulnerado.
              </p>

              {rotationProgress === -1 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textDim }}>SELECCIONAR EQUIPO</span>
                    <select
                      value={selectedRotationTeam}
                      onChange={(e) => setSelectedRotationTeam(e.target.value)}
                      style={{
                        padding: '10px 14px', background: t.bg, color: t.text,
                        border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                        fontFamily: t.font, fontSize: 13, outline: 'none', width: 220
                      }}>
                      <option value="All">Toda la organización</option>
                      <option value="Engineering">Engineering</option>
                      <option value="Legal">Legal</option>
                      <option value="Treasury Ops">Treasury Ops</option>
                      <option value="Field Research">Field Research</option>
                      <option value="External Audit">External Audit</option>
                    </select>
                  </div>
                  
                  <button 
                    onClick={handleTriggerRotation}
                    style={{
                      background: t.accent, color: t.accentInk, border: 'none',
                      borderRadius: t.radius, padding: '12px 24px',
                      fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer',
                      marginTop: 18
                    }}>Rotar claves ahora</button>
                </div>
              ) : (
                <div style={{
                  background: t.surface2, border: `1px solid ${t.borderStrong}`,
                  borderRadius: t.radiusS, padding: 18,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent }}>{rotationStep}</span>
                    <span style={{ fontFamily: t.fontMono, fontSize: 12, fontWeight: 600 }}>{rotationProgress}%</span>
                  </div>
                  <div style={{ height: 6, background: t.bg, borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${rotationProgress}%`, background: t.accent, transition: 'width 0.4s ease-out' }}/>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* VIEW 5: Relays */}
        {activeTab === 'relays' && (
          <div>
            {/* Header */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
              marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${t.divider}`,
            }}>
              <div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                              letterSpacing: '0.1em', marginBottom: 6 }}>ESTADO DE LA INFRAESTRUCTURA</div>
                <div style={{
                  fontFamily: t.fontDisplay, fontSize: 36,
                  fontWeight: t.displayWeight,
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>Servidores y relays de red</div>
              </div>
            </div>

            {/* Relays grid */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {relays.map(r => {
                const isActive = r.status === 'Active';
                const isDegraded = r.status === 'Degraded';
                return (
                  <div key={r.name} style={{
                    background: t.surface, border: `1px solid ${t.border}`,
                    borderRadius: t.radius, padding: 20,
                    display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr 1fr',
                    alignItems: 'center', gap: 16
                  }}>
                    {/* Relay Name */}
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: isActive ? t.accent : (isDegraded ? t.warn : t.danger),
                          display: 'inline-block'
                        }}/>
                        <span style={{ fontFamily: t.fontMono, fontWeight: 600, fontSize: 14 }}>{r.name}</span>
                      </div>
                      <div style={{ fontSize: 12, color: t.textDim, marginTop: 4 }}>{r.type} · Región: {r.region}</div>
                    </div>

                    {/* Resources */}
                    <div>
                      <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textFaint, display: 'block' }}>RECURSOS CPU</span>
                      <span style={{ fontSize: 14, fontFamily: t.fontMono, fontWeight: 500 }}>{r.cpu}</span>
                    </div>
                    <div>
                      <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textFaint, display: 'block' }}>MEMORIA RAM</span>
                      <span style={{ fontSize: 14, fontFamily: t.fontMono, fontWeight: 500 }}>{r.mem}</span>
                    </div>

                    {/* Network load & live graph */}
                    <div>
                      <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textFaint, display: 'block' }}>TRAFICO ({r.activeConns} conns)</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                        <span style={{ fontSize: 12, fontFamily: t.fontMono }}>{r.bandwidth}</span>
                        {isActive && (
                          <svg width="60" height="20" style={{ stroke: t.accent, fill: 'none', strokeWidth: 1.5 }}>
                            <path d="M0 10 Q10 2, 20 12 T40 6 T60 14" />
                          </svg>
                        )}
                        {isDegraded && (
                          <svg width="60" height="20" style={{ stroke: t.warn, fill: 'none', strokeWidth: 1.5 }}>
                            <path d="M0 18 L10 5 L20 18 L30 2 L40 16 L50 8 L60 18" />
                          </svg>
                        )}
                        {r.isMaint && (
                          <span style={{ fontSize: 11, color: t.textFaint }}>— Offline —</span>
                        )}
                      </div>
                    </div>

                    {/* Action */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button 
                        onClick={() => handleToggleMaint(r.name)}
                        style={{
                          background: r.isMaint ? t.accent : 'transparent', 
                          color: r.isMaint ? t.accentInk : t.text,
                          border: `1px solid ${r.isMaint ? t.accent : t.borderStrong}`,
                          borderRadius: t.radiusS, padding: '8px 14px',
                          fontFamily: t.fontMono, fontSize: 11, fontWeight: 500, cursor: 'pointer'
                        }}
                        onMouseEnter={(e) => { if(!r.isMaint) e.currentTarget.style.background = t.surface2; }}
                        onMouseLeave={(e) => { if(!r.isMaint) e.currentTarget.style.background = 'transparent'; }}>
                        {r.isMaint ? 'ACTIVAR' : 'MANTENIMIENTO'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* VIEW 6: Audit log */}
        {activeTab === 'audit' && (
          <div>
            {/* Header */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
              marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${t.divider}`,
            }}>
              <div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                              letterSpacing: '0.1em', marginBottom: 6 }}>REGISTRO DE SEGURIDAD</div>
                <div style={{
                  fontFamily: t.fontDisplay, fontSize: 36,
                  fontWeight: t.displayWeight,
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>Registro de auditoría</div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button 
                  onClick={() => triggerToast('Exportación JSON iniciada.')}
                  style={{
                    background: 'transparent', color: t.text, border: `1px solid ${t.borderStrong}`,
                    borderRadius: t.radius, padding: '10px 18px',
                    fontFamily: t.font, fontWeight: 500, fontSize: 13, cursor: 'pointer',
                  }}>Exportar JSON</button>
                <button 
                  onClick={() => triggerToast('Archivo CSV generado y descargado.')}
                  style={{
                    background: t.accent, color: t.accentInk, border: 'none',
                    borderRadius: t.radius, padding: '10px 18px',
                    fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer',
                  }}>Exportar CSV</button>
              </div>
            </div>

            {/* Filter control */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {['All', 'Security', 'Members', 'Devices', 'Relays', 'Policy'].map(cat => (
                <button 
                  key={cat}
                  onClick={() => setAuditFilter(cat)}
                  style={{
                    background: auditFilter === cat ? t.surface3 : t.surface,
                    color: auditFilter === cat ? t.accent : t.textDim,
                    border: `1px solid ${auditFilter === cat ? t.accent : t.border}`,
                    borderRadius: t.radiusS, padding: '6px 14px',
                    fontFamily: t.fontMono, fontSize: 11, cursor: 'pointer'
                  }}
                  onMouseEnter={(e) => { if(auditFilter !== cat) e.currentTarget.style.borderColor = t.accent; }}
                  onMouseLeave={(e) => { if(auditFilter !== cat) e.currentTarget.style.borderColor = t.border; }}>
                  {cat.toUpperCase()}
                </button>
              ))}
            </div>

            {/* Logs table */}
            <div style={{
              border: `1px solid ${t.border}`, borderRadius: t.radius,
              background: t.surface, overflow: 'hidden',
            }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1.5fr 4fr 2fr',
                padding: '12px 18px', borderBottom: `1px solid ${t.divider}`,
                fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                letterSpacing: '0.08em',
              }}>
                <span>HORA</span><span>CATEGORÍA</span><span>DETALLE</span><span>OPERADOR</span>
              </div>
              {incidents
                .filter(it => auditFilter === 'All' || it.category === auditFilter)
                .map((it, idx, arr) => {
                  const dot = it.sev === 'warn' ? t.warn : (it.sev === 'error' ? t.danger : (it.sev === 'ok' ? t.accent : t.textDim));
                  return (
                    <div key={idx} style={{
                      display: 'grid', gridTemplateColumns: '1fr 1.5fr 4fr 2fr',
                      padding: '14px 18px', alignItems: 'center',
                      borderBottom: idx < arr.length - 1 ? `1px solid ${t.divider}` : 'none',
                      fontFamily: t.font, fontSize: 13,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot }}/>
                        <span style={{ fontFamily: t.fontMono, color: t.textDim }}>{it.time}</span>
                      </div>
                      <span>
                        <span style={{
                          fontFamily: t.fontMono, fontSize: 9, padding: '2px 6px',
                          background: 'rgba(255,255,255,0.04)', border: `1px solid ${t.border}`,
                          borderRadius: 4, color: t.textDim
                        }}>{it.category}</span>
                      </span>
                      <span style={{ fontWeight: 500 }}>{it.msg}</span>
                      <span style={{ color: t.textDim }}>{it.operator}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* VIEW 7: Policies */}
        {activeTab === 'policy' && (
          <div>
            {/* Header */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
              marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${t.divider}`,
            }}>
              <div>
                <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim,
                              letterSpacing: '0.1em', marginBottom: 6 }}>AJUSTES CATASTRÓFICOS</div>
                <div style={{
                  fontFamily: t.fontDisplay, fontSize: 36,
                  fontWeight: t.displayWeight,
                  letterSpacing: '-0.02em', lineHeight: 1,
                }}>Políticas de seguridad globales</div>
              </div>
            </div>

            {/* Policy form */}
            <div style={{
              background: t.surface, border: `1px solid ${t.border}`,
              borderRadius: t.radius, padding: 28, display: 'flex', flexDirection: 'column', gap: 24
            }}>
              
              {/* Switches group */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                {/* Switch 1: MFA */}
                <div style={{
                  background: t.bg, padding: 18, borderRadius: t.radius,
                  border: `1px solid ${t.borderStrong}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <div style={{ maxWidth: '80%' }}>
                    <span style={{ fontWeight: 600, display: 'block', fontSize: 14 }}>Forzar verificación multifactor (2FA)</span>
                    <span style={{ fontSize: 12, color: t.textDim, lineHeight: 1.4, display: 'block', marginTop: 4 }}>
                      Los dispositivos requieren una clave atómica externa antes de registrarse en un relay.
                    </span>
                  </div>
                  <input 
                    type="checkbox"
                    checked={policy.enforceMfa}
                    onChange={(e) => setPolicy({ ...policy, enforceMfa: e.target.checked })}
                    style={{ width: 20, height: 20, accentColor: t.accent, cursor: 'pointer' }}
                  />
                </div>

                {/* Switch 2: Screen Capture */}
                <div style={{
                  background: t.bg, padding: 18, borderRadius: t.radius,
                  border: `1px solid ${t.borderStrong}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <div style={{ maxWidth: '80%' }}>
                    <span style={{ fontWeight: 600, display: 'block', fontSize: 14 }}>Bloquear capturas de pantalla</span>
                    <span style={{ fontSize: 12, color: t.textDim, lineHeight: 1.4, display: 'block', marginTop: 4 }}>
                      Evita que los usuarios tomen capturas de pantalla o graben la pantalla en Android/iOS.
                    </span>
                  </div>
                  <input 
                    type="checkbox"
                    checked={policy.preventScreenshots}
                    onChange={(e) => setPolicy({ ...policy, preventScreenshots: e.target.checked })}
                    style={{ width: 20, height: 20, accentColor: t.accent, cursor: 'pointer' }}
                  />
                </div>
              </div>

              {/* Threshold limits */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                {/* Age limits dropdown */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textDim }}>VENCIMIENTO DE PRE-CLAVES</label>
                  <select
                    value={policy.keyAgeLimit}
                    onChange={(e) => setPolicy({ ...policy, keyAgeLimit: e.target.value })}
                    style={{
                      padding: 12, background: t.bg, color: t.text,
                      border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                      fontFamily: t.font, fontSize: 13, outline: 'none'
                    }}>
                    <option value="30d">Rotar cada 30 días</option>
                    <option value="90d">Rotar cada 90 días (Recomendado)</option>
                    <option value="180d">Rotar cada 180 días</option>
                  </select>
                </div>

                {/* Ephemeral dropdown */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textDim }}>TIEMPO DE AUTO-BORRADO DE MENSAJES (EPHEMERAL)</label>
                  <select
                    value={policy.ephemeralLifespan}
                    onChange={(e) => setPolicy({ ...policy, ephemeralLifespan: e.target.value })}
                    style={{
                      padding: 12, background: t.bg, color: t.text,
                      border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                      fontFamily: t.font, fontSize: 13, outline: 'none'
                    }}>
                    <option value="24h">Auto-quemar en 24 horas</option>
                    <option value="7d">Auto-quemar en 7 días</option>
                    <option value="30d">Auto-quemar en 30 días</option>
                    <option value="none">Sin quemado automático</option>
                  </select>
                </div>
              </div>

              {/* Attachment checkboxes */}
              <div style={{ borderTop: `1px solid ${t.divider}`, paddingTop: 20 }}>
                <span style={{ fontWeight: 600, display: 'block', fontSize: 14, marginBottom: 12 }}>Tipos de adjuntos permitidos</span>
                <div style={{ display: 'flex', gap: 24 }}>
                  {[
                    { key: 'allowAudio', label: '🎙 Mensajes de Audio' },
                    { key: 'allowVideo', label: '🎥 Mensajes de Video' },
                    { key: 'allowImages', label: '📷 Fotos y Galería' },
                    { key: 'allowFiles', label: '📎 Archivos Raw / Zips' },
                  ].map(chk => (
                    <label key={chk.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input 
                        type="checkbox"
                        checked={policy[chk.key]}
                        onChange={(e) => setPolicy({ ...policy, [chk.key]: e.target.checked })}
                        style={{ width: 16, height: 16, accentColor: t.accent }}
                      />
                      <span>{chk.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Relay routing settings */}
              <div style={{ borderTop: `1px solid ${t.divider}`, paddingTop: 20 }}>
                <span style={{ fontWeight: 600, display: 'block', fontSize: 14, marginBottom: 6 }}>Pinning de Servidores (Relays)</span>
                <span style={{ fontSize: 12, color: t.textDim, display: 'block', marginBottom: 14 }}>
                  Fuerza al cliente a usar únicamente nodos localizados en jurisdicciones específicas.
                </span>
                <div style={{ display: 'flex', gap: 20 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                    <input 
                      type="radio" 
                      name="relayMode"
                      value="strict"
                      checked={policy.relayPinning === 'strict'}
                      onChange={() => setPolicy({ ...policy, relayPinning: 'strict' })}
                      style={{ accentColor: t.accent }}
                    />
                    <span>Jurisdicción Suiza Estricta (zurich.aegis.swiss)</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                    <input 
                      type="radio" 
                      name="relayMode"
                      value="global"
                      checked={policy.relayPinning === 'global'}
                      onChange={() => setPolicy({ ...policy, relayPinning: 'global' })}
                      style={{ accentColor: t.accent }}
                    />
                    <span>Ruteo de nodo más cercano (Baja latencia global)</span>
                  </label>
                </div>
              </div>

              {/* Save trigger */}
              <div style={{ borderTop: `1px solid ${t.divider}`, paddingTop: 20, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 14 }}>
                {policySuccess && (
                  <span style={{ color: t.accent, fontSize: 13, fontWeight: 500, fontFamily: t.fontMono }}>
                    ✔ ¡Políticas aplicadas exitosamente en todos los relays!
                  </span>
                )}
                <button
                  onClick={handleSavePolicy}
                  disabled={savingPolicy}
                  style={{
                    background: t.accent, color: t.accentInk, border: 'none',
                    borderRadius: t.radius, padding: '12px 28px',
                    fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer',
                    opacity: savingPolicy ? 0.7 : 1
                  }}>
                  {savingPolicy ? 'Guardando políticas...' : 'Guardar y aplicar'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Invite Member Modal */}
      {showInviteModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000
        }}>
          <div style={{
            background: t.surface, border: `1px solid ${t.borderStrong}`,
            borderRadius: t.radius, padding: 28, width: 420,
            display: 'flex', flexDirection: 'column', gap: 18,
            boxShadow: '0 12px 36px rgba(0,0,0,0.3)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 18, fontWeight: 600 }}>Invitar nuevo miembro</span>
              <button 
                onClick={() => setShowInviteModal(false)}
                style={{ background: 'none', border: 'none', color: t.textDim, fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>
            
            <form onSubmit={handleInvite} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 4 }}>NOMBRE DEL MIEMBRO</label>
                <input 
                  type="text"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="Ej: David Miller"
                  required
                  style={{
                    width: '100%', padding: 10, background: t.bg, color: t.text,
                    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                    fontFamily: t.font, fontSize: 13, outline: 'none'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 4 }}>ID DE AEGISLINK</label>
                <input 
                  type="text"
                  value={inviteAegisId}
                  onChange={(e) => setInviteAegisId(e.target.value)}
                  placeholder="Ej: AAA-BBBB-CCCC"
                  required
                  style={{
                    width: '100%', padding: 10, background: t.bg, color: t.text,
                    border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                    fontFamily: t.font, fontSize: 13, outline: 'none'
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 4 }}>EQUIPO</label>
                  <select
                    value={inviteTeam}
                    onChange={(e) => setInviteTeam(e.target.value)}
                    style={{
                      width: '100%', padding: 10, background: t.bg, color: t.text,
                      border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                      fontFamily: t.font, fontSize: 13, outline: 'none'
                    }}>
                    <option value="Engineering">Engineering</option>
                    <option value="Legal">Legal</option>
                    <option value="Treasury Ops">Treasury Ops</option>
                    <option value="Field Research">Field Research</option>
                    <option value="External Audit">External Audit</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontFamily: t.fontMono, color: t.textDim, marginBottom: 4 }}>ROL</label>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    style={{
                      width: '100%', padding: 10, background: t.bg, color: t.text,
                      border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS,
                      fontFamily: t.font, fontSize: 13, outline: 'none'
                    }}>
                    <option value="Member">Member</option>
                    <option value="Mod">Mod</option>
                    <option value="Admin">Admin</option>
                  </select>
                </div>
              </div>

              <button 
                type="submit"
                style={{
                  background: t.accent, color: t.accentInk, border: 'none',
                  borderRadius: t.radius, padding: '12px 0',
                  fontFamily: t.font, fontWeight: 600, fontSize: 13, cursor: 'pointer',
                  marginTop: 10
                }}>Generar invitación cifrada</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { WorkDashboard });
