# ROADMAP — Traspaso de la ronda iOS TestFlight (2026-07-09/10)

Documento de traspaso para continuar en sesiones nuevas. Estado verificado contra
código y PRs en el momento de escribirlo (regla: la doc no miente — si algo
discrepa al leerlo, gana el código y se corrige aquí).

## 1. Estado actual

### Mergeado a `main` (entra en build 16)

| PR | Qué | Evidencia |
|----|-----|-----------|
| [#279](https://github.com/gabinotech22-cmyk/AegisLink/pull/279) | VoIP nativo re-activado vía bridging header ObjC (llamadas en background) | merge [`b3926a1`](https://github.com/gabinotech22-cmyk/AegisLink/commit/b3926a1) |
| [#281](https://github.com/gabinotech22-cmyk/AegisLink/pull/281) | Cert pins ATS iOS + freeze foto de perfil (settle delay en `pickingGuard`) | merge [`dcaca61`](https://github.com/gabinotech22-cmyk/AegisLink/commit/dcaca61); [`mobile/app.json`](../mobile/app.json), [`pickingGuard.test.ts`](../mobile/src/utils/__tests__/pickingGuard.test.ts) |
| [#282](https://github.com/gabinotech22-cmyk/AegisLink/pull/282) | Lock PIN-first: numpad por defecto, biometría solo por botón, `disableDeviceFallback: true` | merge [`a21626e`](https://github.com/gabinotech22-cmyk/AegisLink/commit/a21626e); [`Lock.test.tsx`](../mobile/src/screens/__tests__/Lock.test.tsx) |
| [#283](https://github.com/gabinotech22-cmyk/AegisLink/pull/283) | Lote auditoría: claves identidad `_THIS_DEVICE_ONLY`, pickers de documentos con guard, sesión de audio restaurada, doc VoIP | merge [`109c692`](https://github.com/gabinotech22-cmyk/AegisLink/commit/109c692) (4 commits, 1 test/fix) |
| [#284](https://github.com/gabinotech22-cmyk/AegisLink/pull/284) | Guard biometría en LockSetup + `NSLocalNetworkUsageDescription` | merge [`8fbf75b`](https://github.com/gabinotech22-cmyk/AegisLink/commit/8fbf75b) |
| [#285](https://github.com/gabinotech22-cmyk/AegisLink/pull/285) | Media privada excluida del backup iCloud/iTunes | merge [`106a10a`](https://github.com/gabinotech22-cmyk/AegisLink/commit/106a10a) |
| [#286](https://github.com/gabinotech22-cmyk/AegisLink/pull/286) | Paths de media relativos + migración (UUID de contenedor iOS) | merge [`55b27a9`](https://github.com/gabinotech22-cmyk/AegisLink/commit/55b27a9) |
| [#287](https://github.com/gabinotech22-cmyk/AegisLink/pull/287) | Tormenta de reintentos de registro: cooldown persistido, cero minería PoW en ban, banner honesto con error crudo | merge [`bc3234a`](https://github.com/gabinotech22-cmyk/AegisLink/commit/bc3234a) — su F4 (banner con error crudo) habilita el diagnóstico de §2 |

### Abierto / en vuelo

| Qué | Estado | Siguiente paso |
|-----|--------|----------------|
| **[PR #288](https://github.com/gabinotech22-cmyk/AegisLink/pull/288)** — este doc + hardening base del lock (flag longitud PIN, cooldown progresivo persistido, fallos biométricos fuera del contador/auto-wipe; commit `ec763bf` + fixes de review) | En review | Merge → build 16. El addendum §3 (A-E) NO va aquí: rama aparte |
| [PR #278](https://github.com/gabinotech22-cmyk/AegisLink/pull/278) — export compliance | Abierto | Review + decisión dueño |
| Build 15 | En TestFlight | Probada por el dueño: registro sigue fallando (ver §2), contactos hardcodeados en ES |
| Build 16 | Pendiente de lanzar (`main` ya tiene #279+#287) | Mergear #288 → lanzar → pedir al dueño captura del banner de error (§2) |

## 2. Investigación abierta: registro falla en iPhone 8 (build 15)

Hechos verificados:
- Relay sano (`/health` 200, ~200 ms). Challenge endpoint OK (`GET /identity/challenge`).
- Rate-limit: 5 intentos / **15 min** por IP (`server/src/routes/identity.ts:18-31`, ventana fija,
  store en memoria). Tras >20 min cerrado siguió fallando ⇒ **no es (solo) el rate-limit**.
- **Sospechoso #1 — PoW vs TTL**: producción exige dificultad **18** (~262k SHA-256 de media,
  `server/src/pow/challenge.ts:19-20`) con challenge TTL **300 s** (`:23`). El minero del cliente
  (`mobile/src/crypto/registration.ts:154-181`) es JS puro con allocs por hash y yield cada 2048;
  en un iPhone 8/Hermes el p90-p99 de minado puede exceder el TTL ⇒ challenge caducado ⇒ fallo
  permanente/intermitente en hardware viejo. Además el minado explica la lentitud general reportada.
- Diagnóstico definitivo: **pendiente de la build 16**. El F4 de
  [#287](https://github.com/gabinotech22-cmyk/AegisLink/pull/287) (ya en `main`) hace que el
  banner muestre el error crudo; cuando la build 16 esté en TestFlight, pedir captura al dueño.

Fixes candidatos (decidir en la sesión que lo tome):
1. SHA-256 nativo para el minero (p.ej. `expo-crypto digestStringAsync` en lotes, o precomputar
   el estado del hash) — orden de magnitud más rápido, sin cambiar el protocolo.
2. Reusar buffer en el bucle (quitar allocs por hash) — barato, x2-x5.
3. Server: bajar dificultad a 16 o TTL a 10 min — decisión de producto (anti-bots vs hardware viejo).
4. Cliente: reintentar automáticamente con challenge fresco si el server responde "challenge expirado".

## 3. Addendum pendiente de lock-hardening (rama nueva tras mergear #288)

El hardening base (spec original: 4 fixes + tests) va en
[#288](https://github.com/gabinotech22-cmyk/AegisLink/pull/288). Queda pendiente, en una rama
`fix/*` propia:
- **A. "Borrar identidad" = wipe completo**: `Profile.tsx:112` llama solo `reset()`; debe llamar
  `wipeDatabase()` + `reset()` como el pánico (`App.tsx:630`). Hoy deja el PIN viejo y
  `appLockEnabled` vivos → el bug reportado "identidad nueva, candado viejo".
- **B. Purga de instalación fresca (iOS)**: el Keychain sobrevive a la desinstalación. Marcador
  fuera del Keychain (p.ej. archivo en `documentDirectory`, muere con la app); si falta y hay
  slots `aegis.*` → purgarlos y escribir el marcador. Cuidado: el marcador SÍ sobrevive a updates.
- **C. Orden de verificación real→señuelo** en `validatePin()` (hoy señuelo→real): desbloqueo
  normal en 1 Argon2 en vez de 2. Sin regresión de indistinguibilidad (la asimetría ya existía).
- **D. Invariante biometría↔coerción (requisito del dueño, con test)**: el éxito biométrico
  jamás toca `duressActive` en NINGUNA dirección — nunca activa coerción, y si estás en señuelo
  te DEJA en señuelo (solo el PIN real sale). Test: success con `duressActive=true` → `onUnlock`
  sin cambiar el estado ni hidratar los stores reales.
- **E. Default `lockTimeoutMin` 0 → 1 min** (solo instalaciones/configs nuevas; no pisar la
  preferencia ya elegida). Tarea #4.

## 4. Cola aprobada por el dueño (tasks #1-#14 de la sesión)

Orden sugerido por valor/urgencia:
1. **Merge #288 (hardening base del lock) → build 16** (#287 y #279 ya están en `main`;
   desbloquea el diagnóstico §2 y todos los fixes).
2. **i18n pantallas de agregar contactos** (hardcodeadas en español — bug reportado en build 15).
3. **PoW/registro** según diagnóstico §2 (+ task #5: subir `AEGIS_REG_RATELIMIT_MAX` en el relay
   durante testing; investigar mecanismo de deploy antes de tocar prod).
4. **PR #278 export compliance** (task #6; #279 ya mergeada — entra en build 16, no hace falta
   build 17 dedicada).
5. **Des-registro autenticado en relay + auto-purga de inactivos** (tasks #2, #12 — juntas).
6. **Migración PIN 4→6** (task #3, depende de lock-hardening mergeado).
7. **Capturas de pantalla ambas plataformas** (task #11), **clipboard** (#14), **jailbreak aviso**
   (#13), **backup nudge** (#10).
8. **Estrategia pagos iOS: cripto fuera de la app** (task #9 — decisión tomada, documentar en el
   doc canónico de la sección 14 y auditar que ninguna pantalla iOS mencione pagos).
9. **`docs/IOS-TEST-PLAN.md`** (task #7) y **regla CLAUDE.md "proponer decisiones de producto"**
   (task #8 — la decisión está registrada en §5; falta el PR que la añada a `CLAUDE.md`).

## 5. Decisiones de producto ya tomadas por el dueño (no re-litigar)

- Lock **PIN-first**; biometría opcional por botón; el passcode del dispositivo NUNCA desbloquea.
- Biometría ciega al estado de coerción (§3.D).
- Pagos cripto **solo fuera de iOS**; la app iOS solo vincula/desbloquea.
- Capturas: FLAG_SECURE Android + detección/aviso iOS, **ambas ya** (sin fases).
- Auto-wipe solo por intentos de PIN, nunca por fallos del sensor.
- Cooldown progresivo del lock: 5º fallo 30 s → 60 s → 5 min → 15 min, persistido, reset idéntico
  con PIN real o señuelo.
