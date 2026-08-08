// store-shots.jsx — localized content for the App Store / Play Store screenshots.
//
// One source of truth for both canvases (prototype/appstore-shots.html at 1284×2778
// and prototype/playstore-shots.html at 1080×1920). Screenshots are a PER-LOCALE
// store asset: App Store Connect and Play Console both let you upload a different
// set per language, and the set attached to the primary language is what most of
// the world sees. See docs/APP-STORE-LISTING.md and docs/PLAY-STORE-LISTING.md.
//
// Why the mock screens live here instead of reusing prototype/screens.jsx:
//   1. screens.jsx' ScreenOnboarding/ScreenHome/ScreenChat render the "AegisLink
//      Work" enterprise enrolment demo (Cirrus Labs AG), not the anonymous consumer
//      flow — using them on the public listing would misrepresent the app.
//   2. The shared screens are hardcoded (part in English, part in Spanish) and are
//      also used by the deck/demo, so they can't be parameterized by locale without
//      churning that. Store shots need all three locales.
// The UI copy below mirrors the real app strings in mobile/src/i18n/locales/*.json.

const STORE_SHOT_LANGS = ['en', 'es', 'it'];
const STORE_SHOT_IDS = ['onboarding', 'home', 'chat', 'verify', 'call', 'groups', 'panic', 'devices'];

// Hardware shown in the "linked devices" shot — Android names on the Play listing,
// Apple names on the App Store one. Never a location: AegisLink does not record
// where a device connects from, and showing a city would contradict zero metadata.
const DEVICE_SETS = {
  play: [
    { name: 'Pixel 8',           os: 'Android 15',      key: 'K7F2·9AC1', ago: 'now',   this: true },
    { name: 'AegisLink Desktop', os: 'Linux · Wayland', key: '3B8D·1E4F', ago: 'min8',  desktop: true },
    { name: 'Galaxy Tab S9',     os: 'Android 14',      key: 'A19C·7D02', ago: 'days2' },
    { name: 'Fairphone 5',       os: 'Android 14',      key: 'C044·B6E8', ago: 'days5' },
    { name: 'Pixel 6a',          os: 'Android 14',      key: '8E51·2F7B', ago: 'days9' },
  ],
  app: [
    { name: 'iPhone 15 Pro',     os: 'iOS 18.4',        key: 'K7F2·9AC1', ago: 'now',   this: true },
    { name: 'AegisLink Desktop', os: 'macOS 14.5',      key: '3B8D·1E4F', ago: 'min8',  desktop: true },
    { name: 'iPad Air',          os: 'iPadOS 18.4',     key: 'A19C·7D02', ago: 'days2' },
    { name: 'Linux (Wayland)',   os: 'AegisLink 0.9.2', key: 'C044·B6E8', ago: 'days5', desktop: true },
    { name: 'iPhone SE',         os: 'iOS 17.6',        key: '8E51·2F7B', ago: 'days9' },
  ],
};

const SAFETY_WORDS = ['orbit', 'cedar', 'lantern', 'rhubarb', 'parallel', 'gust', 'cobalt', 'thicket'];

