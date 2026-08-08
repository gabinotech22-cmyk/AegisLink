# Wake de iOS con la app en segundo plano o cerrada

iOS **no permite** un foreground service como Android: para avisar con la app
minimizada o matada hace falta un push que la despierte. Este documento traza qué
está activo, con qué evidencia, y qué falta.

## Estado

| Pieza | Estado | Evidencia |
|---|---|---|
| Alerta de mensaje visible en iOS (app minimizada/matada) | ✅ HECHO | #378 + desplegado 2026-08-08 |
| Aviso de llamada visible en iOS (app minimizada/matada) | ✅ HECHO | #412 + `callWakePayload.test.ts` |
| Wake directo a APNs (sin salto por Expo) | ✅ HECHO | #386, activo en el relay desde 2026-08-08 |
| Clave APNs en el relay | ✅ HECHO | Key ID `CZWJ3VC29S`, validada contra `api.push.apple.com` |
| Timbre nativo con la app CERRADA (PushKit + CallKit) | 🟡 EN CURSO | `feat/ios-voip-pushkit` — falta build de device |

## El fallo que costó dos meses: `content-available`

En iOS, poner `_contentAvailable: true` **junto a una alerta visible** hace que el
sistema clasifique el push como notificación de *background*, sujeta al
presupuesto de background-refresh. Cuando ese presupuesto se agota, iOS descarta
la alerta **con él**: la app matada no recibe absolutamente nada.

Se arregló para mensajes en #378 y para llamadas en #412 — donde seguía vivo
porque se asumió que las llamadas son demasiado infrecuentes para agotar el
presupuesto. No lo son. Android **mantiene** el flag: su tarea headless de
reconexión depende del wake en background y FCM no aplica ese throttling.

**El código correcto llevaba semanas en `main` sin desplegar.** El relay corría un
commit del 25-jul. Antes de dar por roto el código del relay, comprobar siempre:

```bash
ssh root@aegislink.duckdns.org "cd /opt/aegislink && git log -1 --oneline"
```

## Configuración del relay (ya aplicada)

En `/etc/aegislink.env` de la VM (`/opt/aegislink/.env` es un symlink a él, ver
`docs/PROJECT-STRUCTURE.md` y la nota de deriva más abajo):

```
APNS_KEY_ID=<key id de la APNs Auth Key>
APNS_TEAM_ID=X2W7MRTDMJ
APNS_KEY_P8=<contenido del .p8 en UNA línea, con \n escapados>
APNS_BUNDLE_ID=com.aegislink.app
PUSH_MAILBOX_ENABLED=on
PUSH_MAILBOX_TOKEN_WAKE=on
```

`APNS_HOST` se deja **vacío** = producción (`api.push.apple.com`), correcto para
App Store y TestFlight. Solo se pone `sandbox` para builds con perfil de
desarrollo.

Tras editarlo: `cd /opt/aegislink && docker compose up -d --build relay`.

> ⚠️ **Deriva de `.env`.** Hubo dos ficheros de entorno casi idénticos
> (`/opt/aegislink/.env` y `/etc/aegislink.env`) que solo diferían en `TURN_HOST`.
> El contenedor corría con el de `/etc`, así que un `docker compose up` normal
> habría revertido el cutover de coturn y roto las llamadas. Quedaron unificados
> con un symlink el 2026-08-08; no volver a crear un `.env` independiente.

### Comprobar que la clave autentica, sin necesitar un dispositivo

Un POST a APNs con un token falso distingue los dos fallos posibles:
`400 BadDeviceToken` = la clave es **válida** (el JWT autenticó, solo el token es
falso). `403 InvalidProviderToken` = `KEY_ID`/`TEAM_ID`/`.p8` mal.

> Gotcha: el `.p8` viaja en el `.env` en una línea con `\n` literales y el código
> hace `.replace(/\\n/g,'\n')`. Un script de diagnóstico escrito con heredocs
> anidados **pierde ese escapado** y falla con `ERR_OSSL_UNSUPPORTED`, aparentando
> que la clave está corrupta. Construir la barra con `String.fromCharCode(92)`.

## PushKit (timbre con la app cerrada)

Un push de alerta muestra un banner; solo un **VoIP push** lanza la app matada y
permite reportar una llamada real del sistema.

`react-native-voip-push-notification` (3.3.3, aún la última) **no sirve**: emite
sus eventos por el bridge viejo de RN, que no existe bajo la New Architecture. El
callback del token moría con `doesNotRecognizeSelector` → SIGABRT ~2 s tras
arrancar (confirmado en iOS 16.7 desde un `.ips` real de TestFlight, PRs
#279/#280). Por eso VoIP quedó apagado.

La sustitución vive en `mobile/plugins/withIosVoip.js`, que inyecta
`AegisVoipPush.h/.m` en el target de la app (mismo patrón que
`withTorEmbeddedIOS.js`). Es estructuralmente inmune a aquel crash porque **nunca
emite un evento a JS**:

- el push entrante se reporta a CallKit **en nativo**, dentro del callback de
  PushKit — obligatorio por política de Apple, y lo único que puede funcionar con
  la app cerrada, porque JS todavía no existe;
- el token del dispositivo lo **pide** JS (`getToken()`), y se registra por el
  socket autenticado (`voip:register`), con el mismo patrón de reintento por ack
  que `push:register`.

Cero metadatos: el payload solo lleva un `callId` aleatorio y un `media`
`'audio'|'video'`, y las etiquetas de CallKit son constantes genéricas.

## Prueba en un iPhone REAL

1. Abre la app y espera unos segundos (registra los tokens contra el relay).
2. Comprueba en la VM que llegaron:
   ```bash
   docker exec aegislink-relay node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/aegislink.db',{readOnly:true});for(const t of ['apns_tokens','voip_tokens'])console.log(t, d.prepare('SELECT count(*) n FROM '+t).get().n)"
   ```
3. Mata la app por completo.
4. **Mensaje** → debe aparecer el banner sin abrir la app.
5. **Llamada** → con PushKit activo debe sonar la UI nativa de iOS.

## Notas

- `PUSH_MAILBOX_TOKEN_WAKE` es un **recorte de privacidad documentado** (un token
  estable puede re-enlazar epochs de mailbox, §7.3 de
  `FASE4-SLICE2B-PUSH-DESIGN.md`) — por eso es opt-in.
- **China:** la build 20 fue rechazada por Guideline 5 con CallKit activo; se
  resolvió quitando China continental del territorio en ASC. PushKit no cambia
  eso, pero lo consolida: no re-añadir China mientras CallKit siga activo.
