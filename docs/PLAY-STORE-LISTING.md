# Play Store — Store Listing (borrador)

> Estado: **borrador listo para pegar en Play Console.** Complementa
> `docs/ANDROID-LAUNCH-READINESS.md` (checklist de bloqueantes) — este doc es
> solo el contenido textual + assets de la ficha de Play, no el roadmap.
>
> Fuente de verdad de privacidad: `docs/privacy-policy.md`. Si algo aquí discrepa
> con ese doc, el privacy-policy manda (regla de oro "la doc no miente").

## Package
`com.aegislink.app`

## Título (30 caracteres máx.)
```
AegisLink — Chat privado E2EE
```
(29 caracteres)

## Descripción corta (80 caracteres máx.)
```
Mensajería cifrada y anónima. Sin teléfono, sin email, cero metadatos.
```
(71 caracteres)

## Descripción larga (4000 caracteres máx.)

```
AegisLink es una app de mensajería cifrada extremo a extremo, anónima por
defecto y diseñada para no guardar metadatos — ni de quién hablas, ni cuándo,
ni con qué frecuencia.

SIN DATOS PERSONALES PARA EMPEZAR
Regístrate sin teléfono, sin email y sin nombre real. Tu identidad
criptográfica se genera y se queda en tu dispositivo: la clave privada nunca
sale de tu teléfono.

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
huella en vivo durante la llamada.

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

## Traducciones de la ficha

A diferencia de App Store Connect, **Play Console sí traduce automáticamente y
gratis**: Play Console → *Crecer* → *Presencia en la tienda* → *Ficha principal
de Play Store* → **Gestionar traducciones** → *Traducción automática gratuita*
(29 idiomas, minutos). Se elige el idioma de origen y se marcan título,
descripción corta y descripción larga.

Sirve como primer borrador, pero **no se publica a ciegas**: la traducción
automática destroza términos de criptografía ("sealed sender", "double
ratchet", "clave privada") y esta ficha hace afirmaciones de seguridad que no
pueden quedar ambiguas. Para los idiomas que la app ya soporta en su UI
(inglés e italiano, ver `mobile/src/i18n/locales/`) usar el copy revisado a mano
de `docs/APP-STORE-LISTING.md` → "Localizaciones de la ficha", adaptando
longitudes a los límites de Play (título 30, descripción corta 80). Para el
resto de idiomas, la traducción automática es aceptable como alcance extra.

## Íconos y gráficos

| Asset | Especificación Play | Estado |
|---|---|---|
| Ícono de la app | 512×512 PNG, 32-bit con alpha | ✅ `promo-video/play-store/icon-512.png` (verificado 512×512, RGBA con alpha) |
| Feature graphic | 1024×500 PNG/JPG, sin alpha | ✅ `promo-video/play-store/feature-graphic.png` (verificado 1024×500, RGB sin canal alpha) |
| Screenshots teléfono | 2-8 imágenes, PNG/JPG, min 320px / max 3840px por lado | ✅ 8 generadas, ver abajo |

## Screenshots (generadas 2026-07-01)

Ubicación: `promo-video/play-store/screenshots/*.png` (1080×1920 cada una).

Generadas desde el prototipo (`prototype/playstore-shots.html`, servido con
`npx serve prototype` y capturado con Playwright headless — script en
`_scratch/capture-playstore-shots.mjs`, no forma parte del build). Reutilizan
los componentes reales de `prototype/*.jsx` (tema VAULT, `AndroidDevice`)
excepto onboarding/home/chat, reescritos a mano — ver nota abajo.

| Archivo | Pilar mostrado |
|---|---|
| `onboarding.png` | Identidad anónima generada en el dispositivo |
| `home.png` | Lista de chats sin metadatos (handles pseudónimos) |
| `chat.png` | E2EE (Double Ratchet/X3DH), efímeros |
| `verify.png` | Verificación de identidad por QR + 8 palabras |
| `call.png` | Llamada de voz/video cifrada (WebRTC) |
| `groups.png` | Grupos privados |
| `panic.png` | Modo pánico + PIN señuelo |
| `devices.png` | Multi-dispositivo, clave por dispositivo, revocación |

> ⚠️ **Hallazgo durante la generación**: `prototype/screens.jsx` tiene
> `ScreenOnboarding`, `ScreenHome` y `ScreenChat` actualmente mostrando el
> flujo de **AegisLink Work** (enrolamiento corporativo, "Cirrus Labs AG"),
> no el onboarding anónimo personal descrito en `CLAUDE.md` §1-3. Work es
> alcance de otro repo (ver memoria `work-separate-repo`). Para no
> representar mal la app consumer en la ficha pública, esas 3 capturas se
> reescribieron con contenido propio (mismo sistema de theme/marca) en vez
> de reusar esos componentes. El prototipo compartido (`AegisLink.html`,
> usado también para el deck/demo) **no se tocó** — si ese deck también
> necesita mostrar el onboarding personal real en algún momento, es un
> trabajo aparte de re-alinear `screens.jsx`.

Para regenerar tras cambios de copy/tema:
```
# server "prototype" ya definido en .claude/launch.json (puerto 4180)
npx --yes serve -l 4180 prototype
node _scratch/capture-playstore-shots.mjs
```

## Data Safety form — respuestas honestas

Basado en `docs/privacy-policy.md` (fuente de verdad; si cambia, actualizar aquí).

- **¿Recolecta datos?** Sí, el mínimo operativo: AegisID pseudónimo, claves
  públicas, token de push FCM/APNs, ciphertext en tránsito (borrado al
  entregar o a los 30 días máx.).
- **¿Comparte datos con terceros?** No.
- **¿Los datos están cifrados en tránsito?** Sí (E2EE + TLS del transporte).
- **¿El usuario puede pedir borrado de datos?** Sí — eliminar cuenta borra
  el AegisID y las claves asociadas.
- **Recolección de IP/analítica/crash reporting de terceros:** No.
- Marcar la categoría **"No data collected"/"No data shared"** solo si tras
  revisar la tabla de §2 de `privacy-policy.md` se confirma que sigue
  vigente — no se declara sin releer el doc primero (regla "no mentir").

## Content rating
Cuestionario aún no completado en Play Console. Sugerido: sin contenido
para adultos, mensajería con contenido generado por usuarios (marcar
"comunicación entre usuarios / contenido no moderado" honestamente).

## Privacy Policy URL
`docs/privacy-policy.md` debe estar **hosteada en una URL pública** (Play
exige URL, no archivo del repo). Pendiente: publicar en landing (`web/`) o
GitHub Pages y pegar la URL aquí una vez exista.

## Pendientes para publicar (resumen — ver detalle en ANDROID-LAUNCH-READINESS.md)
1. ~~Feature graphic 1024×500~~ ✅ hecho, ver arriba.
2. ~~Ícono 512×512~~ ✅ hecho, ver arriba.
3. Privacy Policy hosteada en URL pública.
4. Prueba en 2-3 dispositivos Android físicos arm64 (bloqueante, ver Fase 1).
5. Alta en Play Console + Data Safety form + Content rating + Closed Testing track.

Regenerar assets tras cambios de copy/tema/marca:
```
npx --yes serve -l 4180 prototype
node _scratch/capture-feature-graphic.mjs
node _scratch/capture-icon.mjs
node _scratch/capture-playstore-shots.mjs
```