const STORE_SHOT_COPY = {
  // ─────────────────────────────────────────── English (App Store primary language)
  en: {
    captions: {
      onboarding: { kicker: 'ANONYMOUS BY DEFAULT', headline: 'No phone number.\nNo email.\nNo real name.' },
      home:       { kicker: 'ZERO METADATA',        headline: 'The relay never knows\nwho you talk to.' },
      chat:       { kicker: 'DOUBLE RATCHET · X3DH', headline: 'End-to-end encryption\non every message.' },
      verify:     { kicker: 'REAL VERIFICATION',    headline: 'Confirm identities\nwith QR and safety words.' },
      call:       { kicker: 'WEBRTC · DTLS-SRTP',   headline: 'Voice and video calls,\nencrypted too.' },
      groups:     { kicker: 'PRIVATE GROUPS',       headline: 'Group conversations\nwith anonymous voting.' },
      panic:      { kicker: 'PANIC MODE',           headline: 'Instant wipe and a decoy\naccount in one gesture.' },
      devices:    { kicker: 'YOU HOLD THE KEYS',    headline: 'Every device,\nits own key.' },
    },
    onboarding: {
      step: 'STEP 2 OF 3 · GENERATING IDENTITY',
      note: 'Your private key is created here and never leaves this phone.',
      cta: 'No phone · no email · no name',
    },
    home: {
      badge: 'ZERO METADATA',
      chats: [
        { name: 'moth19',        preview: 'Package arrived, all good 🌿', time: '09:14' },
        { name: '0x7a3f…c1e2',   preview: 'Confirmed by QR ✔',           time: '08:52' },
        { name: 'cipher_reader', preview: 'See you at 7',                time: 'Yesterday' },
        { name: 'Family',        preview: 'Photo (self-destructs in 1h)', time: 'Yesterday' },
        { name: 'satoshi.eth',   preview: 'Missed call',                 time: 'Mon' },
        { name: 'lark_88',       preview: 'Sent you the keys 🔑',        time: 'Mon' },
        { name: 'PrivacyOps',    preview: 'Anonymous poll · 11 votes',   time: 'Sun' },
        { name: 'nb_quiet',      preview: 'Voice message · 0:42',        time: 'Sun' },
        { name: 'Trip 2026',     preview: 'Scheduled message · Fri',     time: 'Sat' },
        { name: 'ember.k',       preview: 'View-once photo · opened',    time: 'Sat' },
      ],
    },
    chat: {
      dayLabel: 'END-TO-END ENCRYPTED · TODAY',
      msgs: [
        { me: true,  text: 'Added you — no phone number needed, right?' },
        { me: false, text: 'Right, just the QR. Nothing else to hand over.' },
        { me: false, text: 'Hey! Did the fingerprint I sent arrive?' },
        { me: true,  text: 'Yes, verified by QR — it matches 🔒' },
        { me: false, text: 'Perfect, now we can talk freely.' },
        { me: true,  text: 'Nobody can read this — not even the relay that carries it.' },
        { me: false, text: 'And nothing is stored on the server once it lands.' },
        { me: true,  text: 'This message self-destructs in 1 hour ⏳' },
      ],
      placeholder: 'Encrypted message…',
    },
    verify: {
      title: 'Verify contact',
      desc: 'Compare key fingerprints in person, by QR scan, or by reading 8 words.',
      orWords: 'OR — 8 SAFETY WORDS',
      scanQR: 'Scan QR',
      markVerified: 'Mark as verified',
      fingerprintLabel: 'KEY FINGERPRINT (HEX)',
    },
    call: {
      you: 'YOU',
      fingerprintLabel: 'SESSION FINGERPRINT',
      controls: { mute: 'MUTE', video: 'VIDEO', flip: 'FLIP', more: 'MORE', end: 'END' },
    },
    groups: {
      title: 'Groups',
      poll: {
        badge: 'ANONYMOUS POLL',
        question: 'Move the meetup to Saturday?',
        options: [{ label: 'Yes', pct: 71 }, { label: 'Keep Friday', pct: 29 }],
        notice: 'Votes are not linked to identities. Only the total is published.',
      },
      list: [
        { name: 'Family',         desc: 'Personal',                 members: 6 },
        { name: 'PrivacyOps',     desc: 'Relay infra & monitoring',  members: 11 },
        { name: 'Cipher Reading', desc: 'Cryptography study group',  members: 23 },
        { name: 'Trip 2026',      desc: 'Logistics and dates',       members: 4 },
        { name: 'DAO · Treasury', desc: 'Multisig signers · 3-of-5', members: 5 },
        { name: 'Neighbours',     desc: 'Building 4',                members: 9 },
      ],
    },
    panic: {
      title: 'Panic mode',
      heroTitle: 'If you are forced to open the app',
      heroDesc: 'AegisLink can instantly delete your chats, or show an empty account under a duress PIN.',
      gestureSection: 'PANIC GESTURE',
      gestures: [
        { l: 'SHAKE',      s: 'Shake device vigorously' },
        { l: 'TRIPLE TAP', s: 'Tap 3 times rapidly on logo' },
        { l: 'HOLD 3s',    s: 'Hold logo for 3 seconds' },
      ],
      duressSection: 'DURESS PIN',
      decoyLabel: 'Activate decoy PIN',
      decoySub: 'Opens a decoy account with fake data. Your real data is hidden, not erased.',
      currentPin: 'CURRENT PIN',
      autoWipeSection: 'AUTO-WIPE',
      autoWipe: 'Auto-wipe after failed attempts',
      autoWipeSub: '10 incorrect PINs in a row',
      cta: 'Activate panic mode',
    },
    devices: {
      title: 'Linked devices',
      info: 'Each device has its own key. If you lose one, revoke it here — new messages will immediately become unreadable.',
      thisDevice: 'THIS DEVICE',
      revoke: 'REVOKE',
      keyLabel: 'DEVICE KEY',
      linkBtn: '+ Link new device',
      footer: 'Keys never leave your devices.',
      times: { now: 'Active now', min8: 'Linked 8 min ago', days2: 'Linked 2 days ago', days5: 'Linked 5 days ago', days9: 'Linked 9 days ago' },
    },
  },

  // ─────────────────────────────────────────────────────────────────────── Español
  es: {
    captions: {
      onboarding: { kicker: 'ANÓNIMO POR DEFECTO',  headline: 'Sin teléfono.\nSin email.\nSin nombre real.' },
      home:       { kicker: 'CERO METADATOS',       headline: 'El relay nunca sabe\ncon quién hablas.' },
      chat:       { kicker: 'DOUBLE RATCHET · X3DH', headline: 'Cifrado extremo a extremo\nen cada mensaje.' },
      verify:     { kicker: 'VERIFICACIÓN REAL',    headline: 'Confirma identidades\ncon QR y palabras clave.' },
      call:       { kicker: 'WEBRTC · DTLS-SRTP',   headline: 'Llamadas de voz y video\ntambién cifradas.' },
      groups:     { kicker: 'GRUPOS PRIVADOS',      headline: 'Conversaciones grupales\ncon votación anónima.' },
      panic:      { kicker: 'MODO PÁNICO',          headline: 'Borrado instantáneo\ny señuelo en un toque.' },
      devices:    { kicker: 'TÚ TIENES LAS LLAVES', headline: 'Cada dispositivo,\nsu propia clave.' },
    },
    onboarding: {
      step: 'PASO 2 DE 3 · GENERANDO IDENTIDAD',
      note: 'Tu clave privada se crea aquí y nunca sale de este teléfono.',
      cta: 'Sin teléfono · sin email · sin nombre',
    },
    home: {
      badge: 'CERO METADATOS',
      chats: [
        { name: 'moth19',        preview: 'Llegó el paquete, todo bien 🌿', time: '09:14' },
        { name: '0x7a3f…c1e2',   preview: 'Confirmado por QR ✔',           time: '08:52' },
        { name: 'cipher_reader', preview: 'Nos vemos a las 7',             time: 'Ayer' },
        { name: 'Familia',       preview: 'Foto (se autodestruye en 1h)',  time: 'Ayer' },
        { name: 'satoshi.eth',   preview: 'Llamada perdida',               time: 'Lun' },
        { name: 'lark_88',       preview: 'Te mandé las claves 🔑',        time: 'Lun' },
        { name: 'PrivacyOps',    preview: 'Encuesta anónima · 11 votos',   time: 'Dom' },
        { name: 'nb_quiet',      preview: 'Mensaje de voz · 0:42',         time: 'Dom' },
        { name: 'Viaje 2026',    preview: 'Mensaje programado · vie',      time: 'Sáb' },
        { name: 'ember.k',       preview: 'Foto de ver una vez · abierta', time: 'Sáb' },
      ],
    },
    chat: {
      dayLabel: 'CIFRADO EXTREMO A EXTREMO · HOY',
      msgs: [
        { me: true,  text: 'Te añadí — sin número de teléfono, ¿verdad?' },
        { me: false, text: 'Exacto, solo el QR. Nada más que dar.' },
        { me: false, text: '¡Hola! ¿Llegó la huella que te mandé?' },
        { me: true,  text: 'Sí, verificada por QR — coincide 🔒' },
        { me: false, text: 'Perfecto, ya podemos hablar tranquilos.' },
        { me: true,  text: 'Nadie puede leer esto — ni siquiera el relay que lo transporta.' },
        { me: false, text: 'Y no queda nada en el servidor cuando llega.' },
        { me: true,  text: 'Este mensaje se autodestruye en 1 hora ⏳' },
      ],
      placeholder: 'Mensaje cifrado…',
    },
    verify: {
      title: 'Verificar contacto',
      desc: 'Compara las huellas de clave en persona, escaneando el QR o leyendo las 8 palabras.',
      orWords: 'O — 8 PALABRAS DE SEGURIDAD',
      scanQR: 'Escanear QR',
      markVerified: 'Marcar verificado',
      fingerprintLabel: 'HUELLA DIGITAL DE CLAVE (HEX)',
    },
    call: {
      you: 'TÚ',
      fingerprintLabel: 'HUELLA DE SESIÓN',
      controls: { mute: 'SILENCIAR', video: 'VÍDEO', flip: 'GIRAR', more: 'MÁS', end: 'COLGAR' },
    },
    groups: {
      title: 'Grupos',
      poll: {
        badge: 'ENCUESTA ANÓNIMA',
        question: '¿Movemos la quedada al sábado?',
        options: [{ label: 'Sí', pct: 71 }, { label: 'Dejarla el viernes', pct: 29 }],
        notice: 'Los votos no están vinculados a identidades. Solo se publica el total.',
      },
      list: [
        { name: 'Familia',        desc: 'Personal',                       members: 6 },
        { name: 'PrivacyOps',     desc: 'Infra del relay y monitorización', members: 11 },
        { name: 'Cipher Reading', desc: 'Grupo de estudio de criptografía', members: 23 },
        { name: 'Viaje 2026',     desc: 'Logística y fechas',             members: 4 },
        { name: 'DAO · Treasury', desc: 'Firmantes multisig · 3 de 5',    members: 5 },
        { name: 'Vecinos',        desc: 'Bloque 4',                       members: 9 },
      ],
    },
    panic: {
      title: 'Modo pánico',
      heroTitle: 'Si te obligan a abrir la app',
      heroDesc: 'AegisLink puede eliminar al instante tus chats o mostrar una cuenta vacía con un PIN de coacción.',
      gestureSection: 'GESTO DE PÁNICO',
      gestures: [
        { l: 'AGITAR',        s: 'Agita el dispositivo con fuerza' },
        { l: 'TRIPLE TOQUE',  s: 'Toca 3 veces rápido sobre el logo' },
        { l: 'MANTENER 3s',   s: 'Mantén pulsado el logo 3 segundos' },
      ],
      duressSection: 'PIN DE COACCIÓN',
      decoyLabel: 'Activar PIN señuelo',
      decoySub: 'Abre una cuenta señuelo con datos falsos. Tus datos reales quedan ocultos, no borrados.',
      currentPin: 'PIN ACTUAL',
      autoWipeSection: 'BORRADO AUTOMÁTICO',
      autoWipe: 'Borrado automático tras intentos fallidos',
      autoWipeSub: '10 PINs incorrectos seguidos',
      cta: 'Activar modo pánico',
    },
    devices: {
      title: 'Dispositivos vinculados',
      info: 'Cada dispositivo tiene su propia clave. Si pierdes uno, revócalo aquí — los mensajes nuevos se volverán ilegibles de inmediato.',
      thisDevice: 'ESTE DISPOSITIVO',
      revoke: 'REVOCAR',
      keyLabel: 'CLAVE DEL DISPOSITIVO',
      linkBtn: '+ Vincular nuevo dispositivo',
      footer: 'Las claves nunca salen de tus dispositivos.',
      times: { now: 'Activo ahora', min8: 'Vinculado hace 8 min', days2: 'Vinculado hace 2 días', days5: 'Vinculado hace 5 días', days9: 'Vinculado hace 9 días' },
    },
  },

  // ────────────────────────────────────────────────────────────────────── Italiano
  it: {
    captions: {
      onboarding: { kicker: 'ANONIMO PER DEFAULT',  headline: 'Nessun telefono.\nNessuna email.\nNessun nome reale.' },
      home:       { kicker: 'ZERO METADATI',        headline: 'Il relay non sa mai\ncon chi parli.' },
      chat:       { kicker: 'DOUBLE RATCHET · X3DH', headline: 'Cifratura end-to-end\nin ogni messaggio.' },
      verify:     { kicker: 'VERIFICA REALE',       headline: 'Conferma le identità\ncon QR e parole di sicurezza.' },
      call:       { kicker: 'WEBRTC · DTLS-SRTP',   headline: 'Chiamate vocali e video,\nanch’esse cifrate.' },
      groups:     { kicker: 'GRUPPI PRIVATI',       headline: 'Conversazioni di gruppo\ncon votazione anonima.' },
      panic:      { kicker: 'MODALITÀ PANICO',      headline: 'Cancellazione istantanea\ned esca con un gesto.' },
      devices:    { kicker: 'LE CHIAVI SONO TUE',   headline: 'Ogni dispositivo,\nla propria chiave.' },
    },
    onboarding: {
      step: 'PASSO 2 DI 3 · GENERAZIONE IDENTITÀ',
      note: 'La tua chiave privata viene creata qui e non lascia mai questo telefono.',
      cta: 'Senza telefono · senza email · senza nome',
    },
    home: {
      badge: 'ZERO METADATI',
      chats: [
        { name: 'moth19',        preview: 'Il pacco è arrivato, tutto ok 🌿', time: '09:14' },
        { name: '0x7a3f…c1e2',   preview: 'Confermato tramite QR ✔',         time: '08:52' },
        { name: 'cipher_reader', preview: 'Ci vediamo alle 7',               time: 'Ieri' },
        { name: 'Famiglia',      preview: 'Foto (si autodistrugge tra 1h)',  time: 'Ieri' },
        { name: 'satoshi.eth',   preview: 'Chiamata persa',                  time: 'Lun' },
        { name: 'lark_88',       preview: 'Ti ho mandato le chiavi 🔑',      time: 'Lun' },
        { name: 'PrivacyOps',    preview: 'Sondaggio anonimo · 11 voti',     time: 'Dom' },
        { name: 'nb_quiet',      preview: 'Messaggio vocale · 0:42',         time: 'Dom' },
        { name: 'Viaggio 2026',  preview: 'Messaggio programmato · ven',     time: 'Sab' },
        { name: 'ember.k',       preview: 'Foto visualizza una volta · aperta', time: 'Sab' },
      ],
    },
    chat: {
      dayLabel: 'CIFRATO END-TO-END · OGGI',
      msgs: [
        { me: true,  text: 'Ti ho aggiunto — senza numero di telefono, vero?' },
        { me: false, text: 'Esatto, solo il QR. Nient’altro da dare.' },
        { me: false, text: 'Ciao! Ti è arrivata l’impronta che ti ho mandato?' },
        { me: true,  text: 'Sì, verificata tramite QR — corrisponde 🔒' },
        { me: false, text: 'Perfetto, ora possiamo parlare tranquilli.' },
        { me: true,  text: 'Nessuno può leggerlo — nemmeno il relay che lo trasporta.' },
        { me: false, text: 'E sul server non resta nulla una volta consegnato.' },
        { me: true,  text: 'Questo messaggio si autodistrugge tra 1 ora ⏳' },
      ],
      placeholder: 'Messaggio cifrato…',
    },
    verify: {
      title: 'Verifica contatto',
      desc: 'Confronta le impronte della chiave di persona, tramite scansione QR o leggendo le 8 parole.',
      orWords: 'OPPURE — 8 PAROLE DI SICUREZZA',
      scanQR: 'Scansiona QR',
      markVerified: 'Segna verificato',
      fingerprintLabel: 'IMPRONTA DELLA CHIAVE (HEX)',
    },
    call: {
      you: 'TU',
      fingerprintLabel: 'IMPRONTA DI SESSIONE',
      controls: { mute: 'SILENZIA', video: 'VIDEO', flip: 'RUOTA', more: 'ALTRO', end: 'TERMINA' },
    },
    groups: {
      title: 'Gruppi',
      poll: {
        badge: 'SONDAGGIO ANONIMO',
        question: 'Spostiamo l’incontro a sabato?',
        options: [{ label: 'Sì', pct: 71 }, { label: 'Restiamo a venerdì', pct: 29 }],
        notice: 'I voti non sono collegati alle identità. Viene pubblicato solo il totale.',
      },
      list: [
        { name: 'Famiglia',       desc: 'Personale',                        members: 6 },
        { name: 'PrivacyOps',     desc: 'Infrastruttura relay e monitoraggio', members: 11 },
        { name: 'Cipher Reading', desc: 'Gruppo di studio di crittografia', members: 23 },
        { name: 'Viaggio 2026',   desc: 'Logistica e date',                 members: 4 },
        { name: 'DAO · Treasury', desc: 'Firmatari multisig · 3 su 5',      members: 5 },
        { name: 'Vicinato',       desc: 'Palazzina 4',                      members: 9 },
      ],
    },
    panic: {
      title: 'Modalità panico',
      heroTitle: 'Se sei costretto ad aprire l’app',
      heroDesc: 'AegisLink può cancellare istantaneamente le tue chat, o mostrare un account vuoto con un PIN di coercizione.',
      gestureSection: 'GESTO PANICO',
      gestures: [
        { l: 'SCUOTI',     s: 'Scuoti energicamente il dispositivo' },
        { l: 'TRIPLO TAP', s: 'Tocca 3 volte rapidamente il logo' },
        { l: 'TIENI 3s',   s: 'Tieni premuto il logo per 3 secondi' },
      ],
      duressSection: 'PIN DI COERCIZIONE',
      decoyLabel: 'Attiva PIN esca',
      decoySub: 'Apre un account esca con dati falsi. I tuoi dati reali restano nascosti, non cancellati.',
      currentPin: 'PIN ATTUALE',
      autoWipeSection: 'CANCELLAZIONE AUTOMATICA',
      autoWipe: 'Auto-cancella dopo tentativi falliti',
      autoWipeSub: '10 PIN errati di fila',
      cta: 'Attiva modalità panico',
    },
    devices: {
      title: 'Dispositivi collegati',
      info: 'Ogni dispositivo ha la propria chiave. Se ne perdi uno, revocalo qui — i nuovi messaggi diventeranno immediatamente illeggibili.',
      thisDevice: 'QUESTO DISPOSITIVO',
      revoke: 'REVOCA',
      keyLabel: 'CHIAVE DISPOSITIVO',
      linkBtn: '+ Collega nuovo dispositivo',
      footer: 'Le chiavi non lasciano mai i tuoi dispositivi.',
      times: { now: 'Attivo ora', min8: 'Collegato 8 min fa', days2: 'Collegato 2 giorni fa', days5: 'Collegato 5 giorni fa', days9: 'Collegato 9 giorni fa' },
    },
  },
};

