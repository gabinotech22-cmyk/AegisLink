/**
 * QR from an image (desktop has no camera scanner and Chromium on
 * Windows/Linux has no BarcodeDetector). Pins the pure decode step: a QR
 * rendered to raw RGBA pixels round-trips its payload, both dark-on-light and
 * light-on-dark (a dark-theme screenshot), and a blank image yields null.
 */
import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import { decodeQrPixels } from '../qrImage';

/** Render a QR into an RGBA buffer, `scale` px per module, 4-module quiet zone. */
function renderQr(text: string, scale = 6, invert = false): { data: Uint8ClampedArray; width: number; height: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const side = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4);
  const dark = invert ? 255 : 0;
  const light = invert ? 0 : 255;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const isDark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx) === 1;
      const v = isDark ? dark : light;
      const i = (y * side + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width: side, height: side };
}

const PAYLOAD = 'aegislink://add?id=ABC-DEFG-HJKM&pk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('decodeQrPixels', () => {
  it('round-trips a dark-on-light QR', () => {
    const { data, width, height } = renderQr(PAYLOAD);
    expect(decodeQrPixels(data, width, height)).toBe(PAYLOAD);
  });

  it('round-trips a light-on-dark QR (dark-theme screenshot)', () => {
    const { data, width, height } = renderQr(PAYLOAD, 6, true);
    expect(decodeQrPixels(data, width, height)).toBe(PAYLOAD);
  });

  it('returns null when there is no QR', () => {
    const side = 200;
    const data = new Uint8ClampedArray(side * side * 4).fill(255);
    expect(decodeQrPixels(data, side, side)).toBeNull();
  });
});
