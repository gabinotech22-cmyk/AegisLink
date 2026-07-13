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

## Nombre (30 caracteres máx.)
```
AegisLink
```
(9 caracteres — el nombre de la app en la tienda; no confundir con el título de
30 caracteres de Play que incluye descriptor, aquí ese descriptor va en el subtítulo)

## Subtítulo (30 caracteres máx.)
```
Chat privado, cero metadatos
```
(29 caracteres)

## Texto promocional (170 caracteres máx. — editable sin nueva revisión de Apple)
```
Mensajería E2EE anónima por defecto. Sin teléfono, sin email, sin nombre real.
Cero metadatos en el servidor. Código abierto y auditable.
```
(137 caracteres)

## Palabras clave (100 caracteres máx., separadas por comas, sin espacios tras la coma)
```
cifrado,e2ee,privacidad,anonimo,mensajeria,chat seguro,signal,double ratchet,x3dh,sin metadatos
```
(96 caracteres)

## Descripción (4000 caracteres máx.)

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

AegisLink no pide tu contacto, no vende datos y no puede leer tus mensajes.
```

## Novedades de esta versión ("What's New", 4000 caracteres máx. — obligatorio desde la 2ª subida)
```
Primera versión de AegisLink para iOS: onboarding anónimo, chat 1:1 E2EE con
Double Ratchet/X3DH, llamadas de voz y video cifradas con CallKit nativo,
grupos privados, modo pánico y backup cifrado.
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
1. ~~Capturas iPhone 6.5"/6.7"~~ ✅ hecho, ver arriba.
2. Ícono 1024×1024 sin alpha (subir a App Store Connect).
3. Privacy Policy hosteada en URL pública.
4. Completar App Privacy (Nutrition Label) y Age Rating en App Store Connect.
5. Decidir clasificación de export compliance y documentarla.
6. Seguir Fases 1-2 de `docs/IOS-LAUNCH-READINESS.md` (build, TestFlight,
   smoke test en iPhone físico) antes de enviar a revisión pública.

Regenerar capturas tras cambios de copy/tema/marca:
```
npx --yes serve -l 4180 prototype
node _scratch/capture-appstore-shots.mjs
```
