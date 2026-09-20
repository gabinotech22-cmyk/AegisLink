# Auditoría 2026-09-20 — estado "a medias": se enciende por un camino y nadie lo apaga por el otro

> **Método:** código y tests como única fuente de verdad (regla de oro doc #6). Disparador: el
> badge del icono que nunca bajaba (#502) — un contador que solo se incrementaba. Se buscó **esa
> forma concreta** en mobile y desktop: estado escrito en un sitio y nunca reconciliado en el
> contrario, UI que existe en un lado y no en el otro, caches parciales que se toman por
> completas, y ajustes que no hacen nada. No es una auditoría de seguridad; es de coherencia.
>
> **Ramas:** `fix/state-reconciliation-audit` (§1), `feat/desktop-notification-prefs` (§1b), #502 (badge).
> Estado vivo de cada punto en las tablas.

## 1. Hallazgos

| # | Hallazgo | Impacto visible | Estado |
|---|---|---|---|
| R1 | **Badge del icono solo subía.** Se ponía a `no leídos + 1` al llegar una notificación y nunca se recalculaba. | El icono seguía marcando mensajes ya leídos. | ✅ #502 — `syncAppBadge()` = no leídos reales; en cada cambio de contadores, al volver a primer plano y al tocar el ajuste. `appBadge.test.ts` |
| R2 | **Caches parciales tomadas por historial** (mobile + desktop). Cualquier acción del store sobre un chat no cargado (`updateDelivery`, reacción, borrado remoto, `append`) creaba `byChat[chatId]` con lo poco que sabía, y `loadChat` se lo creía. Los grupos nunca se precargan; los 1:1 solo cuando Home monta. | Un grupo se abría **vacío** hasta reiniciar si antes llegó un receipt/reacción; un 1:1 mostraba **un solo mensaje** si el primero llegó en arranque frío (push → drenaje) antes de que Home precargara. | ✅ `loadedChats`: solo una carga real vale como cache; `clearChat` y el reset de identidad lo limpian. Tests mobile (+4) y desktop (`messages.reconcile.test.ts`) |
| R3 | **Previews de la lista tras borrar / caducar** (mobile + desktop). `refreshPreview` existía y **nadie lo llamaba**; `softDelete`/`remoteDelete`/`pruneExpired` tocaban `byChat` pero no `previews`. | "Eliminar para todos" o un efímero caducado dejaban su texto en la lista de chats hasta el siguiente mensaje o reinicio — fuga de contenido que el emisor creyó retirado. | ✅ Preview se marca `deleted` al borrar; `pruneExpired` refresca desde DB tras la purga; `lastMessageByChat` devuelve `deleted`/`type`/`expiresAt`; Home/Sidebar muestran "Mensaje eliminado". Tests (+3 mobile, +1 desktop) |
| R4 | **Notificaciones de la bandeja tras leer en la app** (mobile). Solo se descartaban al **tocarlas**; abrir el chat desde la lista las dejaba en la bandeja. | Notificaciones "fantasma" de mensajes ya leídos. | ✅ `dismissNotificationsForChat(chatId)` en `markRead`. `dismissForChat.test.ts` |
| R5 | **Estado de envío en grupos sin UI** (mobile). El outbox de grupo ya modelaba `pending`/`failed` por burbuja (#435) y la burbuja de grupo **no lo pintaba** ni ofrecía reintentar. | Un mensaje de grupo que el outbox abandonó parecía entregado a todos. | ✅ `GroupBubble` muestra "ENVIANDO…" / "NO ENVIADO · TOCA PARA REINTENTAR" en lugar de la hora; mantener pulsado → Reintentar (`retryFailedMessage`, re-fan-out) |
| R6 | **Resumen diario** (mobile, `notifSummary`, ON por defecto). Notificación local a las 19:30 con *nombres de contactos* aunque la vista previa esté apagada (default OFF); cuenta *recibidos*, no *no leídos*; en grupos muestra el id crudo; depende de `expo-background-fetch` (poco fiable en iOS). | Nombres de contactos en la pantalla de bloqueo contra la propia postura de privacidad; aviso de conversaciones ya leídas. | ✅ Decisión del dueño 2026-09-20: OFF por defecto y reconstruido — ver §1b |
| R7 | **Pantalla de notificaciones del desktop es un stub.** Todos los toggles (`master`, `preview`, `sound`, `badge`, `summary`, keywords) son `useState` locales: no persisten ni gobiernan nada (comentario literal: `// Stub preferences`). | Ajustes que mienten. | ✅ Decisión del dueño 2026-09-20: construido, no ocultado — ver §1b |

## 1b. Notificaciones — pasada específica (decisión del dueño: "cero huecos")

Cada sitio que emite una notificación (`scheduleNotificationAsync` en mobile; `notifications:show`
en desktop) contrastado con **cada** interruptor de la pantalla de notificaciones y con lo que llega a
la pantalla de bloqueo / al centro de notificaciones del sistema.

| # | Hallazgo | Impacto | Estado |
|---|---|---|---|
| N1 | Una **palabra clave** mostraba el **texto completo y el remitente** aunque "mostrar contenido" estuviera OFF (`showContent = preview \|\| keyword`). | El usuario que eligió no exponer contenido lo veía expuesto por una coincidencia. | ✅ La keyword salta el silencio/interruptor maestro, nunca el interruptor de contenido |
| N2 | Con contenido OFF, las notificaciones de **grupo** y de **canal** llevaban el **nombre del grupo/canal** en el título; el nombre del grupo viajaba además en los `data` de la notificación (legibles por apps con acceso a notificaciones, guardados en el historial de Android). | Qué grupos/canales tienes, en la pantalla de bloqueo. | ✅ Título genérico con contenido OFF; `data` solo con ids de enrutado |
| N5 | Con contenido ON, el cuerpo era el **texto de cable**: para un adjunto, `[image:blob:<id>:<clave>:<nonce>:<token>]` — **la clave de descifrado del blob** en el centro de notificaciones (mobile y desktop). | Material de clave fuera de la app (regla de oro de seguridad #2, extendida al SO). | ✅ El cuerpo es siempre la etiqueta humana (`previewLabel`, ahora también `[video:`/`[multi:`); desktop igual |
| N6 | **Llamada perdida** y **llamada de grupo activa** mostraban el nombre del contacto/grupo con contenido OFF. | Nombres en la pantalla de bloqueo. | ✅ Genérico con contenido OFF (el toque abre el chat). El banner de llamada *entrante* sigue mostrando quién llama: es necesario para decidir |
| N7 | El aviso de **nueva versión** ignoraba el interruptor maestro ("apaga todas las notificaciones"). | Ajuste que no cumple lo que dice. | ✅ Obedece al maestro |
| N8 | **Llamada perdida** ignoraba el maestro y el silencio del contacto. | Un contacto silenciado seguía notificando por llamada perdida. | ✅ Maestro + silenciado (lista y `mutedUntil`) |
| N9 | "**Solo menciones**" solo reaccionaba a palabras clave; una `@mención` real de tu nombre no notificaba. | Modo que no hace lo que su nombre promete. | ✅ Keyword **o** `@<tu nombre>` |
| N10 | **Desktop**: `append` sumaba no leídos aunque el chat estuviera en pantalla (mobile lo guardaba). | Badge y contador inflados con lo que estás leyendo. | ✅ Guardia de chat activo en desktop; `Chat`/`GroupChat` lo marcan |
| N11 | **Desktop**: al pulsar una notificación no se abría nada (`setNotificationOpenChatHandler` era un stub). | Notificación sin destino. | ✅ IPC `open-chat` con el id del chat (contactos y grupos); enfoca la ventana |
| N12 | **Desktop**: el badge del dock/barra no existía. | Sin señal de no leídos con la app en segundo plano. | ✅ `app.setBadgeCount` derivado de los contadores (0 con el ajuste OFF) |
| R6 | Resumen diario (ver §1). | | ✅ OFF por defecto; **no leídos**; nombres solo con contenido ON; misma lógica byte a byte mobile/desktop (`dailySummaryCore.ts`); mobile también lo comprueba en primer plano (el fetch en segundo plano es decisión del SO) |
| R7 | Pantalla de notificaciones del desktop (ver §1). | | ✅ Cableada a `store/preferences` (persistidas) y cada interruptor honrado en `notifications/push.ts` (`decideNotification`, puro y testeado); lista de silenciados real desde los contactos |

Relay: los pushes FCM/APNs/Expo siguen siendo **solo despertador** (`AegisLink` / `Nuevo mensaje
cifrado · E2EE`), sin remitente ni contenido — verificado en `server/src/push/*`.

Tests: mobile `contentPolicy.test.ts` (6), `dailySummaryCore.test.ts` (5), suites de notificaciones
existentes verdes; desktop `push.policy.test.ts` (8), `dailySummaryCore.test.ts` (5), suite completa.


## 2. Qué se revisó y quedó bien

`pruneExpired` sí se ejecuta (intervalo en `App.tsx`); borrar contacto/grupo limpia `unreadCounts`/`previews`;
el indicador "escribiendo…" se autolimpia a 5 s en ambos transportes; `mutedUntil` se respeta al
notificar; las *keywords* de notificación están implementadas; borradores no reaparecen tras enviar.

## 3. Regla que sale de aquí

Todo estado derivado que se **muestra** (badges, previews, contadores, notificaciones presentadas)
se **recalcula desde la fuente** en cada cambio de esa fuente — nunca se incrementa/decrementa por
su cuenta — y toda cache tiene un marcador explícito de "cargada" antes de servirse como verdad.
