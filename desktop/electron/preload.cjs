'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('secureStore', {
  get:    (key)       => ipcRenderer.invoke('secure-store:get', key),
  set:    (key, val)  => ipcRenderer.invoke('secure-store:set', key, val),
  delete: (key)       => ipcRenderer.invoke('secure-store:delete', key),
});

contextBridge.exposeInMainWorld('db', {
  run:     (sql, params) => ipcRenderer.invoke('db:run', sql, params),
  all:     (sql, params) => ipcRenderer.invoke('db:all', sql, params),
  get:     (sql, params) => ipcRenderer.invoke('db:get', sql, params),
  getPath: ()            => ipcRenderer.invoke('db:getPath'),
});

contextBridge.exposeInMainWorld('electronWindow', {
  minimize:    () => ipcRenderer.send('window:minimize'),
  maximize:    () => ipcRenderer.send('window:maximize'),
  close:       () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
});

contextBridge.exposeInMainWorld('panic', {
  wipe: () => ipcRenderer.invoke('panic:wipe'),
});
