---
name: react-native-performance
description: Guía de optimización de rendimiento React Native / Expo 54 para AegisLink — FPS, TTI, tamaño de bundle, memory leaks y animaciones. Aplica cuando haya jank en listas, lag en TextInput, arranque lento o consumo excesivo de memoria.
source: https://github.com/callstackincubator/agent-skills (MIT, Callstack)
---

# React Native Performance — AegisLink

> Basado en el skill oficial de Callstack: "The Ultimate Guide to React Native Optimization"

## Regla de oro: Medir → Optimizar → Re-medir → Validar

Nunca optimizar sin métricas de baseline. Captura FPS, TTI o tamaño de bundle **antes** de cualquier cambio.

---

## 1. FPS y Re-renders (CRÍTICO)

### Herramienta
```bash
# Abrir React Native DevTools
# Metro: presiona 'j' | Dispositivo: agitar → "Open DevTools"
```

### Patrones correctos

```typescript
// ❌ MAL — ScrollView para listas largas (mensajes del chat)
<ScrollView>
  {messages.map(m => <MessageBubble key={m.id} {...m} />)}
</ScrollView>

// ✅ BIEN — FlashList (Shopify) para el chat de AegisLink
import { FlashList } from '@shopify/flash-list';
<FlashList
  data={messages}
  renderItem={({ item }) => <MessageBubble {...item} />}
  estimatedItemSize={72}
  inverted
  keyExtractor={m => m.id}
/>
```

```typescript
// ❌ MAL — estado global monolítico causa re-renders en cascada
const { messages, profile, calls, panic } = useStore();

// ✅ BIEN — estado atómico con Zustand/Jotai
import { useAtom } from 'jotai';
const [messages] = useAtom(messagesAtom); // solo re-renderiza cuando messages cambia
```

### Memoización con React Compiler (Expo SDK 54+)
```typescript
// babel.config.js — habilitar React Compiler
module.exports = {
  presets: ['babel-preset-expo'],
  plugins: [['babel-plugin-react-compiler', {}]],
};
// El compiler aplica memo/useCallback automáticamente — no hacerlo a mano
```

---

## 2. Bundle Size (CRÍTICO)

### Analizar bundle
```bash
cd mobile
npx react-native bundle \
  --entry-file index.js \
  --bundle-output /tmp/bundle.js \
  --platform ios --dev false --minify true

npx source-map-explorer /tmp/bundle.js
```

### Evitar barrel imports
```typescript
// ❌ MAL — importa TODO el módulo aunque solo uses una función
import { encrypt, decrypt, hash } from '@/crypto';

// ✅ BIEN — import directo al archivo fuente
import { encrypt } from '@/crypto/encrypt';
import { decrypt } from '@/crypto/decrypt';
```

### Tree shaking en Expo SDK 52+
```json
// app.json — activar tree shaking
{
  "expo": {
    "experiments": { "treeShaking": true }
  }
}
```

---

## 3. TTI — Tiempo hasta Interacción (ALTO)

```typescript
// Medir cold start con react-native-performance
import { performance } from 'react-native-performance';

// En el componente raíz
useEffect(() => {
  performance.mark('app_interactive');
  performance.measure('tti', 'nativeLaunchStart', 'app_interactive');
}, []);
```

**Fix de mayor impacto:** Deshabilitar compresión del bundle JS en Android (permite mmap de Hermes):
```json
// app.json
{
  "expo": {
    "android": { "jsEngine": "hermes" }
  }
}
```
```groovy
// android/app/build.gradle
bundleConfig { enableCompression = false }
```

---

## 4. Animaciones sin jank (MEDIO)

```typescript
// ✅ BIEN — Reanimated worklet corre en UI thread, no en JS thread
import Animated, { useSharedValue, withSpring, runOnUI } from 'react-native-reanimated';

// Para el modo pánico / transiciones de AegisLink
const opacity = useSharedValue(1);
const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

function triggerPanicAnimation() {
  'worklet'; // corre en UI thread
  opacity.value = withSpring(0, { duration: 200 });
}
```

---

## 5. Memory leaks (MEDIO-ALTO)

```typescript
// ❌ MAL — listener de socket no se limpia
useEffect(() => {
  socket.on('envelope', handleEnvelope);
}, []); // falta cleanup

// ✅ BIEN — siempre retornar cleanup en useEffect
useEffect(() => {
  socket.on('envelope', handleEnvelope);
  return () => socket.off('envelope', handleEnvelope);
}, [handleEnvelope]);
```

```typescript
// ❌ MAL — timer de mensajes efímeros sin limpiar
useEffect(() => {
  setTimeout(() => deleteMessage(id), timer);
}, [id]);

// ✅ BIEN
useEffect(() => {
  const t = setTimeout(() => deleteMessage(id), timer);
  return () => clearTimeout(t);
}, [id, timer]);
```

---

## Mapa Problema → Solución

| Problema | Solución |
|----------|----------|
| Chat hace jank al scrollear | FlashList + estimatedItemSize |
| Demasiados re-renders en pantalla de chat | Estado atómico (Jotai) + React Compiler |
| Arranque lento (> 2s en Android) | Hermes mmap — deshabilitar compresión |
| Bundle muy grande (> 3MB) | Eliminar barrel imports + tree shaking |
| TextInput de búsqueda laggy | `useUncontrolledInput` + `useDeferredValue` |
| Animación de modo pánico tiembla | Reanimated worklet (UI thread) |
| Memoria crece al navegar entre chats | Limpiar listeners Socket.IO en useEffect |
