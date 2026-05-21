---
name: expo-native-security
description: Skill para la integración segura de APIs nativas en Expo SDK 54, incluyendo bloqueo de capturas de pantalla, almacenamiento seguro en SecureStore y sandboxing.
---

# Integración Segura de APIs Nativas en Expo SDK 54

Esta skill detalla las mejores prácticas para interactuar con las características de hardware y sistema operativo en dispositivos móviles de AegisLink, minimizando el riesgo de fugas accidentales de información.

## 1. Bloqueo de Captura de Pantalla Reactivo (`expo-screen-capture`)
AegisLink protege el contenido visual de la pantalla contra capturas de pantalla accidentales o maliciosas en Android e iOS.

### Implementación Correcta
```typescript
import { useEffect } from 'react';
import * as ScreenCapture from 'expo-screen-capture';

export function useScreenCaptureProtection(isEnabled: boolean) {
  useEffect(() => {
    let active = true;
    
    async function configureProtection() {
      try {
        if (isEnabled) {
          await ScreenCapture.preventScreenCaptureAsync();
        } else {
          await ScreenCapture.allowScreenCaptureAsync();
        }
      } catch (err) {
        // Fallback silencioso pero seguro
      }
    }
    
    configureProtection();
    
    return () => {
      active = false;
    };
  }, [isEnabled]);
}
```

---

## 2. Almacenamiento Criptográfico Nativo (`expo-secure-store`)
Las claves de identidad del usuario (`IdentityKeyPair`, `dhKeys`, `PIN`) **deben almacenarse exclusivamente** en las áreas de almacenamiento seguro provistas por el sistema operativo (Keychain en iOS, Keystore en Android).

### Reglas de Acceso Seguro
- **No persistir en SQLite**: SQLite está pensado únicamente para mensajes, contactos, salas y estados de ratchet serializados (sin clave secreta).
- **Usar accesibilidad de nivel de dispositivo**: Configurar el llavero para requerir desbloqueo del dispositivo para acceder a las claves maestras.
- **Formatear claves como cadenas Base64/Hexadecimal** antes de guardarlas en SecureStore, y parsearlas de forma segura en memoria de forma inmediata.

```typescript
import * as SecureStore from 'expo-secure-store';

export async function savePrivateKey(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
```

---

## 3. Borrado Físico y Trituración de Archivos Temporales
Los medios temporales (como fotos "Ver una vez" o archivos descargados en caché) no deben dejarse a merced de la recolección de basura del sistema operativo. Deben ser triturados inmediatamente después de su uso.

### Trituración mediante Eliminación del Sistema de Archivos
```typescript
import * as FileSystem from 'expo-file-system';

export async function shredLocalFile(fileUri: string): Promise<void> {
  try {
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (fileInfo.exists) {
      // Borrar físicamente el archivo del disco
      await FileSystem.deleteAsync(fileUri, { idempotent: true });
    }
  } catch (err) {
    // Manejar fallos de eliminación de archivos
  }
}
```
