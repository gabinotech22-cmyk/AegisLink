# AegisLink — Test Blueprint

Lista de verificación end-to-end por fase. Cuando todas las fases estén construidas, ejecuta este blueprint en orden. Cada sección es independiente: si una falla, no bloquea el resto, pero anótalo para resolver.

## Setup one-time

1. **Wi-Fi**: PC + ambos teléfonos en la misma red. PC IP actual: `192.168.1.4` (cambia en `mobile/.env` si tu IP cambia).
2. **Firewall Windows**: permitir Node.js en redes privadas (puerto 3001). Primera vez `npm run dev` lo pedirá.
3. **Expo Go**: instalado en iPhone (App Store) y Android (Play Store).
4. **Terminales**:
   ```bash
   # Terminal A
   cd c:/Users/starl/Desktop/AegisLink/server
   npm run dev
   # → "listening on http://0.0.0.0:3001"

   # Terminal B (después de que el server esté arriba)
   cd c:/Users/starl/Desktop/AegisLink/mobile
   npm run start
   # → muestra QR + URL en LAN
   ```
5. **Conectar teléfonos a Expo**:
   - iPhone: Cámara → apunta al QR → "Open in Expo Go"
   - Android: Expo Go app → "Scan QR code"

> [!IMPORTANT]
> A partir de Fase 3c (WebRTC) Expo Go **deja de funcionar**. Necesitarás `eas build --profile development` para generar un dev client custom una vez por teléfono. Está detallado en la sección 3c.

---

## ✅ Fase 1 — Identidad real on-device

**Objetivo**: el teléfono genera una clave Curve25519 real, deriva un Aegis ID válido, y la persiste de manera segura.

| Check | Esperado | Mira |
|---|---|---|
| Tap "Generate my identity" en welcome | Spinner 1.4s mínimo, luego pantalla "show identity" | — |
| Aegis ID formato | `XXX-XXXX-XXXX` con chars Crockford (sin I/L/O/U) | Visualmente |
| Fingerprint hex | 8 grupos de 4 hex chars, no vacíos | Visualmente |
| Icono copy → portapapeles | Pega en cualquier app y debe estar tu Aegis ID | — |
| Tap "Enter AegisLink" → Home | Home muestra mismo Aegis ID en la pill superior | — |
| Cierra app, abre de nuevo | Salta directo a Home, NO a welcome (identidad persistió) | — |
| Reset identity → confirma | Vuelve a welcome, IndexedDB limpia | — |

**Pruebas de seguridad**:
- La `secretKey` debe estar en Keychain (iOS) / Keystore (Android) — NO en SQLite. Comprobable solo en debug build, no en Expo Go.

---

## ✅ Fase 2 — Mensajería E2EE entre dos teléfonos

**Objetivo**: A escribe, B recibe descifrado. Server nunca ve plaintext.

**Pre-req**: Fase 1 ✅ en ambos teléfonos.

| # | Acción | Esperado |
|---|---|---|
| 1 | Phone A: genera identidad → copia Aegis ID | — |
| 2 | Phone B: genera identidad propia | — |
| 3 | Phone B: tap `+` arriba → pega Aegis ID de A → "Add contact" | Aparece chat con A en la lista Home |
| 4 | Phone B: abre chat de A → escribe "hola desde B" → enviar | Mensaje aparece en burbuja propia (verde, derecha) inmediatamente |
| 5 | Phone A: debe aparecer notificación inline. Si A no había agregado a B, el chat se crea automáticamente al recibir el primer mensaje | Mensaje "hola desde B" aparece en burbuja entrante (gris, izquierda) en <1s |
| 6 | Phone A responde → Phone B recibe | Reverse direction works |
| 7 | Logs del server (Terminal A) durante esto | `[relay] XXX-XXXX-XXXX connected` por cada teléfono; **NO** se imprime plaintext en ningún log |
| 8 | Wireshark/HTTP toolkit (opcional) — capturar tráfico entre teléfono y PC | Solo bytes base64 opacos. Si no eres developer y no haces esto, está OK saltarlo. |

**Offline queue**:
| # | Acción | Esperado |
|---|---|---|
| 9 | Phone A: cierra la app (fuerza-quit, no solo background) | Logs server: `[relay] XXX disconnected` |
| 10 | Phone B: envía 3 mensajes a A | Server logs muestran 3 enqueues sin delivery |
| 11 | Phone A: abre la app | Los 3 mensajes aparecen en chat inmediatamente, server logs: `[relay] drained 3 pending` |

