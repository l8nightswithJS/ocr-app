/**
 * Production Pack bootstrap
 * - Imports and initializes: persistence (IndexedDB), override modal, CSV export,
 *   camera settling/debounce, auto-reconnect handlers, and validation runner UI.
 * - Designed to be loaded AFTER your existing main.ts OR as a drop-in replacement.
 *
 * Usage:
 *   1) Replace <script type="module" src="/src/main.ts"> with this file, OR
 *   2) Keep main.ts and import these modules inside main.ts.
 */

import { DB } from './modules/db';
import { attachOverrideUI } from './modules/overrides';
import { attachExportButtons } from './modules/exporter';
import { Settler } from './modules/settle';
import { setupAutoReconnect } from './modules/reconnect';
import { mountValidationRunner } from './modules/validation';

// Initialize DB once
const db = new DB('ocr_line_db', 1);
await db.init();

// Expose minimal API globally for your existing code to call.
declare global {
  interface Window {
    ocrPack: {
      db: DB;
      settler: Settler;
      logScan: (rec: any) => Promise<void>;
      logOverride: (rec: any) => Promise<void>;
      exportCSV: () => Promise<string>;
    };
  }
}

// Settling / debounce helper
const settler = new Settler();

// Wire UI bits (requires existing elements by id; if missing, these are no-ops)
attachOverrideUI(db);
attachExportButtons(db);
setupAutoReconnect();
mountValidationRunner(db);

// Convenience pass-throughs
window.ocrPack = {
  db,
  settler,
  logScan: (rec: any) => db.logScan(rec),
  logOverride: (rec: any) => db.logOverride(rec),
  exportCSV: () => db.exportCSV(),
};

console.info('[production-pack] Ready. Use window.ocrPack in devtools.');
