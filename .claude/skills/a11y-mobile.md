---
name: a11y-mobile
description: Auditoría y guía de accesibilidad (a11y) para AegisLink en React Native/Expo — WCAG 2.2, VoiceOver/TalkBack, contraste, focus management, roles ARIA-equivalentes, y tests con RNTL. Aplica cuando se implementen pantallas nuevas, se audite una pantalla existente, o se detecten problemas de accesibilidad en el onboarding, chat, modo pánico, o llamadas.
source: https://github.com/senaiverse/claude-code-reactnative-expo-agent-system (MIT)
---

# Accesibilidad Mobile — AegisLink

> La accesibilidad en una app de privacidad es también seguridad: un usuario con discapacidad visual que no puede cerrar sesión o activar el modo pánico está en riesgo.

---

## 1. Props de accesibilidad obligatorias

### Botones e iconos táctiles
```tsx
// ❌ Mal — lector de pantalla no sabe qué hace
<TouchableOpacity onPress={onDelete}>
  <Icon name="trash" />
</TouchableOpacity>

// ✅ Bien
<TouchableOpacity
  onPress={onDelete}
  accessible={true}
  accessibilityRole="button"
  accessibilityLabel="Eliminar mensaje"
  accessibilityHint="Elimina este mensaje de forma permanente"
>
  <Icon name="trash" />
</TouchableOpacity>
```

### Imágenes decorativas
```tsx
// Ocultar del árbol de accesibilidad si no aporta información
<Image source={decorativeAsset} accessible={false} />

// Avatar con info útil
<Image
  source={{ uri: avatarUrl }}
  accessible={true}
  accessibilityLabel={`Avatar de ${contactName}`}
/>
```

---

## 2. Contraste de color — Paleta AegisLink

| Combinación | Ratio | WCAG AA (4.5:1) | WCAG AAA (7:1) |
|---|---|---|---|
| `#00FF88` sobre `#000000` | 15.3:1 | ✅ | ✅ |
| `#FFFFFF` sobre `#000000` | 21:1 | ✅ | ✅ |
| `#666666` sobre `#000000` | 5.74:1 | ✅ | ❌ texto pequeño |
| `#444444` sobre `#000000` | 3.07:1 | ❌ FALLO | ❌ |

**Regla**: Textos secundarios mínimo `#555555` sobre negro.

---

## 3. Focus management — Pantallas críticas

### Modo pánico (CRÍTICO de accesibilidad)
```tsx
import { AccessibilityInfo, findNodeHandle } from 'react-native';

const panicButtonRef = useRef(null);

// Al abrir pantalla de pánico, forzar focus al botón de confirmación
useEffect(() => {
  const node = findNodeHandle(panicButtonRef.current);
  if (node) {
    AccessibilityInfo.setAccessibilityFocus(node);
  }
}, []);
```

### Anuncios de estado para operaciones asíncronas
```tsx
// Anunciar cuando un mensaje se envía (sin revelar contenido)
AccessibilityInfo.announceForAccessibility('Mensaje enviado');

// Anunciar llamada entrante
AccessibilityInfo.announceForAccessibility(`Llamada entrante de ${contactDisplayName}`);
```

---

## 4. Reduce Motion — Respetar preferencias del sistema

```tsx
import { useReducedMotion } from 'react-native-reanimated';

function MessageBubble({ content, animate }: Props) {
  const reduceMotion = useReducedMotion();

  const style = useAnimatedStyle(() => ({
    opacity: reduceMotion
      ? 1  // Sin animación
      : withTiming(1, { duration: 300 }),
  }));

  return <Animated.View style={style}>{/* ... */}</Animated.View>;
}
```

---

## 5. Tests de accesibilidad con RNTL

```tsx
import { render, screen } from '@testing-library/react-native';

describe('PanicButton accessibility', () => {
  it('tiene accessibilityRole button y label descriptivo', () => {
    render(<PanicButton onPress={jest.fn()} />);
    const btn = screen.getByRole('button', { name: /modo pánico/i });
    expect(btn).toBeTruthy();
  });

  it('anuncia el estado cuando se activa', async () => {
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    render(<PanicButton onPress={jest.fn()} />);
    fireEvent.press(screen.getByRole('button'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('pánico'));
  });
});
```

---

## 6. Checklist de auditoría a11y por pantalla

### Onboarding (Sección 1)
- [ ] Cada paso tiene `accessibilityLiveRegion="polite"` para anunciar progreso
- [ ] El QR de identidad tiene descripción alternativa textual
- [ ] PIN input: `secureTextEntry` + `accessibilityLabel="Dígito N del PIN"`

### Chat 1:1 (Sección 3)
- [ ] Lista de mensajes usa `FlatList` con `accessibilityLabel` en cada burbuja
- [ ] El campo de texto tiene placeholder y label describiendo destinatario
- [ ] Mensajes efímeros anuncian tiempo restante con `accessibilityLiveRegion`

### Llamadas (Secciones 7 y 8)
- [ ] Botones de mute/cámara tienen estado (`accessibilityState={{ checked: isMuted }}`)
- [ ] Llamada entrante anuncia nombre del contacto por VoiceOver/TalkBack
- [ ] Botón de colgar: `accessibilityLabel="Colgar llamada"`, no solo icono

### Modo pánico (Sección 9)
- [ ] Focus automático al botón de confirmación al abrir
- [ ] Confirmación no requiere gestos complejos (accesible con un toque)
- [ ] Mensaje de resultado anunciado con `announceForAccessibility`

---

## 7. Herramientas de auditoría

```bash
# Inspeccionar árbol de accesibilidad en simulador iOS
xcrun simctl accessibility inspect <device-id>

# Android — activar TalkBack en emulador
adb shell settings put secure enabled_accessibility_services \
  com.google.android.marvin.talkback/.TalkBackService

# React Native — ver árbol en dev menu
# Shake → "Show Inspector" → "Accessibility"
```
