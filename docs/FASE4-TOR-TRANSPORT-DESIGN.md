# Fase 4 · Transporte Tor para el path mailbox (documento de decisión)

> Estado: **decisión de arquitectura, pre-implementación.** Desbloquea la
> promesa de la Fase 4: el modo buzón oculta `to` al relay, pero **sin Tor el
> relay ve nuestra IP junto al socket de control aegisId y nos re-vincula**. Hoy
> el cliente hace `io(ONION_URL)` a pelo (`mobile/src/socket/mailboxSocket.ts:115`)
> y **no embebe Tor** — la `.onion` no resuelve sin un proxy Tor en el device. Por
> eso `MAILBOX_ENABLED` es fail-closed y el modo está OFF por defecto. Este doc
> decide CÓMO llevamos el tráfico del mailbox por Tor de verdad.

## 1. La restricción que lo decide todo

El transporte del mailbox es **Socket.IO** (WebSocket con fallback a long-polling).
Para enrutarlo por Tor necesitamos que ESE socket salga por un SOCKS5 de Tor. Y
aquí está el muro técnico:

- El `WebSocket` de React Native (OkHttp en Android, NSURLSession en iOS) **no
  expone configuración de proxy SOCKS por conexión** desde JS. No puedes decirle a
  `socket.io-client` "usa el puerto SOCKS 9050".
- Por tanto, un Tor embebido que sólo ofrezca "un puerto SOCKS" **no basta**: el
  WebSocket no sabrá usarlo.

Cualquier solución tiene que resolver esto, no sólo "arrancar un tor".

## 2. Por qué `react-native-tor` queda descartada

Era la candidata obvia ("embebe el daemon, sin Orbot, con iOS"). Pero:

- **Último release v0.1.8 — febrero 2022. Abandonada.** Sin commits recientes.
- **Sin New Architecture (Fabric/TurboModules)** ni RN 0.76+. Estamos en **Expo
  SDK 54 / RN ~0.79 con New Arch** → incompatible de base.
- Su TCP es "sólo texto delimitado por líneas (Electrum)"; **no soporta WebSocket**.
  Expone un puerto SOCKS, pero por §1 eso no le sirve a nuestro socket.

Construir sobre un módulo nativo muerto es, en sí mismo, una promesa a medias.
**Fuera.**

## 3. Las opciones que SÍ funcionan

| | Qué es | ¿Resuelve §1? | Esfuerzo | Promesa cumplida |
|---|---|---|---|---|
| **A. Orbot asistido + verificación + fail-closed** | El usuario instala Orbot (Guardian Project, battle-tested), lo pone en **modo VPN** y selecciona AegisLink. El SO enruta TODO nuestro tráfico por Tor de forma **transparente** — el WebSocket incluido, sin tocar el socket. | ✅ Transparente a nivel de red | **Días.** Detección de Orbot, deep-link de activación, verificación de que salimos por Tor, gate `MAILBOX_ENABLED` sólo si verificado | ✅ Oculta IP de verdad. ⚠️ Requiere instalar Orbot |
| **B. Tor embebido nativo (tor-android/Arti) + bridge SOCKS** | Bundleamos el binario Tor (AAR de Guardian Project en Android / `Tor.framework` en iOS), arrancamos un SOCKS local y movemos el socket del mailbox a **Kotlin/Swift nativo sobre SOCKS** (porque el WS de RN no puede), puenteando eventos a JS. Es lo que hace Briar. | ✅ En nativo | **Semanas.** Módulo nativo por plataforma + reescritura del transporte mailbox en nativo + mantenimiento del binario Tor | ✅ Sin Orbot, "de fábrica" |
| **C. VpnService propio + tor + tun2socks** | Reimplementar dentro de la app lo que hace Orbot: un VpnService que captura sólo nuestro tráfico y lo manda al SOCKS de Tor. | ✅ | **Semanas+.** Choca con el límite de UN VPN activo en Android; conflicto con VPNs reales del usuario | ✅ pero invasivo |
| **D. Rediseñar el mailbox a request/response sobre HTTP-Tor** | Cambiar el transporte de socket persistente a polling HTTP que sí puede ir por un cliente HTTP-Tor embebido. | ✅ por otra vía | **Semanas.** Cambio de protocolo cliente+server, pierde tiempo real, reintroduce latencia/batería | ✅ pero peor UX |

## 4. Recomendación: **A ahora (Tier 1), B como endgame (Tier 2)**

