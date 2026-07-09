/**
 * App.tsx file-attachment pickers — withPickingGuard regression (iOS audit
 * fix #3, branch fix/ios-audit-batch).
 *
 * handleFilePick (1:1 chat) and handleGroupFilePick (group chat) call
 * `DocumentPicker.getDocumentAsync`, which on iOS presents the system Files
 * picker and backgrounds the app. Without `withPickingGuard`, `isPicking()`
 * stays false during that transition, so App.tsx's background→foreground
 * app-lock handler treats it as a real backgrounding — with the default
 * lock timeout ("Immediately"), returning from the Files picker re-locks the
 * app mid-send. `App.tsx` is a 1800+ line unexported Shell component with no
 * existing render-level test harness (it would require mocking the entire
 * navigation stack, every screen, and the socket/store layer just to reach
 * these two closures) — until that harness exists, this is a source-text
 * regression test in the same spirit as `audit-regression.test.ts`: it
 * fails loudly if either picker call is ever un-wrapped again.
 */
import fs from 'node:fs';
import path from 'node:path';

const APP_TSX = path.resolve(__dirname, '..', '..', 'App.tsx');

function extractFunctionBody(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('App.tsx — file-attachment DocumentPicker calls are wrapped in withPickingGuard', () => {
  const src = fs.readFileSync(APP_TSX, 'utf8');

  it('handleFilePick (1:1 chat) wraps DocumentPicker.getDocumentAsync in withPickingGuard', () => {
    const body = extractFunctionBody(
      src,
      'async function handleFilePick(',
      'async function handleMultipleImages(',
    );
    expect(body).toContain('withPickingGuard');
    // The guard must wrap the call, not merely appear somewhere in the function.
    const guardIdx = body.indexOf('withPickingGuard(');
    const pickIdx = body.indexOf('DocumentPicker.getDocumentAsync(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pickIdx).toBeGreaterThan(guardIdx);
  });

  it('handleGroupFilePick (group chat) wraps DocumentPicker.getDocumentAsync in withPickingGuard', () => {
    const body = extractFunctionBody(
      src,
      'async function handleGroupFilePick(',
      'async function handleGroupMultipleImages(',
    );
    expect(body).toContain('withPickingGuard');
    const guardIdx = body.indexOf('withPickingGuard(');
    const pickIdx = body.indexOf('DocumentPicker.getDocumentAsync(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pickIdx).toBeGreaterThan(guardIdx);
  });
});
