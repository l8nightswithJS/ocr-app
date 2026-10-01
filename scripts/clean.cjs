// scripts/clean.cjs
// Robust cleanup for Electron/Vite builds on Windows.
// It closes the packaged station app first, then removes dist/out with retries.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const targets = ['dist', 'out'];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killIfWindows(imageName) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', imageName], { stdio: 'ignore' });
    console.log(`Closed running process: ${imageName}`);
  } catch (_) {
    // Not running is fine.
  }
}

function removeWithRetry(target) {
  const fullPath = path.join(root, target);
  if (!fs.existsSync(fullPath)) return;

  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      console.log(`Removed ${target}`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Could not remove ${target} on attempt ${attempt}: ${error.code || error.message}`);
      sleep(500);
    }
  }

  console.error(`Failed to remove ${target}.`);
  console.error('Close the Electron app, close any File Explorer window inside the out folder, then run npm run clean again.');
  if (lastError) throw lastError;
}

// Packaged app from Electron Forge is out\\ocr-app-win32-x64\\ocr-app.exe.
killIfWindows('ocr-app.exe');
sleep(750);
for (const target of targets) removeWithRetry(target);
