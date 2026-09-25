/**
 * Re-encode an image through a canvas so none of its metadata (EXIF, GPS
 * position, camera serial, XMP) leaves the device: a canvas export never copies
 * the source's metadata. Capped at `maxPx` on the long side, JPEG.
 *
 * Fails closed: if the image cannot be decoded or re-encoded this THROWS; the
 * caller must not fall back to sending the original bytes.
 */
export async function stripImageMetadata(file: Blob, maxPx = 1280, quality = 0.85): Promise<Blob> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image_decode_failed'));
    el.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxPx || height > maxPx) {
    const r = Math.min(maxPx / width, maxPx / height);
    width = Math.round(width * r);
    height = Math.round(height * r);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  ctx.drawImage(img, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('image_encode_failed'))), 'image/jpeg', quality);
  });
}
