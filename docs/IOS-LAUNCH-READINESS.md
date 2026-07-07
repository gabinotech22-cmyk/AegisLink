# iOS / TestFlight Launch Readiness — Roadmap

> Estado a **2026-07-07**. Objetivo: testing en dispositivo iOS real vía **TestFlight**,
> sin MacBook, usando **EAS Build en la nube**.
> Espejo de `ANDROID-LAUNCH-READINESS.md`. Filosofía igual: riesgo conocido, pequeño y monitoreado.

## TL;DR — no hace falta Mac

Compilar iOS **no requiere Mac**. EAS Build compila en máquinas macOS de Expo y gestiona los
certificados de Apple en la nube. Solo necesitas: cuenta Apple Developer (✅ activa), tus iPhones,
y este PC Windows. La distribución a los teléfonos de test se hace por **TestFlight** — sin
registrar UDIDs, sin Xcode, sin Keychain.

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

### 1. Crear la app en App Store Connect  *(manual, requiere tu Apple ID)*
- [ ] appstoreconnect.apple.com → **Apps → +** → nueva app.
- [ ] Bundle ID: `com.aegislink.app`. Plataforma: iOS. Nombre: AegisLink.
- [ ] Anotar el **`ASC_APP_ID`** (el número que aparece en la URL / App Information) → hace falta
      para `eas submit`.

### 2. Definir las env vars de submit  *(local, este PC)*
```
APPLE_ID=<tu email de Apple Developer>
APPLE_TEAM_ID=X2W7MRTDMJ
ASC_APP_ID=<el de App Store Connect, paso 1>
```
> No commitear estos valores. Se exportan en la shell antes de `eas submit`.

### 3. Generar credenciales iOS en la nube  *(sin Mac)*
- [ ] `eas credentials -p ios` → loguea con el Apple ID una vez; EAS crea y guarda el
      **Distribution Certificate** + **Provisioning Profile** en su servidor.

### 4. Build de producción iOS  *(nube)*
- [ ] `eas build -p ios --profile production` → genera el `.ipa` firmado.

### 5. Subir a TestFlight
- [ ] `eas submit -p ios --profile production` → sube el build a App Store Connect.
- [ ] Esperar el procesado de Apple (~5-30 min) — aparece en la pestaña **TestFlight**.

### 6. Testers internos  *(sin review de Apple)*
- [ ] En TestFlight → **Internal Testing** → añadir tus Apple IDs (hasta 100).
- [ ] Los testers instalan la app **TestFlight** en el iPhone y aceptan la invitación.
- [ ] **No requiere beta review** → se puede probar de inmediato.

### 7. Smoke test en iPhone físico
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