---

> Las fases siguientes se completan a medida que se construyen. Por ahora son placeholders.

## ✅ Fase 3a — Auth real + sealed sender

**Objetivo**:
- El server **autentica** que el socket pertenece al dueño de la `secretKey` registrada para el `aegisId` declarado (no solo confiar en el handshake).
- El wire envelope **no incluye `from`** — el server no puede mapear who→who desde un paquete único.
- El recipient hace **trial decrypt** contra cada contacto hasta que MAC valide.

**Pre-req**: Fase 1 + 2 ✅.

| # | Acción | Esperado |
|---|---|---|
| 1 | Phone A: abre la app | Logs server: `[relay] auth challenge issued` (en dev). Después: `[relay] XXX-XXXX-XXXX authenticated` |
| 2 | Envía mensaje A→B | Server logs el envelope SIN `from` field. Mirar con `console.log` o devtools — solo `{id, to, ciphertext, nonce}` |
| 3 | B recibe y descifra OK | Aparece en chat. Logs mobile: `[socket] authenticated as YYY-YYYY-YYYY` |
| 4 | Cambia el `secretKey` localmente (hack: borra `expo-secure-store` con app reset, regenera identidad, no la re-publiques al server) | Al reconectar, server emite `auth_failed`, socket se desconecta. App muestra el chat pero sin recibir nada nuevo. |
| 5 | Identidad NO registrada al server (cuando server estaba caído al generar) | Reconecta cuando server vuelve: `error_msg: unknown_identity`. App re-registra automáticamente via `publishToServer` al hidratar. |

**Manual seguridad**:
- En el log del server NO debe aparecer plaintext ni el `from` field. Si lo ves, hay una regresión.

---

## ✅ Fase 3b — Verification + QR + MITM detection

**Objetivo**: dos peers verifican fuera-de-banda que tienen la pubkey correcta, así un MITM en el directorio se detecta visualmente.

**Pre-req**: Fase 3a ✅.

| # | Acción | Esperado |
|---|---|---|
| 1 | Phone A: en Home, tap la pill superior del Aegis ID | Abre pantalla **Verify** con QR + 8 palabras + fingerprint hex |
| 2 | Phone B: tap `+` → "Scan QR code" → pide permiso de cámara | Permiso concedido la 1ra vez, después abre cámara |
| 3 | Phone B: apunta cámara al QR de A | Contacto se agrega como **verified** automáticamente, abre chat con A |
| 4 | Phone A: tap `+` → "Scan QR code" → apunta al QR de B | Idem reverse |
| 5 | En Home, mira las filas de contactos | A muestra ✓ verde al lado del nombre (verified) |
| 6 | Abre chat con un contacto verificado | Header dice "E2E · VERIFIED" en verde |
| 7 | Abre chat con un contacto agregado solo por Aegis ID (sin QR) | Header dice "E2E · NOT VERIFIED" en amarillo |

**MITM simulation**:
| # | Acción | Esperado |
|---|---|---|
| 8 | Manualmente en el server, modifica la pubkey de A en la tabla `identities` para que sea otra distinta | Server publishes wrong key |
| 9 | Phone B: hace "Add by Aegis ID" de A (no QR) | El contacto se guarda con la pubkey errónea. Cualquier mensaje cifrado por A no podrá descifrarse. |
| 10 | Phone B: ahora escanea el QR real de A | La store detecta el cambio → muestra Alert "Key changed for this contact" + reemplaza con la pubkey correcta + verified=true |
| 11 | Re-envía mensaje A→B | Descifra OK porque ya está la pubkey real |

**Manual**:
- La pantalla Verify tiene un botón "Scan a peer's QR" para verificar bidireccional sin volver al Home.

---

## 🛠️ Setup de Dev Client (necesario para 3c, 3d, 3e)

Desde Fase 3c en adelante Expo Go NO funciona — `react-native-webrtc` y push completo requieren un build nativo custom. Lo hacemos vía **EAS Build** (cloud, gratis, sin Mac).

### Una vez:

