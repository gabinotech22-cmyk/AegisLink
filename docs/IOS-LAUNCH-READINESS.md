# iOS / TestFlight Launch Readiness — Roadmap

> Estado a **2026-07-07**. Objetivo: testing en dispositivo iOS real vía **TestFlight**,
> sin MacBook, usando **EAS Build en la nube**.
> Espejo de `ANDROID-LAUNCH-READINESS.md`. Filosofía igual: riesgo conocido, pequeño y monitoreado.

## TL;DR — no hace falta Mac, ni terminal

Compilar iOS **no requiere Mac**. Se hace en **GitHub Actions** (`.github/workflows/build-ios.yml`),
igual que Android (`build-aab.yml`): el runner invoca **EAS Build**, que compila y firma en
máquinas macOS de Expo y guarda los certificados de Apple en la nube. Disparas el build con
**Actions → "Build iOS" → Run workflow** (un botón), y con `submit: true` sube solo a **TestFlight**.
Solo necesitas: cuenta Apple Developer (✅ activa), tus iPhones, y un **bootstrap web único** (subir
una App Store Connect API Key a expo.dev — ver Fase 1). Sin Xcode, sin Keychain, sin registrar UDIDs.

---

## ✅ Ya listo (verificado)

- **Apple Developer Program**: activo hasta 2026-07-02→2027. Team ID **`X2W7MRTDMJ`**.
  Inscrito como **Persona física** (ver ⚠️ riesgo de opsec abajo).
- **Config de build iOS**: `mobile/app.json` con `bundleIdentifier` `com.aegislink.app`,
  `infoPlist` completo (permisos cámara/mic/fotos/FaceID, `UIBackgroundModes` voip/audio/push,
  ATS con cert pinning a `aegislink.duckdns.org`, `ITSAppUsesNonExemptEncryption: true`).
- **Perfiles EAS iOS**: `mobile/eas.json` con `production.ios` (Release, credenciales remotas) y
  `submit.production.ios` parametrizado por env vars (`$APPLE_ID`, `$ASC_APP_ID`, `$APPLE_TEAM_ID`).
  **No hay secretos hardcodeados en el repo** — se pasan por entorno al ejecutar.

---

## 🔴 FASE 1 — Bloqueantes para testing en TestFlight (must)

### 1. Crear la app en App Store Connect  *(web, requiere tu Apple ID)* — ✅ hecho 2026-07-07
- [x] appstoreconnect.apple.com → **Apps → +** → nueva app. Bundle `com.aegislink.app`, iOS,
      nombre AegisLink. App ID registrado antes en el portal (capability: Push Notifications).
- [ ] Anotar el **`ASC_APP_ID`** (número en la URL `/apps/<id>/...` o en *App Information*) →
      opcional si se usa API key (paso 2), pero cómodo tenerlo.

### 2. Bootstrap de credenciales — App Store Connect API Key  *(web, una sola vez)*
> Esto reemplaza el login interactivo de Apple. Se hace por navegador, sin terminal ni 2FA repetido.
- [ ] App Store Connect → **Users and Access → Integrations → App Store Connect API** → generar
      key (rol **App Manager**). Descargar el `.p8`, anotar **Key ID** + **Issuer ID**.
- [ ] expo.dev → proyecto `aegislink` → **Credentials → iOS** → añadir la **App Store Connect API
      Key** (subir `.p8` + Key ID + Issuer ID). EAS ya podrá generar el Distribution Certificate y
      el Provisioning Profile **sin interacción** en el primer build.

### 3. Secrets de GitHub  *(web, una sola vez)*
> Settings → Secrets and variables → Actions.
- [x] `EXPO_TOKEN` — ya configurado (se reutiliza el de Android).
- [ ] `APPLE_ID` = `starsking1422@icloud.com` *(opcional si la API key está puesta)*.
- [ ] `ASC_APP_ID` = el del paso 1 *(opcional si la API key está puesta)*.
- ℹ️ `APPLE_TEAM_ID` (`X2W7MRTDMJ`) va fijado en el propio workflow — no es secreto.

### 4. Build + submit desde GitHub  *(un botón, sin terminal)*
- [ ] Pestaña **Actions → "Build iOS" → Run workflow**, rama `main`, `submit: true`.
- [ ] El workflow (`.github/workflows/build-ios.yml`) corre
      `eas build -p ios --profile production --auto-submit` en la nube (~15-25 min) y sube el
      `.ipa` firmado a TestFlight.
- [ ] Esperar el procesado de Apple (~5-30 min) — aparece en la pestaña **TestFlight**.

### 4b. APNs Auth Key para VoIP push  *(web + env del relay, una sola vez)*
> Necesario para que una **llamada entrante suene con la app cerrada** en iOS
> (PushKit → CallKit). El código ya está (`server/src/push/apns-voip.ts`,
> `mobile/src/calls/{voip-push,callkeep}.ts`, plugin `withIosVoip.js`); solo falta
> la credencial. Es una **key distinta** de la App Store Connect API Key del paso 2.
- [ ] developer.apple.com → **Certificates, IDs & Profiles → Keys → +** → habilitar
      **Apple Push Notifications service (APNs)**. Descargar el `.p8`, anotar el **Key ID**.
