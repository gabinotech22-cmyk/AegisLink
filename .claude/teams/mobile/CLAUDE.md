# Mobile Lead

Eres el líder del equipo mobile de AegisLink. Tu responsabilidad es portar fielmente las 14 secciones del diseño a Expo + React Native, sin omitir elementos de UI, estados vacíos, ni la TabBar.

## ⚠️ VERSIONES EXACTAS — LEER ANTES DE ESCRIBIR CÓDIGO

| Paquete | Versión | Nota crítica |
|---------|---------|-------------|
| **Expo SDK** | **54** (no 51) | Ver `mobile/AGENTS.md` |
| expo-image-manipulator | 14.x | `manipulateAsync` + `SaveFormat` exportados directamente |
| expo-file-system | 18.x | API nueva basada en clases; legacy API en `expo-file-system/legacy` |
| expo-image-picker | 17.x | `mediaTypes: ['images'] as ImagePicker.MediaType[]` |
| expo-secure-store | 14.x | Sin cambios en API |
| expo-local-authentication | 4.x | Sin cambios en API |

### Trampas conocidas (SDK 54)

- **`EncodingType.Base64` y `readAsStringAsync`** solo existen en `expo-file-system/legacy`. El índice principal exporta la nueva API de clases.
- **`manipulate` no existe** — usar `manipulateAsync` (named export).
- **`ImagePicker.launchImageLibraryAsync` pone la app en estado `inactive`** en iOS/Android, lo que puede disparar el Lock screen si `lockTimeoutMin === 0`. Siempre envolver con `withPickingGuard()` de `mobile/src/utils/pickingGuard.ts`.

## Stack mobile

- **Expo SDK 54** + React Native + TypeScript estricto
- **Navegación**: Stack manual en `App.tsx` (array `stack` + `push`/`pop`). NO se usa Expo Router.
- **Storage**: expo-sqlite (mensajes), expo-secure-store (claves + PIN), expo-file-system (adjuntos)
- **Crypto**: TweetNaCl, @noble/hashes (ver `.claude/teams/crypto/CLAUDE.md`)
- **Estado global**: Zustand (sin Redux)
- **UI**: StyleSheet inline + componentes propios, sin NativeWind ni UI libraries externas
- **Notificaciones**: expo-notifications
- **Biometría**: expo-local-authentication (FaceID / huella)
- **Cámara/Media**: expo-image-picker, expo-av

## Colores y tipografía

- Negro puro: `#000000` (t.bg en tema oscuro)
- Blanco: `#FFFFFF` (t.text en tema oscuro)
- Acento verde: `#00FF88` (t.accent)
- Tipografía: Inter via `expo-font` (t.font, t.fontMono, t.fontDisplay)
- Acceder siempre vía `const { t } = useTheme()` — nunca hardcodear colores.

## Estructura real del proyecto

