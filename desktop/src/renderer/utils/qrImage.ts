/**
 * Decode a QR code from an image file (screenshot, photo, exported PNG).
 *
 * Chromium on Windows/Linux ships no BarcodeDetector backend, so decoding is
 * pure JS (jsqr) over the raw pixels of a canvas. Large photos are downscaled
 * first (jsqr is O(pixels)); inverted colours (a dark-theme QR on a
 * screenshot) are tried too.
 * Everything stays in the renderer: no bytes leave the machine.
 */
import jsQR from 'jsqr';

export const QR_MAX_DECODE_PX = 1600;

export async function decodeQrFromImage(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, QR_MAX_DECODE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return decodeQrPixels(data, w, h);
  } finally {
    bitmap.close();
  }
}

/**
 * Pure decode over RGBA pixels. `attemptBoth` tries normal then inverted
 * (light-on-dark QR of a dark-theme screenshot) in one call — jsqr 1.4's
 * `onlyInvert` path is broken (never computes the inverted bitmap), so the
 * two-call form must not be used.
 */
export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return result?.data || null;
}
