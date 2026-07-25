# App Store — App Store Connect listing (borrador)

> Estado: **borrador listo para pegar en App Store Connect → App Store → Versión 1.0
> → Información de la app / Distribución.** Complementa `docs/IOS-LAUNCH-READINESS.md`
> (checklist de bloqueantes de build/submit) — este doc es solo el contenido textual +
> assets de la ficha, no el roadmap de build.
>
> Fuente de verdad de privacidad: `docs/privacy-policy.md`. Si algo aquí discrepa con
> ese doc, el privacy-policy manda (regla de oro "la doc no miente").
>
> Espejo de `docs/PLAY-STORE-LISTING.md` — mismo producto, mismos pilares, adaptado a
> los campos y límites de caracteres de App Store Connect (distintos de Play Console).

## Bundle ID
`com.aegislink.app`

## Localizaciones de la ficha

App Store Connect **no traduce metadatos automáticamente** (a diferencia de Play
Console, que sí ofrece traducción automática gratuita). Cada idioma se añade a
mano en **App Store Connect → App Store → la versión → selector de idioma arriba
a la derecha → "Añadir idioma"**, y se pega el texto de abajo campo por campo.

| Idioma | Rol | UI de la app localizada |
|---|---|---|
| **English (U.S.)** | **Principal** — fallback mundial para todo país sin ficha propia | ✅ `mobile/src/i18n/locales/en.json` |
| Español (España) | Localización | ✅ `es.json` |
| Italiano | Localización | ✅ `it.json` |

> El idioma principal se cambia en **Información de la app → Idioma principal**.
> Debe ser inglés: es lo que ve un usuario en Alemania, Japón o Brasil mientras
> no exista una ficha en su idioma.

El nombre de la app es **`AegisLink`** en los tres idiomas (9 caracteres; no
confundir con el título de 30 de Play, que incluye descriptor — aquí ese
descriptor va en el subtítulo).

> **No usar nombres de la competencia en las palabras clave.** Apple rechaza
> metadatos que incluyen marcas de terceros (`signal`, `whatsapp`, `threema`…).
> Las keywords de abajo ya están limpias; comparar con `signal` está bien en la
> descripción como referencia técnica al diseño criptográfico, no como keyword.

---

### 🇺🇸 English (U.S.) — idioma principal

**Subtitle** (30 máx.)
```
Private chat, zero metadata
```
(27 caracteres)

**Promotional text** (170 máx. — editable sin nueva revisión de Apple)
```
Anonymous end-to-end encrypted messaging. No phone number, no email, no real
name. Zero metadata on the server. Open source and auditable.
```
(138 caracteres)

**Keywords** (100 máx., separadas por comas, sin espacios tras la coma)
```
encrypted,e2ee,privacy,anonymous,messenger,secure chat,private,double ratchet,x3dh,no metadata
```
(94 caracteres)

**Description** (4000 máx.)
```
AegisLink is an end-to-end encrypted messenger, anonymous by default and built
to keep no metadata — not who you talk to, not when, not how often.

NO PERSONAL DATA TO GET STARTED
Sign up with no phone number, no email and no real name. Your cryptographic
identity is generated on your device and stays there: the private key never
leaves your iPhone.

REAL END-TO-END ENCRYPTION
Every conversation uses Double Ratchet + X3DH (the same cryptographic design as
Signal), with manual verification by QR code or 8 security words. If a
contact's key changes, you are warned before you keep talking.

ZERO METADATA ON THE SERVER
The relay forwards encrypted messages it cannot read, and keeps no record of
who you talk to, when, or how often. Sealed sender by default: not even the
relay knows who sent each message.

SELF-DESTRUCTING MESSAGES
Configurable per-chat timers, view-once messages and scheduled messages.

ENCRYPTED VOICE AND VIDEO CALLS
1:1 and group calls over WebRTC with DTLS-SRTP, with live fingerprint
verification during the call, and native CallKit integration so encrypted calls
feel just like regular ones.

PRIVATE GROUPS
Groups with roles (admin/mod/member) and anonymous voting for group decisions.

PANIC MODE
A configurable gesture wipes your chats instantly, or opens a decoy account
under a duress PIN — what anyone else sees: nothing.

MULTIPLE IDENTITIES
Isolated profiles (personal and work, for example) on the same device, each
with its own keys.

YOUR KEYS, YOUR DEVICE
Every linked device has its own key; revoking one makes its new messages
unreadable instantly. Optional encrypted backup whose key only you know.

OPEN SOURCE AND AUDITABLE
All cryptography is open source and verifiable by third parties.

KNOWN LIMITATIONS (read these before trusting it with sensitive data)
— The cryptography has NOT yet passed a full independent external audit (one is
  planned; follow the real status in the repository).
— Cryptography runs in JavaScript/Hermes, not in a dedicated native enclave;
  performance on very low-end hardware may be limited.
— The service is run by a single maintainer in a single region, so occasional
  relay outages are possible (messages are not lost: they are retried on
  reconnect).

AegisLink does not ask for your address book, does not sell data and cannot
read your messages.
```

