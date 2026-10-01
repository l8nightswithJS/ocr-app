// main.cjs - CommonJS entry for Electron

const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');

// Needed for Web Serial support in Electron/Chromium.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false;
  return (
    origin.startsWith('file://') ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('http://[::1]:')
  );
}

function getOriginFromPermissionDetails(details) {
  return (
    details?.requestingUrl ||
    details?.origin ||
    details?.securityOrigin ||
    details?.embeddingOrigin ||
    ''
  );
}

function formatSerialPortLabel(port, index) {
  const parts = [];

  if (port.portName) parts.push(port.portName);
  if (port.displayName) parts.push(port.displayName);
  if (port.serialNumber) parts.push(`SN ${port.serialNumber}`);

  const ids = [];
  if (port.vendorId) ids.push(`VID ${port.vendorId}`);
  if (port.productId) ids.push(`PID ${port.productId}`);
  if (ids.length) parts.push(ids.join(' / '));

  if (port.portId) parts.push(`ID ${String(port.portId).slice(0, 12)}...`);

  return parts.length ? parts.join(' — ') : `Serial port ${index + 1}`;
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
  // Electron does not show Chrome's built-in Web Serial picker automatically.
  // This native dialog is what lets the station app choose KEYENCE COM5 instead
  // of silently picking the wrong serial device.
  ses.on('select-serial-port', async (event, portList, _webContents, callback) => {
    event.preventDefault();

    try {
      if (!Array.isArray(portList) || portList.length === 0) {
        await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'No Serial Ports Found',
          message: 'No serial ports are available.',
          detail:
            'Confirm the scanner is connected, configured as USB-COM/serial, and visible in Windows Device Manager under Ports (COM & LPT).',
          buttons: ['OK'],
          noLink: true,
        });
        callback('');
        return;
      }

      const labels = portList.map(formatSerialPortLabel);
      const cancelLabel = 'Cancel';
      const buttons = [...labels, cancelLabel];

      const result = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Select Serial Port',
        message: 'Select the scanner/fixture COM port',
        detail:
          'For Hybrid Mode, choose the KEYENCE HR-100 COM port for the LRM Pairing Scanner. On the station this should be the port shown in Device Manager, such as COM5.',
        buttons,
        cancelId: buttons.length - 1,
        defaultId: 0,
        noLink: true,
      });

      if (result.response >= 0 && result.response < portList.length) {
        const chosen = portList[result.response];
        console.log('Selected serial port:', chosen);
        callback(chosen.portId);
        return;
      }

      callback('');
    } catch (error) {
      console.error('Serial port selection failed:', error);
      callback('');
    }
  });

  ses.on('serial-port-added', (_event, port) => {
    console.log('serial-port-added:', port);
  });

  ses.on('serial-port-removed', (_event, port) => {
    console.log('serial-port-removed:', port);
  });

  // Allow permission checks for serial and media from the built file:// app
  // and from localhost while debugging with Vite.
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = requestingOrigin || getOriginFromPermissionDetails(details);
    if (!isAllowedOrigin(origin)) return false;

    return permission === 'serial' || permission === 'media';
  });

  // Allow active permission requests for camera/media and serial from allowed origins.
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = getOriginFromPermissionDetails(details);

    if (isAllowedOrigin(origin) && (permission === 'serial' || permission === 'media')) {
      callback(true);
      return;
    }

    callback(false);
  });

  // Allow device access for serial from allowed origins.
  ses.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial' && isAllowedOrigin(details.origin);
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
