// src/state/store.ts
// FSM + device-setting helpers with shapes that match your current code.

export type State = 'IDLE' | 'ARMED' | 'CAPTURING' | 'DONE';

export interface Session {
  id: string;
  lrm?: string;
  createdAt: number;
  state: State;
}

/* ---------- ROI + Filter types (match your UI usage) ---------- */
// Your UI uses x, y, width, height and treats width/height as a zoom box.
// We also keep w/h as aliases so older code won’t break.
export type Crop = {
  x: number;
  y: number;
  width: number;
  height: number;
  w?: number; // alias
  h?: number; // alias
  zoom?: number;
  xOffset?: number;
  yOffset?: number;
};

// Your ROI preview builds a canvas filter with brightness/contrast
export type Filter = {
  brightness: number; // percent, e.g. 100  (required)
  contrast: number; // percent, e.g. 100  (required)
  grayscale?: boolean;
  threshold?: number;
  blur?: number;
};

export interface Config {
  debounceMs: number;
  settleMs: number;
  postEdgeGuardMs: number;
  armedTimeoutMs: number;
  captureTimeoutMs: number;
  startupWarnLock: boolean;
}

export interface UI {
  showStatus(text: string, tone: 'idle' | 'warn' | 'busy' | 'ok' | 'error'): void;
  showStartupWarning(show: boolean, msg?: string): void;

  ensureActiveRow(lrm: string): HTMLElement;
  setRowOCR(row: HTMLElement, value: string): void;
  setRowBusy(row: HTMLElement, busy: boolean, note?: string): void;
  lockRow(row: HTMLElement): void;

  enableScanInput(enable: boolean): void;
}

export interface OCR {
  startCapture(sessionId: string): void;
}

/* ----------------------------- FSM ----------------------------- */

export class LineFSM {
  private cfg: Config;
  private ui: UI;
  private ocr: OCR;

  private session: Session | null = null;
  private presence = false;
  private debTimer: number | null = null;
  private settleTimer: number | null = null;
  private armedTimer: number | null = null;
  private captureTimer: number | null = null;
  private guardUntil = 0;

  constructor(cfg: Partial<Config>, ui: UI, ocr: OCR) {
    this.cfg = {
      debounceMs: 120,
      settleMs: 500,
      postEdgeGuardMs: 300,
      armedTimeoutMs: 25_000,
      captureTimeoutMs: 8_000,
      startupWarnLock: false,
      ...cfg,
    };
    this.ui = ui;
    this.ocr = ocr;
  }

  handleStartupPresence(initialPresent: boolean) {
    this.presence = initialPresent;
    if (initialPresent) {
      this.ui.showStartupWarning(
        true,
        '⚠️ Chip detected — remove before scanning LRM (otherwise it will auto-process).',
      );
      if (this.cfg.startupWarnLock) this.ui.enableScanInput(false);
    } else {
      this.ui.showStartupWarning(false);
      this.ui.showStatus('Ready — scan LRM to begin.', 'idle');
      this.ui.enableScanInput(true);
    }
  }

  handlePresenceChange(isPresentRaw: boolean) {
    if (this.debTimer) window.clearTimeout(this.debTimer);
    this.debTimer = window.setTimeout(() => {
      const now = performance.now();
      this.presence = isPresentRaw;

      if (!this.presence) {
        this.ui.showStartupWarning(false);
        if (this.cfg.startupWarnLock) this.ui.enableScanInput(true);
      }

      if (now < this.guardUntil) return;

      const s = this.session?.state ?? 'IDLE';
      if (s === 'ARMED' && this.presence) this.beginSettleThenCapture();
      // ignore in IDLE/DONE or during CAPTURING
      this.guardUntil = now + this.cfg.postEdgeGuardMs;
    }, this.cfg.debounceMs);
  }