**What's New** (4000 máx. — obligatorio desde la 2ª subida)
```
First release of AegisLink for iOS: anonymous onboarding, 1:1 E2EE chat with
Double Ratchet/X3DH, encrypted voice and video calls with native CallKit,
private groups, panic mode and encrypted backup.
```

---

### 🇪🇸 Español (España)

**Subtítulo** (30 máx.)
```
Chat privado, cero metadatos
```
(28 caracteres)

**Texto promocional** (170 máx.)
```
Mensajería E2EE anónima por defecto. Sin teléfono, sin email, sin nombre real.
Cero metadatos en el servidor. Código abierto y auditable.
```
(137 caracteres)

**Palabras clave** (100 máx.)
```
cifrado,e2ee,privacidad,anonimo,mensajeria,chat seguro,privado,double ratchet,x3dh,sin metadatos
```
(96 caracteres — `signal` retirado: es marca de terceros y Apple rechaza la ficha por ello)

**Descripción** (4000 máx.)
```
AegisLink es una app de mensajería cifrada extremo a extremo, anónima por
defecto y diseñada para no guardar metadatos — ni de quién hablas, ni cuándo,
ni con qué frecuencia.

SIN DATOS PERSONALES PARA EMPEZAR
Regístrate sin teléfono, sin email y sin nombre real. Tu identidad
criptográfica se genera y se queda en tu dispositivo: la clave privada nunca
sale de tu iPhone.

CIFRADO EXTREMO A EXTREMO DE VERDAD
Cada conversación usa Double Ratchet + X3DH (el mismo diseño criptográfico
que Signal), con verificación manual por código QR o por las 8 palabras de
seguridad. Si la clave de tu contacto cambia, te avisamos antes de que sigas
hablando.

CERO METADATOS EN EL SERVIDOR
El relay reenvía mensajes cifrados que no puede leer, y no guarda con quién
hablas, cuándo ni con qué frecuencia. Sealed-sender por defecto: ni el propio
relay conoce quién envía cada mensaje.

MENSAJES QUE SE AUTODESTRUYEN
Timers configurables por chat, mensajes de "ver una vez" y programados.

LLAMADAS DE VOZ Y VIDEO CIFRADAS
Llamadas 1:1 y grupales sobre WebRTC con DTLS-SRTP, con verificación de
huella en vivo durante la llamada, e integración nativa con CallKit para
llamadas VoIP igual de fluidas que una llamada normal.

GRUPOS PRIVADOS
Grupos con roles (admin/mod/miembro) y votación anónima para decisiones del
grupo.

MODO PÁNICO
Un gesto configurable borra tus chats al instante o abre una cuenta señuelo
bajo un PIN de coacción — lo que ven los demás: nada.

MÚLTIPLES IDENTIDADES
Perfiles aislados (por ejemplo personal y trabajo) en el mismo dispositivo,
cada uno con sus propias claves.

TUS CLAVES, TU DISPOSITIVO
Cada dispositivo vinculado tiene su propia clave; revocar uno hace que sus
mensajes nuevos queden ilegibles al instante. Backup cifrado opcional cuya
clave solo conoces tú.

CÓDIGO ABIERTO Y AUDITABLE
Toda la criptografía es de código abierto y verificable por terceros.

LIMITACIONES CONOCIDAS (léelas antes de confiar datos sensibles)
— La criptografía aún NO ha pasado una auditoría externa independiente
  completa (está planificada; sigue el estado real en el repositorio).
— La criptografía corre en JavaScript/Hermes, no en un enclave nativo
  dedicado; el rendimiento en gama muy baja puede ser limitado.
— Servicio operado por un mantenedor único en una sola región; puede haber
  interrupciones puntuales del relay (los mensajes no se pierden: se
  reintentan al reconectar).

AegisLink no pide tu agenda de contactos, no vende datos y no puede leer tus
mensajes.
```

