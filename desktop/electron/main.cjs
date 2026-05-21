'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

// ── keytar (secure credential store) ─────────────────────────────────────────
let keytar;
try {
  keytar = require('keytar');
} catch {
  const _mem = new Map();
  keytar = {
    getPassword:    async (svc, acc)      => _mem.get(`${svc}:${acc}`) ?? null,
    setPassword:    async (svc, acc, val) => { _mem.set(`${svc}:${acc}`, val); },
    deletePassword: async (svc, acc)      => { _mem.delete(`${svc}:${acc}`); },
    findCredentials: async (svc) => [..._mem.entries()]
      .filter(([k]) => k.startsWith(`${svc}:`))
      .map(([k, password]) => ({ account: k.slice(svc.length + 1), password })),
  };
}

const KEYTAR_SERVICE = 'AegisLink';

// ── better-sqlite3 ────────────────────────────────────────────────────────────
let db;
function getDb() {
  if (db) return db;
  const Database = require('better-sqlite3');
  const dbPath = path.join(app.getPath('userData'), 'aegislink.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    backgroundColor: '#0a0e0d',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173').catch(() => {
      mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });
}

// ── Security helpers ──────────────────────────────────────────────────────────
function assertTrustedSender(e) {
  const url = e.senderFrame?.url ?? '';
  const trusted =
    url.startsWith('file://') ||
    (!app.isPackaged && url.startsWith('http://localhost:5173'));
  if (!trusted) throw new Error('untrusted sender frame');
}

function assertSafeSql(sql) {
  if (typeof sql !== 'string' || sql.length > 2000) throw new Error('invalid sql');
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (trimmed.includes(';')) throw new Error('multi-statement sql forbidden');
  if (/\b(ATTACH|DETACH|LOAD_EXTENSION)\b/i.test(trimmed)) throw new Error('forbidden sql keyword');
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data:; " +
          "connect-src 'self' http://localhost:3000 ws://localhost:3000 http://localhost:3001 ws://localhost:3001 " +
          "https://*.aegislink.com wss://*.aegislink.com; " +
          "object-src 'none'; base-uri 'none';",
        ],
      },
    });
  });

  createWindow();

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (ev, url) => {
      const allowed =
        url.startsWith('file://') ||
        (!app.isPackaged && url.startsWith('http://localhost:5173'));
      if (!allowed) ev.preventDefault();
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: secure store ─────────────────────────────────────────────────────────
ipcMain.handle('secure-store:get', (e, key) => {
  assertTrustedSender(e);
  if (typeof key !== 'string' || key.length > 128) throw new Error('invalid key');
  return keytar.getPassword(KEYTAR_SERVICE, key);
});

ipcMain.handle('secure-store:set', (e, key, value) => {
  assertTrustedSender(e);
  if (typeof key !== 'string' || key.length > 128) throw new Error('invalid key');
  if (typeof value !== 'string') throw new Error('invalid value');
  return keytar.setPassword(KEYTAR_SERVICE, key, value);
});

ipcMain.handle('secure-store:delete', (e, key) => {
  assertTrustedSender(e);
  if (typeof key !== 'string' || key.length > 128) throw new Error('invalid key');
  return keytar.deletePassword(KEYTAR_SERVICE, key);
});

// ── IPC: database ─────────────────────────────────────────────────────────────
ipcMain.handle('db:run', (e, sql, params = []) => {
  assertTrustedSender(e);
  assertSafeSql(sql);
  try {
    const stmt = getDb().prepare(sql);
    const info = stmt.run(...(Array.isArray(params) ? params : []));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  } catch (err) {
    throw new Error(err.message);
  }
});

ipcMain.handle('db:all', (e, sql, params = []) => {
  assertTrustedSender(e);
  assertSafeSql(sql);
  try {
    return getDb().prepare(sql).all(...(Array.isArray(params) ? params : []));
  } catch (err) {
    throw new Error(err.message);
  }
});

ipcMain.handle('db:get', (e, sql, params = []) => {
  assertTrustedSender(e);
  assertSafeSql(sql);
  try {
    return getDb().prepare(sql).get(...(Array.isArray(params) ? params : [])) ?? null;
  } catch (err) {
    throw new Error(err.message);
  }
});

ipcMain.handle('db:getPath', () =>
  path.join(app.getPath('userData'), 'aegislink.db'),
);

// ── IPC: panic wipe ───────────────────────────────────────────────────────────
ipcMain.handle('panic:wipe', async (e) => {
  assertTrustedSender(e);
  try { if (db) { db.close(); db = null; } } catch {}
  const dbPath = path.join(app.getPath('userData'), 'aegislink.db');
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  try {
    const creds = await keytar.findCredentials(KEYTAR_SERVICE);
    await Promise.all(creds.map((c) => keytar.deletePassword(KEYTAR_SERVICE, c.account)));
  } catch {}
  app.relaunch();
  app.exit(0);
});

// ── IPC: window controls ──────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