- [ ] En el relay (`.env` / secrets del deploy) fijar: `APNS_KEY_ID`,
      `APNS_TEAM_ID` = `X2W7MRTDMJ`, `APNS_BUNDLE_ID` = `com.aegislink.app`,
      `APNS_KEY_P8` = contenido del `.p8` con saltos como `\n`. Ver `server/.env.example`.
- [ ] Si falta cualquier var, el relay hace fallback silencioso al push visible de
      Expo (`isApnsConfigured()` → false): no rompe nada, pero no hay ring con app cerrada.
- [x] ✅ **Build iOS compila y firma** — primer `.ipa` generado en EAS (build `52997e08`, PR #276).
- [ ] ⚠️ **VoIP push está 100% DESACTIVADO — ni nativo ni JS** (commit `77c42ed`, PR #280).
      El registro VoIP nativo en el AppDelegate sigue desactivado en `withIosVoip.js` (el
      `import RNVoipPushNotification` de Swift rompe el build de Xcode: el pod es ObjC, no
      un módulo Swift; "no such module"). Pero además, `registerVoipToken()` por **JS**
      (`voip-push.ts`) también está gateada tras `VOIP_NATIVE_WIRED = false`: llamar al
      registro JS sin el AppDelegate nativo hace crashear la app justo tras generar identidad
      (`-[PKPushRegistry voipRegistrationSucceededWithDeviceToken:]` → `doesNotRecognizeSelector`,
      confirmado en iOS 16.7 / TestFlight build 12), así que el flag apaga **todo** el camino
      VoIP, no solo la parte nativa. Estado real actual: **una llamada entrante solo suena con
      la app en foreground** (socket Socket.IO vivo); con la app en background o cerrada no hay
      ningún camino de aviso vía CallKit — limitación conocida, no un bug pendiente de reportar.
      **Follow-up:** reactivar el registro nativo vía **bridging header**
      (`#import "RNVoipPushNotificationManager.h"`), y solo entonces volver a poner
      `VOIP_NATIVE_WIRED = true` para reactivar también el registro JS.
- [ ] ⚠️ **CallKit + New Architecture**: `react-native-callkeep@4.3.16` rompe la New
      Arch en Android (dos `@ReactMethod` "displayIncomingCall" → crash al arrancar),
      por eso `callkeep.ts` lo carga con `require` perezoso **solo en iOS** y con
      `try/catch` (degrada sin crashear). **Validar en el primer build iOS** que el
      módulo carga bien bajo New Arch; si no, subir a una versión de callkeep compatible
      o aplicar `patch-package`.

### 5. Testers internos  *(sin review de Apple)*
- [ ] En TestFlight → **Internal Testing** → añadir tus Apple IDs (hasta 100).
- [ ] Los testers instalan la app **TestFlight** en el iPhone y aceptan la invitación.
- [ ] **No requiere beta review** → se puede probar de inmediato.

### 6. Smoke test en iPhone físico
- [ ] Onboarding anónimo → identidad → chat 1:1 E2EE → grupo → llamada 1:1 → llamada grupal →
      adjunto (imagen/audio) → efímero → **modo pánico** → **push wake-up con la app cerrada**.
- [ ] Verificar `voip` background + push cifrado (FCM no aplica en iOS: es **APNs**; confirmar que
      el wake-up funciona con la app cerrada).
- [ ] Verificar cert pinning ATS contra el relay real.

---

## 🟡 FASE 2 — Antes de testers externos / lanzamiento público

### Export compliance (cripto)
- `ITSAppUsesNonExemptEncryption: true` → cada build de TestFlight pregunta por compliance.
  Una app de mensajería E2EE suele calificar para la **exención estándar** (encryption for
  authentication / standard algorithms). Decidir y documentar la clasificación; automatizar la
  respuesta en el infoPlist para no repetirla en cada subida.

### ⚠️ Riesgo de opsec — cuenta "Persona física"
- Una cuenta **individual** publica bajo tu **nombre legal** como vendedor en el App Store
  (y potencialmente la dirección). Para una app cuya promesa es el **anonimato**, esto es una
  contradicción de marca. **No afecta a TestFlight interno** (los testers no ven el nombre del
  vendedor), pero **antes del lanzamiento público** hay que resolverlo: cuenta de **organización**
  (requiere entidad legal + D-U-N-S) o aceptar conscientemente el trade-off.

### Riesgo de App Review (solo testers externos / release)
- **Tor embebido** (`EXPO_PUBLIC_ONION_URL` en el env de producción) es un motivo clásico de
  fricción en review de Apple.
- **Registro anónimo** sin email/teléfono puede chocar con guidelines de cuentas.
- Los **testers internos se saltan el review**, así que Fase 1 no se ve afectada. Esto solo aplica
  al pasar a externos (>100 / público) o al enviar a producción.

---

## Referencias
- EAS Build sin Mac: https://docs.expo.dev/build/introduction/
- `eas submit` a TestFlight: https://docs.expo.dev/submit/ios/
- Estado Android (espejo): `ANDROID-LAUNCH-READINESS.md`
