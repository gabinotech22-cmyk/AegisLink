# Plan de Mejoras AegisLink — Director

> Generado: 2026-05-21  
> Fuente: auditoría de skills GitHub + análisis de código  
> Estado del producto: 14 secciones marcadas ✅ en director.md — se abren épicas de CALIDAD sobre funcionalidad existente

---

## Resumen ejecutivo

El producto tiene las 14 secciones funcionales implementadas. Las épicas aquí descritas son mejoras de calidad, robustez y completitud detectadas al comparar el código actual contra skills de GitHub (Software Mansion, Expo oficial, senaiverse) y al inspeccionar el árbol de archivos.

**Prioridad asignada:**
- 🔴 P0 — Bloquea seguridad o funcionalidad core
- 🟠 P1 — Calidad significativa, impacto en usuario
- 🟡 P2 — Mejora incremental, no bloquea nada
- 🟢 P3 — Nice-to-have, backlog

---

## ÉPICA 1 — Fix hallazgos de seguridad conocidos 🔴 P0

**Responsable**: `qa-lead` coordina, `crypto-lead` y `backend-lead` implementan

### Hallazgo A — SPK sin verificar en X3DH
- **Archivo**: `mobile/src/crypto/signal/x3dh.ts:38-43`
- **Problema**: Verificación de firma del Signed PreKey comentada. Un cliente acepta SPKs sin validar Ed25519.
- **Riesgo**: Un relay comprometido puede inyectar SPKs maliciosos → man-in-the-middle en el establecimiento de sesión.

**Delegación a crypto-lead:**
```
CONTEXTO: x3dh.ts líneas 38-43 tienen verifySignature() comentado.
TAREA: Descomentar, asegurar que lanza Error si falla, añadir test en
  mobile/src/crypto/signal/__tests__/x3dh.test.ts para SPK inválido.
CRITERIO: Test "rejects invalid SPK signature" pasa en rojo antes del fix, verde después.
RESTRICCIONES: No cambiar la interfaz pública de initSession().
```

### Hallazgo B — /identity sin autenticación
- **Archivo**: `server/src/routes/identity.ts` — POST /identity
- **Problema**: Cualquiera puede registrar aegisIds sin ningún challenge.
- **Riesgo**: Sybil attack — un adversario puede registrar millones de identidades falsas.

**Delegación a backend-lead:**
```
CONTEXTO: POST /identity no requiere nada — solo acepta el body con la prekey bundle.
TAREA: Añadir rate limiting por IP usando express-rate-limit (sin loguear la IP),
  y un proof-of-work simple (hashcash SHA-256, dificultad 18 bits) que el cliente resuelve.
CRITERIO: Test de integración: >5 requests en 60s devuelven 429. Body del 429 sin IP.
RESTRICCIONES: No añadir ningún identificador persistente del cliente. IP se usa solo
  para rate limit en memoria, jamás se persiste ni se loguea.
DEPENDENCIAS: mobile-lead debe actualizar registration.ts para enviar la solución PoW.
```

### Hallazgo C — console.log con aegisIds en producción
- **Archivo**: `App.tsx` (scheduler de mensajes programados)
- **Problema**: Log filtra aegisIds en builds de producción.

**Delegación a mobile-lead:**
```
CONTEXTO: Hay un console.log en el scheduler de mensajes programados en App.tsx
  que expone aegisIds.
TAREA: Buscar todos los console.log en mobile/src/ y App.tsx.
  Eliminar los que contengan aegisId, contactId, o contenido de mensajes.
  Los que sean útiles para debug: envolver en `if (__DEV__)`.
CRITERIO: qa-lead scan #2 (grep console.log) no produce resultados fuera de __DEV__ guards.
```

---

## ÉPICA 2 — Animaciones fluidas a 120fps 🟠 P1

**Responsable**: `mobile-lead`  
**Skill nueva**: `swm-animations-gestures.md`

### Pantallas que necesitan animaciones nativas

| Pantalla | Animación faltante | Impacto UX |
|---|---|---|
| Chat 1:1 | Swipe-to-delete en mensajes | Alto — gesto estándar |
| Llamada entrante | Pulsación del avatar mientras timbra | Alto — feedback visual |
| Modo pánico | Confirmación con vibración + transición | Crítico — seguridad |
| Transiciones generales | Slide entre pantallas (actualmente abruptas) | Medio |

