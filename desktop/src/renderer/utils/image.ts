/**
 * Read an image file, decode it, and re-encode a downscaled JPEG as a data: URL.
 *
 * Avatars/group images must persist in the DB and survive restarts. A
 * `URL.createObjectURL(file)` blob URL is revoked on reload and never persists,
 * so it silently breaks after the next launch. A data: URL is self-contained and
 * durable. Downscaling (default 256px, JPEG q0.85) keeps it small enough to store
 * and broadcast cheaply. Falls back to the raw data URL if canvas is unavailable.
 */
export function fileToDownscaledDataUrl(file: File, max = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const raw = reader.result as string;
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(raw); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  });
}
