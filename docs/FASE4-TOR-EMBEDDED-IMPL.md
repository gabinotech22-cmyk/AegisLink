# Fase 4 · Tor embebido (Tier 2) — spec de implementación

> Estado: **spec de build, Android primero.** Decisión tomada en
> `FASE4-TOR-TRANSPORT-DESIGN.md` (Tier 2: Tor embebido sin Orbot). Este doc es el
> contrato de ingeniería: API del módulo nativo, bridge JS↔nativo, integración de
> build y fases. iOS es fast-follow (`Tor.framework`/Arti) y necesita un Mac — fuera
> de este primer corte.

## 0. Ladrillos (verificados, mantenidos)

- **Tor**: `info.guardianproject:tor-android:0.4.9.10` + `info.guardianproject:jtorctl:0.4.5.7`
  desde el maven de Guardian Project
  (`https://raw.githubusercontent.com/guardianproject/gpmaven/master`). Es C-Tor,
  battle-tested (lo usa Briar). Da `libtor.so` + `TorService`.
- **socket.io sobre SOCKS**: `io.socket:socket.io-client-java:2.1.0` (Maven Central),
  configurable con un `OkHttpClient` custom (`callFactory` + `webSocketFactory`);
  OkHttp soporta proxy SOCKS nativo → el WebSocket de socket.io sale por Tor.

### API exacta de `org.torproject.jni.TorService` (de la fuente)

- Bind: `bindService(Intent(ctx, TorService::class.java), conn, BIND_AUTO_CREATE)`;
  `LocalBinder.getService(): TorService`.
- Estado: broadcast `TorService.ACTION_STATUS`
  (`org.torproject.android.intent.action.STATUS`), extra `EXTRA_STATUS` ∈
  {`STATUS_STARTING`, `STATUS_ON`, `STATUS_STOPPING`, `STATUS_OFF`}.
- `getSocksPort(): Int` (válido tras `STATUS_ON`) y `getTorControlConnection()`.

## 1. Restricción que define la arquitectura

El `WebSocket` de RN no acepta proxy SOCKS por conexión desde JS. Por tanto el
socket del mailbox **se mueve a nativo**: un cliente `socket.io-client-java` sobre
OkHttp-con-SOCKS, puenteado a JS. **La criptografía auditada NO se mueve** — el
nativo es un tubo tonto de socket.io; firmar el challenge, derivar el mailbox, sellar
el sobre, todo sigue en JS (`mobile/src/crypto/*`, `mailboxStore.ts`).

## 2. Superficie del módulo nativo `AegisTor` (Kotlin)

Dos responsabilidades, un solo ReactPackage:

### 2.1 Ciclo de vida de Tor (Fase 1)

```
start(): Promise<{ socksPort: Int }>     // bind TorService, espera STATUS_ON, devuelve getSocksPort()
getStatus(): Promise<{ state, socksPort }>// 'off'|'starting'|'on'
stop(): Promise<void>                     // unbind + stopService
evento "AegisTorStatus" { state, bootstrap?, socksPort? }  // progreso para la UI
```

Bootstrap fino (% de circuito) se lee de la control connection
(`getInfo("status/bootstrap-phase")`) y se emite por el evento; STATUS_ON basta para
el gate.

### 2.2 Bridge genérico socket.io-over-Tor (Fase 2)

Tubo tonto y reusable — JS conserva TODO el protocolo:

```
sioConnect(id: String, url: String, auth: ReadableMap): Promise<void>
   // construye OkHttpClient con Proxy(SOCKS, 127.0.0.1:socksPort), IO.Options
   // { callFactory, webSocketFactory, transports=[websocket], auth }, IO.socket(url,opts)
sioOn(id, event)            // registra forward; el nativo emite a JS:
   evento "AegisTorSio" { id, event, args:[...] }   // p.ej. 'mailbox:challenge', 'envelope:mb', 'auth:ok', 'connect', 'disconnect'
sioEmit(id, event, argsJson, ackId?)   // ack → "AegisTorSio" { id, event:'__ack', ackId, args }
sioDisconnect(id)
```

El nativo NO interpreta payloads — serializa args como JSON. Esto deja la lógica
(firma de posesión, catch-up multi-época, sellado v2) intacta en `mailboxSocket.ts`.