**Novedades de esta versión** (4000 máx.)
```
Primera versión de AegisLink para iOS: onboarding anónimo, chat 1:1 E2EE con
Double Ratchet/X3DH, llamadas de voz y video cifradas con CallKit nativo,
grupos privados, modo pánico y backup cifrado.
```

---

### 🇮🇹 Italiano

**Sottotitolo** (30 máx.)
```
Chat privata, zero metadati
```
(27 caracteres)

**Testo promozionale** (170 máx.)
```
Messaggistica E2EE anonima per impostazione predefinita. Senza telefono, senza
email, senza nome reale. Zero metadati sul server. Codice aperto e verificabile.
```
(159 caracteres)

**Parole chiave** (100 máx.)
```
cifratura,e2ee,privacy,anonimo,messaggi,chat sicura,crittografia,double ratchet,x3dh,zero metadati
```
(98 caracteres)

**Descrizione** (4000 máx.)
```
AegisLink è un'app di messaggistica cifrata end-to-end, anonima per
impostazione predefinita e progettata per non conservare metadati — né con chi
parli, né quando, né con quale frequenza.

NESSUN DATO PERSONALE PER INIZIARE
Registrati senza telefono, senza email e senza nome reale. La tua identità
crittografica viene generata sul dispositivo e lì rimane: la chiave privata non
lascia mai il tuo iPhone.

CIFRATURA END-TO-END VERA
Ogni conversazione usa Double Ratchet + X3DH (lo stesso design crittografico di
Signal), con verifica manuale tramite codice QR o le 8 parole di sicurezza. Se
la chiave di un contatto cambia, ti avvisiamo prima che tu continui a parlare.

ZERO METADATI SUL SERVER
Il relay inoltra messaggi cifrati che non può leggere e non registra con chi
parli, quando né con quale frequenza. Sealed sender per impostazione
predefinita: nemmeno il relay sa chi invia ciascun messaggio.

MESSAGGI CHE SI AUTODISTRUGGONO
Timer configurabili per chat, messaggi "visualizza una volta" e messaggi
programmati.

CHIAMATE VOCALI E VIDEO CIFRATE
Chiamate 1:1 e di gruppo su WebRTC con DTLS-SRTP, con verifica dell'impronta in
tempo reale durante la chiamata e integrazione nativa con CallKit: le chiamate
cifrate funzionano come quelle normali.

GRUPPI PRIVATI
Gruppi con ruoli (admin/mod/membro) e votazione anonima per le decisioni del
gruppo.

MODALITÀ PANICO
Un gesto configurabile cancella le tue chat all'istante oppure apre un account
esca con un PIN di coercizione — quello che vedono gli altri: nulla.

IDENTITÀ MULTIPLE
Profili isolati (per esempio personale e lavoro) sullo stesso dispositivo,
ciascuno con le proprie chiavi.

LE TUE CHIAVI, IL TUO DISPOSITIVO
Ogni dispositivo collegato ha la propria chiave; revocarne uno rende
illeggibili all'istante i suoi nuovi messaggi. Backup cifrato opzionale la cui
chiave conosci solo tu.

CODICE APERTO E VERIFICABILE
Tutta la crittografia è open source e verificabile da terze parti.

LIMITI NOTI (leggili prima di affidare dati sensibili)
— La crittografia NON ha ancora superato un audit esterno indipendente
  completo (è pianificato; segui lo stato reale nel repository).
— La crittografia gira in JavaScript/Hermes, non in un enclave nativo
  dedicato; le prestazioni su hardware molto datato possono essere limitate.
— Servizio gestito da un unico manutentore in una sola regione: sono possibili
  interruzioni occasionali del relay (i messaggi non vengono persi: vengono
  ritentati alla riconnessione).

AegisLink non chiede la tua rubrica, non vende dati e non può leggere i tuoi
messaggi.
```

