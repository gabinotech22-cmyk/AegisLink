'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('secureStore', {
  get: (key) => ipcRenderer.invoke('secure-store:get', key),
  set: (key, value) => ipcRenderer.invoke('secure-store:set', key, value),
  delete: (key) => ipcRenderer.invoke('secure-store:delete', key),
});

contextBridge.exposeInMainWorld('db', {
  run: (sql, params) => ipcRenderer.invoke('db:run', sql, params),
  all: (sql, params) => ipcRenderer.invoke('db:all', sql, params),
  get: (sql, params) => ipcRenderer.invoke('db:get', sql, params),
  getPath: () => ipcRenderer.invoke('db:getPath'),
});

contextBridge.exposeInMainWorld('electronWindow', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
});

contextBridge.exposeInMainWorld('panic', {
  wipe: () => ipcRenderer.invoke('panic:wipe'),
});
