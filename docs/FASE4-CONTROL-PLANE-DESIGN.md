# Fase 4 — Plano de control vs entrega: decisión de diseño

> Estado: **documento de decisión, pre-Slice 4.** Bloquea la reescritura del path
> de auth del socket. Escrito porque Slice 4 obliga a una bifurcación de
> arquitectura con implicación directa de privacidad — y CLAUDE.md manda mirar a
> Session/SimpleX antes de inventar. Ver `SEALED-SENDER-ARCHITECTURE.md` §3.4.

## 1. El nudo

Fases 1-3 quitaron el `from`. Fase 4 (Slices 1-3) oculta el `to`: el relay rutea
por un **mailbox id opaco y rotatorio** (`mailboxId = SHA256(signPub)[0:16]`,
`signPub = HKDF(root, época)`), nunca por el `aegisId`. El socket mailbox de
Slice 1 es **solo entrega**: maneja `envelope:mb` (enviar+recibir) y nada más.

Pero el **plano de control** sigue atado al socket autenticado por `aegisId`:

| Operación              | Transporte hoy            | Indexada por |
|------------------------|---------------------------|--------------|
| `prekeys:upload`       | socket aegisId (`auth:ok`)| aegisId      |
| `prekeys:fetch`        | socket aegisId            | aegisId (del destinatario) |
| `push:register`        | socket aegisId            | aegisId      |
| `deliveryToken:register`| socket aegisId           | aegisId      |
| broadcast de perfil    | socket aegisId            | aegisId      |

Un socket puro-mailbox **no puede** hacer nada de esto. Por tanto Slice 4 exige
decidir **cómo conviven control (ligado a la identidad) y entrega (mailbox opaco)**
antes de tocar el path crítico de `connect()`.

Hecho clave que acota el problema: el QR/link de contacto 1:1 lleva
`aegisId + pubkey` (`mobile/src/crypto/qr.ts`), **no** un bundle de prekeys. El
primer contacto SIEMPRE pide el bundle al relay por `aegisId`. Esa consulta de
directorio es la fuga residual del plano de control, y es inherente al diseño
actual de X3DH-por-directorio.

## 2. Cómo lo resuelven los expertos

### Session (red Oxen, onion routing)
- **Sí hay identidad de largo plazo** (Session ID = clave X25519). El almacenamiento
  (swarm) se **indexa por la pubkey del destinatario**: Session NO oculta el
  destinatario al nodo de almacenamiento.
- Su privacidad viene del **onion routing (3 saltos)**: el nodo que guarda los
  mensajes nunca ve la IP del emisor ni los empareja. Desacopla **IP ↔ identidad**,
  no oculta la identidad de routing.
- El "directorio de prekeys" lo sirve el propio swarm (pubkey-indexado), tras
  onion. La consulta existe; lo que se rompe es el vínculo con la IP/momento.

**Lección:** el arreglo correcto del residuo del plano de control (IP↔aegisId) es
**Tor/onion**, no necesariamente rotar el identificador.

### SimpleX (protocolo SMP)
- **No hay identidad de usuario.** La comunicación va por **colas unidireccionales
  por-par-de-contactos**, cada una con IDs distintos para enviar y recibir, de modo
  que el servidor no puede ligar los dos extremos como la misma cola.
- El establecimiento de contacto es **100% out-of-band**: el invite-link lleva la
  dirección de la cola + claves. **No existe directorio de identidades en el
  servidor** → no hay "fetch de bundle por identidad" que filtre nada.
- Colas rotan; credencial de notificación separada por cola.

**Lección:** se elimina la fuga del directorio **llevando el material de conexión
en el link OOB** y usando aislamiento por-par en vez de un buzón por-usuario.

### Dónde queda AegisLink
El mailbox rotatorio (Slices 1-3) es un **buzón por-usuario, rotatorio** — más
privado que "indexar por aegisId" (Session) pero menos aislado que las colas
por-par (SimpleX). El residuo que nos queda y que **ninguno de los dos tiene en
esta forma** es el **directorio de prekeys por aegisId** en el primer contacto.

## 3. Opciones

**A — Socket mailbox dedicado SOLO entrega; control-plane sigue en socket aegisId.**
Conexión mailbox aparte para `envelope:mb`; el socket aegisId actual queda intacto
para control. Coste mínimo, calza con el server de Slice 1, aterriza la victoria
real (el grafo de routing por mensaje deja de indexarse por aegisId). Residuo: el
relay ve el aegisId en el socket de control → relinkable por IP/tiempo… **salvo
que ese socket vaya por Tor** (ya soportado: `routeViaTor && ONION_URL`,
`client.ts:612`). A+Tor ≈ desacople IP↔identidad estilo Session.

**B — Un solo socket puro-mailbox; control-plane a HTTP firmado Ed25519.**
Ya existe el patrón (`POST /prekeys`, creds TURN firmadas, `ice.ts:92`). Topología
más limpia, pero **no** resuelve por sí mismo la fuga del directorio (el fetch de
prekeys sigue siendo por aegisId, solo que por HTTP) y Tor sigue siendo necesario
para el desacople de IP. El sobrecoste compra limpieza de topología, no una
postura de privacidad fundamentalmente mejor que A+Tor.

**C — Estilo SimpleX: matar el directorio en su raíz.**
Embeber el bundle de prekeys (o una dirección de cola de un solo uso) en el
QR/invite-link, de modo que el primer contacto **no consulte el directorio**.
Elimina la fuga residual de raíz. Cambio más grande: toca formato de QR,
onboarding y el bootstrap de X3DH. Es el endgame de privacidad real.

## 4. Recomendación (por fases)

**Objetivo final:** principio de C (minimizar/eliminar el directorio de identidad)
+ desacople IP de Session (Tor), sobre la entrega por mailbox rotatorio ya hecha.

1. **Slice 4 (ahora) → Opción A**, con un requisito duro: cuando `MAILBOX_MODE`
   esté ON, el socket de control **debe** ir por Tor (fail-closed si no hay
   `ONION_URL`), para no vender como "privado" el residuo relinkable. Da la
   victoria real del grafo de routing ya, con la superficie más pequeña, y es
   coherente con la filosofía de desacople-IP de Session. Flag OFF por defecto;
   validación end-to-end = test APK 2-dispositivos.
2. **Slice 4.5 / Fase 5 → evaluar C luego B.** Primero embeber el bundle en el
   QR/link (C) para matar el fetch de directorio en primer contacto; después,
   ya con control-only-Tor validado, mover el control-plane a HTTP firmado (B) si
   aporta.

## 5. Residuo honesto tras el camino recomendado

El relay verá: "el mailbox X está conectado desde un circuito Tor ahora" + de vez
en cuando "alguien pidió el bundle del aegisId Y por Tor". **No** hay grafo social
por routing de mensajes, **no** hay vínculo IP↔identidad. Es paridad con el
residuo que Session acepta; SimpleX es más fuerte solo porque no tiene directorio
— eso lo cierra el paso C de Slice 4.5.

## 6. Pregunta abierta para confirmar antes de implementar Slice 4

¿Validamos el camino por fases (A+Tor ahora → C → B)? ¿O priorizamos C primero
(QR con bundle) aunque retrase la primera prueba end-to-end, por cerrar la fuga
del directorio cuanto antes?
