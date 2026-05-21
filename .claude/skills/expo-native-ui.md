---
name: expo-native-ui
description: Guía de UI nativa con Expo Router para AegisLink — patrones de navegación, estilos inline, SF Symbols, Apple HIG, y construcción de componentes nativos. Aplica cuando se construyan pantallas, TabBar, modales, layouts o componentes visuales.
source: https://github.com/expo/skills (expo/skills oficial)
---

# Expo Native UI — AegisLink

> Basado en los skills oficiales de Expo: `building-native-ui` y `expo-dev-client`

## Principios de UI de AegisLink

1. **Nativo primero**: usar APIs del SO, no emulaciones web
2. **Sin Tailwind/CSS**: flexbox con estilos inline y `StyleSheet.create`
3. **Fiel al prototipo**: portar cada pantalla del `.jsx` de diseño sin omitir estados vacíos ni TabBar
4. **Apple HIG + Material You**: respetar las guías de diseño de cada plataforma

---

## 1. Navegación con Expo Router

```typescript
// app/_layout.tsx — Stack raíz con tabs
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="call/[id]" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  );
}
```

```typescript
// app/(tabs)/_layout.tsx — TabBar nativa
import { Tabs } from 'expo-router';
import { SymbolView } from 'expo-symbols'; // SF Symbols en iOS

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: '#6C63FF' }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color }) => (
            <SymbolView name="bubble.left.and.bubble.right.fill" tintColor={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contactos',
          tabBarIcon: ({ color }) => (
            <SymbolView name="person.2.fill" tintColor={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Ajustes',
          tabBarIcon: ({ color }) => (
            <SymbolView name="gearshape.fill" tintColor={color} />
          ),
        }}
      />
    </Tabs>
  );
}
```

---

## 2. Estilos y layout

```typescript
import { StyleSheet, useWindowDimensions } from 'react-native';

// ✅ BIEN — useWindowDimensions en lugar de Dimensions API
export function ChatBubble({ message }: { message: string }) {
  const { width } = useWindowDimensions();

  return (
    <View style={[styles.bubble, { maxWidth: width * 0.75 }]}>
      <Text selectable style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    borderRadius: 18,
    padding: 12,
    backgroundColor: '#6C63FF',
    // Sombra nativa (no CSS boxShadow)
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3, // Android
  },
  text: { color: '#fff', fontSize: 16, lineHeight: 22 },
});
```

---

## 3. ScrollView con insets correctos

```typescript
import { ScrollView } from 'react-native';

// ✅ SIEMPRE en pantallas con contenido scrolleable
export function SettingsScreen() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic" // respeta notch/barra de estado
      keyboardShouldPersistTaps="handled"
    >
      {/* contenido */}
    </ScrollView>
  );
}
```

---

## 4. Animaciones de entrada/salida

```typescript
import Animated, { FadeIn, FadeOut, SlideInRight } from 'react-native-reanimated';

// Estado vacío animado en lista de chats
export function EmptyChatsState() {
  return (
    <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
      <Text style={styles.emptyTitle}>Sin conversaciones</Text>
      <Text style={styles.emptySubtitle}>Tus chats aparecerán aquí</Text>
    </Animated.View>
  );
}

// Bubble de mensaje nuevo
export function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <Animated.View entering={SlideInRight.springify().damping(15)}>
      <ChatBubble message={message.text} />
    </Animated.View>
  );
}
```

---

## 5. expo-image para adjuntos cifrados

```typescript
import { Image } from 'expo-image';

// ✅ expo-image: blurhash, caché nativo, lazy loading
export function AttachmentPreview({ uri, blurhash }: AttachmentPreviewProps) {
  return (
    <Image
      source={{ uri }}
      placeholder={blurhash}
      contentFit="cover"
      transition={200}
      style={{ width: 200, height: 150, borderRadius: 12 }}
      // Nunca caches imágenes en claro — uri siempre es temporal
      cachePolicy="none"
    />
  );
}
```

---

## 6. Link con preview (Expo Router)

```typescript
import { Link } from 'expo-router';

export function ContactRow({ aegisId }: { aegisId: string }) {
  return (
    <Link href={`/chat/${aegisId}`} asChild>
      <Pressable style={styles.row}>
        <Text>{aegisId}</Text>
        <Link.Preview>
          {/* Preview nativo de la pantalla de chat al hacer long-press */}
          <ChatPreview aegisId={aegisId} />
        </Link.Preview>
      </Pressable>
    </Link>
  );
}
```

---

## Checklist de UI por pantalla

- [ ] `selectable` en texto con datos importantes (IDs, fingerprints)
- [ ] Estado vacío animado con `FadeIn`
- [ ] `ScrollView` con `contentInsetAdjustmentBehavior="automatic"`
- [ ] TabBar con SF Symbols en iOS / Material Icons en Android
- [ ] `useWindowDimensions` en lugar de `Dimensions.get('window')`
- [ ] Ningún `console.log` en componentes de producción
- [ ] `StyleSheet.create` para todos los estilos (no objetos inline anónimos)
