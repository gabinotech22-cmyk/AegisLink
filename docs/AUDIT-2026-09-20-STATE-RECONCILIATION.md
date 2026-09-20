# Auditoría 2026-09-20 — estado "a medias": se enciende por un camino y nadie lo apaga por el otro

> **Método:** código y tests como única fuente de verdad (regla de oro doc #6). Disparador: el
> badge del icono que nunca bajaba (#502) — un contador que solo se incrementaba. Se buscó **esa
> forma concreta** en mobile y desktop: estado escrito en un sitio y nunca reconciliado en el
> contrario, UI que existe en un lado y no en el otro, caches parciales que se toman por
> completas, y ajustes que no hacen nada. No es una auditoría de seguridad; es de coherencia.
>
> **Rama:** `fix/state-reconciliation-audit` (+ #502 para el badge). Estado vivo de cada punto
> en la tabla; lo pendiente son decisiones de producto, no código a medias.

## 1. Hallazgos

| # | Hallazgo | Impacto visible | Estado |
|---|---|---|---|
| R1 | **Badge del icono solo subía.** Se ponía a `no leídos + 1` al llegar una notificación y nunca se recalculaba. | El icono seguía marcando mensajes ya leídos. | ✅ #502 — `syncAppBadge()` = no leídos reales; en cada cambio de contadores, al volver a primer plano y al tocar el ajuste. `appBadge.test.ts` |
| R2 | **Caches parciales tomadas por historial** (mobile + desktop). Cualquier acción del store sobre un chat no cargado (`updateDelivery`, reacción, borrado remoto, `append`) creaba `byChat[chatId]` con lo poco que sabía, y `loadChat` se lo creía. Los grupos nunca se precargan; los 1:1 solo cuando Home monta. | Un grupo se abría **vacío** hasta reiniciar si antes llegó un receipt/reacción; un 1:1 mostraba **un solo mensaje** si el primero llegó en arranque frío (push → drenaje) antes de que Home precargara. | ✅ `loadedChats`: solo una carga real vale como cache; `clearChat` y el reset de identidad lo limpian. Tests mobile (+4) y desktop (`messages.reconcile.test.ts`) |
| R3 | **Previews de la lista tras borrar / caducar** (mobile + desktop). `refreshPreview` existía y **nadie lo llamaba**; `softDelete`/`remoteDelete`/`pruneExpired` tocaban `byChat` pero no `previews`. | "Eliminar para todos" o un efímero caducado dejaban su texto en la lista de chats hasta el siguiente mensaje o reinicio — fuga de contenido que el emisor creyó retirado. | ✅ Preview se marca `deleted` al borrar; `pruneExpired` refresca desde DB tras la purga; `lastMessageByChat` devuelve `deleted`/`type`/`expiresAt`; Home/Sidebar muestran "Mensaje eliminado". Tests (+3 mobile, +1 desktop) |
| R4 | **Notificaciones de la bandeja tras leer en la app** (mobile). Solo se descartaban al **tocarlas**; abrir el chat desde la lista las dejaba en la bandeja. | Notificaciones "fantasma" de mensajes ya leídos. | ✅ `dismissNotificationsForChat(chatId)` en `markRead`. `dismissForChat.test.ts` |
| R5 | **Estado de envío en grupos sin UI** (mobile). El outbox de grupo ya modelaba `pending`/`failed` por burbuja (#435) y la burbuja de grupo **no lo pintaba** ni ofrecía reintentar. | Un mensaje de grupo que el outbox abandonó parecía entregado a todos. | ✅ `GroupBubble` muestra "ENVIANDO…" / "NO ENVIADO · TOCA PARA REINTENTAR" en lugar de la hora; mantener pulsado → Reintentar (`retryFailedMessage`, re-fan-out) |
| R6 | **Resumen diario** (mobile, `notifSummary`, ON por defecto). Notificación local a las 19:30 con *nombres de contactos* aunque la vista previa esté apagada (default OFF); cuenta *recibidos*, no *no leídos*; en grupos muestra el id crudo; depende de `expo-background-fetch` (poco fiable en iOS). | Nombres de contactos en la pantalla de bloqueo contra la propia postura de privacidad; aviso de conversaciones ya leídas. | 🟡 **Decisión de producto pendiente.** Recomendación: quitarlo de 1.0.7 (ajuste + tarea). Alternativa: solo no leídos y sin nombres salvo vista previa ON. |
| R7 | **Pantalla de notificaciones del desktop es un stub.** Todos los toggles (`master`, `preview`, `sound`, `badge`, `summary`, keywords) son `useState` locales: no persisten ni gobiernan nada (comentario literal: `// Stub preferences`). | Ajustes que mienten. | 🟡 **Decisión de producto pendiente.** Recomendación: ocultar la pantalla en la beta hasta cablearla a preferencias reales (o cablear solo `master`/`sound`, que el desktop sí puede honrar). |
| R8 | **Cambiar icono de la app nunca funcionó** (mobile, ambas plataformas). `app.json` pasaba a `expo-alternate-app-icons` un objeto `{ icons: [...] }` cuando el plugin espera un **array** (hace `if (!props.length) return config` → no-op silencioso), nombres en minúscula (el plugin los pasa a PascalCase, así que JS pedía `light` y el SO solo conocía `Light`) y una **cadena** en `android` donde el generador desestructura `{ foregroundImage }`. Ningún alias de actividad ni set de iconos llegó jamás al binario. | "No se pudo cambiar el icono" en cada intento, desde la 1.0.0. | ✅ Config en la forma real (`Light`/`Tinted`, capa adaptativa transparente + `backgroundColor`), la pantalla mapea nombre nativo ↔ variante, `AppIcon.config.test.ts` fija la forma. Verificación real: APK/IPA nuevos. |
| R9 | **Apodo de contacto huérfano** (mobile + desktop). "Apodo (opcional)" al añadir se guardaba en el mismo campo que el nombre que el contacto **anuncia**; el primer `profile_update` lo pisaba y no existía sitio para verlo, editarlo o quitarlo. | El apodo desaparecía solo; incongruencia de UI señalada por el dueño. | ✅ Columna `contacts.nickname` (ADD COLUMN); `name` = apodo → nombre anunciado (`profileName`) → id; `setNickname`; fila "Apodo" en la ficha con editar/quitar; bajo el apodo se ve `~nombre anunciado` (modelo Signal). Tests store + DB + pantalla en mobile, store en desktop. |
| R10 | **Ficha de contacto desktop era un stub**: estado local no cableado al store y **huella digital falsa** (troceaba el base64 de la clave en vez de `fingerprintHex(sha256(key))`). | Comparar las palabras/hex de seguridad móvil↔desktop **nunca podía coincidir** — la verificación en desktop era teatro. | ✅ Contacto vivo del store; huella real (`crypto/fingerprint.ts`, la misma función que Verify). |
| R19 | **Exportar datos (GDPR) dejaba el historial en claro para siempre** (mobile): `aegis_export.json` se escribía en `documentDirectory` y nunca se borraba tras compartir — una copia sin cifrar de todo al lado de la DB SQLCipher. Además exportaba el **texto de mensajes borrados para todos**, el **cable de adjuntos con la clave del blob**, y **omitía los grupos**. En desktop el toggle "mensajes" exportaba `{}` siempre. | Cifrado at-rest anulado por la propia función de exportar; contenido retirado que reaparece; claves en un JSON. | ✅ `utils/dataExport.ts` (idéntico en ambas): borrados → sin texto, adjuntos → `[attachment omitted]`, grupos con `senderId`; mobile escribe en caché y borra en `finally` (también si compartir falla); desktop exporta mensajes reales. Tests `dataExport.test.ts` (ambas), `DataExport.file.test.tsx`. |

## 2. Qué se revisó y quedó bien

`pruneExpired` sí se ejecuta (intervalo en `App.tsx`); borrar contacto/grupo limpia `unreadCounts`/`previews`;
el indicador "escribiendo…" se autolimpia a 5 s en ambos transportes; `mutedUntil` se respeta al
notificar; las *keywords* de notificación están implementadas; borradores no reaparecen tras enviar.

## 3. Regla que sale de aquí

Todo estado derivado que se **muestra** (badges, previews, contadores, notificaciones presentadas)
se **recalcula desde la fuente** en cada cambio de esa fuente — nunca se incrementa/decrementa por
su cuenta — y toda cache tiene un marcador explícito de "cargada" antes de servirse como verdad.
