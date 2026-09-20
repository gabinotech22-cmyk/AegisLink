/**
 * Privacy → "Block screenshots" on desktop = Electron content protection. The
 * toggle used to persist a preference nothing read. Pins: the handler flips
 * setContentProtection on every window, only for trusted senders, and reports
 * whether the platform actually enforces it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
const windows = [{ setContentProtection: vi.fn() }, { setContentProtection: vi.fn() }];

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => windows },
}));

import { registerWindowHandlers } from '../window';

const trusted = { senderFrame: { url: 'file:///app/index.html' } };
const untrusted = { senderFrame: { url: 'https://evil.example' } };

describe('window:set-content-protection', () => {
  beforeEach(() => {
    handlers.clear();
    for (const w of windows) w.setContentProtection.mockClear();
    registerWindowHandlers();
  });

  it('enables / disables protection on every window and reports platform support', () => {
    const h = handlers.get('window:set-content-protection')!;
    const supported = h(trusted, true);
    for (const w of windows) expect(w.setContentProtection).toHaveBeenLastCalledWith(true);
    expect(supported).toBe(process.platform === 'win32' || process.platform === 'darwin');
    h(trusted, false);
    for (const w of windows) expect(w.setContentProtection).toHaveBeenLastCalledWith(false);
  });

  it('treats anything but literal true as off', () => {
    const h = handlers.get('window:set-content-protection')!;
    h(trusted, 'true');
    for (const w of windows) expect(w.setContentProtection).toHaveBeenLastCalledWith(false);
  });

  it('refuses an untrusted sender', () => {
    const h = handlers.get('window:set-content-protection')!;
    expect(() => h(untrusted, true)).toThrow(/untrusted/);
    for (const w of windows) expect(w.setContentProtection).not.toHaveBeenCalled();
  });
});
