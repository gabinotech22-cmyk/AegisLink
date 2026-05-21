/**
 * pickingGuard — evita que el bloqueo de pantalla se active mientras
 * el sistema de selección de archivos / cámara tiene la app en segundo plano.
 *
 * Uso:
 *   await withPickingGuard(() => ImagePicker.launchImageLibraryAsync(...))
 *
 * App.tsx consulta isPicking() antes de activar el lock.
 */

let _picking = false;

export function isPicking(): boolean {
  return _picking;
}

export async function withPickingGuard<T>(fn: () => Promise<T>): Promise<T> {
  _picking = true;
  try {
    return await fn();
  } finally {
    // Pequeño delay para que el AppState 'active' se procese ANTES de que
    // limpiemos el flag — el handler de App.tsx lo lee en el mismo tick.
    setTimeout(() => { _picking = false; }, 600);
  }
}
