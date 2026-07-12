# Fase 4 · Wake de llamadas con app cerrada — documento de decisión

> Estado: **decisión de diseño confirmada por el dueño (2026-07-12), pre-implementación.**
> Hermano de `FASE4-SLICE2B-PUSH-DESIGN.md` (wake de *mensajes*). Este trata el
> caso duro: **despertar una llamada entrante con la app cerrada** sin depender
> de Google/Apple, dentro de "cero metadatos". Referencias:
> `FASE4-SEALED-CALL-SIGNALING-DESIGN.md`, `SEALED-SENDER-ARCHITECTURE.md` §"Límite honesto".

## 1. El problema en una frase

Una llamada **caduca en 30 s** (`server/src/push/expo.ts`, `ttl: 30`). No tolera el
fallback lento que sí vale para mensajes: si el wake tarda, la llamada se pierde.
Y para despertar una app **matada** (no solo en background) el SO **solo** ofrece
dos caminos, ambos con coste:

| Vía | ¿Despierta app matada? | Metadato residual | Batería |
|---|---|---|---|
| FCM / APNs (Google/Apple) | ✅ instantáneo | el proveedor ve *device + timing* | nula |
| Foreground-service con socket propio 24/7 | ✅ (solo Android) | **ninguno nuevo** | alta + notif. permanente |
| ntfy/UnifiedPush self-hosted | ✅ solo con distribuidor (Android); iOS ❌ | nosotros vemos *topic + timing* | baja |

El **contenido** del wake ya es cero-metadatos hoy (título genérico "Llamada
entrante · E2EE", `callId` es un UUID aleatorio, emisor sellado dentro de
`call:invite`). Lo irreducible es el **timing**: que un proveedor externo sepa
*cuándo* despiertas. Eso es lo que este diseño ataca.

## 2. El muro de plataforma (por qué no hay una respuesta única)

- **Android**: permite un foreground-service persistente con un socket propio.
  Es la única plataforma donde podemos cortar a Google del wake de llamadas por
  completo. Coste: notificación permanente ("AegisLink activo") + batería.
- **iOS**: **no existe** el foreground-service. Apple mata cualquier socket al
  pasar a background/killed, sin excepción. La **única** forma de hacer sonar un
  iPhone con la app cerrada es **PushKit/VoIP APNs** (Apple). No es una decisión
  nuestra: el SO no ofrece otra cosa. Ya está implementado en
  `server/src/push/apns-voip.ts` (`apns-push-type: voip`).

Conclusión: "cero proveedores para todos" es **imposible en iOS**. La decisión
honesta es un **híbrido por plataforma**.

## 3. Decisión confirmada (2026-07-12)

**Híbrido por plataforma, degradación honesta (regla R5 del doc hermano):**

- **Android → foreground-service propio 24/7 sobre Tor, por defecto.** Cero
  Google en el wake de llamadas. El socket del relay (o un socket de señalización
  dedicado) se mantiene vivo dentro del servicio; una `call:invite` entrante
  suena sin pasar por FCM. Es **más agresivo que Signal** (que usa FCM por
  defecto también en Android).
- **iOS → VoIP/APNs, por obligación de plataforma.** Se mantiene el reducto de
  timing de Apple, **declarado explícitamente** en la UI y en este doc. Payload
  ya cero-metadatos. No hay alternativa técnica.
- **Desktop**: Electron mantiene su socket mientras vive; sin reducto de push.

### Nivel de paranoia opcional (futuro, no bloquea)
Se deja documentado un posible tercer nivel *opt-in* en Ajustes para quien quiera
también en Android renunciar al FGS (ahorro de batería) a cambio de aceptar el
FCM ciego — el inverso del default. No se implementa en el primer corte.

## 4. Riesgos a gestionar (advertidos al dueño)

