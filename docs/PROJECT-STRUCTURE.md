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

## Convención al añadir algo nuevo

Antes de crear un archivo, pregúntate: ¿es producto, doc, script, prototipo o scratch?
La respuesta determina la carpeta. Si no encaja en ninguna, probablemente es `_scratch/`
o no debería existir. En la duda, este doc y `CLAUDE.md` mandan sobre la conveniencia.
