// preload.cjs
const { contextBridge } = require('electron');

// Just expose a tiny flag so we know preload ran; do NOT touch navigator.serial
contextBridge.exposeInMainWorld('electronEnv', {
  serialEnabled: true,
});
