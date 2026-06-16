/**
 * AttachmentGrid — unit tests (RNTL)
 *
 * Cubre la capa de RENDERIZACIÓN de mensajes con múltiples adjuntos en las
 * pantallas de chat 1:1 y de grupos. Verifica que el grid colapsa correctamente,
 * lista archivos con su chip de extensión, y muestra el caption.
 *
 * Casos:
 *  1.  1 imagen           → 1 celda, sin overlay
 *  2.  2 imágenes         → 2 celdas lado a lado
 *  3.  4 imágenes         → 4 celdas, sin overlay (cabe justo)
 *  4.  6 imágenes         → 4 celdas visibles + overlay "+2"
 *  5.  5 imágenes         → overlay "+1"
 *  6.  mixto (2 img + pdf)→ celdas de imagen + fila de archivo con nombre
 *  7.  solo archivos      → filas con chip de extensión (PDF)
 *  8.  audio sin nombre   → fila etiquetada "Audio"
 *  9.  caption            → texto del caption visible
 *  10. sin caption        → no crashea
 *  11. lista vacía        → no crashea
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import type { Attachment } from '../../db/local';

// ── Theme ──────────────────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bubbleIn: '#222',
      bubbleInText: '#fff',
      bubbleOut: '#05b875',
      bubbleOutText: '#000',
      accent: '#05b875',
      radius: 12,
      radiusS: 8,
      font: 'System',
      fontMono: 'Courier',
    },
  }),
}));

// ── Icons: render nada, son irrelevantes para la lógica de layout ───────────────
jest.mock('../icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── MediaImage: stub que NO toca crypto/resolveMedia. Mantiene el
//    accessibilityLabel del Pressable padre intacto, así contamos celdas
//    de imagen vía getAllByLabelText(/^Image /).
jest.mock('../MediaImage', () => ({
  MediaImage: () => null,
}));

// Importado DESPUÉS de los mocks
import { AttachmentGrid } from '../AttachmentGrid';

function img(uri: string): Attachment {
  return { type: 'image', uri };
}
function file(uri: string, fileName: string): Attachment {
  return { type: 'file', uri, fileName };
}

const NOOP = () => undefined;

function renderGrid(attachments: Attachment[], caption?: string, isMe = true) {
  return render(
    <AttachmentGrid
      attachments={attachments}
      isMe={isMe}
      caption={caption}
      onImagePress={NOOP}
      onFilePress={NOOP}
    />
  );
}

describe('AttachmentGrid — grid de imágenes', () => {
  it('1. una sola imagen renderiza exactamente 1 celda sin overlay', () => {
    const { getAllByLabelText, queryByText } = renderGrid([img('blob:a:k:n')]);
    expect(getAllByLabelText(/^Image /)).toHaveLength(1);
    expect(queryByText(/^\+/)).toBeNull();
  });

  it('2. dos imágenes renderizan 2 celdas', () => {
    const { getAllByLabelText } = renderGrid([img('blob:a:k:n'), img('blob:b:k:n')]);
    expect(getAllByLabelText(/^Image /)).toHaveLength(2);
  });

  it('3. cuatro imágenes renderizan 4 celdas sin overlay', () => {
    const atts = [img('blob:1:k:n'), img('blob:2:k:n'), img('blob:3:k:n'), img('blob:4:k:n')];
    const { getAllByLabelText, queryByText } = renderGrid(atts);
    expect(getAllByLabelText(/^Image /)).toHaveLength(4);
    expect(queryByText(/^\+/)).toBeNull();
  });

  it('4. seis imágenes muestran 4 celdas visibles y overlay "+2"', () => {
    const atts = Array.from({ length: 6 }, (_, i) => img(`blob:${i}:k:n`));
    const { getAllByLabelText, getByText } = renderGrid(atts);
    expect(getAllByLabelText(/^Image /)).toHaveLength(4);
    expect(getByText('+2')).toBeTruthy();
  });

  it('5. cinco imágenes muestran overlay "+1"', () => {
    const atts = Array.from({ length: 5 }, (_, i) => img(`blob:${i}:k:n`));
    const { getByText } = renderGrid(atts);
    expect(getByText('+1')).toBeTruthy();
  });
});

describe('AttachmentGrid — archivos', () => {
  it('6. mixto: 2 imágenes + 1 pdf renderiza celdas y la fila del archivo', () => {
    const atts = [img('blob:a:k:n'), img('blob:b:k:n'), file('blob:f:k:n', 'informe.pdf')];
    const { getAllByLabelText, getByLabelText, getByText } = renderGrid(atts);
    expect(getAllByLabelText(/^Image /)).toHaveLength(2);
    expect(getByLabelText('informe.pdf')).toBeTruthy();
    expect(getByText('informe.pdf')).toBeTruthy();
  });

  it('7. solo archivos: muestra el chip de extensión en mayúsculas (PDF)', () => {
    const atts = [file('blob:f:k:n', 'contrato.pdf')];
    const { getByText, getByLabelText } = renderGrid(atts);
    expect(getByLabelText('contrato.pdf')).toBeTruthy();
    expect(getByText('PDF')).toBeTruthy();
  });

  it('8. audio sin nombre se etiqueta "Audio"', () => {
    const atts: Attachment[] = [{ type: 'audio', uri: 'blob:au:k:n', duration: 12 }];
    const { getByLabelText } = renderGrid(atts);
    expect(getByLabelText('Audio')).toBeTruthy();
  });
});

describe('AttachmentGrid — caption y bordes', () => {
  it('9. el caption se renderiza como texto visible', () => {
    const { getByText } = renderGrid([img('blob:a:k:n')], 'mira estas fotos');
    expect(getByText('mira estas fotos')).toBeTruthy();
  });

  it('10. sin caption no crashea', () => {
    expect(() => renderGrid([img('blob:a:k:n')])).not.toThrow();
  });

  it('11. lista vacía de adjuntos no crashea', () => {
    expect(() => renderGrid([])).not.toThrow();
  });

  it('12. renderiza igual para mensajes entrantes (isMe=false)', () => {
    const atts = [img('blob:a:k:n'), file('blob:f:k:n', 'doc.txt')];
    const { getAllByLabelText, getByLabelText } = renderGrid(atts, undefined, false);
    expect(getAllByLabelText(/^Image /)).toHaveLength(1);
    expect(getByLabelText('doc.txt')).toBeTruthy();
  });
});
