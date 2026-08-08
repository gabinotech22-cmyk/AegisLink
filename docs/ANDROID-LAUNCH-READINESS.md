# Android Launch Readiness — Roadmap

> Estado a **2026-06-24**. Objetivo: primer lanzamiento Android (soft-launch por tandas).
> Filosofía: no existe "0 riesgo"; la meta es **riesgo conocido, pequeño y monitoreado**.
> Para un producto de privacidad el listón es alto porque la promesa es fuerte.

Estimación honesta: **~85-90% listo para un soft-launch** (Closed/Open Testing en Play).
El 10-15% restante **no es código** — es prueba en dispositivo real, configuración de Play
Console y honestidad de claims.

---

## ✅ Ya listo (verificado)

- **App funcional**: chat 1:1 E2EE, grupos, llamadas 1:1 + grupales (validadas en 2 emuladores
  el 24-jun: host-ends + admin-gate), efímeros, adjuntos cifrados, modo pánico, SQLCipher.
- **Cripto**: Double Ratchet, X3DH, PQXDH híbrido, sealed-sender v2 por defecto.
- **Infra**: relay vivo en Hetzner (157.180.116.176) + coturn real + push FCM funcionando.
- **CI**: CodeQL + Semgrep + tests server/desktop/mobile + E2E Maestro (continue-on-error).
- **Build de release**: `mobile/eas.json` con perfil `production` (AAB) + `production-apk`,
  autoIncrement, canal `production`. Keystore `aegislink-release.keystore` referenciado en
  `build.gradle`.
- **Compliance básico**: `targetSdkVersion 35` (Android 15, cumple el mínimo de Play).
  `docs/privacy-policy.md` escrita. Licencia GPL/AGPL, `SECURITY.md`, email de contacto.
- **Dependencias** (al 24-jun): toda la cola de dependabot triada; 5 majors validados
  (zustand 5, react-i18next 17, @noble/hashes 2 desktop, express 5, zod 4) + vite 7.

---

## 🔴 FASE 1 — Bloqueantes para soft-launch (must)

### 1. Prueba en dispositivo Android FÍSICO (no emulador)
- [x] **Gama-baja extrema probada (25-jun)**: Blackview WAVE 8C (ARMv7 32-bit, 2GB RAM).
      Resultado: build armeabi-v7a instala y arranca sin native crash; **generación de
      identidad (argon2id/Hermes) SIN freeze** (riesgo nº1, despejado); onboarding fluye;
      `FLAG_SECURE` confirmado (el SO no puede screenshotear). **PERO** la app va inusable de
      lenta: el dispositivo tiene solo ~210MB libres y **swapea**, y el LMK mató el proceso 3×
      en 5 min. Footprint de la app razonable (103MB PSS) → **no es bug nuestro, es suelo de
      hardware**. **Decisión: mínimo soportado = arm64-v8a + ~3GB RAM**; se dropearon los ABIs
      32-bit en `gradle.properties` (ver `fix/min-spec-arm64`).
- [ ] Instalar el AAB/APK de release en **2-3 teléfonos reales arm64** (3GB+ / 4GB+ / reciente).
- [ ] Smoke completo en cada uno: onboarding anónimo → identidad → chat 1:1 E2EE → grupo →
      llamada 1:1 → llamada grupal → adjunto (imagen/audio) → efímero → **modo pánico** →
      **push wake-up con la app cerrada**.
- [ ] Verificar batería/rendimiento de cripto JS (Hermes) en gama baja — es el punto débil
      conocido (ver `[[project_hermes_kdf_costs]]`).
- **Por qué bloquea:** el emulador no captura permisos reales, push en background, ni perf de
  cripto en hardware modesto. Esta máquina de dev no sirve (reinicia bajo carga, ver
  `docs`/memoria `project_calls_emulator_limit`).

### 2. Google Play Console — setup de publicación
- [ ] Crear la app en Play Console (package `com.aegislink.app`).
- [ ] **Build de producción firmado**: `eas build -p android --profile production` (AAB).
      Confirmar que la **upload key / keystore está respaldada de forma segura** (si se pierde,
      no se puede actualizar la app nunca más). Considerar Play App Signing.
- [ ] **Data Safety form**: declarar honestamente la postura cero-metadatos (es una FORTALEZA —
      "no data collected"/"no data shared"). No exagerar.