- **Tier 1 — Orbot asistido, verificado y fail-closed.** Es la única vía que
  **cumple la promesa de privacidad en días, no semanas**, apoyándose en un Tor
  **battle-tested** (Orbot/Guardian Project) en lugar de un binario que tendríamos
  que mantener. Clave para que NO sea una promesa a medias: el modo buzón **se
  niega a activarse a menos que verifiquemos que el tráfico sale por Tor** (§5).
  Si Orbot no está o no está enrutando, `MAILBOX_ENABLED=false` y caemos al
  transporte aegisId — exactamente la postura fail-closed que ya tiene el código.
  El comentario de `config.ts:61` ya anticipaba esta vía ("still benefits from
  Orbot VPN mode").

- **Tier 2 — Tor embebido nativo (B).** El endgame "sin dependencias" que iguala a
  Briar. Es un proyecto nativo de semanas (módulo por plataforma + transporte
  mailbox en nativo). Va al backlog con diseño propio; no se empieza a medias.

> Matiz honesto sobre "embebido": Briar embebe Tor; muchas apps seguras seria
> (incluidas integraciones de Tor en messengers) **piden Orbot**. Orbot-asistido
> **con verificación + fail-closed NO es una promesa incumplida**: la promesa es
> "ocultamos tu IP", y se cumple porque la app **rechaza** el modo buzón si Tor no
> está verificablemente activo. El coste es "instala Orbot", no "te mentimos".

## 5. Lo que hace que A no sea una promesa a medias: verificación

Sin esto, A sería "esperamos que Orbot esté puesto" — inaceptable. Con esto, es
sólido:

1. **Detectar Orbot** instalado (`org.torproject.android`) y su estado VPN.
2. **Pedir activación** vía intent/deep-link (`OrbotHelper`-style) + selección de
   AegisLink como app Tor-enabled.
3. **Verificar salida por Tor antes de habilitar el mailbox**: una comprobación de
   bootstrap — p.ej. el relay devuelve, por el socket de control, una señal de que
   nos ve llegar desde un exit Tor, o consultamos un check sobre la `.onion`. Sólo
   si la verificación pasa → `MAILBOX_ENABLED=true`.
4. **Re-verificar en rotación de época** (`scheduleEpochRotation` ya reconecta en
   cada boundary): si Orbot cayó, degradar a aegisId, no enviar en claro de IP.
5. **UX honesta**: si el usuario activa "modo máximo anonimato" sin Orbot, la app
   explica por qué hace falta y enlaza a instalarlo — nunca finge que está activo.

## 6. Cambios por capa (Tier 1)

- **mobile/** — nuevo `mobile/src/net/tor.ts`: detección/activación/verificación de
  Orbot (módulo Android intent; iOS usa el Network Extension de Orbot-iOS). Gate de
  `MAILBOX_ENABLED` movido de "ONION_URL presente" a "ONION_URL presente **Y** Tor
  verificado". Pantalla/sección de privacidad para activarlo. Requiere prebuild +
  APK release (intent nativo), nunca Expo Go. Verificar APIs contra
  `https://docs.expo.dev/versions/v54.0.0/` antes de tocar.
- **server/** — endpoint/echo mínimo para la verificación de §5.3 (o reutilizar un
  check existente). Sin metadatos nuevos persistidos.
- **desktop/** — fuera de alcance de Tier 1 (desktop puede usar Tor del sistema /
  `torsocks`; se documenta).
- **infra/** — el relay debe exponer su hidden service `.onion` (ya contemplado por
  `ONION_URL`); confirmar que el HS está publicado.

## 7. Plan por fases (Tier 1)

- **T1.0** — `tor.ts`: detección de Orbot + estado (sin activar nada todavía). Test
  unitario del parser de estado.
- **T1.1** — activación vía intent + UI de privacidad ("Anonimato máximo (Tor)").
- **T1.2** — verificación de salida-por-Tor (§5.3) + reescribir el gate
  `MAILBOX_ENABLED` para exigirla. **Un test por fix.**
- **T1.3** — re-verificación en rotación de época + degradación honesta.
- **T1.4** — validación **2-device** (lo que dejamos pendiente): dos emuladores con
  Orbot-VPN, modo buzón verificado, entrega vía `envelope:mb`, ocultando IP de
  verdad. Esto cierra a la vez la validación 2-device y la promesa de Fase 4.

## 8. Pregunta abierta antes de implementar

¿"Promesa cumplida" para el lanzamiento = **Tier 1 (Orbot asistido + verificación
+ fail-closed)**, o exiges **Tier 2 (Tor embebido sin Orbot)** como condición de
publicar? La diferencia es **días vs semanas** y define si Tier 1 es el camino al
launch con Tier 2 en backlog, o si el launch espera al nativo embebido.