**Novità di questa versione** (4000 máx.)
```
Prima versione di AegisLink per iOS: onboarding anonimo, chat 1:1 E2EE con
Double Ratchet/X3DH, chiamate vocali e video cifrate con CallKit nativo, gruppi
privati, modalità panico e backup cifrato.
```

## Categoría
Principal: **Redes sociales** (Social Networking) — alternativa: **Utilidades**
si Apple objeta la categoría social por el enfoque anónimo/sin perfil público.

## Íconos y capturas

| Asset | Especificación App Store | Estado |
|---|---|---|
| Ícono de la app | 1024×1024 PNG, sin alpha, sin esquinas redondeadas | Reusar/derivar de `promo-video/play-store/icon-512.png` (subir versión 1024² sin canal alpha — pendiente de generar) |
| Capturas iPhone 6.5"/6.7" | 3-10 imágenes, PNG/JPG, 1284×2778 (o 1242×2688) | ✅ 8 generadas, ver abajo |
| Capturas iPad | Solo si `supportsTablet: true` en `app.json` | No aplica — `ios.supportsTablet: false` |

## Capturas (generadas 2026-07-08)

Ubicación: `promo-video/app-store/screenshots/*.png` (1284×2778 cada una, tamaño
iPhone 6.5"/6.7" que exige App Store Connect).

> ⚠️ **Las capturas actuales están en español.** Las capturas son un asset
> **por idioma**: con inglés como idioma principal, el set en español quedaría
> asignado a la ficha inglesa (que es lo que ve la mayoría del mundo). Hay que
> regenerar el set en inglés desde `prototype/appstore-shots.html` — el
> prototipo tiene el copy hardcodeado en español, así que hace falta
> parametrizarlo por idioma antes de recapturar. Ver "Pendientes" abajo.

Generadas desde el prototipo (`prototype/appstore-shots.html`, servido con
`npx serve -l 4180 prototype` y capturado con Playwright headless — script en
`_scratch/capture-appstore-shots.mjs`, no forma parte del build). Mismo tema
VAULT y mismos 8 pilares que la ficha de Play, usando el frame `IOSDevice`
(`prototype/ios-frame.jsx`) en vez de `AndroidDevice`.

| Archivo | Pilar mostrado |
|---|---|
| `onboarding.png` | Identidad anónima generada en el dispositivo |
| `home.png` | Lista de chats sin metadatos (handles pseudónimos) |
| `chat.png` | E2EE (Double Ratchet/X3DH), efímeros |
| `verify.png` | Verificación de identidad por QR + 8 palabras |
| `call.png` | Llamada de voz/video cifrada (WebRTC + CallKit) |
| `groups.png` | Grupos privados |
| `panic.png` | Modo pánico + PIN señuelo |
| `devices.png` | Multi-dispositivo, clave por dispositivo, revocación |

> Igual que en la ficha de Play: `screens.jsx` tiene `ScreenOnboarding`,
> `ScreenHome` y `ScreenChat` mostrando el flujo de **AegisLink Work**
> (enrolamiento corporativo), no el onboarding anónimo personal. Esas 3
> capturas se reescribieron con contenido propio (mismo tema/marca) dentro
> de `prototype/appstore-shots.html`, igual que ya se hizo en
> `prototype/playstore-shots.html`.

Para regenerar tras cambios de copy/tema:
```
npx --yes serve -l 4180 prototype
node _scratch/capture-appstore-shots.mjs
```