**Delegación a mobile-lead:**
```
CONTEXTO: La navegación usa un stack manual en App.tsx. No hay Expo Router.
  Tenemos react-native-reanimated y react-native-gesture-handler instalados.
  Skill: .claude/skills/swm-animations-gestures.md
TAREA: Implementar en orden de prioridad:
  1. Swipe-to-delete en MessageBubble (pantalla ChatScreen)
  2. Pulsación de avatar en IncomingCallScreen
  3. Slide-in/out en push/pop de navegación (App.tsx)
  4. Animación de confirmación en PanicScreen
CRITERIO: 60fps estable en Android gama media (Pixel 4a). Respeta reduceMotion.
  Tests RNTL verifican que los gestos disparan los callbacks correctos.
RESTRICCIONES: Worklets solo — no bloquear JS thread. Sin referencias a aegisIds
  en valores animados.
```

---

## ÉPICA 3 — Accesibilidad WCAG 2.2 🟠 P1

**Responsable**: `mobile-lead` implementa, `qa-lead` audita  
**Skill nueva**: `a11y-mobile.md`

### Pantallas críticas sin auditoría a11y

| Pantalla | Problema detectado |
|---|---|
| PanicScreen | Sin focus automático al botón de confirmación |
| OnboardingScreen | QR de identidad sin descripción textual alternativa |
| CallScreen | Botones mute/cámara sin `accessibilityState` |
| ChatScreen | Mensajes efímeros sin `accessibilityLiveRegion` |

**Delegación a mobile-lead:**
```
CONTEXTO: Skill de referencia: .claude/skills/a11y-mobile.md
  Paleta AegisLink: #000000 bg, #FFFFFF text, #00FF88 accent — contrastes ya OK.
TAREA: Auditar y corregir las 4 pantallas listadas.
  Prioridad máxima: PanicScreen (focus) y CallScreen (accessibilityState).
CRITERIO: Tests RNTL con getByRole() para cada botón crítico pasan.
  screen.getByRole('button', { name: /modo pánico/i }) encuentra el botón.
RESTRICCIONES: No cambiar el diseño visual. Solo props de accesibilidad.
```

**Delegación a qa-lead (después del fix):**
```
CONTEXTO: mobile-lead habrá añadido props de accesibilidad a PanicScreen,
  OnboardingScreen, CallScreen y ChatScreen.
TAREA: Ejecutar checklist de a11y del skill a11y-mobile.md sobre esas 4 pantallas.
  Reportar cualquier hallazgo con el formato estándar de reporte.
CRITERIO: Cero hallazgos Critical o High en el reporte final.
```

---

## ÉPICA 4 — Pipeline EAS Build completo 🟠 P1

**Responsable**: `infra-lead`  
**Skill nueva**: `expo-eas-cicd.md`

### Gaps detectados en infra actual

| Gap | Impacto |
|---|---|
| Sin `AEGIS_EXPO_GO` env en eas.json | Dev client usa stub WebRTC en builds que deberían usar el real |
| Sin canal `production` en EAS Update | OTA updates van a `preview` — riesgo de actualizar usuarios reales con builds QA |
| Sin checklist de permisos en CI | Builds de producción podrían incluir permisos innecesarios |

**Delegación a infra-lead:**
```
CONTEXTO: Skill: .claude/skills/expo-eas-cicd.md
  eas.json actual existe en mobile/eas.json con profiles development/preview/production.
  El stub WebRTC se activa con AEGIS_EXPO_GO=1 en metro.config.js.
TAREA:
  1. Añadir AEGIS_EXPO_GO=0 en perfil development y preview de eas.json.
  2. Configurar canales EAS Update: development → preview → production con promote manual.
  3. Añadir job en .github/workflows/ que verifica permisos del AndroidManifest y
     Info.plist en cada PR (solo CAMERA, MICROPHONE, NOTIFICATIONS permitidos).
CRITERIO: `eas build --profile development` genera un dev client con WebRTC real
  (stub desactivado). CI falla si el manifest incluye permisos no autorizados.
RESTRICCIONES: No añadir permisos nuevos. No cambiar ninguna lógica de aplicación.
```

---

## ÉPICA 5 — Completar secciones incompletas detectadas 🟡 P2

