# Fase 4 · Tor embebido en iOS — documento de diseño (pre-implementación)

> Estado: **diseño, pre-implementación.** Cierra la brecha de paridad que
> `FASE4-TOR-EMBEDDED-IMPL.md` §7 dejó anotada ("iOS es fast-follow, necesita
> Mac"). Objetivo: llevar el **transporte mailbox sobre Tor** a iOS con el mismo
> modelo de privacidad que Android, siendo **honestos sobre lo que iOS NO permite**.

## 0. Qué es paridad aquí (y qué no puede serlo)

Hay que separar dos cosas que en Android van juntas pero en iOS no:

| Capacidad | Android | iOS | ¿Paridad posible? |
|---|---|---|---|
| **Transporte mailbox sobre Tor** (sella metadatos, oculta IP del relay) mientras la app está viva/foreground | ✅ (`AegisTor` + `TorSioSocket`) | ✅ portable (`Tor.framework` + bridge Swift) | **Sí** — este doc |
| **Entrega/wake con app MATADA sin Google** | ✅ (foreground-service) | ❌ **imposible** | **No** — muro de Apple |
| **Suscripción ntfy 2b.2 con app viva** | ✅ (`httpSubscribe`) | ✅ portable (solo foreground) | Sí, limitado a foreground |

**El muro de Apple (no negociable):** iOS **mata** cualquier socket y proceso al
pasar a background/killed; **no existe** foreground-service. La única forma de
despertar una app iOS cerrada es **APNs/VoIP de Apple**. Por tanto:

- El **transporte mailbox** iOS solo corre mientras la app está en foreground (o
  la ventana de background de ~30s que iOS concede). No es "always-on".
- El **wake** (mensaje o llamada con app cerrada) en iOS **seguirá siendo APNs/
  VoIP**, igual que Signal/Session/SimpleX. No hay parity y no la habrá — es del
  sistema operativo. Ya documentado en `FASE4-CALL-WAKE-DESIGN.md` §2.

Este doc entrega la **paridad del transporte** (resistencia a metadatos e IP
oculta cuando el usuario usa la app), no la del wake (que es irreducible en iOS).

## 1. Restricción que define la arquitectura iOS

Igual que en Android, el `WebSocket` de RN no acepta proxy SOCKS por conexión.
La solución espeja la de Android: el socket del mailbox se mueve a **nativo
Swift**, un cliente socket.io sobre una sesión con SOCKS, puenteado a JS. **La
criptografía auditada NO se mueve** — Swift es un tubo tonto; firmar el
challenge, derivar el mailbox y sellar el sobre siguen en JS (`mobile/src/crypto/*`).

Dos opciones de transporte SOCKS en iOS:

- **A (recomendada): `socket.io-client-swift` sobre `URLSession` con
  `connectionProxyDictionary`** apuntando al SOCKS local de Tor. Es el equivalente
  directo del `OkHttpClient`+SOCKS de Android. `connectionProxyDictionary` soporta
  SOCKS (`kCFStreamPropertySOCKSProxy`), y socket.io-swift permite inyectar la
  `URLSessionConfiguration`.
- **B (fallback): `CFStream`/`Network.framework` con SOCKS manual** si
  `connectionProxyDictionary` no enruta el WebSocket upgrade por SOCKS de forma
  fiable (a validar en spike — históricamente `NSURLSession` ignora el proxy SOCKS
  para WebSocket en algunas versiones de iOS). El spike de F2 decide A vs B.

## 2. Ladrillos iOS (a fijar en el spike F1)

- **Tor**: **`Tor.framework`** (Onion Browser / iCepa, CocoaPods `Tor` o SPM),
  C-Tor empaquetado para iOS — el análogo directo de `tor-android`. Alternativa
  futura **Arti** (Rust) si el tamaño/estabilidad lo pide, pero `Tor.framework` es
  el battle-tested hoy. Da un SOCKS local + control port, misma superficie que
  `TorService` en Android.
- **socket.io**: `socket.io-client-swift` (Socket.IO-Client-Swift, CocoaPods).
- **Build**: CocoaPods (o SPM) → requiere **Mac o EAS Build cloud** (macOS). No
  hay iteración local en Windows; cada ciclo es un build EAS (~20 min).

## 3. Superficie del módulo nativo `AegisTor` (Swift) — MISMA API que Kotlin

El bridge JS (`mobile/src/net/tor.ts`) **no debe cambiar**: la interfaz nativa
Swift expone exactamente los mismos métodos y eventos que el módulo Kotlin, para
que `TorSioSocket`, `mailboxSocket.ts` y `subscribeNtfyOverTor` funcionen sin
tocar una línea de JS.

### 3.1 Ciclo de vida de Tor
```
start(): Promise<{ socksPort }>      // arranca Tor.framework, espera bootstrap 100%, devuelve puerto SOCKS
getStatus(): Promise<{ state, socksPort }>
stop(): Promise<void>
evento "AegisTorStatus" { state, bootstrap?, socksPort? }
```

### 3.2 Bridge socket.io-over-Tor (tubo tonto)
```
sioConnect(id, url, authJson, eventsJson): Promise<Bool>
sioEmit(id, event, payloadJson, ackId?): Promise<Bool>
sioDisconnect(id): Promise<Bool>
evento "AegisTorSio" { id, event, args }   // idéntico a Android
```

### 3.3 Suscripción HTTP-streaming (2b.2)
```
httpSubscribe(id, url): Promise<Bool>      // GET /<topic>/json por SOCKS, URLSession dataTask stream
httpUnsubscribe(id): Promise<Bool>
evento "AegisTorHttp" { id, event, line }  // idéntico a Android
```
Nota: en iOS esta suscripción **solo vive en foreground**. No sustituye al wake;
el mensaje con app cerrada sigue llegando por APNs (payload cifrado, ya existe).

## 4. Gate de privacidad — sin cambios

`MAILBOX_ENABLED = MAILBOX_MODE && ONION_URL && torState === 'on'` ya está en JS
(`config.ts`). En iOS `isTorAvailable()` pasará a `true` cuando el módulo Swift
esté presente. Todo el fail-closed (sin Tor → transporte aegisId) se hereda tal
cual. Cero cambios de lógica JS.

## 5. Integración de build — config plugin `plugins/withTorEmbediOS.js` (o extender withTorEmbedded)

- **Podfile** (`withDangerousMod` / `withPodfile`): añadir `pod 'Tor'` y
  `pod 'Socket.IO-Client-Swift'`.
- **Swift** (`withDangerousMod`): escribir `AegisTor.swift` (RCTBridgeModule) +
  header de puente si hace falta, en `ios/`.
- **Info.plist**: sin `UIBackgroundModes` nuevos para esto (Tor no corre en
  background; el wake sigue por el `voip`/`remote-notification` ya presentes).
- Registrar el plugin en `app.json`. Build = EAS cloud (macOS).

## 6. Fases (verificable cada una, vía EAS cloud + iPhone/simulador)

- **F1 — Ciclo de vida de Tor.** Pod `Tor` + módulo Swift 3.1 + `tor.ts` ya lo
  consume. *Verificación:* build EAS, `startTor()` lleva STATUS→ON y `socksPort>0`
  en un iPhone/simulador real.
- **F2 — Spike de transporte SOCKS.** Decidir opción A vs B (§1) conectando
  `TorSioSocket` a un echo socket.io por SOCKS. **Es el mayor riesgo técnico** —
  hacerlo primero.
- **F3 — Cablear mailbox.** `mailboxSocket.ts` ya usa `TorSioSocket`; solo hace
  falta que `isTorAvailable()` sea true en iOS. *Verificación:* gate + selección
  de transporte (los unit tests JS ya existen, corren igual).
- **F4 — 2b.2 en foreground.** `httpSubscribe` Swift; suscripción ntfy sobre el
  onion mientras la app vive.
- **F5 — Validación real.** iPhone + otro device: entrega `envelope:mb` sobre el
  hidden service, IP oculta. Documentar el límite honesto de background (wake =
  APNs).

## 7. Riesgos y decisiones abiertas

1. **`connectionProxyDictionary` + WebSocket** (§1): riesgo #1. Si iOS no enruta el
   WS upgrade por SOCKS, cae a opción B (más trabajo). **Spike F2 antes de
   comprometer plazos.**
2. **Sin Mac local**: toda iteración es EAS cloud (~20 min). Ritmo lento; conviene
   maximizar lo verificable por unit test JS (que no cambia) y minimizar ciclos
   nativos.
3. **Tamaño del `.ipa`**: `Tor.framework` añade peso (C-Tor). Medir contra límites
   de App Store y el tiempo de arranque.
4. **APNs de la cuenta espejo**: recordar que el proyecto EAS espejo NO tiene
   APNs; validar wake iOS exige el build de la cuenta original con la `.p8`.
5. **Background honesto**: dejar CLARÍSIMO en UI/doc que en iOS "Anonimato máximo
   (Tor)" cubre el uso en foreground; el wake sigue por Apple. No prometer lo que
   el SO no da.

## 8. Fuera de alcance (anotado, no olvidado)

- **Wake sin Google en iOS**: imposible (muro Apple). Permanente. No es deuda.
- **Tor en background 24/7 en iOS**: imposible. El transporte mailbox iOS es
  foreground/oportunista por diseño de plataforma.
- **desktop**: sigue con Tor del sistema, track aparte.
