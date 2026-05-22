---
name: swm-animations-gestures
description: Animaciones y gestos avanzados en React Native/Expo para AegisLink — Reanimated 4, 120fps, Skia canvas, GPU shaders con TypeGPU, gesture handlers compuestos. Aplica cuando se implementen transiciones de pantalla, swipe-to-delete en mensajes, pull-to-refresh, animaciones de llamada entrante, o cualquier movimiento fluido en la UI.
source: https://github.com/software-mansion-labs/skills (Software Mansion, MIT)
---

# Animaciones y Gestos Avanzados — AegisLink

> Basado en el plugin oficial de Software Mansion: `react-native-best-practices` + `expo-horizon`

## Regla de oro: 60fps mínimo, 120fps objetivo en ProMotion

Nunca bloquear el JS thread con animaciones. Toda animación usa worklets en el UI thread.

---

## 1. Reanimated 4 — Setup y worklets

```tsx
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';

// ✅ Worklet puro — corre en UI thread
const animatedStyle = useAnimatedStyle(() => ({
  opacity: withTiming(isVisible.value ? 1 : 0, { duration: 200 }),
  transform: [{ scale: withSpring(isVisible.value ? 1 : 0.95) }],
}));
```

### Reglas de worklets
- Todo código dentro de `useAnimatedStyle`, `useAnimatedGestureHandler`, `runOnUI` → debe ser serializable
- No importar stores de Zustand dentro de worklets → usar `runOnJS(callback)(valor)`
- No usar `console.log` dentro de worklets en producción

---

## 2. Gesture Handler — Patrones AegisLink

### Swipe-to-delete en mensajes
```tsx
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

const swipe = Gesture.Pan()
  .activeOffsetX([-10, 10])
  .onUpdate((e) => {
    translateX.value = Math.max(e.translationX, -80);
  })
  .onEnd((e) => {
    if (e.translationX < -60) {
      runOnJS(onDelete)(messageId);
    }
    translateX.value = withSpring(0);
  });
```

### Long-press para modo pánico (crítico)
```tsx
const longPress = Gesture.LongPress()
  .minDuration(2000)
  .onActivated(() => {
    runOnJS(triggerPanicMode)();
  });

// Combinar con tap para cancelar
const composed = Gesture.Exclusive(longPress, tap);
```

---

## 3. Transiciones de pantalla a 120fps

AegisLink usa navegación manual (stack array en `App.tsx`). Para transiciones nativas:

```tsx
import { useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';

// Slide-in desde derecha — usada en push de pantallas
const slideIn = useAnimatedStyle(() => ({
  transform: [{
    translateX: withTiming(isActive ? 0 : width, {
      duration: 280,
      easing: Easing.out(Easing.cubic),
    }),
  }],
}));
```

---

## 4. Animaciones de llamada entrante

```tsx
// Pulsación del avatar mientras timbra
const pulse = useSharedValue(1);

useEffect(() => {
  pulse.value = withRepeat(
    withSequence(
      withTiming(1.08, { duration: 600 }),
      withTiming(1.0, { duration: 600 }),
    ),
    -1, // infinito
    false,
  );
  return () => cancelAnimation(pulse);
}, []);
```

---

## 5. Skia canvas (para visualizaciones de audio en llamadas)

```tsx
import { Canvas, Path, Skia } from '@shopify/react-native-skia';

// Waveform de audio durante llamada — no exponer metadatos de la señal
function AudioWaveform({ levels }: { levels: number[] }) {
  const path = Skia.Path.Make();
  levels.forEach((lvl, i) => {
    path.lineTo(i * 4, 50 - lvl * 40);
  });
  return (
    <Canvas style={{ width: '100%', height: 100 }}>
      <Path path={path} color="#00FF88" strokeWidth={2} style="stroke" />
    </Canvas>
  );
}
```

---

## 6. Checklist antes de shipar una animación

- [ ] ¿Corre en UI thread? (no JS thread)
- [ ] ¿Funciona en modo reducir movimiento (`reduceMotion`)? → `useReducedMotion()`
- [ ] ¿FPS estable en Android gama media (Pixel 4a equivalente)?
- [ ] ¿Libera recursos en `useEffect` cleanup? (`cancelAnimation`)
- [ ] ¿Sin referencias a claves privadas ni IDs de usuario en los valores animados?

---

## Anti-patrones prohibidos

| ❌ Prohibido | ✅ Usar |
|---|---|
| `Animated` del core RN | `Animated` de Reanimated 4 |
| `setState` dentro de worklet | `runOnJS(setState)(value)` |
| `setInterval` para animaciones | `withRepeat` + `withTiming` |
| Skia para texto de mensajes | Solo para visualizaciones (waveform, charts) |