```bash
# Instala EAS CLI globalmente
npm install -g eas-cli

# Crea cuenta gratuita en https://expo.dev (o login si ya tienes)
cd c:/Users/starl/Desktop/AegisLink/mobile
eas login          # email + password de Expo

# Vincula este proyecto (asigna projectId y lo guarda en app.json)
eas init
# Acepta el slug "aegislink" o cambia
```

### Build del dev client por plataforma

**Android** (funciona sin cuenta Apple):
```bash
eas build --profile development --platform android
# ~10 min en cloud. Te da un link de descarga del APK.
# En tu Android: abre el link, instala APK (permite "fuentes desconocidas")
```

**iOS** (requiere Apple Developer account $99/año + Apple ID en el teléfono):
```bash
eas build --profile development --platform ios
# Pregunta credentials la 1ra vez. Si no tienes Apple Dev:
# - EAS puede pedir un Apple ID gratuito para signing ad-hoc (limitado a 7 días)
# - Mejor: pausar iOS hasta que tengas Apple Developer
```

> [!IMPORTANT]
> Sin Apple Developer account NO puedes instalar el dev client en iPhone para más de 7 días seguidos. Recomendación: validar 3c/3d/3e en Android primero (Android ↔ Android), después comprar Apple Dev y validar iPhone.

### Después del build:

```bash
# El servidor de Expo (Metro bundler) sigue siendo el mismo
cd c:/Users/starl/Desktop/AegisLink/mobile
npm run start
# Abre el dev client APK/IPA en el teléfono (ya no Expo Go)
# Conecta automáticamente al Metro y carga el JS
```

---

## ✅ Fase 3c — WebRTC voice

**Objetivo**: dos teléfonos hacen una llamada de voz E2EE (DTLS-SRTP). Signaling via Socket.IO, media P2P (o relayed via TURN si NAT falla).

**Pre-req**: 3a + 3b ✅. Dev clients instalados en ambos teléfonos.

**Setup adicional**:
- STUN: público (Google) por default — funciona en NATs cooperativos
- TURN: opcional pero necesario en NATs simétricos (~20% redes celulares). Sin TURN, ciertas llamadas fallarán al conectar. Para dev local LAN normalmente funciona sin TURN.

| # | Acción | Esperado |
|---|---|---|
| 1 | Phone A: en chat con B, tap el icono ☎ del header | App pide permiso de mic la 1ra vez. UI cambia a Call screen ("CALLING…") |
| 2 | Phone B: notificación de llamada entrante con accept/decline | Aparece overlay con "INCOMING · E2EE" |
| 3 | Phone B: tap "Accept" | Pide permiso mic. UI dice "CONNECTING…" en ambos |
| 4 | Ambos: 1-5s después | UI dice "IN-CALL · 00:00" y empieza a contar |
| 5 | Hablen | Se oyen mutuamente con baja latencia |
| 6 | Phone A: tap "Mute" | Phone B deja de oír a A. Reactivar revierte. |
| 7 | Phone A: tap "End" | Ambos UIs cierran y vuelven a chat |

**Manual seguridad / red**:
- Server logs: `[relay]` muestra `call:invite`, `call:answer`, `call:ice` forward events. **NUNCA** muestran SDP en plaintext en logs (el plaintext es el SDP entre los teléfonos — el server lo forwardea sin parsear).
- Wireshark/devtools: el tráfico de voz pasa por UDP P2P (o por TURN si configuraste). Es DTLS — bytes opacos.

**Edge cases**:
| Síntoma | Causa | Acción |
|---|---|---|
| Llamada nunca conecta (queda en "CONNECTING") | NAT simétrico, sin TURN | Deploy coturn y setea `EXPO_PUBLIC_TURN_URL` en `mobile/.env` |
| Permiso mic denegado | Settings del teléfono | Settings → AegisLink → Microphone |
| App crashea al tap "Call" | `react-native-webrtc` no está en el build | Estás corriendo Expo Go en vez del dev client. Build con EAS. |

---

## ✅ Fase 3d — WebRTC video

**Objetivo**: misma llamada pero con video local + remoto.

**Pre-req**: 3c funciona ✅.