- [x] **Store listing — título/descripciones/screenshots/assets**: borrador
      completo en `docs/PLAY-STORE-LISTING.md` (2026-07-01; capturas
      localizadas 2026-08-08). 8 screenshots **por idioma** en/es/it
      (`promo-video/play-store/screenshots/<idioma>/`, regenerables con
      `node scripts/capture-store-shots.mjs --store play`), feature graphic
      1024×500 y ícono 512×512 con alpha en `promo-video/play-store/`. **Falta
      todavía**: hostear `privacy-policy.md` en URL pública (ver checklist en
      ese doc).
- [ ] **Privacy Policy URL pública**: `docs/privacy-policy.md` debe estar **hosteada** en una URL
      accesible (landing duckdns / GitHub Pages / dominio). Play exige URL, no un .md del repo.
- [ ] Content rating questionnaire.
- [ ] Crear track de **Closed Testing** (lista de testers) antes que producción.
- [ ] **Device catalog / exclusión por RAM**: al subir un AAB arm64-only, Play ya deja de servir
      a dispositivos 32-bit. Adicionalmente, excluir en Play Console los equipos con <3GB RAM
      (Device catalog → exclusion rules) para no recibir reviews de 1★ por lentitud en hardware
      por debajo del mínimo. Reflejar el mínimo en el store listing.

### 3. Honestidad de claims (legal + reputacional)
- [ ] "Known Limitations" visible (README + store listing + About in-app) que diga claro:
      **cripto aún NO auditada por terceros independientes** y **cripto en JS/Hermes**.
- [ ] Que cada claim de marketing ("cero metadatos", "E2EE") tenga respaldo verificable en el
      código abierto. Nada que no podamos demostrar.

---

## 🟡 FASE 2 — Antes de lanzamiento público amplio (should)

- [ ] **Auditoría de seguridad/cripto independiente** (OSTIF / OTF / Amorpheus — contactos ya
      existen, vía grants). Es el mayor reductor de riesgo del *claim*. Semanas/meses.
- [ ] **Rollout escalonado** en Play (Closed → Open → % de producción) con recolección de
      crashes **respetando cero-metadatos** (opt-in o ninguno; nunca telemetría silenciosa).
- [ ] **Monitoreo/alertas del relay** + runbook de incidentes (hoy = 1 mantenedor, single-region
      Hetzner Helsinki → riesgo de disponibilidad). Backup/restore probado.
      Nota cero-metadatos: el monitoreo es **server-side del relay** (health check, error rate,
      disco, uptime) — nunca telemetría de cliente ni métricas ligadas a usuarios.
- [ ] Plan de respuesta a vulnerabilidades (ya hay `SECURITY.md`; falta capacidad operativa).

---

## 🔙 Plan de rollback (documentado ANTES del soft-launch)

En una app de tienda no se puede "revertir" un APK ya instalado; el rollback tiene tres
palancas, cada una con su tiempo:

### Condiciones de disparo
- Crash rate en Play Console vitals > 1% de sesiones, o cualquier crash en el flujo
  cripto/onboarding (pérdida de identidad = irrecuperable para el usuario).
- Relay caído o degradado > 15 min sin causa conocida.
- Bug de integridad de datos (mensajes que no descifran, sesiones ratchet corruptas).
- Vulnerabilidad de seguridad reportada que afecte a la versión publicada.

### Palancas y tiempos
1. **Halt del rollout en Play Console** (Closed/Open Testing → "Pause rollout"): detiene
   nuevas instalaciones/updates. **< 5 min.** No arregla a quien ya instaló.
2. **Rollback del relay**: redeploy de la imagen/commit anterior en Hetzner.
   **< 15 min** (requiere runbook de Fase 2; hasta entonces, procedimiento manual del
   mantenedor).
3. **Release de emergencia**: nuevo AAB con el fix o con la feature desactivada, subido al
   mismo track. **Horas** (build EAS + review de Play). Es la palanca lenta — por eso las
   dos primeras existen.

### Consideraciones de datos
- Los datos del usuario viven **solo en su dispositivo** (SQLCipher); un rollback de relay
  no puede corromperlos, pero un bug de cliente sí. Prioridad absoluta: nunca publicar una
  migración de esquema local sin camino de vuelta o sin gate de versión.
- El relay no guarda mensajes descifrables → el rollback del server no tiene
  consideraciones de privacidad adicionales.