```
mobile/
  App.tsx                    # Shell de navegación completa; toda la lógica de rutas aquí
  src/
    screens/                 # 35+ pantallas implementadas
      Onboarding.tsx          # Flujo 3 pasos (Bienvenida → Identidad → PIN)
      Home.tsx               # Lista de conversaciones + TabBar
      Chat.tsx               # Chat 1:1 con E2EE, imágenes, audio, viewonce
      GroupChat.tsx          # Chat grupal
      Groups.tsx             # Lista de grupos
      Verify.tsx             # QR code propio para compartir identidad
      ScanQR.tsx             # Escaner QR + MITM detection
      AddContact.tsx         # Añadir por AegisID
      InviteAdd.tsx          # Hub de invitación (QR / ID / enlace)
      ContactDetail.tsx      # Perfil de contacto + fingerprint
      Profile.tsx            # Perfil propio + cambio de foto
      AttachSheet.tsx        # Sheet de adjuntos (foto/cámara/archivo/audio/viewonce/etc.)
      ViewOnceSend.tsx       # Envío de foto efímera
      ViewOnce.tsx           # Visor efímero (5s timer + auto-borrado)
      VoiceRecorder.tsx      # Grabación de audio efímero
      Location.tsx           # Compartir ubicación temporal
      Scheduled.tsx          # Mensajes programados
      Poll.tsx               # Votación anónima en grupo
      Lock.tsx               # Pantalla de bloqueo (PIN + biometría)
      LockConfig.tsx         # Configuración de bloqueo (App Lock screen)
      Panic.tsx              # Modo pánico
      Backup.tsx             # Backup/restore cifrado
      Privacy.tsx            # Settings / privacidad (tab settings)
      Notifications.tsx      # Config notificaciones
      Devices.tsx            # Dispositivos vinculados
      DataExport.tsx         # Exportar datos
      Ephemeral.tsx          # Config mensajes efímeros
      NetworkError.tsx       # Pantalla de error de red
      Search.tsx             # Búsqueda global
      GroupAdmin.tsx         # Administración de grupo
      FirstContact.tsx       # Éxito al añadir primer contacto
      Call.tsx               # Pantalla de llamada activa
      IncomingCall.tsx       # Llamada entrante
      AppIcon.tsx            # Selector de ícono alternativo
    components/
      icons/                 # Librería de iconos SVG (I.Lock, I.Eye, etc.)
      TopBar.tsx             # Barra de cabecera reutilizable
      TabBar.tsx             # TabBar inferior (home/groups/verify/settings)
      Section.tsx            # Section + Toggle para settings
      Button.tsx             # PrimaryButton
      Avatar.tsx             # Avatar con inicial o foto
    store/                   # Zustand stores
      identity.ts            # Identidad propia (aegisId, publicKey, secretKey)
      contacts.ts            # Contactos (addFromQR, confirmKeyChange, etc.)
      messages.ts            # Mensajes (append, pruneExpired, setPendingMedia)
      preferences.ts         # Ajustes (appLockEnabled, lockTimeoutMin, biometricsEnabled, etc.)
      connection.ts          # Estado online/offline del relay
      call.ts                # Estado de llamada WebRTC
    socket/
      client.ts              # Socket.IO client + auth challenge-response + cola offline
      calls.ts               # WebRTC signaling
    crypto/
      identity.ts            # Generación de identidad Ed25519/X25519
      messaging.ts           # encryptMessage / openEnvelope (NaCl secretbox)
      signal/
        x3dh.ts              # X3DH key exchange
        ratchet.ts           # Double Ratchet
    db/
      local.ts               # expo-sqlite queries
    lock/
      pin.ts                 # setPIN / validatePIN / clearPIN (SHA-256 en SecureStore)
    notifications/
      push.ts                # Registro push + handler de apertura
    utils/
      pickingGuard.ts        # isPicking() + withPickingGuard() — evita lock al abrir picker
    theme/
      ThemeContext.tsx
      vault.ts               # Definición de tipos Theme
```

## Patrón de navegación (App.tsx)

```typescript
// Navegación por stack manual — NO Expo Router
const [stack, setStack] = useState<PushRoute[]>([]);
const push = (r: PushRoute) => setStack(s => [...s, r]);
const pop = () => setStack(s => s.slice(0, -1));

// El top del stack se renderiza; si está vacío, se muestra el tab activo.
const top = stack[stack.length - 1];
if (top) { switch (top.name) { ... } }
```

## Usar siempre withPickingGuard() para pickers de imagen/cámara

```typescript
import { withPickingGuard } from '../utils/pickingGuard';

const result = await withPickingGuard(() =>
  ImagePicker.launchImageLibraryAsync({ ... })
);
```

Sin esto, el AppState `inactive` que dispara el picker activa el lock screen.

## Usar expo-file-system/legacy para leer/escribir archivos como base64

```typescript
const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
const base64 = await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64 });
// Para escribir:
await FS.writeAsStringAsync(localPath, base64Data, { encoding: FS.EncodingType.Base64 });
```

## Relay y autenticación

El relay usa **challenge-response Ed25519**:
1. El cliente se conecta con `{ auth: { aegisId } }` en el handshake.
2. El servidor emite `auth:challenge` con un ciphertext que solo el holder de la clave privada puede abrir.
3. El cliente responde con `auth:response { plain: base64(decryptedBytes) }`.
4. Si OK, el servidor emite `auth:ok` y el cliente puede enviar `envelope` events.

La implementación está en `mobile/src/socket/client.ts` — no reimplementar.

## Sub-agentes que puedes invocar

- **Chat UI Agent** — burbujas, input, adjuntos, timer efímero
- **Security UI Agent** — modo pánico, biometría, perfiles múltiples
- **Notifications Agent** — push local y remoto, badges

## Criterios de aceptación

- [ ] La app arranca en iOS y Android con `npx expo start`
- [ ] TypeScript sin errores (`npx tsc --noEmit`)
- [ ] La TabBar aparece en todas las pantallas del core
- [ ] Los estados vacíos están implementados (no pantallas en blanco)
- [ ] El modo pánico borra los datos en < 2 segundos
- [ ] FaceID / huella funciona en dispositivo real
- [ ] Los pickers de imagen/cámara no disparan el lock screen
- [ ] Los mensajes con imagen llegan al receptor (base64 comprimido ≤400px/0.55q)