### 5A — Grupos: tests de cifrado de votos (Sección 6)

**Responsable**: `crypto-lead`

```
CONTEXTO: mobile/src/store/polls.ts existe pero no hay tests de que los votos
  estén cifrados antes de enviarse por socket.
TAREA: Revisar polls.ts — verificar que submitVote() cifra el voto con la clave
  del grupo antes de emitir por socket. Si no: implementar.
  Añadir test en mobile/src/store/__tests__/polls.test.ts:
  "submitVote does not expose vote in plaintext on the wire".
CRITERIO: Test pasa. Ningún objeto emitido por socket contiene el voto en texto claro.
```

### 5B — AegisLink Work: completar UI de salas y roles (Sección 13)

**Responsable**: `mobile-lead` + `backend-lead`

```
CONTEXTO: mobile/src/store/work.ts existe. Hay test de orgname pero no de salas ni roles.
  mobile/src/store/__tests__/work.orgname.test.ts solo cubre el nombre de org.
TAREA (mobile-lead): Identificar qué pantallas de AegisLink Work faltan o están vacías.
  Listar en un reporte de 1 página: pantalla → estado (existe / vacía / falta).
TAREA (backend-lead): Verificar que server/ expone endpoints para salas y roles de Work.
  Si faltan: listarlos para implementación coordinada.
CRITERIO: Reporte entregado al director. No implementar sin alineación previa.
```

### 5C — Pagos Lightning: conectar UI real (Sección 14)

**Responsable**: `web3-lead`

```
CONTEXTO: mobile/src/web3/payments/LightningPayment.ts existe pero no está claro
  si hay pantalla de UI conectada.
TAREA: Verificar si existe PaymentScreen o similar en mobile/src/screens/.
  Si no: implementar pantalla mínima que llame a LightningPayment.ts.
  Si sí: verificar que el flujo completo funciona (initiate → invoice → confirm).
CRITERIO: El flujo de pago de suscripción AegisLink Work completa sin errores.
  No se correlaciona wallet address con aegisId en ningún log.
```

---

## ÉPICA 6 — i18n: auditoría de cobertura de idiomas 🟡 P2

**Responsable**: `mobile-lead`

```
CONTEXTO: mobile/src/i18n/ tiene index.ts y useLocale.ts pero no está claro
  cuántos idiomas están cubiertos ni si hay strings hardcodeados en pantallas.
TAREA: Auditar qué pantallas tienen strings hardcodeados (no pasados por useLocale).
  Prioridad: PanicScreen, OnboardingScreen, ChatScreen.
  Reportar lista de strings faltantes al director.
CRITERIO: Reporte entregado. No implementar nuevos idiomas sin priorización explícita.
```

---

## Orden de ejecución recomendado

```
Semana 1: ÉPICA 1 (seguridad — P0)
  → crypto-lead: Hallazgo A (SPK)
  → backend-lead: Hallazgo B (/identity PoW)
  → mobile-lead: Hallazgo C (console.log)

Semana 2: ÉPICA 2 (animaciones) + ÉPICA 3 (a11y) en paralelo
  → mobile-lead: animaciones + accesibilidad
  → qa-lead: auditoría a11y tras los fixes

Semana 3: ÉPICA 4 (EAS Build) + ÉPICA 5A (polls cifrado)
  → infra-lead: EAS completo
  → crypto-lead: polls cifrados

Semana 4: ÉPICA 5B + 5C + 6 (investigación y reporte)
  → todos los leads: reportes al director
  → director: prioriza siguiente sprint
```

---

## Criterios de aceptación globales antes del próximo release

- [ ] Épica 1 completa (cero hallazgos P0/P1 en auditoría qa-lead)
- [ ] SPK verification activa y testeada
- [ ] /identity con rate limiting + PoW
- [ ] Animaciones a 60fps+ en las 4 pantallas prioritarias
- [ ] PanicScreen y CallScreen pasan auditoría a11y
- [ ] EAS Build production con AEGIS_EXPO_GO=0 confirmado
- [ ] CI verde en main

---

## Cómo usar este plan

El director lo lee y delega épicas a los agentes usando el bloque de "Delegación" de cada épica.
Los agentes **no modifican este archivo** — el director lo actualiza al cierre de cada épica.