| # | Acción | Esperado |
|---|---|---|
| 1 | Phone A: en chat, tap el icono 📷 (segundo) | Pide permisos mic + cámara. UI Call screen muestra preview local arriba-derecha |
| 2 | Phone B: incoming call screen | Igual a 3c pero "video" en metadata. Tap Accept. |
| 3 | Conectados | Phone A ve el video de B en fullscreen; el suyo aparece pequeño top-right. Phone B simétrico. |
| 4 | Phone A: tap "Camera off" | Su video local se pausa (tile en negro en lado de B); audio sigue. Reactivar revierte. |
| 5 | Tap "End" en cualquiera | Cierra ambos |

**Manual**:
- Verifica que ambas cámaras se enciendan y apaguen sin reiniciar la llamada.
- Verifica que en modo Camera-off solo el video se corta — audio sigue.

---

## ✅ Fase 3e — Push notifications (silent wake-up)

**Objetivo**: cuando A envía un mensaje a B y B no está conectado, el server le pinga vía FCM/APNs (relayed por Expo) para que B reconecte y baje el mensaje. **El push NO transmite plaintext** — solo dice "wake up".

**Pre-req**: Dev client instalado (Expo Go tiene push limitado).

| # | Acción | Esperado |
|---|---|---|
| 1 | Phone B: abre la app por primera vez | iOS/Android pide permiso de notificaciones. Permite. |
| 2 | Phone B: en logs (terminal Expo) | `[push] registered for wake-ups as YYY-YYYY-YYYY` |
| 3 | Server: revisa tabla `push_tokens` (`sqlite3 server/data/aegislink.db "SELECT * FROM push_tokens"`) | Una fila con el aegisId de B + un ExponentPushToken[…] string |
| 4 | Phone B: cierra la app (force-quit) | Logs server: `[relay] YYY disconnected` |
| 5 | Phone A: envía un mensaje a B | Server logs: enqueue + `void notifyRecipient(B)` |
| 6 | Phone B: en background, recibe push silencioso | Sin banner visible (es silencioso). El sistema operativo despierta brevemente la app. |
| 7 | Phone B: abre la app | El mensaje de A está ahí inmediatamente (drained on reconnect) |

**Manual seguridad**:
- Inspecciona el payload del push (Expo Push Tool: https://expo.dev/notifications) — debe contener solo `{kind: "wakeup", aegisId, at}`. NUNCA plaintext, NUNCA el ciphertext.
- Probar que un mensaje a un destinatario CONECTADO **no** dispara push (delivery directa por socket).

---

## Recap de seguridad post-Fase 3

| Pieza | Estado |
|---|---|
| E2EE Curve25519 + XSalsa20-Poly1305 | ✅ TweetNaCl |
| Sealed sender (server no ve `from`) | ✅ Fase 3a |
| Server auth con challenge/response | ✅ Fase 3a |
| Verification out-of-band con QR + 8 palabras | ✅ Fase 3b |
| MITM detection (key cambió) | ✅ Fase 3b |
| Llamadas E2EE (DTLS-SRTP) | ✅ Fase 3c/3d |
| Push sin plaintext (wake-up only) | ✅ Fase 3e |
| Clave privada en Keychain/Keystore | ✅ Fase 1 |
| Postquantum-safe | ❌ Fase 5+ (Kyber/ML-KEM) |
| Sealed call signaling | ❌ Fase 4+ |
| At-rest encryption de SQLite local | ❌ Fase 4 (SQLCipher) |
| Forward secrecy per-message (Double Ratchet) | ❌ Fase 5+ |

---

## Troubleshooting general

| Síntoma | Causa probable | Acción |
|---|---|---|
| "Network request failed" en mobile | Firewall Windows bloqueando 3001 | Configuración Windows → Firewall → permitir Node.js en redes privadas |
| Phones no se ven con el server | IP de PC cambió | `ipconfig` en PC, actualiza `mobile/.env`, reinicia `npm run start` |
| Expo Go crashea al abrir el QR | Cache stale | En Expo: tecla `r` para recargar, o `npx expo start -c` |
| "ID format invalid" al agregar contacto | Pegaste con espacios o lowercase | Auto-uppercase está activo. Verifica que pegaste 11 chars + 2 guiones |
| Mensajes llegan tarde | Conexión Wi-Fi inestable o socket reconectando | Mira logs server: `[socket] disconnected`. Reconecta solo. |
| Decryption failed in console | Pubkey del contacto cambió o MITM | Fase 3b detectará esto automáticamente |
