import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';

const CLIPBOARD_CLEAR_TIMEOUT_MS = 60000;

let currentTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Copia texto al portapapeles marcándolo como sensible.
 * En Android 13+ y iOS 15+ esto previene que el contenido se muestre en
 * la previsualización del sistema operativo y lo oculta a otras aplicaciones
 * que lean el portapapeles en segundo plano.
 *
 * Además, borra el contenido del portapapeles después de 60 segundos
 * para cumplir con la regla de 0 metadatos.
 */
export async function copySensitiveText(text: string): Promise<void> {
  // Clear any existing timeout so we don't accidentally clear a new copy
  // too early.
  if (currentTimeout) {
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }

  // Copy with sensitive flag
  await Clipboard.setStringAsync(text, {
    setIsSensitive: true,
  } as any);

  // Schedule auto-clear
  currentTimeout = setTimeout(() => {
    void Clipboard.setStringAsync('');
    currentTimeout = null;
  }, CLIPBOARD_CLEAR_TIMEOUT_MS);
}

/**
 * Copia texto público que no requiere protección anti-metadatos (ej. un link genérico).
 */
export async function copyPublicText(text: string): Promise<void> {
  if (currentTimeout) {
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }
  await Clipboard.setStringAsync(text);
}