// ─── shared bits ──────────────────────────────────────────────────────────────

const CHAT_COLORS = ['#5bf2b9', '#8b5cf6', '#f59e0b', '#06b6d4', '#ef4444',
                     '#34d399', '#a78bfa', '#fbbf24', '#22d3ee', '#f472b6'];
const GROUP_COLORS = ['#06b6d4', '#ef4444', '#5bf2b9', '#f59e0b'];

function ShotTopBar({ t, title, big }) {
  const { I } = window;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 18px 12px', minHeight: 52, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <I.ChevronL size={22} style={{ color: t.textDim }}/>
        <span style={{
          fontFamily: t.fontDisplay, fontWeight: t.displayWeight,
          fontStyle: t.italic ? 'italic' : 'normal',
          fontSize: big ? 22 : 17, letterSpacing: '-0.02em', color: t.text,
        }}>{title}</span>
      </div>
      <I.More size={20} style={{ color: t.textDim }}/>
    </div>
  );
}

function ShotSection({ t, label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
        letterSpacing: '0.1em', padding: '0 18px 6px',
      }}>{label}</div>
      <div style={{ background: t.surface, borderTop: `1px solid ${t.divider}`, borderBottom: `1px solid ${t.divider}` }}>
        {children}
      </div>
    </div>
  );
}