## 3. Bridge JS — `mobile/src/net/tor.ts`

- `startTor()/torStatus()/stopTor()` envuelven 2.1.
- `TorSioSocket`: una clase mínima con la misma forma que usa `mailboxSocket.ts`
  (`on(event,cb)`, `emit(event,payload,ack?)`, `connected`, `disconnect()`) pero
  respaldada por 2.2. Así `mailboxSocket.ts` cambia **una línea**: en vez de
  `io(ONION_URL, opts)` usa `new TorSioSocket(ONION_URL, opts)` cuando Tor está ON.

## 4. Gate de privacidad (reescritura de `MAILBOX_ENABLED`)

Hoy: `MAILBOX_ENABLED = MAILBOX_MODE && ONION_URL !== null`. Pasa a:
`MAILBOX_ENABLED = MAILBOX_MODE && ONION_URL !== null && torState === 'on'`.

Es decir, el modo buzón **sólo** se activa con Tor verificablemente arriba (no sólo
"configurado"). Si Tor cae (rotación de época re-chequea), degrada al transporte
aegisId — fail-closed, sin filtrar IP. Esto es lo que convierte la promesa en real.

## 5. Integración de build — config plugin `plugins/withTorEmbedded.js`

Mismo idiom que `withCallForegroundService.js`:

1. **Gradle** (`withAppBuildGradle` + `withProjectBuildGradle`): añadir el repo
   gpmaven y las 3 deps (tor-android, jtorctl, socket.io-client-java) +
   `androidx.localbroadcastmanager` para el receiver de estado.
2. **Manifest** (`withAndroidManifest`): permisos ya presentes (INTERNET); añadir
   `ACCESS_LOCAL_NETWORK` sólo si subimos a API 37. TorService lo aporta el AAR vía
   merge.
3. **Kotlin** (`withDangerousMod`): escribir `AegisTorModule.kt` + `AegisTorPackage.kt`
   en `com/aegislink/app/`.
4. **Registro** (`withMainApplication`): `add(AegisTorPackage())` en `getPackages()`.

Registrar `./plugins/withTorEmbedded.js` en `app.json` plugins. Build = prebuild +
assembleRelease (módulo nativo → nunca Expo Go). Ojo APK size: +libtor.so por ABI
(arm64-v8a + x86_64 ya son los únicos targets, `buildArchs` en app.json).

## 6. Fases (verificable cada una)

- **F1 — Ciclo de vida de Tor.** Plugin + módulo nativo 2.1 + `tor.ts` start/status/stop.
  *Verificación:* APK release; `startTor()` lleva el evento de STATUS_STARTING→ON y
  devuelve un `socksPort` > 0 en el emulador. (Tor bootstrapea en emulador con red.)
- **F2 — Bridge socket.io-over-Tor.** Módulo nativo 2.2 + `TorSioSocket` en `tor.ts`.
  *Verificación:* `TorSioSocket` conecta a un echo socket.io de prueba por SOCKS.
- **F3 — Cablear el mailbox.** `mailboxSocket.ts` usa `TorSioSocket` cuando Tor ON;
  gate §4 reescrito. *Verificación:* unit tests de gate + el socket elige transporte.
- **F4 — Validación 2-device real.** 2 emuladores, modo buzón verificado por Tor,
  entrega vía `envelope:mb` contra el hidden service del relay, IP oculta de verdad.
  Cierra la validación 2-device Y la promesa de Fase 4.
- **F5 — Endurecer + UX.** Re-verificación en rotación de época, UI de "Anonimato
  máximo (Tor)", manejo de fallo de bootstrap, métricas de batería.

## 7. Fuera de alcance (anotado, no olvidado)

- **iOS**: `Tor.framework`/Arti + `socket.io-client-swift` sobre URLSession con
  `connectionProxyDictionary` SOCKS. Necesita Mac. Fast-follow (`[[project_launch_ios_decision]]`).
- **desktop**: puede usar Tor del sistema / `torsocks`; sin módulo embebido por ahora.
- **Slice 2b push**: el push por mailbox (`FASE4-SLICE2B-PUSH-DESIGN.md`) sigue su
  propio track (UnifiedPush/ntfy); ortogonal a este transporte.
