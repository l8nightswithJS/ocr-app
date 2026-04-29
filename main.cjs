// main.cjs - CommonJS entry for Electron

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// Ensure experimental web platform features are on globally.
// Needed for Web Serial support in Electron/Chromium.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

function isFileOrigin(origin) {
  return typeof origin === 'string' && origin.startsWith('file://');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    title: 'Smart Cartridge Build Tracker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),

      // Security-friendly defaults.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,

      // Enable Web Serial in Electron.
      experimentalFeatures: true,
      enableBlinkFeatures: 'Serial',
    },
  });

  const ses = win.webContents.session;

  // ---- Web Serial wiring ----
  // Handle port selection when navigator.serial.requestPort() is called.
  ses.on('select-serial-port', (event, portList, _webContents, callback) => {
    console.log('select-serial-port fired. Available ports:', portList);

    event.preventDefault();

    if (portList && portList.length > 0) {
      // Current behavior: auto-select the first available serial port.
      // If multiple serial devices are connected later, this may need a picker UI.
      const chosen = portList[0];
      console.log('Auto-selecting serial port:', chosen);
      callback(chosen.portId);
      return;
    }

    console.warn('No serial ports available');
    callback('');
  });

  ses.on('serial-port-added', (_event, port) => {
    console.log('serial-port-added:', port);
  });

  ses.on('serial-port-removed', (_event, port) => {
    console.log('serial-port-removed:', port);
  });

  // Allow permission checks for serial and media from the built file:// app.
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (!isFileOrigin(requestingOrigin)) return false;

    return permission === 'serial' || permission === 'media';
  });

  // Allow active permission requests for camera/media and serial from file://.
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = details?.requestingUrl || details?.origin || '';

    if (isFileOrigin(origin) && (permission === 'serial' || permission === 'media')) {
      callback(true);
      return;
    }

    callback(false);
  });

  // Allow device access for serial from file:// origin.
  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial' && isFileOrigin(details.origin)) {
      return true;
    }

    return false;
  });
  // ---- end Web Serial & media permission wiring ----

  // Load the built Vite app from ./dist/index.html.
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