function ShotToggle({ t, label, sub, on }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{label}</div>
        {sub && <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      <div style={{
        width: 42, height: 24, borderRadius: 12, flexShrink: 0,
        background: on ? t.accent : t.surface2, position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 3, left: on ? 21 : 3,
          width: 18, height: 18, borderRadius: '50%', background: on ? t.accentInk : t.textFaint,
        }}/>
      </div>
    </div>
  );
}

function ShotQR({ t }) {
  // Pseudo QR — deterministic 21×21 pattern, same generator as prototype/screens.jsx.
  const cells = [];
  const seed = 0x9c3a7;
  for (let i = 0; i < 441; i++) {
    const x = i % 21, y = Math.floor(i / 21);
    const inFinder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
    let on;
    if (inFinder) {
      const ax = x < 7 ? x : (x - 14), ay = y < 7 ? y : (y - 14);
      on = (ax === 0 || ax === 6 || ay === 0 || ay === 6) || (ax >= 2 && ax <= 4 && ay >= 2 && ay <= 4);
    } else {
      on = ((x * 73 + y * 131 + seed) & 0x3) === 0 || ((x * x + y) & 0x7) === 1;
    }
    if (on) cells.push({ x, y });
  }
  return (
    <div style={{
      width: 200, height: 200, padding: 12, background: t.bg,
      borderRadius: t.radius, border: `1px solid ${t.borderStrong}`, position: 'relative',
    }}>
      <svg viewBox="0 0 21 21" width="174" height="174" style={{ display: 'block' }}>
        {cells.map((c, i) => <rect key={i} x={c.x} y={c.y} width="1" height="1" fill={t.accent}/>)}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: t.bg,
          border: `2px solid ${t.accent}`, color: t.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <window.AegisMark t={t} size={20} mono/>
        </div>
      </div>
    </div>
  );
}