  handleLrmScan(lrm: string) {
    const nowState = this.session?.state ?? 'IDLE';
    if (nowState === 'ARMED' || nowState === 'CAPTURING') {
      this.ui.showStatus(
        'Busy with current part — finish or cancel before scanning a new LRM.',
        'warn',
      );
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.session = { id, lrm, createdAt: performance.now(), state: 'ARMED' };

    const row = this.ui.ensureActiveRow(lrm);
    this.ui.setRowBusy(row, false);
    this.ui.showStatus('LRM received — waiting for chip…', 'idle');

    this.clearTimer('armedTimer');
    this.armedTimer = window.setTimeout(() => {
      if (this.session && this.session.id === id && this.session.state === 'ARMED') {
        this.session = { ...this.session, state: 'IDLE' };
        this.ui.showStatus(
          'No chip detected — session timed out. Scan LRM to start again.',
          'warn',
        );
      }
    }, this.cfg.armedTimeoutMs);

    if (this.presence) {
      this.ui.showStatus('Chip detected — capturing shortly…', 'busy');
      this.beginSettleThenCapture();
    } else {
      this.ui.showStatus('Insert chip to capture.', 'idle');
    }
  }

  handleRescanSameRow() {
    if (!this.session || this.session.state !== 'DONE') {
      this.ui.showStatus('No completed row to rescan.', 'warn');
      return;
    }
    const { lrm } = this.session;
    this.session = null;
    if (lrm) this.handleLrmScan(lrm);
  }

  handleCancel() {
    if (!this.session || (this.session.state !== 'ARMED' && this.session.state !== 'CAPTURING'))
      return;
    this.session = null;
    this.clearAllTimers();
    this.ui.showStatus('Canceled. Ready — scan LRM to begin.', 'idle');
  }

  onOcrSuccess(result: { top?: string }) {
    if (!this.session || this.session.state !== 'CAPTURING') return;
    const row = this.ui.ensureActiveRow(this.session.lrm || '');
    if (result.top) this.ui.setRowOCR(row, result.top);

    this.ui.lockRow(row);
    this.session.state = 'DONE';
    this.clearAllTimers();
    this.ui.showStatus('Scan complete. Remove part.', 'ok');
    this.guardUntil = performance.now() + this.cfg.postEdgeGuardMs;
  }

  onOcrFail(reason?: string) {
    if (!this.session || this.session.state !== 'CAPTURING') return;
    const row = this.ui.ensureActiveRow(this.session.lrm || '');
    this.ui.setRowBusy(row, false);
    this.session.state = 'DONE';
    this.clearAllTimers();
    this.ui.showStatus(
      reason ? `Read failed: ${reason}` : 'Read failed. Manual entry required.',
      'error',
    );
  }

  private beginSettleThenCapture() {
    if (!this.session || this.session.state !== 'ARMED') return;
    const sessionId = this.session.id;

    const row = this.ui.ensureActiveRow(this.session.lrm || '');
    this.ui.setRowBusy(row, true, 'Capturing in a moment…');

    this.clearTimer('settleTimer');
    this.settleTimer = window.setTimeout(() => {
      if (!this.session || this.session.id !== sessionId) return;
      if (!this.presence) {
        this.ui.setRowBusy(row, false);
        this.ui.showStatus('Chip removed during settle — waiting for insertion.', 'warn');
        return;
      }

      this.session.state = 'CAPTURING';
      this.ui.setRowBusy(row, true, 'Reading…');
      this.ui.showStatus('Reading…', 'busy');

      this.clearTimer('captureTimer');
      this.captureTimer = window.setTimeout(() => {
        this.onOcrFail('Capture timed out.');
      }, this.cfg.captureTimeoutMs);

      this.ocr.startCapture(sessionId);
    }, this.cfg.settleMs);
  }

  private clearTimer(name: 'settleTimer' | 'armedTimer' | 'captureTimer') {
    if (this[name]) {
      window.clearTimeout(this[name] as number);
      this[name] = null;
    }
  }
  private clearAllTimers() {
    this.clearTimer('settleTimer');
    this.clearTimer('armedTimer');
    this.clearTimer('captureTimer');
  }
}

/* ------------------ LocalStorage-backed helpers ------------------ */

type Json = Record<string, any>;

export interface DeviceSettingsOne {
  hw: Json; // focus/exposure/wb/etc — ALWAYS present
  crop: Crop; // ALWAYS present
  filter: Filter; // ALWAYS present
}

// Meta can be an object keyed by deviceId, or an array of MediaDeviceInfo
export interface DevicesMeta {
  [deviceId: string]: { label?: string } & Json;
}

// Keep the existing Top Plate camera key so current stations retain their selection.
export interface PersistedIds {
  cam2?: string;
  camBId?: string;
}

const LS = {
  devicesMeta: 'ocr.devicesMeta',
  perDevice: 'ocr.deviceSettings.byId',
  persistedIds: 'ocr.persistedIds',
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write<T>(key: string, val: T) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

// Provide safe defaults so s.hw etc. are never undefined.
function defaultCrop(): Crop {
  return { x: 0.05, y: 0.05, width: 0.9, height: 0.9, w: 0.9, h: 0.9 };
}
function defaultFilter(): Filter {
  return { brightness: 100, contrast: 100 };
}
function defaultSettings(): DeviceSettingsOne {
  return { hw: {}, crop: defaultCrop(), filter: defaultFilter() };
}

/** Save metadata about devices (array or object). */
export function saveDevicesMeta(meta: DevicesMeta | MediaDeviceInfo[]): void {
  let payload: DevicesMeta = {};
  if (Array.isArray(meta)) {
    for (const d of meta) {
      payload[d.deviceId] = { label: d.label };
    }
  } else {
    payload = meta;
  }
  const cur = read<DevicesMeta>(LS.devicesMeta, {});
  write(LS.devicesMeta, { ...cur, ...payload });
}
export function loadDevicesMeta(): DevicesMeta {
  return read<DevicesMeta>(LS.devicesMeta, {});
}

/** Per-device settings: ALWAYS return objects with hw/crop/filter present. */
export function loadDeviceSettings(deviceId: string): DeviceSettingsOne {
  const all = read<Record<string, Partial<DeviceSettingsOne>>>(LS.perDevice, {});
  const raw = all[deviceId] ?? {};
  return {
    hw: raw.hw ?? {},
    crop: { ...defaultCrop(), ...(raw.crop ?? {}) },
    filter: { ...defaultFilter(), ...(raw.filter ?? {}) },
  };
}
export function saveDeviceSettings(deviceId: string, settings: Partial<DeviceSettingsOne>): void {
  const all = read<Record<string, DeviceSettingsOne>>(LS.perDevice, {});
  const cur = all[deviceId] ?? defaultSettings();
  all[deviceId] = {
    hw: { ...cur.hw, ...(settings.hw ?? {}) },
    crop: { ...cur.crop, ...(settings.crop ?? {}) },
    filter: { ...cur.filter, ...(settings.filter ?? {}) },
  };
  write(LS.perDevice, all);
}

/** Persist the preferred Top Plate camera ID. */
export function savePersistedIds(ids: PersistedIds): void {
  const cur = read<PersistedIds>(LS.persistedIds, {});
  write(LS.persistedIds, { ...cur, ...ids });
}
export function loadPersistedIds(): PersistedIds {
  const got = read<PersistedIds>(LS.persistedIds, {});
  return {
    ...got,
    cam2: got.cam2 ?? got.camBId,
  };
}
