# ROADMAP — Traspaso de la ronda iOS TestFlight (2026-07-09/10)

Documento de traspaso para continuar en sesiones nuevas. Estado verificado contra
código y PRs en el momento de escribirlo (regla: la doc no miente — si algo
discrepa al leerlo, gana el código y se corrige aquí).

## 1. Estado actual

### Mergeado a `main` (entra en build 16)
| PR | Qué | Evidencia |
|----|-----|-----------|
| #281 | Cert pins ATS iOS + freeze foto de perfil (settle delay en `pickingGuard`) | `mobile/app.json`, `pickingGuard.test.ts` |
| #282 | Lock PIN-first: numpad por defecto, biometría solo por botón, `disableDeviceFallback: true` | `Lock.test.tsx` |
| #283 | Lote auditoría: claves identidad `_THIS_DEVICE_ONLY`, pickers de documentos con guard, sesión de audio restaurada, doc VoIP | 4 commits, 1 test/fix |
| #284 | Guard biometría en LockSetup + `NSLocalNetworkUsageDescription` | |
| #285 | Media privada excluida del backup iCloud/iTunes | |
| #286 | Paths de media relativos + migración (UUID de contenedor iOS) | |

### Abierto / en vuelo
| Qué | Estado | Siguiente paso |
|-----|--------|----------------|
| **PR #287** — tormenta de reintentos de registro (cooldown persistido, cero minería PoW en ban, banner honesto con error crudo) | CI verde, **pendiente OK de merge del dueño** | Merge → build 16 |
| **`fix/lock-hardening`** — rama WIP (commit `ec763bf`) | Agente parado a medias; hecho: flag longitud PIN, andamiaje cooldown, guard en `authenticateAsync`; **sin verificar** | Retomar y completar según §3, tests en verde, PR |
| PR #279 — VoIP nativo vía bridging header (llamadas en background) | Abierto (otra sesión) | Review + build 17 dedicada |
| PR #278 — export compliance | Abierto | Review + decisión dueño |
| Build 15 | En TestFlight | Probada por el dueño: registro sigue fallando (ver §2), contactos hardcodeados en ES |

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
- Diagnóstico definitivo: la build 16 muestra el error crudo en el banner (F4 del #287). Pedir
  captura al dueño.

Fixes candidatos (decidir en la sesión que lo tome):
1. SHA-256 nativo para el minero (p.ej. `expo-crypto digestStringAsync` en lotes, o precomputar
   el estado del hash) — orden de magnitud más rápido, sin cambiar el protocolo.
2. Reusar buffer en el bucle (quitar allocs por hash) — barato, x2-x5.
3. Server: bajar dificultad a 16 o TTL a 10 min — decisión de producto (anti-bots vs hardware viejo).
4. Cliente: reintentar automáticamente con challenge fresco si el server responde "challenge expirado".

## 3. Addendum pendiente para `fix/lock-hardening` (retomar el WIP)

Terminar lo empezado (spec original: 4 fixes + tests) y añadir:
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
1. **Merge #287 + finalizar lock-hardening → build 16** (desbloquea diagnóstico §2 y todos los fixes).
2. **i18n pantallas de agregar contactos** (hardcodeadas en español — bug reportado en build 15).
3. **PoW/registro** según diagnóstico §2 (+ task #5: subir `AEGIS_REG_RATELIMIT_MAX` en el relay
   durante testing; investigar mecanismo de deploy antes de tocar prod).
4. **PR #279 VoIP → build 17** (task #1) y **PR #278** (task #6).
5. **Des-registro autenticado en relay + auto-purga de inactivos** (tasks #2, #12 — juntas).
6. **Migración PIN 4→6** (task #3, depende de lock-hardening mergeado).
7. **Capturas de pantalla ambas plataformas** (task #11), **clipboard** (#14), **jailbreak aviso**
   (#13), **backup nudge** (#10).
8. **Estrategia pagos iOS: cripto fuera de la app** (task #9 — decisión tomada, documentar en el
   doc canónico de la sección 14 y auditar que ninguna pantalla iOS mencione pagos).
9. **`docs/IOS-TEST-PLAN.md`** (task #7) y **regla CLAUDE.md "proponer decisiones de producto"**
   (task #8 — ya en memoria del asistente; falta el PR de CLAUDE.md).

## 5. Decisiones de producto ya tomadas por el dueño (no re-litigar)

- Lock **PIN-first**; biometría opcional por botón; el passcode del dispositivo NUNCA desbloquea.
- Biometría ciega al estado de coerción (§3.D).
- Pagos cripto **solo fuera de iOS**; la app iOS solo vincula/desbloquea.
- Capturas: FLAG_SECURE Android + detección/aviso iOS, **ambas ya** (sin fases).
- Auto-wipe solo por intentos de PIN, nunca por fallos del sensor.
- Cooldown progresivo del lock: 5º fallo 30 s → 60 s → 5 min → 15 min, persistido, reset idéntico
  con PIN real o señuelo.