function ShotWordGrid({ t, words }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {words.map((w, i) => (
        <div key={w} style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          padding: '6px 8px', background: t.surface2, borderRadius: t.radiusS,
        }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, width: 14 }}>
            {(i + 1).toString().padStart(2, '0')}
          </span>
          <span style={{ fontFamily: t.fontMono, fontSize: 14, color: t.text, fontWeight: 500 }}>{w}</span>
        </div>
      ))}
    </div>
  );
}

// ─── screens ──────────────────────────────────────────────────────────────────

function ShotOnboarding({ t, c }) {
  const { AegisMark, AegisWord } = window;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
                  padding: '32px 26px', background: t.bg, color: t.text, alignItems: 'center' }}>
      <AegisMark t={t} size={56}/>
      <AegisWord t={t} size={26}/>
      <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: '0.12em',
                    margin: '18px 0 30px', textAlign: 'center' }}>
        {c.onboarding.step}
      </div>
      <div style={{
        width: '100%', border: `1px solid ${t.borderStrong}`, borderRadius: t.radius,
        padding: 16, background: t.surface, marginBottom: 22,
      }}>
        <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginBottom: 12, lineHeight: 1.45 }}>
          {c.onboarding.note}
        </div>
        <ShotWordGrid t={t} words={SAFETY_WORDS.slice(0, 4)}/>
      </div>
      <div style={{ width: '100%', height: 6, borderRadius: 3, background: t.surface2, overflow: 'hidden', marginBottom: 22 }}>
        <div style={{ width: '66%', height: '100%', background: t.accent, borderRadius: 3 }}/>
      </div>
      <div style={{
        width: '100%', padding: '15px 0', borderRadius: t.radius, textAlign: 'center',
        background: t.accent, color: t.accentInk, fontFamily: t.font, fontWeight: 600, fontSize: 15,
      }}>{c.onboarding.cta}</div>
    </div>
  );
}