1. **Google Play Store.** Un foreground-service persistente por defecto exige
   justificar el tipo (`connectedDevice`/`dataSync`) en la ficha de Play con un
   **video-demo** del caso de uso, y Android 14+ endureció mucho la revisión de
   FGS de arranque. Superable, pero añade fricción de publicación. El FGS de
   `type=microphone` existente (`withCallForegroundService.js`) NO cubre esto:
   ese solo vive durante una llamada activa; el nuevo es persistente y de otro
   tipo.
2. **Batería y percepción.** Notificación permanente. Debe ser clara ("protege
   tus llamadas E2EE") y, idealmente, con un ahorro por Doze-aware backoff del
   socket cuando no hay actividad.
3. **iOS sigue con reducto.** Ningún esfuerzo en Android cambia que Apple ve el
   timing. Comunicarlo sin marketing engañoso.

## 5. Plan de implementación (sub-slices)

- **cw.0** — ✅ HECHO. Este doc + wiring de la decisión en
  `SEALED-SENDER-ARCHITECTURE.md` ("Límite honesto": Android sin proveedor, iOS
  APNs declarado). (#307)
- **cw.1** — 🟢 IMPLEMENTADO (pendiente validación en dispositivo). Expo config
  plugin `mobile/plugins/withCallWakeService.js`: servicio `AegisWakeService`
  como **HeadlessJsTaskService** (`foregroundServiceType=dataSync`) que, al
  (re)arrancar (START_STICKY o `AegisWakeBootReceiver` tras reboot), lanza el
  task JS `AegisCallWake` (`mobile/src/webrtc/callWakeTask.ts`) que conecta el
  socket sobre Tor + handlers de llamada y **mantiene el proceso residente** (la
  crypto sealed-sender sigue en JS; el nativo nunca ve claves). Wrapper JS
  `callWakeService.ts` (start/stop), preferencia `callWakeService` (store), y
  cableado en `connect()`/teardown de `client.ts`. Tests JS:
  `callWakeService.test.ts`. **Default OFF** hasta validar en dispositivo; el
  objetivo de producto es default-ON en Android tras confirmar batería/OEM en
  hardware real. Boot receiver gated por marcador `SharedPreferences` (opt-in).
  Validación en vivo = **APK dev-client 2-dispositivos** (matar app → recibir
  llamada sin FCM), no automatizable en Jest.
- **cw.2** — ✅ HECHO. UI toggle (Ajustes › LLAMADAS, Android-only, i18n en/es/it;
  `Privacy.tsx` + preferencia `callWakeService`). **Doble-ring: ya prevenido por
  diseño** — el relay solo hace `sendCallWakeUp` cuando `!delivered`
  (`server/src/relay/callSignaling.ts:239`); con el FGS el socket está vivo, el
  `call:invite:v2` se entrega directo y no se emite FCM. **Default ON en Android**
  tras **validación funcional en dispositivo (2026-07-12)**: con el toggle activo
  y la app matada, la llamada entrante suena (heads-up "Chiamata E2EE in arrivo"),
  cero Google. Seguimiento abierto (no bloquea): medir batería + OEMs agresivos
  (Xiaomi/Samsung matan FGS) en **hardware físico** — el emulador no estresa Doze.
- **cw.3** — iOS: sin cambios de transporte (VoIP/APNs ya vive); solo copy en UI
  del límite honesto.
- **cw.4** — Play Store: preparar el video-demo y el texto de justificación del
  FGS antes de subir el build.

## 6. Modelo de amenaza — qué cierra y qué no

**Cierra (Android):** el wake de llamadas deja de pasar por Google. Ningún
proveedor externo ve el timing de tus llamadas entrantes en Android con el FGS
activo.

**Reducto residual (honesto):**
- **iOS**: Apple ve *device + timing* de cada VoIP push. Irreducible en la
  plataforma. Declarado en UI.
- **Android sin FGS** (si el usuario lo desactiva a futuro): cae al FCM ciego,
  reducto opt-in y marcado.
- La correlación temporal "sonó justo cuando llegó una invite" es el mismo
  límite irreducible que el resto de Fase 4; se ataca con cover-traffic en Fase 5.
