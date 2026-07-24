# Activar el wake de iOS con la app cerrada (Problema B)

Reliability audit 2026-07-24. iOS **no permite** un foreground service como Android;
para entregar/avisar con la app **matada** hace falta un push que la despierte. Toda
la infraestructura ya está en el código — solo estaba **gateada off / mal cableada**.

## Ya hecho en código
- Cliente: `EXPO_PUBLIC_MAILBOX_IOS_WAKE=on` en el perfil **production** de `mobile/eas.json`.
- Server: `push/apns-voip.ts` (VoIP push = wake de **llamadas** con app matada),
  `push/ntfy.ts` token-wake (wake de **mensajes**), handler `mailbox:push:token`,
  plugin `mobile/plugins/withIosVoip.js` (PushKit).
- **FIX (esta rama):** `docker-compose.yml` ahora pasa `APNS_KEY_P8` al contenedor
  del relay. Faltaba, así que la key nunca llegaba y el VoIP wake NO podía funcionar.

## Lo que configuras TÚ (VM del relay + build)

### 1. Consigue la clave APNs (.p8)
De la cuenta **`aegislinkspejo3`** (la que tiene la APNs key válida — ver nota de
memoria). Exporta el `.p8`, anota el **Key ID** y el **Team ID** (`X2W7MRTDMJ`).

### 2. Añade al env del relay (`/etc/aegislink.env` en la VM)
```
APNS_KEY_ID=<tu key id>
APNS_TEAM_ID=X2W7MRTDMJ
APNS_KEY_P8=<contenido del .p8; una sola línea con \n, o multilínea>
APNS_BUNDLE_ID=com.aegislink.app
PUSH_MAILBOX_ENABLED=on
PUSH_MAILBOX_TOKEN_WAKE=on
```

### 3. Redeploya el relay (re-lee compose + env)
```
cd /ruta/a/aegislink && docker compose up -d relay
```

### 4. Build iOS production (el flag ya está on) → TestFlight/instala

### 5. Prueba en un iPhone REAL
- Mata la app por completo.
- Desde otro dispositivo: manda un mensaje **y** haz una llamada.
- **Llamada** → debe sonar (VoIP/CallKit) — es el wake más fiable con app matada.
- **Mensaje** → debe despertar/notificar.

## Caveats honestos
- El **VoIP push (llamadas)** es el wake fiable de app-matada en iOS (via CallKit).
  Requiere el entitlement PushKit (lo aporta `withIosVoip.js`).
- El **wake de mensajes** vía token Expo/APNs: un push de alerta normal muestra la
  notificación, pero iOS es estricto para *ejecutar código* en una app force-killed.
  Verifica en device si además de notificar drena los mensajes al despertar.
- `PUSH_MAILBOX_TOKEN_WAKE` es un **reduct de privacidad documentado** (un token
  estable puede re-enlazar epochs de mailbox, §7.3) — por eso es opt-in.