function ShotHome({ t, c }) {
  const { AegisMark, AegisWord, Avatar, SecuredBadge } = window;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AegisMark t={t} size={26}/>
          <AegisWord t={t} size={18}/>
        </div>
        <SecuredBadge t={t} label={c.home.badge}/>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {c.home.chats.map((chat, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
                                borderBottom: `1px solid ${t.divider}` }}>
            <Avatar t={t} name={chat.name} color={CHAT_COLORS[i % CHAT_COLORS.length]}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: t.fontMono, fontWeight: 600, fontSize: 15, color: t.text }}>{chat.name}</div>
              <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{chat.preview}</div>
            </div>
            <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, flexShrink: 0 }}>{chat.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShotChat({ t, c }) {
  const { Avatar, SecuredBadge } = window;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px 12px',
                    borderBottom: `1px solid ${t.divider}` }}>
        <Avatar t={t} name="moth19" color="#5bf2b9" size={36}/>
        <div>
          <div style={{ fontFamily: t.fontMono, fontWeight: 600, fontSize: 15, color: t.text }}>moth19</div>
          <SecuredBadge t={t}/>
        </div>
      </div>
      {/* justifyContent flex-end: a short thread sits on the composer, like a real chat */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 10px',
                    display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10 }}>
        <div style={{ alignSelf: 'center', fontFamily: t.fontMono, fontSize: 9.5,
                      color: t.textFaint, letterSpacing: '0.08em', marginBottom: 2 }}>
          {c.chat.dayLabel}
        </div>
        {c.chat.msgs.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.me ? 'flex-end' : 'flex-start', maxWidth: '78%',
            background: m.me ? t.bubbleOut : t.bubbleIn, color: m.me ? t.bubbleOutText : t.bubbleInText,
            padding: '10px 14px', borderRadius: t.radius, fontFamily: t.font, fontSize: 14.5, lineHeight: 1.4,
          }}>{m.text}</div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px 18px' }}>
        <div style={{ flex: 1, height: 44, borderRadius: 22, background: t.surface, border: `1px solid ${t.border}`,
                      display: 'flex', alignItems: 'center', padding: '0 16px',
                      fontFamily: t.font, fontSize: 14, color: t.textFaint }}>
          {c.chat.placeholder}
        </div>
      </div>
    </div>
  );
}

function ShotVerify({ t, c }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <ShotTopBar t={t} title={c.verify.title}/>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 22px 22px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ fontFamily: t.font, fontSize: 13, color: t.textDim,
                      textAlign: 'center', lineHeight: 1.5, marginBottom: 20, maxWidth: 290 }}>
          {c.verify.desc}
        </div>
        <ShotQR t={t}/>
        <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                      letterSpacing: '0.1em', margin: '22px 0 10px', textAlign: 'center' }}>
          {c.verify.orWords}
        </div>
        <div style={{ width: '100%', border: `1px solid ${t.borderStrong}`,
                      borderRadius: t.radius, padding: 14, background: t.surface }}>
          <ShotWordGrid t={t} words={SAFETY_WORDS}/>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, width: '100%' }}>
          <div style={{
            flex: 1, padding: '12px 0', borderRadius: t.radius, textAlign: 'center',
            border: `1px solid ${t.borderStrong}`, color: t.text,
            fontFamily: t.font, fontWeight: 500, fontSize: 14,
          }}>{c.verify.scanQR}</div>
          <div style={{
            flex: 1, padding: '12px 0', borderRadius: t.radius, textAlign: 'center',
            background: t.accent, color: t.accentInk, fontFamily: t.font, fontWeight: 600, fontSize: 14,
          }}>{c.verify.markVerified}</div>
        </div>

        <div style={{ width: '100%', marginTop: 18 }}>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                        letterSpacing: '0.08em', marginBottom: 8 }}>{c.verify.fingerprintLabel}</div>
          <div style={{
            border: `1px solid ${t.border}`, borderRadius: t.radius, padding: '12px 14px',
            background: t.surface, fontFamily: t.fontMono, fontSize: 12.5,
            color: t.textDim, lineHeight: 1.7, letterSpacing: '0.06em', textAlign: 'center',
          }}>
            5F2A 91C4 0BD7 6E38<br/>
            A18B 74E0 C592 3DF1
          </div>
        </div>
      </div>
    </div>
  );
}