### Comunicación
- Incidente + acción tomada se publican en el canal de testers (Closed Testing) y, si
  aplica seguridad, se sigue `SECURITY.md`.

---

## ✅ Verificación post-launch (primera hora tras publicar en Closed Testing)

- [ ] Health check del relay responde (endpoint + socket handshake).
- [ ] Instalar desde Play (no sideload) en 1 dispositivo real: onboarding → chat 1:1 →
      push wake-up con app cerrada.
- [ ] Play Console vitals: 0 crashes/ANRs nuevos.
- [ ] Logs del relay fluyen y sin errores nuevos (sin datos de usuario, como siempre).
- [ ] Verificar que "Pause rollout" está accesible y entendido (dry-run mental del rollback).
- [ ] Ventana de observación: revisar vitals + relay a las 24h antes de ampliar testers.

---

## 🧹 Backlog de dependencias (cola dependabot abierta al 24-jun)

> El config (`.github/dependabot.yml`) ya está endurecido (PR #147): ignora minor+major de
> `react-native`/`react`/`reanimated`/`worklets` y major de `expo-*`. **El próximo run semanal
> producirá grupos mobile limpios.** Recomendado: dejar asentar el config, **batch-cerrar las
> PRs mobile stale** abajo, y reprocesar las limpias.

| PR | Qué | Disposición sugerida (próxima sesión) |
|----|-----|----------------------------------------|
| #150 | vitest 2→4 (desktop dev) | Validar local (typecheck+vitest); major de test-runner |
| #152 | typescript 5.9→6 (desktop dev) | Seguro (server ya en TS 6); typecheck valida |
| #157 | @noble/hashes 1→2 (mobile, **cripto**) | Misma migración de imports que hice en desktop (`sha2.js`, hkdf utf8) — usar ese commit como plantilla; **validar por CI** (no local) |
| #158 | @testing-library/react-native 13→14 (mobile dev) | Validar por CI |
| #154 | mobile-minor-patch group (stale, pre-#147) | **Cerrar** — regenerará limpio tras el config |
| #155 | react-native-gesture-handler 2→3 (native) | Acoplado al SDK → va con el upgrade de SDK |
| #156 | jest-expo 54→56 | Requiere **Expo SDK 56** → va con el upgrade de SDK |

---

## 🚫 NO hacer ahora (decisiones conscientes)

- **Expo SDK 54 → 56**: NO subir por dependabot. SDK 54 es estable, soportado, sin deuda.
  RN 0.86 (que pedía dependabot) rompe SDK 54. El upgrade es un **proyecto planificado** con
  prueba on-device, no un bump. Ver memoria `decision_expo_sdk54_stay`. Detona cuando: las
  tiendas suban el target-SDK mínimo, queramos features nuevas, o 54 se acerque a EOL.
- **@vitejs/plugin-react 6 / vite 8**: imposibles hasta que `electron-vite` soporte vite 8
  (upstream). Ya shipeamos vite 7 como máximo (#149).
- **Feature flags remotos / kill switch**: NO. Un flag controlado por el server es
  superficie de ataque (el relay podría alterar el comportamiento del cliente) y contradice
  el modelo de confianza cero-metadatos. El "kill switch" de AegisLink es el halt del
  rollout en Play + release de emergencia (ver Plan de rollback). Flags locales de build
  (compile-time) sí son aceptables.

---

## 📌 Pendientes menores de features (de memoria, no bloquean launch)

- Canal de voz grupal **Fase 2 (push)** — `[[project_group_voice_channel]]`.
- Sealed-sender **Fase 4 Slice 2b (push)** + APK 2-device combinada — `[[project_sealed_sender_epic]]`.

---

## Riesgos residuales que se ACEPTAN y se documentan

1. **Cripto no auditada externamente** (mitigación: disclaimer honesto + auditoría en Fase 2).
2. **Cripto en JS/Hermes** (perf en gama baja; mitigación: argon2idAsync ya aplicado, medir en Fase 1).
3. **Single-region relay + 1 mantenedor** (mitigación: monitoreo + runbook en Fase 2).
4. **Validación a escala limitada** (mitigación: rollout escalonado).

> Recordatorio: el objetivo NO es "0 riesgo" (inalcanzable). Es lanzar con riesgo **acotado,
> conocido y observado** — y por eso el soft-launch por tandas es el camino correcto.