## Privacy Nutrition Label (App Privacy — cuestionario de App Store Connect)

Basado en `docs/privacy-policy.md` (fuente de verdad; si cambia, actualizar aquí).
Este cuestionario es más granular que el Data Safety de Play — declarar por tipo
de dato:

- **Identificadores** (AegisID pseudónimo, token de push APNs): **Sí, vinculado
  al usuario**, uso: "Funcionalidad de la app", no usado para tracking.
- **Datos de uso / contenido de usuario** (ciphertext en tránsito): **Sí, no
  vinculado a identidad real** — el relay no puede leerlo; se borra al
  entregar o a los 30 días máx.
- **Datos de contacto** (email, teléfono, nombre): **No se recolectan.**
- **Ubicación:** **No se recolecta.**
- **Datos usados para rastrearte (tracking) entre apps/webs de terceros:** **No.**
- **Compartición con terceros:** **No.**
- Responder **"Data Not Linked to You"** solo en los campos donde, tras releer
  §2 de `privacy-policy.md`, se confirme que sigue vigente — no se declara sin
  releer el doc primero (regla "no mentir").

## Export compliance (cripto)
`ITSAppUsesNonExemptEncryption: true` ya está en `mobile/app.json`. Cada build
de TestFlight/producción pregunta por compliance: AegisLink usa cifrado
estándar (TweetNaCl/NaCl secretbox, Double Ratchet/X3DH) para confidencialidad
de comunicaciones de usuario final — normalmente califica para la **exención
de excepción de uso masivo de mercado** (ver `docs/IOS-LAUNCH-READINESS.md`
Fase 2, "Export compliance"). Decidir y documentar la clasificación exacta
antes del primer envío a revisión externa/pública.

## Content rating (Age Rating)
Cuestionario aún no completado en App Store Connect. Sugerido: sin contenido
para adultos; marcar honestamente "Comunicación ilimitada entre usuarios /
contenido no moderado" (mensajería E2EE — Apple no puede revisar contenido).

## Privacy Policy URL
Mismo pendiente que en Play: `docs/privacy-policy.md` debe estar **hosteada
en una URL pública** (campo obligatorio en App Information). Pendiente:
publicar en landing (`web/`) o GitHub Pages y pegar la URL aquí una vez exista.

## Riesgos de App Review conocidos (ver también IOS-LAUNCH-READINESS.md Fase 2)
- **Cuenta "Persona física"**: publica bajo el nombre legal del vendedor —
  contradice la promesa de anonimato de marca. No bloquea TestFlight interno.
- **Tor embebido** (`EXPO_PUBLIC_ONION_URL`): motivo clásico de fricción en
  review si se activa en producción.
- **Registro anónimo** sin email/teléfono: puede chocar con guidelines de
  cuentas de Apple; tener lista la justificación (mensajería E2EE tipo
  Signal/SimpleX, no red social con perfiles públicos).

## Pendientes para publicar (resumen)
1. ~~Capturas iPhone 6.5"/6.7"~~ ✅ hecho (en español) — falta el **set en
   inglés** para la ficha principal, ver aviso en "Capturas".
2. Ícono 1024×1024 sin alpha (subir a App Store Connect).
3. Privacy Policy hosteada en URL pública.
4. Completar App Privacy (Nutrition Label) y Age Rating en App Store Connect.
5. Decidir clasificación de export compliance y documentarla.
6. **Cambiar el idioma principal a English (U.S.)** en Información de la app y
   añadir Español (España) e Italiano como localizaciones, pegando el copy de
   "Localizaciones de la ficha".
7. **Quitar `signal` de las palabras clave** en la ficha ya cargada en ASC — es
   marca de terceros y es causa habitual de rechazo de metadatos.
8. Seguir Fases 1-2 de `docs/IOS-LAUNCH-READINESS.md` (build, TestFlight,
   smoke test en iPhone físico) antes de enviar a revisión pública.

Regenerar capturas tras cambios de copy/tema/marca:
```
npx --yes serve -l 4180 prototype
node _scratch/capture-appstore-shots.mjs
```