function ShotCall({ t, c }) {
  const { I } = window;
  const peerColor = '#8b5cf6';
  const controls = [
    { i: I.MicOff, label: c.call.controls.mute,  light: false },
    { i: I.Video,  label: c.call.controls.video, light: true },
    { i: I.Flip,   label: c.call.controls.flip,  light: false },
    { i: I.More,   label: c.call.controls.more,  light: false },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  background: '#000', color: '#fff', position: 'relative', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 30% 30%, ${peerColor}55, #000 65%),
                     radial-gradient(circle at 70% 75%, ${t.accent}22, transparent 50%)`,
      }}/>
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0 1px, transparent 1px 4px)',
      }}/>
      <div style={{ position: 'relative', zIndex: 2, padding: '48px 22px 26px',
                    display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                          background: 'rgba(0,0,0,0.5)', borderRadius: 99 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.accent }}/>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, letterSpacing: '0.08em', color: t.accent }}>
                E2EE · CURVE25519 · SRTP
              </span>
            </div>
            <div style={{ fontFamily: t.fontDisplay, fontSize: 26, marginTop: 12,
                          fontStyle: t.italic ? 'italic' : 'normal', fontWeight: t.displayWeight,
                          letterSpacing: '-0.02em' }}>satoshi.eth</div>
            <div style={{ fontFamily: t.fontMono, fontSize: 13, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>04:18</div>
          </div>
          <div style={{
            width: 90, height: 130, borderRadius: t.radius,
            background: `linear-gradient(135deg, ${t.accent}33, #222)`,
            border: '1px solid rgba(255,255,255,0.15)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 6,
          }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{c.call.you}</span>
          </div>
        </div>

        <div style={{ flex: 1 }}/>

        <div style={{
          background: 'rgba(0,0,0,0.5)', borderRadius: t.radius, padding: '12px 14px',
          marginBottom: 18, border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.08em' }}>
              {c.call.fingerprintLabel}
            </span>
            <I.Check size={14} style={{ color: t.accent }}/>
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 16, color: '#fff', marginTop: 4, letterSpacing: '0.04em' }}>
            orbit · cedar · lantern · gust
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0 2px' }}>
          {controls.map((b, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 62 }}>
              <div style={{
                width: 54, height: 54, borderRadius: '50%',
                background: b.light ? '#fff' : 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: b.light ? '#000' : '#fff',
              }}><b.i size={22}/></div>
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.5)',
                             letterSpacing: '0.06em', textAlign: 'center' }}>{b.label}</span>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 66 }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%', background: '#e63946',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', transform: 'rotate(135deg)',
            }}><I.Phone size={26}/></div>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.5)',
                           letterSpacing: '0.06em', textAlign: 'center' }}>{c.call.controls.end}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShotGroups({ t, c }) {
  const { I } = window;
  const poll = c.groups.poll;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 18px 12px' }}>
        <span style={{ fontFamily: t.fontDisplay, fontWeight: t.displayWeight,
                       fontStyle: t.italic ? 'italic' : 'normal', fontSize: 22,
                       letterSpacing: '-0.02em', color: t.text }}>{c.groups.title}</span>
        <I.Plus size={22} style={{ color: t.textDim }}/>
      </div>

      {/* anonymous poll — the pillar the caption promises */}
      <div style={{
        margin: '2px 18px 14px', padding: 14, background: t.surface,
        border: `1px solid ${t.borderStrong}`, borderRadius: t.radius,
      }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: t.accent }}/>
          <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: '0.1em' }}>
            {poll.badge}
          </span>
        </div>
        <div style={{ fontFamily: t.font, fontSize: 14, fontWeight: 600, color: t.text, marginBottom: 10 }}>
          {poll.question}
        </div>
        {poll.options.map((o, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>{o.label}</span>
              <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim }}>{o.pct}%</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: t.surface2, overflow: 'hidden' }}>
              <div style={{ width: `${o.pct}%`, height: '100%', background: t.accent, borderRadius: 3 }}/>
            </div>
          </div>
        ))}
        <div style={{ fontFamily: t.font, fontSize: 11, color: t.textFaint, marginTop: 8, lineHeight: 1.4 }}>
          {poll.notice}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {c.groups.list.map((g, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px',
                                borderBottom: `1px solid ${t.divider}` }}>
            <div style={{
              width: 46, height: 46, borderRadius: t.radiusL, flexShrink: 0,
              background: GROUP_COLORS[i % GROUP_COLORS.length] + '22',
              color: GROUP_COLORS[i % GROUP_COLORS.length],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><I.Users size={22}/></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 15, color: t.text }}>{g.name}</div>
              <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.desc}</div>
            </div>
            <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint,
                          padding: '3px 7px', background: t.surface2, borderRadius: 99, flexShrink: 0 }}>{g.members}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShotPanic({ t, c }) {
  const { I } = window;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <ShotTopBar t={t} title={c.panic.title}/>
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0 16px' }}>
        <div style={{ padding: '4px 28px 14px', textAlign: 'center' }}>
          <div style={{
            margin: '0 auto 12px', width: 62, height: 62, borderRadius: '50%',
            background: 'rgba(255,107,107,0.12)', border: `1px solid ${t.danger}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.danger,
          }}><I.Shield size={26} stroke={1.8}/></div>
          <div style={{
            fontFamily: t.fontDisplay, fontSize: 20,
            fontStyle: t.italic ? 'italic' : 'normal', fontWeight: t.displayWeight,
            letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>{c.panic.heroTitle}</div>
          <div style={{
            fontFamily: t.font, fontSize: 12.5, color: t.textDim,
            lineHeight: 1.45, maxWidth: 300, margin: '8px auto 0',
          }}>{c.panic.heroDesc}</div>
        </div>

        <ShotSection t={t} label={c.panic.gestureSection}>
          {c.panic.gestures.map((o, i, arr) => (
            <div key={o.l} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px',
              borderBottom: i < arr.length - 1 ? `1px solid ${t.divider}` : 'none',
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                border: `2px solid ${i === 0 ? t.danger : t.borderStrong}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {i === 0 && <div style={{ width: 9, height: 9, borderRadius: '50%', background: t.danger }}/>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: t.fontMono, fontSize: 13, letterSpacing: '0.04em',
                              fontWeight: i === 0 ? 600 : 400, color: t.text }}>{o.l}</div>
                <div style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>{o.s}</div>
              </div>
            </div>
          ))}
        </ShotSection>

        <ShotSection t={t} label={c.panic.duressSection}>
          <ShotToggle t={t} label={c.panic.decoyLabel} sub={c.panic.decoySub} on/>
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim,
                          letterSpacing: '0.06em', marginBottom: 7 }}>{c.panic.currentPin}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} style={{
                  flex: 1, height: 34, background: t.surface2, borderRadius: t.radiusS,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: t.text, fontSize: 18,
                }}>●</div>
              ))}
            </div>
          </div>
        </ShotSection>

        <ShotSection t={t} label={c.panic.autoWipeSection}>
          <ShotToggle t={t} label={c.panic.autoWipe} sub={c.panic.autoWipeSub} on={false}/>
        </ShotSection>

        <div style={{ padding: '2px 18px 0' }}>
          <div style={{
            width: '100%', padding: '14px 0', borderRadius: t.radius, textAlign: 'center',
            background: t.danger, color: '#fff', fontFamily: t.font, fontWeight: 600, fontSize: 14,
          }}>{c.panic.cta}</div>
        </div>
      </div>
    </div>
  );
}

