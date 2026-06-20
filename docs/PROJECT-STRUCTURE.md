# Estructura del proyecto AegisLink

> Documento normativo. La versión corta y obligatoria vive en `CLAUDE.md`
> (REGLA DE ORO — Estructura y ubicación de archivos). Aquí está el detalle y la
> justificación. Si una PR introduce un archivo y no sabes dónde va, este doc decide.

## Por qué existe

La raíz del repo se contaminó con ~40 prototipos sueltos, ~400 artefactos de
depuración (`_*.png`, `*.apk` de 180 MB, `bugreport-*.zip`) y scripts/docs ad-hoc.
Eso hace que `git status` sea ruido, que builds y reviews tropiecen con basura, y
que "no sepamos dónde va" cada cosa nueva — el síntoma de la desviación que esto
previene. **La raíz es sagrada: solo lo canónico vive ahí.**

## Mapa canónico de directorios

| Ruta | Dueño / contenido | Quién toca aquí |
|------|-------------------|-----------------|
| `mobile/` | App Expo SDK 54 + React Native + TS (cliente principal) | `mobile-lead` |
| `desktop/` | Cliente desktop (Electron/Tauri); **paridad obligatoria** con mobile en crypto/sesión | `mobile-lead` / `crypto-lead` |
| `server/` | Relay Socket.IO, SQLite, push, señalización WebRTC | `backend-lead` |
| `infra/` | CI/CD, EAS, coturn, Docker, deploy, runbooks | `infra-lead` |
| `web/` | Landing / web pública | `mobile-lead` |
| `docs/` | Toda la documentación: protocolo, seguridad, roadmaps, legal, testing | todos |
| `prototype/` | Prototipos de diseño originales (`*.jsx`, `*.html`, canvas). **Referencia, no build.** | diseño |
| `scripts/` | Scripts operativos sueltos (`*.ps1`, helpers de build/deploy local) | `infra-lead` |
| `promo-video/` | Material de marketing/vídeo | marketing |
| `.claude/agents/` | Definiciones de sub-agentes | `director` |
| `_scratch/` | **Transitorio, gitignored.** Screenshots de emulador, dumps UI, logs, APKs de prueba, scripts de un solo uso | nadie commitea |

## Qué puede vivir en la raíz (lista cerrada)

Solo estos, y nada más nuevo sin justificación:
`README.md`, `LICENSE`, `SECURITY.md`, `CLAUDE.md`, `.gitignore`, `.env.example`,
`docker-compose.yml`, `skills-lock.json`, y los dotfiles de tooling (`.github/`, `.idea/`).

Cualquier otro archivo en la raíz es deuda: muévelo a su carpeta o a `_scratch/`.

## Reglas de ubicación

1. **Código de producto** → siempre dentro de `mobile/`, `desktop/`, `server/` o `web/`.
   Nunca un `.ts`/`.tsx` de producto suelto en la raíz.
2. **Documentación** → `docs/`. Un `.md` nuevo va a `docs/` salvo los 4 canónicos de raíz.
3. **Scripts operativos** → `scripts/`. No `.ps1`/`.sh` sueltos en raíz.
4. **Prototipos de diseño** → `prototype/`. Son referencia histórica; no se importan desde el build.
5. **Cualquier cosa transitoria** (capturas, logs, dumps, APKs de test, `_powtest.mjs`,
   experimentos de un solo uso) → `_scratch/`, que está gitignored. **Nunca** se commitea.
6. **Binarios pesados** (APK, mp4, zip, bugreports) no se versionan; van a `_scratch/`
   o a release artifacts, nunca a git. Ver patrones en `.gitignore`.
7. **Paridad mobile↔desktop**: un cambio de crypto/sesión/ratchet vive en la misma rama
   y toca ambas carpetas. No se reparte una feature entre varias ramas (ver REGLA DE ORO de ramas).

## Organización interna de cada paquete

El mapa de arriba dice en qué paquete vive algo; esto dice **dónde dentro del paquete**.
No inventes carpetas nuevas en la raíz de un paquete sin actualizar esta tabla.

### `mobile/src/`
| Subcarpeta | Qué contiene |
|------------|--------------|
| `screens/` | Una pantalla por archivo (`PascalCase.tsx`). Es la capa de navegación. |
| `components/` | UI reutilizable, sin lógica de negocio ni I/O. |
| `crypto/` | Double Ratchet, X3DH, NaCl, fingerprints. **Nada de UI aquí.** |
| `socket/` | Cliente del relay, sealed-sender, sesión. `client.ts` es el núcleo. |
| `webrtc/` · `calls/` | Señalización y UI de llamadas E2EE. |
| `db/` | expo-sqlite, esquema, cifrado at-rest. |
| `store/` | Estado global (zustand). |
| `security/` · `lock/` | Modo pánico, biometría, app-lock. |
| `notifications/` | Push wake-up (payload siempre cifrado). |
| `hooks/` · `utils/` · `theme/` · `i18n/` | Helpers transversales. |
| `web3/` | DIDs y pagos — opcional, la app funciona sin esto. |
| `__tests__/` · `__mocks__/` | Tests Jest + RNTL y sus mocks (ver convención de tests). |
| `_unused/` | Código aparcado a recuperar (p. ej. Wallet/monetización). No se importa desde producción. |

### `server/src/`
| Subcarpeta | Qué contiene |
|------------|--------------|
| `relay/` | Socket.IO, reenvío de blobs opacos, colas. |
| `auth/` | Challenge-response Ed25519, autenticación de socket. |
| `routes/` | Endpoints HTTP (validados con Zod). |
| `crypto/` · `pow/` | Verificación de firmas, prueba de trabajo anti-spam. |
| `push/` | FCM/APNs solo wake-up. |
| `db/` | SQLite del relay (mínimos metadatos at-rest). |
| `__tests__/` · `__mocks__/` | Tests del servidor. |

### `desktop/src/`
Modelo Electron: `main/` (proceso principal + IPC), `preload/` (puente seguro),
`renderer/` (UI + `renderer/socket/client.ts`, que **espeja** `mobile/src/socket/client.ts`).
Todo cambio de crypto/sesión va en paralelo en ambos `client.ts` (regla de oro #5).

## Convenciones de nombres y tests

- **Componentes y pantallas**: `PascalCase.tsx`. **Módulos de lógica/util**: `camelCase.ts`.
- **Tests**: en un `__tests__/` del paquete, nombrados `<unidad>.<caso>.test.ts`
  (p. ej. `client.desyncRecovery.test.ts`). **Un test de regresión por fix de seguridad** (regla #11).
- **Ramas**: `feat/*` para features, `fix/*` para arreglos, `chore/*` para tooling/estructura.
  Una feature que toca varios paquetes va en **una sola rama** (regla de oro de ramas #5).
- **Una sección de producto nueva** (de las 14) entra como pantallas en `mobile/src/screens/`
  + su lógica en el paquete que corresponda; nunca como código suelto fuera de `src/`.

## Convención al añadir algo nuevo

Antes de crear un archivo, dos preguntas en orden:
1. ¿Es producto, doc, script, prototipo o scratch? → determina el **paquete/carpeta raíz**.
2. Si es producto, ¿qué capa es (pantalla, componente, crypto, socket, db, store…)? → determina
   la **subcarpeta** según las tablas de arriba.

Si no encaja en ninguna, probablemente es `_scratch/` o no debería existir. En la duda,
este doc y `CLAUDE.md` mandan sobre la conveniencia.