function ShotDevices({ t, c, store }) {
  const { I } = window;
  const devices = DEVICE_SETS[store] || DEVICE_SETS.play;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, overflow: 'hidden' }}>
      <ShotTopBar t={t} title={c.devices.title} big/>
      <div style={{
        margin: '0 18px 14px', padding: '12px 14px', background: t.surface,
        border: `1px solid ${t.border}`, borderRadius: t.radius,
        fontFamily: t.font, fontSize: 12.5, color: t.textDim, lineHeight: 1.5,
      }}>{c.devices.info}</div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {devices.map((d, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px',
                                borderBottom: `1px solid ${t.divider}` }}>
            <div style={{
              width: 38, height: 38, borderRadius: t.radius, flexShrink: 0,
              background: t.surface2, color: t.text,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{d.desktop ? <I.Building size={18}/> : <I.Phone size={18}/>}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: t.font, fontWeight: 600, fontSize: 14 }}>{d.name}</span>
                {d.this && <span style={{
                  fontFamily: t.fontMono, fontSize: 8.5, color: t.accent, letterSpacing: '0.06em',
                  padding: '1px 5px', border: `1px solid ${t.accent}`, borderRadius: 99,
                }}>{c.devices.thisDevice}</span>}
              </div>
              <div style={{ fontFamily: t.font, fontSize: 11.5, color: t.textDim, marginTop: 2 }}>
                {d.os} · {c.devices.times[d.ago]}
              </div>
              <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 3 }}>
                {c.devices.keyLabel} {d.key}
              </div>
            </div>
            {!d.this && (
              <div style={{
                background: 'transparent', border: `1px solid ${t.danger}55`, color: t.danger,
                borderRadius: t.radiusS, padding: '5px 10px',
                fontFamily: t.fontMono, fontSize: 10, letterSpacing: '0.06em', flexShrink: 0,
              }}>{c.devices.revoke}</div>
            )}
            {d.this && <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.accent, flexShrink: 0 }}/>}
          </div>
        ))}

        <div style={{ padding: '18px 18px 10px' }}>
          <div style={{
            width: '100%', padding: '13px 0', borderRadius: t.radius, textAlign: 'center',
            background: t.accent, color: t.accentInk, fontFamily: t.font, fontWeight: 600, fontSize: 14,
          }}>{c.devices.linkBtn}</div>
          <div style={{ fontFamily: t.font, fontSize: 12, color: t.textFaint,
                        textAlign: 'center', marginTop: 12 }}>{c.devices.footer}</div>
        </div>
      </div>
    </div>
  );
}

const SHOT_SCREENS = {
  onboarding: ShotOnboarding,
  home: ShotHome,
  chat: ShotChat,
  verify: ShotVerify,
  call: ShotCall,
  groups: ShotGroups,
  panic: ShotPanic,
  devices: ShotDevices,
};

// Returns the ordered shot list for a locale: { id, Screen, kicker, headline }.
function getStoreShots(lang) {
  const copy = STORE_SHOT_COPY[lang] || STORE_SHOT_COPY.en;
  return STORE_SHOT_IDS.map(id => ({
    id,
    Screen: SHOT_SCREENS[id],
    copy,
    kicker: copy.captions[id].kicker,
    headline: copy.captions[id].headline,
  }));
}

// Reads ?lang= from the URL, falling back to English (the App Store primary language).
function getStoreShotLang() {
  const lang = new URLSearchParams(window.location.search).get('lang');
  return STORE_SHOT_LANGS.includes(lang) ? lang : 'en';
}

Object.assign(window, {
  STORE_SHOT_LANGS, STORE_SHOT_IDS, STORE_SHOT_COPY,
  getStoreShots, getStoreShotLang,
});
