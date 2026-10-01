import './index.css';
const SIM_MODE = import.meta.env.VITE_SIM_MODE === 'true';

// Camera module (real vs mock)
let initWebcams: any;
let startStreams: any;
let waitForFreshFrame: any;
let stopAllCameraStreams: any;

let connectAndListenToArduino: any;
let reconnectArduino: any;
let disconnectArduino: any;
let forgetArduinoPort: any;
let onArduinoConnectionChange: any;
let getArduinoConnectionState: any;
let TOKEN: any;
let sendToArduino: any;

async function loadHardwareModules() {
  const cameras = SIM_MODE
    ? await import('./devices/cameras.mock')
    : await import('./devices/cameras');
  const serial = SIM_MODE
    ? await import('./devices/serial.mock')
    : await import('./devices/serial');

  ({ initWebcams, startStreams, waitForFreshFrame, stopAllCameraStreams } = cameras);
  ({
    connectAndListenToArduino,
    reconnectArduino,
    disconnectArduino,
    forgetArduinoPort,
    onArduinoConnectionChange,
    getArduinoConnectionState,
    TOKEN,
    sendToArduino,
  } = serial);

  if (SIM_MODE) {
    console.log('[SIM MODE] Using mock cameras + mock serial');
  }
}

import { updateStatus } from './ui/status';
import { setupCropControls, livePreviewLoop } from './ui/roi';
import { loadDeviceSettings, saveDeviceSettings, type Crop, type Filter } from './state/store';
import { readNumberFromCamera } from './ocr/gemini';

import { adaptiveBurstRead } from './modules/validation';
import { DB, type ScanRecord } from './modules/db';
import { promptOverride } from './modules/overrides';
import { exportCsv } from './modules/exporter';
import { settleAfterPresence } from './modules/settle';
import { setupAutoReconnect } from './modules/reconnect';

console.log('SIM MODE:', import.meta.env.VITE_SIM_MODE);

// ---------- Tunables ----------
const SETTLE_AFTER_PRESENT_MS = 350;
const SETTLE_AFTER_REMOVAL_MS = 200;
const CAPTURE_SETTLE_FRAMES = 2;
const CAPTURE_EXTRA_DELAY_MS = 80;
const POST_SCAN_COOLDOWN_MS = 800;
const PRESENCE_EDGE_MIN_GAP_MS = 150;

const OCR_MAX_ATTEMPTS = Math.max(1, Number(import.meta.env.VITE_OCR_MAX_ATTEMPTS ?? '3'));

const SIM_OCR_MAX_ATTEMPTS = Math.max(1, Number(import.meta.env.VITE_SIM_OCR_MAX_ATTEMPTS ?? '2'));

const OCR_MIN_GAP_FRAMES = Math.max(0, Number(import.meta.env.VITE_OCR_MIN_GAP_FRAMES ?? '1'));

const APP_BUILD_LABEL = 'GNM-HYBRID-2026-06-24.5';

// ---------- Modes ----------
type AppMode = 'standard' | 'traceability_beta';
const APP_MODE_KEY = 'ocr-app-mode';

// ---------- Standard run ----------
const CONDITION_PREFIX = 'COND|';
const RUN_BASE_KEY = 'ocr-run-base';
const RUN_NEXT_KEY = 'ocr-run-next';
const RUN_PAD_KEY = 'ocr-run-pad';
const RUN_LRM_MAP_KEY = 'ocr-run-lrm-map';
const RUN_LYO_KEY = 'ocr-run-lyo-condition';
const RUN_MISSING_KEY = 'ocr-run-missing-numbers';

// ---------- Traceability run ----------
const BETA_BUILD_KEY = 'ocr-beta-build';
const BETA_LYO_KEY = 'ocr-beta-lyo';
const BETA_NEXT_SEQUENCE_KEY = 'ocr-beta-next-sequence';
const BETA_MISSING_KEY = 'ocr-beta-missing-numbers';
const BETA_WORKFLOW_PHASE_KEY = 'ocr-beta-workflow-phase';
const BETA_RUN_ID_KEY = 'ocr-beta-run-id';
const BETA_QR_INFO_MAP_KEY = 'ocr-beta-qr-info-map';
const BETA_MIXWHEEL_LOT_KEY = 'ocr-beta-mixwheel-lot';
const BETA_SAMPLE_CAP_LOT_KEY = 'ocr-beta-sample-cap-lot';
const BETA_SYNC_CHANNEL = 'ocr-traceability-run-sync';
const OCR_STATION_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const SCAN_DEBOUNCE_MS = 350;

const SCANNER_BAUD_KEY = 'ocr-scanner-baud-rate';
const DEFAULT_SCANNER_BAUD = 115200;
const OCR_KEYBOARD_SCANNER_TIMEOUT_MS = 80;

type ScannerRoute = 'lrm' | 'cartridge';
type ScannerSerialStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type ScannerSerialState = {
  status: ScannerSerialStatus;
  message: string;
  portLabel: string;
  lastScan?: string;
};


type StationRole = 'full' | 'lrm' | 'cartridge';

function readStationRoleFromUrl(): StationRole {
  const station = new URLSearchParams(window.location.search).get('station');
  if (station === 'cartridge') return 'cartridge';
  if (station === 'lrm') return 'lrm';
  return 'full';
}

let stationRole: StationRole = readStationRoleFromUrl();
let lastOcrFocusedSequence: string | null = null;
let betaSequenceCalloutGeneration = 0;

// Important: do not persist this in sessionStorage. Some browsers clone sessionStorage
// into popup windows, which makes both stations think they are the same source and
// causes BroadcastChannel sync updates to be ignored.
const STATION_ID = `station-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type BetaWorkflowPhase = 'lrm_pairing' | 'cartridge_ocr';
type BetaSpecialAction = 'mark_failed' | 'recover_missing' | 'post_ocr_reject' | null;

// ---------- DOM ----------
const body = document.body;
const setupBtn = document.getElementById('enter-setup-btn');
const badge = document.querySelector('.mode-badge');
const appSubtitleEl = document.getElementById('app-subtitle') as HTMLParagraphElement | null;
const appModeSelectEl = document.getElementById('appModeSelect') as HTMLSelectElement | null;
const standardRunPanelEl = document.getElementById('standard-run-panel') as HTMLDivElement | null;
const traceabilityRunPanelEl = document.getElementById(
  'traceability-run-panel',
) as HTMLDivElement | null;
const tableHeadRowEl = document.getElementById('data-table-head-row') as HTMLTableRowElement | null;

const menuBtn = document.getElementById('menuBtn') as HTMLButtonElement | null;
const menuDropdown = document.getElementById('menuDropdown') as HTMLDivElement | null;

const addRowBtn = document.getElementById('addRowBtn') as HTMLButtonElement | null;
const exportCsvBtn = document.getElementById('exportCsvBtn') as HTMLButtonElement | null;
const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement | null;

// Standard run UI
const conditionInputEl = document.getElementById('conditionInput') as HTMLInputElement | null;
const lyoConditionInputEl = document.getElementById('lyoConditionInput') as HTMLInputElement | null;
const missingCartridgesInputEl = document.getElementById(
  'missingCartridgesInput',
) as HTMLInputElement | null;
const startRunBtn = document.getElementById('startRunBtn') as HTMLButtonElement | null;
const clearConditionBtn = document.getElementById('clearConditionBtn') as HTMLButtonElement | null;
const conditionEmptyEl = document.getElementById('condition-empty') as HTMLDivElement | null;
const conditionActiveEl = document.getElementById('condition-active') as HTMLDivElement | null;
const activeConditionValueEl = document.getElementById(
  'activeConditionValue',
) as HTMLDivElement | null;
const activeLyoConditionValueEl = document.getElementById(
  'activeLyoConditionValue',
) as HTMLDivElement | null;
const activeMissingCartridgesValueEl = document.getElementById(
  'activeMissingCartridgesValue',
) as HTMLDivElement | null;
const activeMissingCartridgesInputEl = document.getElementById(
  'activeMissingCartridgesInput',
) as HTMLInputElement | null;
const updateMissingCartridgesBtn = document.getElementById(
  'updateMissingCartridgesBtn',
) as HTMLButtonElement | null;

// Traceability run UI
const betaBuildInputEl = document.getElementById('betaBuildInput') as HTMLInputElement | null;
const betaLyoInputEl = document.getElementById('betaLyoInput') as HTMLInputElement | null;
const betaStartSequenceInputEl = document.getElementById(
  'betaStartSequenceInput',
) as HTMLInputElement | null;
const betaMissingSequencesInputEl = document.getElementById(
  'betaMissingSequencesInput',
) as HTMLInputElement | null;
const startBetaRunBtn = document.getElementById('startBetaRunBtn') as HTMLButtonElement | null;
const clearBetaRunBtn = document.getElementById('clearBetaRunBtn') as HTMLButtonElement | null;
const traceabilityEmptyEl = document.getElementById('traceability-empty') as HTMLDivElement | null;
const traceabilityActiveEl = document.getElementById(
  'traceability-active',
) as HTMLDivElement | null;
const betaActiveBuildValueEl = document.getElementById(
  'betaActiveBuildValue',
) as HTMLDivElement | null;
const betaActiveLyoValueEl = document.getElementById('betaActiveLyoValue') as HTMLDivElement | null;
const betaExpectedSequenceValueEl = document.getElementById(
  'betaExpectedSequenceValue',
) as HTMLDivElement | null;
const betaExpectedSequenceLabelEl = document.getElementById(
  'betaExpectedSequenceLabel',
) as HTMLDivElement | null;
const betaActiveMissingSequencesValueEl = document.getElementById(
  'betaActiveMissingSequencesValue',
) as HTMLDivElement | null;
const betaCurrentStepValueEl = document.getElementById(
  'betaCurrentStepValue',
) as HTMLDivElement | null;
const betaShroudScanInputEl = document.getElementById(
  'betaShroudScanInput',
) as HTMLInputElement | null;
const betaLrmScanInputEl = document.getElementById('betaLrmScanInput') as HTMLInputElement | null;
const betaSequenceScanLabelEl = document.querySelector(
  'label[for="betaShroudScanInput"]',
) as HTMLLabelElement | null;
const betaLrmScanLabelEl = document.querySelector(
  'label[for="betaLrmScanInput"]',
) as HTMLLabelElement | null;
let betaWorkflowPhaseSelectEl: HTMLSelectElement | null = null;
const betaActiveMissingSequencesInputEl = document.getElementById(
  'betaActiveMissingSequencesInput',
) as HTMLInputElement | null;
const updateBetaMissingSequencesBtn = document.getElementById(
  'updateBetaMissingSequencesBtn',
) as HTMLButtonElement | null;

// General DOM
const tableBody = document.getElementById('data-table-body') as HTMLTableSectionElement;
const tableScrollContainer = document.getElementById(
  'table-scroll-container',
) as HTMLDivElement | null;

// Arduino status/menu/modal DOM
const arduinoStatusPill = document.getElementById('arduinoStatusPill') as HTMLDivElement | null;
const arduinoStatusDot = document.getElementById('arduinoStatusDot') as HTMLSpanElement | null;
const arduinoStatusText = document.getElementById('arduinoStatusText') as HTMLSpanElement | null;
const arduinoConnectionMenuBtn = document.getElementById(
  'arduinoConnectionMenuBtn',
) as HTMLButtonElement | null;
const singleWindowModeMenuBtn = document.getElementById(
  'singleWindowModeMenuBtn',
) as HTMLButtonElement | null;
const arduinoModal = document.getElementById('arduinoModal') as HTMLDivElement | null;
const arduinoModalBackdrop = document.getElementById(
  'arduinoModalBackdrop',
) as HTMLDivElement | null;
const arduinoCloseModalBtn = document.getElementById(
  'arduinoCloseModalBtn',
) as HTMLButtonElement | null;
const arduinoModalStatus = document.getElementById('arduinoModalStatus') as HTMLDivElement | null;
const arduinoModalPort = document.getElementById('arduinoModalPort') as HTMLDivElement | null;
const arduinoConnectModalBtn = document.getElementById(
  'arduinoConnectModalBtn',
) as HTMLButtonElement | null;
const arduinoReconnectModalBtn = document.getElementById(
  'arduinoReconnectModalBtn',
) as HTMLButtonElement | null;
const arduinoDisconnectModalBtn = document.getElementById(
  'arduinoDisconnectModalBtn',
) as HTMLButtonElement | null;
const arduinoForgetPortModalBtn = document.getElementById(
  'arduinoForgetPortModalBtn',
) as HTMLButtonElement | null;

const brightness2 = document.getElementById('brightness-2') as HTMLInputElement;
const contrast2 = document.getElementById('contrast-2') as HTMLInputElement;

const zoom2 = document.getElementById('zoom-2') as HTMLInputElement;
const x2 = document.getElementById('x-2') as HTMLInputElement;
const y2 = document.getElementById('y-2') as HTMLInputElement;

const webcam2 = document.getElementById('webcam2') as HTMLVideoElement;

// ---------- OCR preview result UI ----------
type OcrPreviewTone = 'idle' | 'busy' | 'ok' | 'warn' | 'error';

const ocrResultCard2 = document.getElementById('ocr-result-card-2') as HTMLDivElement | null;
const ocrResultLabel2 = document.getElementById('ocr-result-label-2') as HTMLDivElement | null;
const ocrResultValue2 = document.getElementById('ocr-result-value-2') as HTMLDivElement | null;

function applyOcrPreviewTone(
  card: HTMLDivElement | null,
  valueEl: HTMLDivElement | null,
  tone: OcrPreviewTone,
) {
  if (!card || !valueEl) return;

  card.classList.remove(
    'border-gray-200',
    'bg-gray-50',
    'border-indigo-200',
    'bg-indigo-50',
    'border-emerald-200',
    'bg-emerald-50',
    'border-amber-200',
    'bg-amber-50',
    'border-rose-200',
    'bg-rose-50',
  );

  valueEl.classList.remove(
    'text-gray-800',
    'text-indigo-700',
    'text-emerald-700',
    'text-amber-700',
    'text-rose-700',
    'animate-pulse',
  );

  if (tone === 'busy') {
    card.classList.add('border-indigo-200', 'bg-indigo-50');
    valueEl.classList.add('text-indigo-700', 'animate-pulse');
    return;
  }

  if (tone === 'ok') {
    card.classList.add('border-emerald-200', 'bg-emerald-50');
    valueEl.classList.add('text-emerald-700');
    return;
  }

  if (tone === 'warn') {
    card.classList.add('border-amber-200', 'bg-amber-50');
    valueEl.classList.add('text-amber-700');
    return;
  }

  if (tone === 'error') {
    card.classList.add('border-rose-200', 'bg-rose-50');
    valueEl.classList.add('text-rose-700');
    return;
  }

  card.classList.add('border-gray-200', 'bg-gray-50');
  valueEl.classList.add('text-gray-800');
}

function setOcrPreview(
  value: string,
  tone: OcrPreviewTone = 'idle',
  labelOverride?: string,
) {
  if (ocrResultLabel2 && labelOverride) {
    ocrResultLabel2.textContent = labelOverride;
  }

  if (ocrResultValue2) {
    ocrResultValue2.textContent = value;
  }

  applyOcrPreviewTone(ocrResultCard2, ocrResultValue2, tone);
}

function hasOpenStandardEntryRow() {
  const rows = Array.from(tableBody.querySelectorAll<HTMLTableRowElement>('tr'));

  return rows.some((row) => {
    if (row.dataset.mode !== 'standard') return false;
    const input = row.querySelector('.lrm-input') as HTMLInputElement | null;
    return !!input && input.dataset.accepted !== 'true';
  });
}

function betaRowTopIsVerified(row: HTMLTableRowElement) {
  const sequence = row.dataset.sequence ?? '';
  const topCell = row.querySelector('.beta-top-cell') as HTMLElement | null;
  const topValue = (topCell?.textContent ?? '').trim();

  if (!topValue || topValue === 'NO_CODE_FOUND') return false;
  return topMatchesExpectedSequence(topValue, sequence);
}

async function maybeCreateNextStandardRowIfReady() {
  if (currentAppMode !== 'standard') return false;
  if (stablePresence) return false;
  if (hasOpenStandardEntryRow()) return false;

  state = 'IDLE';
  armedRow = null;
  createStandardTableRow();
  await sendToArduino(TOKEN.NO_PART);
  return true;
}

function resetOcrPreviews() {
  setOcrPreview(
    '—',
    'idle',
    currentAppMode === 'traceability_beta' ? 'Top Plate / Sequence Check' : 'Top Plate',
  );
}

function setOcrPreviewsScanning() {
  setOcrPreview(
    'Scanning...',
    'busy',
    currentAppMode === 'traceability_beta' ? 'Top Plate / Sequence Check' : 'Top Plate',
  );
}

// ---------- Arduino connection modal / status pill ----------
type ArduinoConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

type ArduinoUiState = {
  status: ArduinoConnectionStatus;
  message?: string;
  portLabel?: string;
};

const arduinoPresenceHandler = (rawPresent: boolean) => {
  schedulePresenceChange(
    !!rawPresent,
    rawPresent ? SETTLE_AFTER_PRESENT_MS : SETTLE_AFTER_REMOVAL_MS,
  );
};

function setArduinoControlsBusy(busy: boolean) {
  if (arduinoConnectModalBtn) arduinoConnectModalBtn.disabled = busy;
  if (arduinoReconnectModalBtn) arduinoReconnectModalBtn.disabled = busy;
  if (arduinoDisconnectModalBtn) arduinoDisconnectModalBtn.disabled = busy;
  if (arduinoForgetPortModalBtn) arduinoForgetPortModalBtn.disabled = busy;
}

function applyArduinoUiState(stateInfo?: ArduinoUiState) {
  const state: ArduinoUiState = stateInfo ?? {
    status: 'disconnected',
    message: 'Arduino: Disconnected',
    portLabel: 'No port selected',
  };

  const status: ArduinoConnectionStatus = state.status;

  const labels: Record<ArduinoConnectionStatus, string> = {
    disconnected: 'Arduino: Disconnected',
    connecting: 'Arduino: Connecting',
    connected: 'Arduino: Connected',
    reconnecting: 'Arduino: Reconnecting',
    error: 'Arduino: Error',
  };

  const dotClasses: Record<ArduinoConnectionStatus, string> = {
    disconnected: 'bg-gray-400',
    connecting: 'bg-amber-400',
    connected: 'bg-emerald-500',
    reconnecting: 'bg-amber-400',
    error: 'bg-rose-500',
  };

  const pillClasses: Record<ArduinoConnectionStatus, string> = {
    disconnected: 'border-gray-200 bg-gray-50 text-gray-700',
    connecting: 'border-amber-200 bg-amber-50 text-amber-800',
    connected: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    reconnecting: 'border-amber-200 bg-amber-50 text-amber-800',
    error: 'border-rose-200 bg-rose-50 text-rose-700',
  };

  if (arduinoStatusText) {
    arduinoStatusText.textContent = labels[status];
  }

  if (arduinoModalStatus) {
    arduinoModalStatus.textContent = state.message || labels[status].replace('Arduino: ', '');
  }

  if (arduinoModalPort) {
    arduinoModalPort.textContent = state.portLabel || 'No port selected';
  }

  if (arduinoStatusDot) {
    arduinoStatusDot.className = `h-2.5 w-2.5 rounded-full ${dotClasses[status]}`;
  }

  if (arduinoStatusPill) {
    arduinoStatusPill.className = `inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold whitespace-nowrap ${pillClasses[status]}`;
  }

  const busy = status === 'connecting' || status === 'reconnecting';
  setArduinoControlsBusy(busy);

  if (arduinoConnectModalBtn) {
    arduinoConnectModalBtn.disabled = busy || status === 'connected';
  }

  if (arduinoDisconnectModalBtn) {
    arduinoDisconnectModalBtn.disabled = busy || status === 'disconnected';
  }
}

function openArduinoModal() {
  applyArduinoUiState();
  arduinoModal?.classList.remove('hidden');
}

function closeArduinoModal() {
  arduinoModal?.classList.add('hidden');
}

// ---------- Persisted filters / crops ----------
let crop2: Crop = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
let filter2: Filter = { brightness: 100, contrast: 100 };

// ---------- UI mode persistence ----------
const MODE_KEY = 'ocr-ui-mode';
let currentMode: 'run' | 'setup' = 'run';
const savedMode = localStorage.getItem(MODE_KEY);
if (savedMode === 'setup') currentMode = 'setup';

if (currentMode === 'setup') {
  body.classList.add('setup-mode');
  body.classList.remove('run-mode');
  if (badge) badge.textContent = 'SETUP MODE';
  if (setupBtn) setupBtn.textContent = 'Enter Run Mode';
} else {
  body.classList.add('run-mode');
  body.classList.remove('setup-mode');
  if (badge) badge.textContent = 'RUN MODE';
  if (setupBtn) setupBtn.textContent = 'Enter Setup Mode';
}

if (setupBtn && badge) {
  setupBtn.addEventListener('click', () => {
    const isRun = body.classList.contains('run-mode');

    body.classList.toggle('run-mode', !isRun);
    body.classList.toggle('setup-mode', isRun);

    badge.textContent = isRun ? 'SETUP MODE' : 'RUN MODE';
    setupBtn.textContent = isRun ? 'Enter Run Mode' : 'Enter Setup Mode';

    localStorage.setItem(MODE_KEY, isRun ? 'setup' : 'run');
  });
}

// ---------- Global app mode ----------
let currentAppMode: AppMode = 'traceability_beta';

// ---------- State machine ----------
type FSM = 'IDLE' | 'ARMED' | 'PRESENT' | 'SCANNING' | 'WAITING_QR' | 'WAITING_LRM' | 'COOLDOWN';
let state: FSM = 'IDLE';
let cooldownUntil = 0;
let scanInFlight = false;
let armedRow: HTMLTableRowElement | null = null;

// presence debouncer
let stablePresence = false;
let pendingTimer: number | null = null;
let lastPresenceEdgeAt = 0;

// ---------- Beta row state ----------
type BetaStep = 'scan_shroud' | 'scan_lrm' | 'place_part';

type BetaUnit = {
  build: string;
  lyoCondition: string;
  expectedSequence: string;
  shroudRaw: string | null;
  lrm: string | null;
  row: HTMLTableRowElement;
  recordId?: number;
  recovered?: boolean;
};

let betaCurrentUnit: BetaUnit | null = null;
let betaSpecialAction: BetaSpecialAction = null;
let lastScanSignature = '';
let lastScanAt = 0;
let lrmStatusMirrorObserverReady = false;

// Prevent overlapping cross-window refreshes from appending duplicate visual rows.
// OCR and Gemini code is intentionally untouched by this fix.
let betaTableRenderGeneration = 0;

// ---------- DB ----------
const db = new DB();

function showStartupError(error: unknown, context = 'Startup') {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${context} error:`, error);
  try {
    applyAppModeUI();
    updateStatus(`${context} error: ${message}. Open DevTools console for details.`, 'error');
  } catch {
    // If the UI is not ready, avoid masking the original error.
  }
}

window.addEventListener('error', (event) => {
  showStartupError(event.error ?? event.message, 'Runtime');
});

window.addEventListener('unhandledrejection', (event) => {
  showStartupError(event.reason, 'Async runtime');
});

// ---------- Cross-window run sync ----------
const runSyncChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(BETA_SYNC_CHANNEL) : null;

function notifyRunDataChanged(reason: string) {
  try {
    runSyncChannel?.postMessage({
      type: 'run-data-changed',
      runId: getBetaRunId(),
      source: STATION_ID,
      reason,
      at: Date.now(),
    });
  } catch (err) {
    console.warn('Run sync broadcast failed', err);
  }
}

function notifyStationModeCommand(action: 'single-window') {
  try {
    runSyncChannel?.postMessage({
      type: 'station-mode-command',
      action,
      runId: getBetaRunId(),
      source: STATION_ID,
      at: Date.now(),
    });
  } catch (err) {
    console.warn('Station mode broadcast failed', err);
  }
}

async function refreshFromExternalRunUpdate(reason = 'external update') {
  if (currentAppMode !== 'traceability_beta' || !hasActiveBetaRun()) return;
  if (hasUnsafeLocalBetaWorkInProgress()) {
    await updateBetaRunSummary();
    return;
  }

  await renderBetaTableForActiveRun();
  updateBetaRunUI();
  refreshBetaEnhancementPanel();
  await updateBetaRunSummary();

  if (isCartridgeStation()) {
    updateStatus('Run table updated from LRM Pairing Station. Scan passing unit Sequence QR.', 'info');
  } else if (isLrmOnlyStation()) {
    updateStatus('Run table updated from Cartridge OCR Station. Continue LRM pairing.', 'info');
  } else if (reason) {
    updateStatus('Run table updated from another station.', 'info');
  }
}

runSyncChannel?.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.source === STATION_ID) return;

  const activeRunId = getBetaRunId();
  if (activeRunId && message.runId && activeRunId !== message.runId) return;

  if (message.type === 'run-data-changed') {
    void refreshFromExternalRunUpdate(message.reason);
    return;
  }

  if (message.type === 'station-mode-command' && message.action === 'single-window') {
    if (isCartridgeStation()) {
      if (window.opener) {
        window.close();
      } else {
        void enterSingleWindowStationMode(false);
      }
      return;
    }

    if (isLrmOnlyStation()) {
      void enterSingleWindowStationMode(false);
    }
  }
});

window.addEventListener('storage', (event) => {
  if (!event.key) return;
  if (
    event.key === BETA_RUN_ID_KEY ||
    event.key === BETA_BUILD_KEY ||
    event.key === BETA_LYO_KEY ||
    event.key === BETA_NEXT_SEQUENCE_KEY ||
    event.key.startsWith(`${BETA_QR_INFO_MAP_KEY}:`)
  ) {
    void refreshFromExternalRunUpdate('storage update');
  }
});

// ---------- Helpers ----------
function padNum(n: number, width: number) {
  return String(n).padStart(width, '0');
}

function normalizeBuildNumber(raw: string) {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(3, '0').slice(-3);
}

function normalizeSequence(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!/(\d+)$/.test(trimmed)) return null;

  const upper = trimmed.toUpperCase();
  if (/^Z\d+$/.test(upper)) return upper;

  return trimmed;
}

function formatSequenceFromTemplate(template: string, n: number) {
  const trimmed = (template ?? '').trim();
  const match = trimmed.match(/^(.*?)(\d+)$/);

  if (!match) return String(n);

  const [, prefix, digits] = match;
  return `${prefix}${String(n).padStart(digits.length, '0')}`;
}

function incrementSequence(seq: string) {
  const num = extractTrailingNumericValue(seq);
  if (num === null) return seq;
  return formatSequenceFromTemplate(seq, num + 1);
}

function formatBetaSequenceNumber(n: number, template?: string) {
  const baseTemplate = (template ?? getBetaExpectedSequence() ?? '').trim();
  if (baseTemplate) return formatSequenceFromTemplate(baseTemplate, n);
  return `Z${String(n).padStart(10, '0')}`;
}

function parseBetaMissingNumbersInput(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: true as const,
      values: [] as number[],
      invalidTokens: [] as string[],
    };
  }

  const tokens = trimmed
    .split(/[,\n\r\t ]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const invalidTokens: string[] = [];
  const values = new Set<number>();

  for (const token of tokens) {
    const digitsMatch = token.match(/(\d+)$/);

    if (!digitsMatch) {
      invalidTokens.push(token);
      continue;
    }

    const num = Number(digitsMatch[1]);
    if (!Number.isInteger(num) || num < 0) {
      invalidTokens.push(token);
      continue;
    }

    values.add(num);
  }

  return {
    ok: invalidTokens.length === 0,
    values: [...values].sort((a, b) => a - b),
    invalidTokens,
  };
}

function parseShroudQrSequence(raw: string) {
  return extractTrailingNumericValue(raw);
}

function focusAndSelect(input: HTMLInputElement | null) {
  if (!input) return;
  input.focus();
  input.select?.();
}

function schedulePresenceChange(target: boolean, delayMs: number) {
  const now = performance.now();
  if (now - lastPresenceEdgeAt < PRESENCE_EDGE_MIN_GAP_MS) return;
  lastPresenceEdgeAt = now;

  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    if (stablePresence === target) return;
    stablePresence = target;
    void onPresenceStable(target);
  }, delayMs);
}

function extractTrailingNumericValue(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const match = String(raw)
    .trim()
    .match(/(\d+)$/);
  if (!match) return null;

  return Number(match[1]);
}

function expectedSequenceNumericValue(seq: string): number | null {
  return extractTrailingNumericValue(seq);
}

function topMatchesExpectedSequence(
  topValue: string | null | undefined,
  expectedSequence: string,
): boolean {
  const topNum = extractTrailingNumericValue(topValue);
  const expectedNum = expectedSequenceNumericValue(expectedSequence);
  if (topNum === null || expectedNum === null) return false;
  return topNum === expectedNum;
}

function normalizeScannerText(raw: string | null | undefined) {
  return (raw ?? '').trim().toUpperCase();
}

function getBetaWorkflowPhase(): BetaWorkflowPhase {
  if (isCartridgeStation()) return 'cartridge_ocr';
  if (isLrmOnlyStation()) return 'lrm_pairing';
  const saved = localStorage.getItem(BETA_WORKFLOW_PHASE_KEY);
  return saved === 'cartridge_ocr' ? 'cartridge_ocr' : 'lrm_pairing';
}

function setBetaWorkflowPhase(phase: BetaWorkflowPhase) {
  if (!isCartridgeStation() && !isLrmOnlyStation()) {
    localStorage.setItem(BETA_WORKFLOW_PHASE_KEY, phase);
  }
}

function setStationRoleUrlParam(role: StationRole) {
  const url = new URL(window.location.href);
  if (role === 'full') url.searchParams.delete('station');
  else url.searchParams.set('station', role);

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(null, '', nextUrl);
}

function hasUnsafeLocalBetaWorkInProgress() {
  if (scanInFlight) return true;
  if (!betaCurrentUnit) return false;

  // In LRM Pairing Station, an empty next row is safe to rebuild when the OCR
  // station broadcasts updates. Do not rebuild only when the operator has
  // already captured part of a local pair.
  if (getBetaWorkflowPhase() === 'lrm_pairing') {
    return Boolean(betaCurrentUnit.shroudRaw || betaCurrentUnit.lrm);
  }

  // In Cartridge OCR Station, a loaded row means the station may be waiting for
  // the sensor/OCR/correction flow. Do not overwrite that local state.
  return true;
}

function normalizeLookupKey(value: string | null | undefined) {
  return (value ?? '').trim().toUpperCase();
}

function getBetaQrInfoMap(): Record<string, string> {
  try {
    const scopedKey = getBetaQrInfoStorageKey();
    const raw = localStorage.getItem(scopedKey) ?? localStorage.getItem(BETA_QR_INFO_MAP_KEY) ?? '{}';
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function setBetaQrInfoMap(map: Record<string, string>) {
  localStorage.setItem(getBetaQrInfoStorageKey(), JSON.stringify(map));
}

function getImportedCustomerQr(sequenceLabel: string) {
  const map = getBetaQrInfoMap();
  const direct = map[normalizeLookupKey(sequenceLabel)];
  if (direct) return direct;

  const sequenceNum = expectedSequenceNumericValue(sequenceLabel);
  if (sequenceNum === null) return '';

  for (const [label, qr] of Object.entries(map)) {
    if (expectedSequenceNumericValue(label) === sequenceNum) return qr;
  }

  return '';
}

function extractCustomerQrSequence(qrCode: string) {
  const zPart = qrCode
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse()
    .find((part) => /^Z\d+$/i.test(part));
  return zPart ?? '';
}

function getBetaMixwheelLot() {
  return localStorage.getItem(BETA_MIXWHEEL_LOT_KEY) ?? '';
}

function getBetaSampleCapLot() {
  return localStorage.getItem(BETA_SAMPLE_CAP_LOT_KEY) ?? '';
}

function setBetaMaterialLots(mixwheelLot: string, sampleCapLot: string) {
  localStorage.setItem(BETA_MIXWHEEL_LOT_KEY, mixwheelLot.trim());
  localStorage.setItem(BETA_SAMPLE_CAP_LOT_KEY, sampleCapLot.trim());
}

function createBetaRunId(build: string, lyo: string) {
  const safeBuild = build.trim() || 'build';
  const safeLyo = lyo.trim().replace(/[^a-z0-9_-]+/gi, '_') || 'lyo';
  return `${safeBuild}-${safeLyo}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function getBetaRunId() {
  return localStorage.getItem(BETA_RUN_ID_KEY) ?? '';
}

function setBetaRunId(runId: string) {
  localStorage.setItem(BETA_RUN_ID_KEY, runId);
}

function getBetaQrInfoStorageKey() {
  const runId = getBetaRunId();
  return runId ? `${BETA_QR_INFO_MAP_KEY}:${runId}` : BETA_QR_INFO_MAP_KEY;
}

function getStationLabel() {
  if (stationRole === 'cartridge') return 'Cartridge OCR Station';
  if (stationRole === 'lrm') return 'LRM Pairing Station';
  return 'Single-Window Station';
}

function isCartridgeStation() {
  return stationRole === 'cartridge';
}

function isLrmOnlyStation() {
  return stationRole === 'lrm';
}

function shouldIgnoreDuplicateScan(source: string, raw: string) {
  const now = performance.now();
  const signature = `${stationRole}|${source}|${normalizeScannerText(raw)}`;
  if (signature && signature === lastScanSignature && now - lastScanAt < SCAN_DEBOUNCE_MS) {
    return true;
  }
  lastScanSignature = signature;
  lastScanAt = now;
  return false;
}


function scannerSerialAvailable() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function getScannerBaudRate() {
  const selected = Number((document.getElementById('scannerSerialBaudSelect') as HTMLSelectElement | null)?.value);
  const saved = Number(localStorage.getItem(SCANNER_BAUD_KEY));
  const baud = Number.isFinite(selected) && selected > 0 ? selected : saved;
  return Number.isFinite(baud) && baud > 0 ? baud : DEFAULT_SCANNER_BAUD;
}

function getSerialPortLabel(port: SerialPort | null) {
  if (!port) return 'No port selected';
  const info = port.getInfo?.();
  if (info?.usbVendorId || info?.usbProductId) {
    const vendor = info.usbVendorId ? `VID ${info.usbVendorId.toString(16).toUpperCase()}` : 'VID unknown';
    const product = info.usbProductId ? `PID ${info.usbProductId.toString(16).toUpperCase()}` : 'PID unknown';
    return `${vendor} / ${product}`;
  }
  return 'Selected scanner serial port';
}

class ScannerSerialReader {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private decoder: TextDecoderStream | null = null;
  private decoderPipe: Promise<void> | null = null;
  private activeLoop: Promise<void> | null = null;
  private open = false;

  constructor(private readonly route: ScannerRoute) { }

  get isOpen() {
    return this.open;
  }

  get label() {
    return this.route === 'lrm' ? 'LRM Pairing Scanner' : 'Cartridge OCR Scanner';
  }

  get portLabel() {
    return getSerialPortLabel(this.port);
  }

  async connect(baudRate = getScannerBaudRate()) {
    if (!scannerSerialAvailable()) {
      updateScannerSerialState(this.route, {
        status: 'error',
        message: 'Web Serial unavailable',
        portLabel: 'No port selected',
      });
      updateStatus('Web Serial is not available in this browser/build. Use Chrome/Electron with serial support.', 'error');
      return;
    }

    await this.disconnect(false);
    updateScannerSerialState(this.route, {
      status: 'connecting',
      message: `Selecting ${this.label}...`,
      portLabel: 'No port selected',
    });

    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate });
      if (!port.readable) throw new Error('SCANNER_STREAM_UNAVAILABLE');

      this.port = port;
      this.decoder = new TextDecoderStream();
      this.decoderPipe = (port.readable as ReadableStream<Uint8Array>)
        .pipeTo(this.decoder.writable as WritableStream<Uint8Array>)
        .catch(() => {
          // Expected during disconnect/unplug.
        });
      this.reader = this.decoder.readable.getReader();
      this.open = true;

      updateScannerSerialState(this.route, {
        status: 'connected',
        message: `Connected at ${baudRate} baud`,
        portLabel: this.portLabel,
      });
      updateStatus(`${this.label} connected. Scans from this COM port will route even when the window is not focused.`, 'success');

      this.activeLoop = this.readLoop();
      void this.activeLoop;
    } catch (error) {
      console.error(`${this.label} connection failed`, error);
      await this.disconnect(false);
      const msg = error instanceof Error && error.message.includes('No port selected')
        ? 'Scanner selection canceled'
        : 'Could not open scanner COM port';
      updateScannerSerialState(this.route, {
        status: error instanceof Error && error.message.includes('No port selected') ? 'disconnected' : 'error',
        message: msg,
        portLabel: 'No port selected',
      });
      updateStatus(`${this.label}: ${msg}.`, error instanceof Error && error.message.includes('No port selected') ? 'warn' : 'error');
    }
  }

  private async readLoop() {
    const reader = this.reader;
    if (!reader) return;

    let buffer = '';

    try {
      for (; ;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value ?? '';

        let match = buffer.match(/[\r\n]/);
        while (match && match.index !== undefined) {
          const line = buffer.slice(0, match.index).trim();
          buffer = buffer.slice(match.index + 1);
          if (line) {
            updateScannerSerialState(this.route, {
              status: 'connected',
              message: 'Scan received',
              portLabel: this.portLabel,
              lastScan: line,
            });
            await routeSerialScannerScan(this.route, line);
          }
          match = buffer.match(/[\r\n]/);
        }

        if (buffer.length > 4096) buffer = buffer.slice(-1024);
      }
    } catch (error) {
      console.warn(`${this.label} read loop stopped`, error);
    } finally {
      if (this.open) {
        this.open = false;
        updateScannerSerialState(this.route, {
          status: 'disconnected',
          message: 'Disconnected',
          portLabel: 'No port selected',
        });
      }
    }
  }

  async disconnect(showMessage = true) {
    this.open = false;
    const reader = this.reader;
    const decoderPipe = this.decoderPipe;
    const port = this.port;

    this.reader = null;
    this.decoder = null;
    this.decoderPipe = null;
    this.activeLoop = null;
    this.port = null;

    if (reader) {
      try { await reader.cancel(); } catch { }
      try { reader.releaseLock(); } catch { }
    }
    if (decoderPipe) {
      try { await Promise.race([decoderPipe, new Promise((resolve) => setTimeout(resolve, 500))]); } catch { }
    }
    if (port) {
      try { await port.close(); } catch { }
    }

    updateScannerSerialState(this.route, {
      status: 'disconnected',
      message: 'Disconnected',
      portLabel: 'No port selected',
    });
    if (showMessage) updateStatus(`${this.label} disconnected.`, 'info');
  }
}

const scannerSerialReaders: Record<ScannerRoute, ScannerSerialReader> = {
  lrm: new ScannerSerialReader('lrm'),
  cartridge: new ScannerSerialReader('cartridge'),
};

const scannerSerialStates: Record<ScannerRoute, ScannerSerialState> = {
  lrm: { status: 'disconnected', message: 'Disconnected', portLabel: 'No port selected' },
  cartridge: { status: 'disconnected', message: 'Disconnected', portLabel: 'No port selected' },
};

let ocrKeyboardScannerBuffer = '';
let ocrKeyboardScannerLastKeyAt = 0;

function updateScannerSerialState(route: ScannerRoute, patch: Partial<ScannerSerialState>) {
  scannerSerialStates[route] = { ...scannerSerialStates[route], ...patch };
  refreshScannerSerialUi();
}

function setScannerInputValue(input: HTMLInputElement | null, value: string) {
  if (!input) return;
  input.value = value;
}

function isModalOrDialogOpen() {
  const overrideModal = Array.from(document.querySelectorAll<HTMLElement>('body > .fixed')).some(
    (el) => String(el.className).includes('z-[1000]') && !el.classList.contains('hidden'),
  );
  const arduinoModal = document.getElementById('arduinoModal');
  return overrideModal || Boolean(arduinoModal && !arduinoModal.classList.contains('hidden'));
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest?.('[contenteditable="true"]'));
}

async function routeKeyboardOcrScannerScan(raw: string) {
  const value = raw.trim();
  if (!value) return;
  if (shouldIgnoreDuplicateScan('keyboard-ocr', value)) return;

  if (currentAppMode !== 'traceability_beta') {
    updateStatus('Keyboard OCR scanner ignored: Traceability mode is not active.', 'warn');
    return;
  }

  if (!isCartridgeStation()) {
    updateStatus('Keyboard OCR scanner scan ignored on this station. Keep the Cartridge OCR Station window active for the NETUM scanner.', 'warn');
    return;
  }

  if (scanInFlight) {
    updateStatus('Keyboard OCR scanner ignored. Finish the active Top Plate OCR first.', 'warn');
    return;
  }

  if (getBetaWorkflowPhase() !== 'cartridge_ocr') {
    setBetaWorkflowPhase('cartridge_ocr');
    updateBetaRunUI();
  }

  setScannerInputValue(betaShroudScanInputEl, value);
  await handleBetaShroudScan();
}

function shouldCaptureOcrKeyboardScannerEvent(event: KeyboardEvent) {
  if (!isCartridgeStation()) return false;
  if (currentAppMode !== 'traceability_beta') return false;
  if (!hasActiveBetaRun()) return false;
  if (isModalOrDialogOpen()) return false;
  // Let normal typing and keyboard-wedge scans flow into the focused input.
  // The input's Enter handler will route the scan. Global capture remains active
  // when focus is not in an editable field.
  if (isEditableKeyboardTarget(event.target)) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return false;
  if (event.key.length === 1) return true;
  return event.key === 'Enter';
}

function installOcrKeyboardScannerRouter() {
  document.addEventListener(
    'keydown',
    (event) => {
      if (!shouldCaptureOcrKeyboardScannerEvent(event)) return;

      const now = performance.now();
      if (now - ocrKeyboardScannerLastKeyAt > OCR_KEYBOARD_SCANNER_TIMEOUT_MS) {
        ocrKeyboardScannerBuffer = '';
      }
      ocrKeyboardScannerLastKeyAt = now;

      if (event.key === 'Enter') {
        const scan = ocrKeyboardScannerBuffer.trim();
        ocrKeyboardScannerBuffer = '';
        if (scan) {
          event.preventDefault();
          event.stopPropagation();
          void routeKeyboardOcrScannerScan(scan);
        }
        return;
      }

      if (event.key.length === 1) {
        ocrKeyboardScannerBuffer += event.key;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}

async function routeSerialScannerScan(route: ScannerRoute, raw: string) {
  const value = raw.trim();
  if (!value) return;
  if (shouldIgnoreDuplicateScan(`serial-${route}`, value)) return;

  if (currentAppMode !== 'traceability_beta') {
    updateStatus(`${route === 'lrm' ? 'LRM' : 'OCR'} scanner ignored: Traceability mode is not active.`, 'warn');
    return;
  }

  if (route === 'cartridge') {
    if (scanInFlight) {
      updateStatus('OCR scanner ignored. Finish the active Top Plate OCR first.', 'warn');
      return;
    }
    if (getBetaWorkflowPhase() !== 'cartridge_ocr' && !isLrmOnlyStation()) {
      setBetaWorkflowPhase('cartridge_ocr');
      updateBetaRunUI();
    }
    setScannerInputValue(betaShroudScanInputEl, value);
    await handleBetaShroudScan();
    return;
  }

  if (getBetaWorkflowPhase() !== 'lrm_pairing' && !isCartridgeStation()) {
    setBetaWorkflowPhase('lrm_pairing');
    updateBetaRunUI();
  }

  if (betaSpecialAction) {
    setScannerInputValue(betaShroudScanInputEl, value);
    await handleBetaShroudScan();
    return;
  }

  if (betaCurrentUnit?.shroudRaw) {
    setScannerInputValue(betaLrmScanInputEl, value);
    await handleBetaLrmScan();
  } else {
    setScannerInputValue(betaShroudScanInputEl, value);
    await handleBetaShroudScan();
  }
}

function scannerStatusClass(status: ScannerSerialStatus) {
  if (status === 'connected') return 'text-emerald-700';
  if (status === 'connecting') return 'text-indigo-700';
  if (status === 'error') return 'text-red-700';
  return 'text-gray-600';
}

function refreshScannerSerialUi() {
  const baudSelect = document.getElementById('scannerSerialBaudSelect') as HTMLSelectElement | null;
  if (baudSelect) {
    const saved = String(localStorage.getItem(SCANNER_BAUD_KEY) ?? DEFAULT_SCANNER_BAUD);
    if (!baudSelect.value) baudSelect.value = saved;
  }

  for (const route of ['lrm', 'cartridge'] as const) {
    const state = scannerSerialStates[route];
    const statusEl = document.getElementById(`${route}ScannerSerialStatus`);
    const portEl = document.getElementById(`${route}ScannerSerialPort`);
    const lastEl = document.getElementById(`${route}ScannerSerialLast`);
    const connectBtn = document.getElementById(`${route}ScannerConnectBtn`) as HTMLButtonElement | null;
    const disconnectBtn = document.getElementById(`${route}ScannerDisconnectBtn`) as HTMLButtonElement | null;

    if (statusEl) {
      statusEl.textContent = state.message;
      statusEl.className = `font-semibold ${scannerStatusClass(state.status)}`;
    }
    if (portEl) portEl.textContent = state.portLabel;
    if (lastEl) lastEl.textContent = state.lastScan ? `Last scan: ${state.lastScan}` : 'Last scan: none';
    if (connectBtn) connectBtn.disabled = scannerSerialReaders[route].isOpen || state.status === 'connecting';
    if (disconnectBtn) disconnectBtn.disabled = !scannerSerialReaders[route].isOpen;
  }
}

function isWorkflowStatusComplete(record: {
  workflowStatus?: ScanRecord['workflowStatus'];
  top?: string | null;
  topFinal?: string | null;
  sequenceNumber?: string;
  condition?: string;
}) {
  if (record.workflowStatus === 'complete' || record.workflowStatus === 'post_ocr_reject') return true;
  if (record.workflowStatus) return false;

  const top = record.topFinal ?? record.top ?? '';
  const seq = record.sequenceNumber ?? record.condition ?? '';

  return (
    isNonEmptyString(top) &&
    top !== 'NO_CODE_FOUND' &&
    topMatchesExpectedSequence(top, seq)
  );
}

function isNonEmptyString(value: string | null | undefined) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBetaCartridgeCompleteRecord(record: ScanRecord | { workflowStatus?: ScanRecord['workflowStatus']; topFinal?: string | null; top?: string | null; sequenceNumber?: string; condition?: string }) {
  return isWorkflowStatusComplete(record);
}

function sequenceScansMatch(scannedRaw: string, expectedSequence: string) {
  const scannedNorm = normalizeScannerText(scannedRaw);
  const expectedNorm = normalizeScannerText(expectedSequence);
  if (scannedNorm && expectedNorm && scannedNorm === expectedNorm) return true;

  const scannedNum = parseShroudQrSequence(scannedRaw);
  const expectedNum = expectedSequenceNumericValue(expectedSequence);
  return scannedNum !== null && expectedNum !== null && scannedNum === expectedNum;
}

function betaRecordMatchesActiveRun(record: { mode?: string; runId?: string; buildNumber?: string; lyoCondition?: string }) {
  if (record.mode !== 'traceability_beta') return false;
  const activeRunId = getBetaRunId().trim();
  if (activeRunId && record.runId) return record.runId === activeRunId;

  // Legacy fallback for records created before true Run ID existed.
  const build = getBetaBuild().trim();
  const lyo = getBetaLyo().trim();
  if (build && (record.buildNumber ?? '').trim() !== build) return false;
  if (lyo && (record.lyoCondition ?? '').trim() !== lyo) return false;
  return true;
}

async function findBetaRecordBySequenceScan(scannedRaw: string) {
  const records = await db.getAll();
  const matches = records
    .filter(betaRecordMatchesActiveRun)
    .filter((record) => sequenceScansMatch(scannedRaw, record.sequenceNumber ?? record.condition ?? ''));

  return pickBestBetaRecord(matches);
}

async function findBetaRecordByLrm(lrm: string) {
  const lrmNorm = normalizeScannerText(lrm);
  if (!lrmNorm) return undefined;

  const records = await db.getAll();
  return records
    .filter(betaRecordMatchesActiveRun)
    .filter((record) => normalizeScannerText(record.lrm) === lrmNorm)
    .sort((a, b) => b.ts - a.ts)[0];
}

function isLikelyDuplicateQrAtLrmStep(
  lrmRaw: string,
  shroudRaw: string | null,
  expectedSequence: string,
) {
  const lrmNorm = normalizeScannerText(lrmRaw);
  const shroudNorm = normalizeScannerText(shroudRaw);

  const parsedShroudSeq = parseShroudQrSequence(shroudRaw ?? '');
  const lrmNum = extractTrailingNumericValue(lrmRaw);
  const expectedNum = expectedSequenceNumericValue(expectedSequence);

  const matchesRawQr = !!lrmNorm && lrmNorm === shroudNorm;
  const matchesParsedQrSequence =
    lrmNum !== null && parsedShroudSeq !== null && lrmNum === parsedShroudSeq;
  const matchesExpectedSequence = lrmNum !== null && expectedNum !== null && lrmNum === expectedNum;

  return matchesRawQr || matchesParsedQrSequence || matchesExpectedSequence;
}

function scrollTableRowIntoView(
  row: HTMLTableRowElement | null,
  block: ScrollLogicalPosition = 'nearest',
) {
  const target = tableScrollContainer;
  if (!target || !row) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      row.scrollIntoView({
        behavior: 'smooth',
        block,
        inline: 'nearest',
      });
    });
  });
}

function scrollTableToSequence(sequence: string | null, block: ScrollLogicalPosition = 'center') {
  if (!sequence) return false;
  const row = getBetaTableRowBySequence(sequence);
  if (!row) return false;
  scrollTableRowIntoView(row, block);
  return true;
}

function scrollTableToBottom() {
  const target = tableScrollContainer;
  if (!target) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const lastRow = tableBody.querySelector('tr:last-child') as HTMLTableRowElement | null;

      if (lastRow) {
        scrollTableRowIntoView(lastRow, 'end');
      } else {
        target.scrollTop = target.scrollHeight;
      }
    });
  });
}

function shouldPreserveOcrTableFocus() {
  return (
    currentAppMode === 'traceability_beta' &&
    (isCartridgeStation() || (!isLrmOnlyStation() && getBetaWorkflowPhase() === 'cartridge_ocr'))
  );
}

function scrollBetaTableAfterRender() {
  if (shouldPreserveOcrTableFocus() && scrollTableToSequence(lastOcrFocusedSequence, 'center')) {
    return;
  }

  if (getBetaWorkflowPhase() === 'lrm_pairing' || isLrmOnlyStation()) {
    scrollTableToBottom();
  }
}

function getOcrMaxAttempts() {
  return SIM_MODE ? SIM_OCR_MAX_ATTEMPTS : OCR_MAX_ATTEMPTS;
}

async function settleBeforeOcr() {
  if (!SIM_MODE) {
    await waitForFreshFrame(webcam2, CAPTURE_SETTLE_FRAMES);
    await settleAfterPresence([webcam2], 1, 0, waitForFreshFrame);

    if (CAPTURE_EXTRA_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, CAPTURE_EXTRA_DELAY_MS));
    }
  } else {
    await waitForFreshFrame(webcam2, 1);
    await new Promise((r) => setTimeout(r, 30));
  }
}

// ---------- Standard mode helpers ----------
function parseConditionSeed(seed: string) {
  const m = seed.match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { base: m[1], next: Number(m[2]), pad: m[2].length };
}

function parseMissingNumbersInput(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: true as const,
      values: [] as number[],
      invalidTokens: [] as string[],
    };
  }

  const tokens = trimmed
    .split(/[,\n\r\t ]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const invalidTokens: string[] = [];
  const values = new Set<number>();

  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      invalidTokens.push(token);
      continue;
    }

    const num = Number(token);
    if (!Number.isInteger(num) || num < 0) {
      invalidTokens.push(token);
      continue;
    }

    values.add(num);
  }

  return {
    ok: invalidTokens.length === 0,
    values: [...values].sort((a, b) => a - b),
    invalidTokens,
  };
}

function getRunBase() {
  return localStorage.getItem(RUN_BASE_KEY) ?? '';
}
function getRunNext() {
  return Number(localStorage.getItem(RUN_NEXT_KEY) ?? '0');
}
function getRunPad() {
  return Number(localStorage.getItem(RUN_PAD_KEY) ?? '3');
}
function getRunLyo() {
  return localStorage.getItem(RUN_LYO_KEY) ?? '';
}

function getLrmMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(RUN_LRM_MAP_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function setLrmMap(m: Record<string, string>) {
  localStorage.setItem(RUN_LRM_MAP_KEY, JSON.stringify(m));
}

function getRunMissingNumbers(): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RUN_MISSING_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function setRunMissingNumbers(values: number[]) {
  const normalized = [...new Set(values)]
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0)
    .sort((a, b) => a - b);

  localStorage.setItem(RUN_MISSING_KEY, JSON.stringify(normalized));
}

function formatRunMissingNumbers(values: number[], width = getRunPad()) {
  if (!values.length) return 'None';
  return values.map((n) => padNum(n, width)).join(', ');
}

function isMissingSequenceNumber(n: number) {
  return getRunMissingNumbers().includes(n);
}

function getNextAssignableSequence(start: number) {
  let next = start;
  while (isMissingSequenceNumber(next)) {
    next += 1;
  }
  return next;
}

function hasActiveRun() {
  return !!getRunBase() && getRunNext() > 0 && !!getRunLyo();
}

function clearRunStateOnly() {
  localStorage.removeItem(RUN_BASE_KEY);
  localStorage.removeItem(RUN_NEXT_KEY);
  localStorage.removeItem(RUN_PAD_KEY);
  localStorage.removeItem(RUN_LRM_MAP_KEY);
  localStorage.removeItem(RUN_LYO_KEY);
  localStorage.removeItem(RUN_MISSING_KEY);
}

function updateRunUI() {
  const active = hasActiveRun();

  if (conditionEmptyEl) conditionEmptyEl.classList.toggle('hidden', active);
  if (conditionActiveEl) conditionActiveEl.classList.toggle('hidden', !active);

  if (activeConditionValueEl) {
    activeConditionValueEl.textContent = active
      ? `${getRunBase()}${padNum(getRunNext(), getRunPad())}`
      : '';
  }

  if (activeLyoConditionValueEl) {
    activeLyoConditionValueEl.textContent = active ? getRunLyo() : '';
  }

  if (activeMissingCartridgesValueEl) {
    activeMissingCartridgesValueEl.textContent = active
      ? formatRunMissingNumbers(getRunMissingNumbers(), getRunPad())
      : 'None';
  }

  if (activeMissingCartridgesInputEl) {
    activeMissingCartridgesInputEl.value = active
      ? getRunMissingNumbers()
        .map((n) => padNum(n, getRunPad()))
        .join(', ')
      : '';
  }
}

function startRunFromSeedAndLyo(seed: string, lyoCondition: string, missingRaw: string) {
  const parsed = parseConditionSeed(seed);
  if (!parsed) {
    return { ok: false as const, reason: 'invalid-seed' as const };
  }

  const parsedMissing = parseMissingNumbersInput(missingRaw);
  if (!parsedMissing.ok) {
    return {
      ok: false as const,
      reason: 'invalid-missing' as const,
      invalidTokens: parsedMissing.invalidTokens,
    };
  }

  const normalizedMissing = parsedMissing.values.filter((n) => n >= parsed.next);
  setRunMissingNumbers(normalizedMissing);

  const startingNext = getNextAssignableSequence(parsed.next);

  localStorage.setItem(RUN_BASE_KEY, parsed.base);
  localStorage.setItem(RUN_NEXT_KEY, String(startingNext));
  localStorage.setItem(RUN_PAD_KEY, String(parsed.pad));
  localStorage.setItem(RUN_LRM_MAP_KEY, JSON.stringify({}));
  localStorage.setItem(RUN_LYO_KEY, lyoCondition.trim());

  return {
    ok: true as const,
    skippedAtStart: startingNext !== parsed.next,
    startingNext,
    missingNumbers: normalizedMissing,
  };
}

function assignConditionForLrm(lrm: string) {
  const map = getLrmMap();
  if (map[lrm]) return map[lrm];

  const base = getRunBase();
  const pad = getRunPad();

  const assignableNext = getNextAssignableSequence(getRunNext());
  const assigned = `${base}${padNum(assignableNext, pad)}`;

  map[lrm] = assigned;
  setLrmMap(map);

  localStorage.setItem(RUN_NEXT_KEY, String(getNextAssignableSequence(assignableNext + 1)));
  updateRunUI();

  return assigned;
}

function syncLrmMapForOverride(previousLrm: string, nextLrm: string, assignedCondition: string) {
  if (!assignedCondition) return { ok: true as const };

  const map = getLrmMap();
  const existingAssigned = map[nextLrm];

  if (nextLrm !== previousLrm && existingAssigned && existingAssigned !== assignedCondition) {
    return {
      ok: false as const,
      conflictCondition: existingAssigned,
    };
  }

  if (previousLrm && map[previousLrm] === assignedCondition) {
    delete map[previousLrm];
  }

  if (nextLrm) {
    map[nextLrm] = assignedCondition;
  }

  setLrmMap(map);
  return { ok: true as const };
}

function updateRunMissingNumbersLive(raw: string) {
  if (!hasActiveRun()) {
    return { ok: false as const, reason: 'no-run' as const };
  }

  const parsed = parseMissingNumbersInput(raw);
  if (!parsed.ok) {
    return {
      ok: false as const,
      reason: 'invalid-missing' as const,
      invalidTokens: parsed.invalidTokens,
    };
  }

  const currentNext = getRunNext();
  const invalidPast = parsed.values.filter((n) => n < currentNext);
  if (invalidPast.length) {
    return {
      ok: false as const,
      reason: 'past-values' as const,
      values: invalidPast,
    };
  }

  setRunMissingNumbers(parsed.values);
  localStorage.setItem(RUN_NEXT_KEY, String(getNextAssignableSequence(currentNext)));
  updateRunUI();

  return {
    ok: true as const,
    values: parsed.values,
  };
}

// ---------- Beta helpers ----------
function hasActiveBetaRun() {
  return (
    !!localStorage.getItem(BETA_BUILD_KEY) &&
    !!localStorage.getItem(BETA_LYO_KEY) &&
    !!localStorage.getItem(BETA_NEXT_SEQUENCE_KEY)
  );
}

function getBetaBuild() {
  return localStorage.getItem(BETA_BUILD_KEY) ?? '';
}

function getBetaLyo() {
  return localStorage.getItem(BETA_LYO_KEY) ?? '';
}

function getBetaExpectedSequence() {
  return localStorage.getItem(BETA_NEXT_SEQUENCE_KEY) ?? '';
}

function setBetaExpectedSequence(value: string) {
  localStorage.setItem(BETA_NEXT_SEQUENCE_KEY, value);
}

function getBetaMissingNumbers(): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BETA_MISSING_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function setBetaMissingNumbers(values: number[]) {
  const normalized = [...new Set(values)]
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0)
    .sort((a, b) => a - b);

  localStorage.setItem(BETA_MISSING_KEY, JSON.stringify(normalized));
}

function formatBetaMissingNumbers(values: number[], template?: string) {
  if (!values.length) return 'None';
  return values.map((n) => formatBetaSequenceNumber(n, template)).join(', ');
}

function isBetaMissingSequenceNumber(n: number) {
  return getBetaMissingNumbers().includes(n);
}

function getNextAssignableBetaSequence(startSequence: string) {
  let next = startSequence;
  let nextNum = expectedSequenceNumericValue(next);

  while (nextNum !== null && isBetaMissingSequenceNumber(nextNum)) {
    next = incrementSequence(next);
    nextNum = expectedSequenceNumericValue(next);
  }

  return next;
}

function clearBetaRunStateOnly() {
  localStorage.removeItem(BETA_BUILD_KEY);
  localStorage.removeItem(BETA_LYO_KEY);
  localStorage.removeItem(BETA_NEXT_SEQUENCE_KEY);
  localStorage.removeItem(BETA_MISSING_KEY);
  localStorage.removeItem(BETA_RUN_ID_KEY);
  betaCurrentUnit = null;
  state = 'IDLE';
}

function ensureBetaWorkflowPhaseControl() {
  if (betaWorkflowPhaseSelectEl) return betaWorkflowPhaseSelectEl;

  const currentStepBlock = betaCurrentStepValueEl?.parentElement;
  if (!currentStepBlock) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'mt-3 rounded-md border border-indigo-100 bg-white/70 p-2';
  wrapper.innerHTML = `
    <label for="betaWorkflowPhaseSelect" class="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
      Workflow Stage
    </label>
    <select id="betaWorkflowPhaseSelect" class="table-cell-input mt-2 text-sm">
      <option value="lrm_pairing">LRM Pairing / Build LRM List</option>
      <option value="cartridge_ocr">Cartridge OCR / Append Cartridge Data</option>
    </select>
    <p id="betaWorkflowPhaseHelp" class="mt-2 text-xs text-gray-500"></p>
  `.trim();

  currentStepBlock.before(wrapper);
  betaWorkflowPhaseSelectEl = wrapper.querySelector('#betaWorkflowPhaseSelect');

  betaWorkflowPhaseSelectEl?.addEventListener('change', () => {
    void (async () => {
      const nextPhase =
        betaWorkflowPhaseSelectEl?.value === 'cartridge_ocr' ? 'cartridge_ocr' : 'lrm_pairing';
      betaSpecialAction = null;
      setBetaWorkflowPhase(nextPhase);
      betaCurrentUnit = null;
      armedRow = null;
      scanInFlight = false;
      state = 'WAITING_QR';
      resetBetaInputsAfterCompletion();

      await renderBetaTableForActiveRun();
      updateBetaRunUI();
      resetOcrPreviews();
      updateStatus(
        nextPhase === 'lrm_pairing'
          ? `LRM Pairing active. Next LRM sequence: ${getBetaExpectedSequence()}. Scan Sequence QR.`
          : 'Cartridge OCR active. Scan the outside Sequence QR on a passing leak-tested assembly.',
        'info',
      );
    })();
  });

  return betaWorkflowPhaseSelectEl;
}

function updateBetaWorkflowPhaseHelp() {
  const phase = getBetaWorkflowPhase();
  const help = document.getElementById('betaWorkflowPhaseHelp') as HTMLParagraphElement | null;
  if (!help) return;

  help.textContent =
    phase === 'lrm_pairing'
      ? 'Use before shrouding: scan Sequence QR, then scan exposed LRM. No cartridge OCR happens in this stage.'
      : 'Use after shrouding + leak test: failed units are pulled; only passing units are scanned by Sequence QR for cartridge OCR.';
}

function setElementHidden(el: Element | null, hidden: boolean) {
  if (!el) return;
  el.classList.toggle('hidden', hidden);
}

function applyStationRoleUI() {
  body.classList.toggle('lrm-station', isLrmOnlyStation());
  body.classList.toggle('cartridge-station', isCartridgeStation());
  body.classList.toggle('single-station', !isLrmOnlyStation() && !isCartridgeStation());

  let banner = document.getElementById('stationRoleBanner') as HTMLDivElement | null;
  if (!banner && traceabilityRunPanelEl) {
    banner = document.createElement('div');
    banner.id = 'stationRoleBanner';
    banner.className = 'mb-3 rounded-lg border p-3 text-sm font-semibold';
    traceabilityRunPanelEl.prepend(banner);
  }

  if (banner) {
    banner.classList.remove('border-emerald-200', 'bg-emerald-50', 'text-emerald-800', 'border-indigo-200', 'bg-indigo-50', 'text-indigo-800', 'border-slate-200', 'bg-slate-50', 'text-slate-800');
    if (isCartridgeStation()) {
      banner.classList.add('border-emerald-200', 'bg-emerald-50', 'text-emerald-800');
      banner.textContent = 'CARTRIDGE OCR STATION — scan passing unit Sequence QR, then place cartridge for OCR.';
    } else if (isLrmOnlyStation()) {
      banner.classList.add('border-indigo-200', 'bg-indigo-50', 'text-indigo-800');
      banner.textContent = 'LRM PAIRING STATION — scan Sequence QR, then exposed LRM. Cameras and Arduino are released for OCR station.';
    } else {
      banner.classList.add('border-slate-200', 'bg-slate-50', 'text-slate-800');
      banner.textContent = 'SINGLE-WINDOW STATION — use workflow stage selector, or open a dedicated Cartridge OCR Station.';
    }
  }

  const cameraPanels = Array.from(document.querySelectorAll('main > section.bg-white'));
  for (const panel of cameraPanels) setElementHidden(panel, isLrmOnlyStation());

  const appModePanel = appModeSelectEl?.closest('.rounded-lg') ?? null;
  setElementHidden(appModePanel, isLrmOnlyStation());

  if (isLrmOnlyStation()) {
    try { stopAllCameraStreams?.(); } catch { }
    ensureLrmOperatorDock();
  }

  if (betaWorkflowPhaseSelectEl) {
    betaWorkflowPhaseSelectEl.value = getBetaWorkflowPhase();
    betaWorkflowPhaseSelectEl.disabled = isCartridgeStation() || isLrmOnlyStation();
  }

  document.title = `${getStationLabel()} - Smart Cartridge Build Tracker`;
}

function enterLrmPairingStationMode() {
  stationRole = 'lrm';
  setStationRoleUrlParam('lrm');
  betaSpecialAction = null;
  betaCurrentUnit = null;
  armedRow = null;
  scanInFlight = false;
  state = 'WAITING_QR';
  try { stopAllCameraStreams?.(); } catch { }
  try { void disconnectArduino?.(); } catch { }
  applyStationRoleUI();
  updateBetaRunUI();
  setBetaStep('scan_shroud');
  updateStatus('LRM Pairing Station active. Cartridge OCR runs in the popup window.', 'success');
}

function openCartridgeOcrStation() {
  const url = new URL(window.location.href);
  url.searchParams.set('station', 'cartridge');
  const popup = window.open(url.toString(), 'cartridgeOcrStation', 'popup=yes,width=1400,height=900');
  if (!popup) {
    updateStatus('Popup blocked. Allow popups, then try Open Cartridge OCR Station again.', 'error');
    return;
  }

  enterLrmPairingStationMode();
  popup.focus();
}

async function enterSingleWindowStationMode(broadcast = true) {
  if (broadcast) notifyStationModeCommand('single-window');

  stationRole = 'full';
  setStationRoleUrlParam('full');
  betaSpecialAction = null;
  betaCurrentUnit = null;
  armedRow = null;
  scanInFlight = false;
  state = 'WAITING_QR';

  applyStationRoleUI();

  try {
    await initWebcams();
    wireCropControls();
  } catch (error) {
    showStartupError(error, 'Single-window camera startup');
  }

  updateBetaRunUI();
  setBetaStep('scan_shroud');
  resetOcrPreviews();
  updateStatus('Single-Window Station active. Use Workflow Stage to switch between LRM Pairing and Cartridge OCR.', 'success');
}

function getTraceabilityScanGrid() {
  if (!traceabilityActiveEl) return null;
  return (
    document.getElementById('lrmDockScanGrid')?.querySelector('.lrm-sticky-scan-grid') ??
    traceabilityActiveEl.querySelector(':scope > .mt-4.grid')
  ) as HTMLDivElement | null;
}

function ensureLrmOperatorDock() {
  if (!isLrmOnlyStation()) return;
  if (!traceabilityRunPanelEl || !traceabilityActiveEl) return;

  const aside = traceabilityRunPanelEl.closest('aside');
  const statusContainer = document.getElementById('status-container');
  if (!aside || !statusContainer) return;

  let dock = document.getElementById('lrmOperatorDock') as HTMLDivElement | null;
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'lrmOperatorDock';
    dock.className = 'lrm-operator-dock';
    dock.innerHTML = `
      <div class="lrm-dock-topline">
        <div class="min-w-0">
          <div class="lrm-dock-badge">LRM Pairing Station</div>
          <div class="lrm-dock-title">Next LRM: <span id="lrmDockExpectedSequence">—</span></div>
          <div class="lrm-dock-subtitle">Step: <span id="lrmDockCurrentStep">—</span></div>
        </div>
        <div id="lrmDockSummary" class="lrm-dock-summary">No active run</div>
        <div class="lrm-dock-actions">
          <button id="lrmDockMarkFailedBtn" type="button" class="lrm-dock-action lrm-dock-action-danger">Mark Failed / Pulled</button>
          <button id="lrmDockRecoverMissingBtn" type="button" class="lrm-dock-action lrm-dock-action-warn">Recover Missing</button>
          <button id="lrmDockOpenOcrBtn" type="button" class="lrm-dock-action lrm-dock-action-success">Open OCR Station</button>
          <button id="lrmDockToggleToolsBtn" type="button" class="lrm-dock-action lrm-dock-action-muted">Run Tools</button>
        </div>
      </div>
      <div id="lrmDockScanGrid" class="lrm-dock-scan-grid"></div>
      <div id="lrmDockStatus" class="lrm-dock-status">Ready.</div>
    `.trim();
    aside.insertBefore(dock, statusContainer);

    (dock.querySelector('#lrmDockMarkFailedBtn') as HTMLButtonElement | null)?.addEventListener('click', () => setBetaSpecialAction('mark_failed'));
    (dock.querySelector('#lrmDockRecoverMissingBtn') as HTMLButtonElement | null)?.addEventListener('click', () => setBetaSpecialAction('recover_missing'));
    (dock.querySelector('#lrmDockOpenOcrBtn') as HTMLButtonElement | null)?.addEventListener('click', openCartridgeOcrStation);
    (dock.querySelector('#lrmDockToggleToolsBtn') as HTMLButtonElement | null)?.addEventListener('click', () => {
      const details = document.getElementById('betaRunToolsDetails') as HTMLDetailsElement | null;
      if (details) {
        details.open = !details.open;
        details.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const panel = document.getElementById('betaEnhancementPanel');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const scanGrid =
    (document.getElementById('lrmDockScanGrid')?.querySelector('.lrm-sticky-scan-grid') as HTMLDivElement | null) ??
    (traceabilityActiveEl.querySelector(':scope > .mt-4.grid') as HTMLDivElement | null);
  const dockScanGrid = document.getElementById('lrmDockScanGrid') as HTMLDivElement | null;
  if (scanGrid && dockScanGrid && scanGrid.parentElement !== dockScanGrid) {
    scanGrid.classList.add('lrm-sticky-scan-grid');
    dockScanGrid.appendChild(scanGrid);
  }

  const activeSummary = traceabilityActiveEl.querySelector(':scope > .flex') as HTMLDivElement | null;
  let setupDetails = document.getElementById('lrmSetupDetails') as HTMLDetailsElement | null;
  if (!setupDetails) {
    setupDetails = document.createElement('details');
    setupDetails.id = 'lrmSetupDetails';
    setupDetails.className = 'lrm-setup-details';
    setupDetails.innerHTML = `
      <summary>
        <span>Run setup / missing sequence details</span>
        <span class="lrm-setup-summary-help">Open only when editing run setup or missing sequence list.</span>
      </summary>
      <div id="lrmSetupDetailsBody" class="lrm-setup-details-body"></div>
    `.trim();
    traceabilityRunPanelEl.appendChild(setupDetails);
  }

  const setupBody = document.getElementById('lrmSetupDetailsBody');
  if (activeSummary && setupBody && activeSummary.parentElement !== setupBody) {
    setupBody.appendChild(activeSummary);
  }

  if (!lrmStatusMirrorObserverReady) {
    const statusMessage = document.getElementById('status-message');
    if (statusMessage) {
      const observer = new MutationObserver(() => refreshLrmOperatorDock());
      observer.observe(statusMessage, { childList: true, subtree: true, characterData: true });
      lrmStatusMirrorObserverReady = true;
    }
  }

  refreshLrmOperatorDock();
}

function refreshLrmOperatorDock(summaryText?: string) {
  if (!isLrmOnlyStation()) return;

  const expectedEl = document.getElementById('lrmDockExpectedSequence');
  const stepEl = document.getElementById('lrmDockCurrentStep');
  const summaryEl = document.getElementById('lrmDockSummary');
  const statusEl = document.getElementById('lrmDockStatus');
  const statusMessage = document.getElementById('status-message');

  if (expectedEl) expectedEl.textContent = hasActiveBetaRun() ? getBetaExpectedSequence() : 'No active run';
  if (stepEl) stepEl.textContent = betaCurrentStepValueEl?.textContent?.trim() || '—';
  if (summaryEl && summaryText) summaryEl.textContent = summaryText;
  if (statusEl && statusMessage) statusEl.textContent = statusMessage.textContent?.trim() || 'Ready.';
}

function ensureTraceabilityEnhancementPanel() {
  if (document.getElementById('betaEnhancementPanel')) return;
  if (!traceabilityRunPanelEl) return;

  const panel = document.createElement('div');
  panel.id = 'betaEnhancementPanel';
  panel.className = 'mt-3 rounded-lg border border-slate-200 bg-white p-3 space-y-3';
  panel.className = 'mt-3 rounded-xl border border-slate-200 bg-white p-4 space-y-4 lrm-run-tools';
  panel.innerHTML = `
    <details id="betaRunToolsDetails" class="run-tools-details">
      <summary class="run-tools-heading flex flex-wrap items-center justify-between gap-3 cursor-pointer">
        <div>
          <div class="text-xs font-semibold text-gray-500 uppercase tracking-wide">Run Tools</div>
          <div class="text-base font-bold text-gray-900">QR import, material lots, failures, backup</div>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <div id="betaRunSummary" class="run-summary-pill text-xs font-semibold text-gray-700">No active run</div>
          <span class="run-tools-toggle text-xs font-bold text-indigo-700">Open / Close</span>
        </div>
      </summary>

      <div class="run-tools-grid grid grid-cols-1 xl:grid-cols-3 gap-4 mt-4">
      <div class="run-tool-card qr-import-card rounded-lg border border-indigo-100 bg-indigo-50/40 p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <label for="betaQrImportText" class="block text-xs font-bold text-indigo-800 uppercase tracking-wide">
              Customer QR Info Import
            </label>
            <p class="mt-1 text-xs text-indigo-700/80">Paste from Excel/CSV or load CSV/TXT.</p>
          </div>
          <span id="betaQrImportStatus" class="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-indigo-700 shadow-sm">No QR info imported.</span>
        </div>
        <textarea
          id="betaQrImportText"
          class="table-cell-input mt-3 min-h-[92px] text-xs font-mono bg-white"
          placeholder="Paste QR info from Excel/CSV. Expected columns include Label and QR code."
        ></textarea>
        <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button id="betaImportQrBtn" type="button" class="rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700">
            Import QR Info
          </button>
          <label class="rounded-md border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 cursor-pointer text-center">
            Load CSV/TXT
            <input id="betaQrFileInput" type="file" accept=".csv,.txt" class="hidden" />
          </label>
          <button id="betaClearQrBtn" type="button" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">
            Clear QR Import
          </button>
        </div>
      </div>

      <div class="run-tool-card material-lot-card rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div class="text-xs font-bold text-slate-700 uppercase tracking-wide">Material Lots / Batches</div>
        <p class="mt-1 text-xs text-slate-500">Changes apply to future rows only.</p>
        <div class="mt-3 grid grid-cols-1 gap-3">
          <div>
            <label for="betaMixwheelLotInput" class="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Mixwheel Lot/Batch</label>
            <input id="betaMixwheelLotInput" type="text" class="table-cell-input mt-1.5 bg-white" placeholder="Example: 10300617" />
          </div>
          <div>
            <label for="betaSampleCapLotInput" class="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Sample Cap Lot/Batch</label>
            <input id="betaSampleCapLotInput" type="text" class="table-cell-input mt-1.5 bg-white" placeholder="Example: 10289762" />
          </div>
        </div>
        <button id="betaUpdateLotsBtn" type="button" class="mt-3 w-full rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800">
          Update Lots For Future Rows
        </button>
      </div>

      <div class="run-tool-card action-card rounded-lg border border-emerald-100 bg-emerald-50/40 p-4">
        <div class="text-xs font-bold text-emerald-800 uppercase tracking-wide">Production Actions</div>
        <p class="mt-1 text-xs text-emerald-700/80">Use these when a unit changes status outside normal scan flow.</p>
        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button id="betaMarkFailedBtn" type="button" class="rounded-md bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700">
            Mark Failed / Pulled
          </button>
          <button id="betaRecoverMissingBtn" type="button" class="rounded-md bg-amber-500 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-600">
            Recover Missing
          </button>
          <button id="betaPostOcrRejectBtn" type="button" class="rounded-md bg-orange-600 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-700">
            Post-OCR Reject
          </button>
          <button id="betaOpenCartridgeStationBtn" type="button" class="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700">
            Open Cartridge OCR Station
          </button>
        </div>
        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button id="betaSaveBackupBtn" type="button" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">
            Save Run Backup
          </button>
          <button id="betaLoadBackupBtn" type="button" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">
            Load Run Backup
          </button>
          <input id="betaBackupFileInput" type="file" accept=".json,application/json" class="hidden" />
        </div>
        <p class="mt-3 text-xs text-gray-600">
          Failed units are pulled and locked out of cartridge OCR. Recovered missing units return to LRM pairing.
        </p>
      </div>

      <div class="run-tool-card scanner-serial-card rounded-lg border border-cyan-100 bg-cyan-50/40 p-4 xl:col-span-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="text-xs font-bold text-cyan-800 uppercase tracking-wide">Serial Scanner Routing</div>
            <p class="mt-1 text-xs text-cyan-700/80">Use when scanners are configured as USB COM / Virtual Serial devices. Scans route by COM port, not by active input focus.</p>
          </div>
          <div class="flex items-center gap-2">
            <label for="scannerSerialBaudSelect" class="text-xs font-semibold text-cyan-800">Baud</label>
            <select id="scannerSerialBaudSelect" class="table-cell-input !w-auto bg-white text-xs py-1.5">
              <option value="115200">115200</option>
              <option value="9600">9600</option>
              <option value="57600">57600</option>
              <option value="38400">38400</option>
            </select>
          </div>
        </div>
        <div class="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div class="rounded-lg border border-white/80 bg-white p-3">
            <div class="text-xs font-bold text-gray-700 uppercase tracking-wide">LRM Pairing Scanner</div>
            <div id="lrmScannerSerialStatus" class="mt-1 text-sm font-semibold text-gray-600">Disconnected</div>
            <div id="lrmScannerSerialPort" class="mt-1 text-xs text-gray-500">No port selected</div>
            <div id="lrmScannerSerialLast" class="mt-1 text-xs text-gray-500">Last scan: none</div>
            <div class="mt-3 flex gap-2">
              <button id="lrmScannerConnectBtn" type="button" class="rounded-md bg-cyan-700 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-800">Connect LRM Scanner</button>
              <button id="lrmScannerDisconnectBtn" type="button" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">Disconnect</button>
            </div>
          </div>
          <div class="rounded-lg border border-white/80 bg-white p-3">
            <div class="text-xs font-bold text-gray-700 uppercase tracking-wide">Cartridge OCR Scanner</div>
            <div class="mt-1 text-sm font-semibold text-emerald-700">NETUM keyboard mode supported</div>
            <div class="mt-1 text-xs text-gray-600">Keep this Cartridge OCR Station window active. Scans are captured by the station, not by a specific input field.</div>
            <div id="cartridgeScannerSerialStatus" class="mt-2 text-xs font-semibold text-gray-600">Optional serial: Disconnected</div>
            <div id="cartridgeScannerSerialPort" class="mt-1 text-xs text-gray-500">No port selected</div>
            <div id="cartridgeScannerSerialLast" class="mt-1 text-xs text-gray-500">Last serial scan: none</div>
            <div class="mt-3 flex gap-2">
              <button id="cartridgeScannerConnectBtn" type="button" class="rounded-md border border-cyan-300 bg-white px-3 py-2 text-xs font-semibold text-cyan-800 hover:bg-cyan-50">Optional COM OCR Scanner</button>
              <button id="cartridgeScannerDisconnectBtn" type="button" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">Disconnect</button>
            </div>
          </div>
        </div>
        <div class="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <div class="font-bold">Hybrid mode recommended for your current setup:</div>
          <div>Connect the KEYENCE COM port as the LRM Pairing Scanner. Leave the NETUM in keyboard mode and keep the Cartridge OCR Station window active. The OCR station captures the full scanner entry globally, so the operator does not need to click the scan input each time.</div>
        </div>
      </div>
    </details>
  `.trim();

  traceabilityRunPanelEl.appendChild(panel);

  const importBtn = panel.querySelector('#betaImportQrBtn') as HTMLButtonElement | null;
  const clearQrBtn = panel.querySelector('#betaClearQrBtn') as HTMLButtonElement | null;
  const qrFileInput = panel.querySelector('#betaQrFileInput') as HTMLInputElement | null;
  const updateLotsBtn = panel.querySelector('#betaUpdateLotsBtn') as HTMLButtonElement | null;
  const markFailedBtn = panel.querySelector('#betaMarkFailedBtn') as HTMLButtonElement | null;
  const recoverMissingBtn = panel.querySelector('#betaRecoverMissingBtn') as HTMLButtonElement | null;
  const postOcrRejectBtn = panel.querySelector('#betaPostOcrRejectBtn') as HTMLButtonElement | null;
  const openCartridgeStationBtn = panel.querySelector('#betaOpenCartridgeStationBtn') as HTMLButtonElement | null;
  const saveBackupBtn = panel.querySelector('#betaSaveBackupBtn') as HTMLButtonElement | null;
  const loadBackupBtn = panel.querySelector('#betaLoadBackupBtn') as HTMLButtonElement | null;
  const backupFileInput = panel.querySelector('#betaBackupFileInput') as HTMLInputElement | null;
  const scannerBaudSelect = panel.querySelector('#scannerSerialBaudSelect') as HTMLSelectElement | null;
  const lrmScannerConnectBtn = panel.querySelector('#lrmScannerConnectBtn') as HTMLButtonElement | null;
  const lrmScannerDisconnectBtn = panel.querySelector('#lrmScannerDisconnectBtn') as HTMLButtonElement | null;
  const cartridgeScannerConnectBtn = panel.querySelector('#cartridgeScannerConnectBtn') as HTMLButtonElement | null;
  const cartridgeScannerDisconnectBtn = panel.querySelector('#cartridgeScannerDisconnectBtn') as HTMLButtonElement | null;

  importBtn?.addEventListener('click', () => {
    const text = (document.getElementById('betaQrImportText') as HTMLTextAreaElement | null)?.value ?? '';
    importBetaQrInfoText(text);
  });

  clearQrBtn?.addEventListener('click', () => {
    if (!window.confirm('Clear imported customer QR info for this browser?')) return;
    setBetaQrInfoMap({});
    notifyRunDataChanged('qr-info-cleared');
    refreshBetaEnhancementPanel();
    void updateBetaRunSummary();
    updateStatus('Imported QR info cleared.', 'info');
  });

  qrFileInput?.addEventListener('change', () => {
    const file = qrFileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const textarea = document.getElementById('betaQrImportText') as HTMLTextAreaElement | null;
      if (textarea) textarea.value = text;
      importBetaQrInfoText(text);
      qrFileInput.value = '';
    };
    reader.readAsText(file);
  });

  updateLotsBtn?.addEventListener('click', () => {
    const mixwheelLot = (document.getElementById('betaMixwheelLotInput') as HTMLInputElement | null)?.value ?? '';
    const sampleCapLot = (document.getElementById('betaSampleCapLotInput') as HTMLInputElement | null)?.value ?? '';
    setBetaMaterialLots(mixwheelLot, sampleCapLot);
    notifyRunDataChanged('material-lots-updated');
    updateStatus('Material lots updated. New values will apply to future rows only.', 'success');
    refreshBetaEnhancementPanel();
  });

  markFailedBtn?.addEventListener('click', () => setBetaSpecialAction('mark_failed'));
  recoverMissingBtn?.addEventListener('click', () => setBetaSpecialAction('recover_missing'));
  postOcrRejectBtn?.addEventListener('click', () => setBetaSpecialAction('post_ocr_reject'));
  openCartridgeStationBtn?.addEventListener('click', openCartridgeOcrStation);
  saveBackupBtn?.addEventListener('click', () => void saveBetaRunBackup());
  loadBackupBtn?.addEventListener('click', () => backupFileInput?.click());

  scannerBaudSelect?.addEventListener('change', () => {
    localStorage.setItem(SCANNER_BAUD_KEY, scannerBaudSelect.value);
    updateStatus(`Scanner baud rate set to ${scannerBaudSelect.value}. Reconnect scanner ports to apply it.`, 'info');
  });

  lrmScannerConnectBtn?.addEventListener('click', () => void scannerSerialReaders.lrm.connect());
  lrmScannerDisconnectBtn?.addEventListener('click', () => void scannerSerialReaders.lrm.disconnect());
  cartridgeScannerConnectBtn?.addEventListener('click', () => void scannerSerialReaders.cartridge.connect());
  cartridgeScannerDisconnectBtn?.addEventListener('click', () => void scannerSerialReaders.cartridge.disconnect());

  backupFileInput?.addEventListener('change', () => {
    const file = backupFileInput.files?.[0];
    if (!file) return;
    void loadBetaRunBackupFromFile(file).finally(() => {
      backupFileInput.value = '';
    });
  });

  refreshBetaEnhancementPanel();
}

function refreshBetaEnhancementPanel() {
  const qrStatus = document.getElementById('betaQrImportStatus') as HTMLDivElement | null;
  const mixwheelInput = document.getElementById('betaMixwheelLotInput') as HTMLInputElement | null;
  const sampleInput = document.getElementById('betaSampleCapLotInput') as HTMLInputElement | null;

  if (mixwheelInput && document.activeElement !== mixwheelInput) mixwheelInput.value = getBetaMixwheelLot();
  if (sampleInput && document.activeElement !== sampleInput) sampleInput.value = getBetaSampleCapLot();

  if (qrStatus) {
    const count = Object.keys(getBetaQrInfoMap()).length;
    qrStatus.textContent = count ? `${count} customer QR labels imported.` : 'No QR info imported.';
  }

  refreshScannerSerialUi();
}

function splitDelimitedLine(line: string, delimiter: ',' | '\t') {
  if (delimiter === '\t') return line.split('\t').map((cell) => cell.trim());

  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === ',' && !inQuotes) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }

    cell += ch;
  }

  cells.push(cell.trim());
  return cells;
}

function looksLikeSequenceLabel(value: string) {
  return /ME-\d+.*\d+$/i.test(value.trim()) || /^Z\d+$/i.test(value.trim());
}

function looksLikeCustomerQr(value: string) {
  return /Z\d{3,}/i.test(value) || /^CI\d+/i.test(value.trim()) || value.split(',').length >= 3;
}

function parseBetaQrImportRows(text: string) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const imported: Record<string, string> = {};
  const errors: string[] = [];
  if (!lines.length) return { imported, errors: ['No QR import rows found.'] };

  const delimiter: ',' | '\t' = lines.some((line) => line.includes('\t')) ? '\t' : ',';
  const firstCells = splitDelimitedLine(lines[0], delimiter);
  const lowerHeaders = firstCells.map((cell) => cell.trim().toLowerCase());
  const hasHeader = lowerHeaders.some((cell) => cell.includes('label') || cell.includes('qr'));
  const labelIndex = hasHeader
    ? lowerHeaders.findIndex((cell) => cell.includes('label') || cell.includes('sequence'))
    : -1;
  const qrIndex = hasHeader
    ? lowerHeaders.findIndex((cell) => cell.includes('qr'))
    : -1;

  const dataLines = hasHeader ? lines.slice(1) : lines;

  dataLines.forEach((line, index) => {
    const cells = splitDelimitedLine(line, delimiter);
    let label = '';
    let qr = '';

    if (labelIndex >= 0 && labelIndex < cells.length) label = cells[labelIndex]?.trim() ?? '';
    if (qrIndex >= 0 && qrIndex < cells.length) {
      qr = cells.slice(qrIndex).join(delimiter === ',' ? ',' : '\t').trim();
    }

    if (!label || !qr) {
      const labelCell = cells.find(looksLikeSequenceLabel) ?? '';
      const labelCellIndex = cells.findIndex((cell) => cell === labelCell);
      label = label || labelCell;

      if (labelCellIndex >= 0) {
        const qrCandidate = cells
          .filter((_, cellIndex) => cellIndex !== labelCellIndex)
          .find(looksLikeCustomerQr);
        qr = qr || qrCandidate || cells.slice(labelCellIndex + 1).join(delimiter === ',' ? ',' : '\t').trim();
      }
    }

    if (!label || !qr) {
      errors.push(`Row ${index + 1}: missing label or QR code.`);
      return;
    }

    imported[normalizeLookupKey(label)] = qr;
  });

  return { imported, errors };
}

function importBetaQrInfoText(text: string) {
  const { imported, errors } = parseBetaQrImportRows(text);
  const count = Object.keys(imported).length;

  if (!count) {
    updateStatus(errors[0] ?? 'No QR info imported. Check the pasted columns.', 'error');
    refreshBetaEnhancementPanel();
    return;
  }

  setBetaQrInfoMap({ ...getBetaQrInfoMap(), ...imported });
  refreshBetaEnhancementPanel();
  void updateBetaRunSummary();

  const errorText = errors.length ? ` ${errors.length} row(s) skipped.` : '';
  notifyRunDataChanged('qr-info-imported');
  updateStatus(`Imported ${count} customer QR label mapping(s).${errorText}`, errors.length ? 'warn' : 'success');
}

function setBetaSpecialAction(action: Exclude<BetaSpecialAction, null>) {
  if (!hasActiveBetaRun()) {
    updateStatus('Start or load a traceability run first.', 'error');
    return;
  }

  betaSpecialAction = action;
  betaCurrentUnit = null;
  armedRow = null;
  scanInFlight = false;
  state = 'WAITING_QR';
  resetBetaInputsAfterCompletion();
  setBetaStep('scan_shroud');

  if (action === 'mark_failed') {
    updateStatus('Failure mode active. Scan the Sequence QR from the failed/pulled assembly.', 'warn');
  } else if (action === 'post_ocr_reject') {
    updateStatus('Post-OCR Reject mode active. Scan the Sequence QR for the completed assembly to reject.', 'warn');
  } else {
    updateStatus('Recover Missing mode active. Scan the Sequence QR that was previously marked missing.', 'warn');
  }
}

function clearBetaSpecialAction() {
  betaSpecialAction = null;
  setBetaStep('scan_shroud');
}

function isBetaRecordActionableForOcr(record: ScanRecord) {
  if (!isNonEmptyString(record.lrm)) return false;
  if (record.leakTestStatus === 'fail') return false;

  if (
    record.workflowStatus === 'complete' ||
    record.workflowStatus === 'post_ocr_reject' ||
    record.workflowStatus === 'failed_pulled' ||
    record.workflowStatus === 'missing' ||
    record.workflowStatus === 'recovered_waiting_lrm'
  ) {
    return false;
  }

  return true;
}

function pickNextBetaOcrRecord(records: ScanRecord[]) {
  return records
    .filter(isBetaRecordActionableForOcr)
    .sort((a, b) => {
      const seqDiff = betaRecordSortValue(a) - betaRecordSortValue(b);
      if (seqDiff !== 0) return seqDiff;
      return (a.ts ?? 0) - (b.ts ?? 0);
    })[0];
}

function betaSequenceCalloutMode(): 'lrm' | 'ocr' {
  if (isCartridgeStation()) return 'ocr';
  if (!isLrmOnlyStation() && getBetaWorkflowPhase() === 'cartridge_ocr') return 'ocr';
  return 'lrm';
}

async function updateBetaSequenceCallout() {
  const generation = ++betaSequenceCalloutGeneration;
  const active = hasActiveBetaRun();
  const mode = betaSequenceCalloutMode();

  if (betaExpectedSequenceLabelEl) {
    betaExpectedSequenceLabelEl.textContent = mode === 'ocr' ? 'Next OCR Sequence' : 'Next LRM Sequence';
  }

  if (!betaExpectedSequenceValueEl) return;

  betaExpectedSequenceValueEl.classList.remove('text-emerald-700', 'text-rose-700', 'text-amber-700');
  betaExpectedSequenceValueEl.classList.add('text-indigo-700');

  if (!active) {
    betaExpectedSequenceValueEl.textContent = mode === 'ocr' ? 'No active run' : 'Z0000000001';
    return;
  }

  if (mode === 'lrm') {
    betaExpectedSequenceValueEl.textContent = getBetaExpectedSequence();
    return;
  }

  const records = await getActiveRunBetaRecords();
  if (generation !== betaSequenceCalloutGeneration) return;

  const nextOcrRecord = pickNextBetaOcrRecord(records);
  const nextOcrSequence = nextOcrRecord ? getBetaRecordSequence(nextOcrRecord) : '';

  betaExpectedSequenceValueEl.classList.remove('text-indigo-700');
  betaExpectedSequenceValueEl.classList.add(nextOcrSequence ? 'text-emerald-700' : 'text-amber-700');
  betaExpectedSequenceValueEl.textContent = nextOcrSequence || 'No OCR-ready pairs';
}

async function updateBetaRunSummary() {
  const summary = document.getElementById('betaRunSummary') as HTMLDivElement | null;
  if (!summary) return;

  if (!hasActiveBetaRun()) {
    summary.textContent = 'No active run';
    refreshLrmOperatorDock('No active run');
    return;
  }

  const records = await getActiveRunBetaRecords();
  const postReject = records.filter((record) => record.workflowStatus === 'post_ocr_reject').length;
  const complete = records.filter((record) => record.workflowStatus === 'complete').length;
  const failed = records.filter((record) => record.leakTestStatus === 'fail' || record.workflowStatus === 'failed_pulled').length;
  const paired = records.filter((record) => isNonEmptyString(record.lrm)).length;
  const pending = records.filter(
    (record) => isNonEmptyString(record.lrm) && record.leakTestStatus !== 'fail' && !isBetaCartridgeCompleteRecord(record),
  ).length;
  const missing = getBetaMissingNumbers().length;
  const importedQr = Object.keys(getBetaQrInfoMap()).length;

  const summaryText = `Paired ${paired} • Pending ${pending} • Complete ${complete} • Failed ${failed} • Post-OCR Reject ${postReject} • Missing ${missing} • QR ${importedQr}`;
  summary.textContent = summaryText;
  refreshLrmOperatorDock(summaryText);
}

function updateBetaLeakCell(row: HTMLTableRowElement, status: ScanRecord['leakTestStatus']) {
  const leakCell = row.querySelector('.beta-leak-cell') as HTMLElement | null;
  if (!leakCell) return;

  leakCell.classList.remove('text-emerald-700', 'text-rose-700', 'text-gray-700', 'font-semibold');

  if (status === 'pass') {
    leakCell.textContent = 'PASS';
    leakCell.classList.add('text-emerald-700', 'font-semibold');
  } else if (status === 'fail') {
    leakCell.textContent = 'FAIL';
    leakCell.classList.add('text-rose-700', 'font-semibold');
  } else {
    leakCell.textContent = 'Pending';
    leakCell.classList.add('text-gray-700');
  }
}

async function markBetaRecordFailed(record: ScanRecord, reason?: string) {
  if (!record.id) return false;

  if (isBetaCartridgeCompleteRecord(record)) {
    updateStatus(`Sequence ${record.sequenceNumber} already has cartridge data. Failure mark is blocked.`, 'error');
    return false;
  }

  const failureReason = reason ?? window.prompt('Failure reason:', 'Mixwheel Leak Test Fail')?.trim();
  if (!failureReason) {
    updateStatus('Failure mark canceled. No reason entered.', 'info');
    return false;
  }

  await db.update(record.id, {
    workflowStatus: 'failed_pulled',
    leakTestStatus: 'fail',
    failureTs: Date.now(),
    failureReason,
    top: null,
    topFinal: null,
    topConf: 0,
    topHist: {},
    lockedByStation: undefined,
    lockedAt: undefined,
  });

  const updated = await db.get(record.id);
  const sequence = getBetaRecordSequence(updated ?? record);
  let row = getBetaTableRowBySequence(sequence);
  if (!row) {
    row = createBetaTableRow({
      build: getBetaRecordBuild(updated ?? record),
      lyoCondition: getBetaRecordLyo(updated ?? record),
      expectedSequence: sequence,
    });
  }
  if (updated) populateBetaTableRowFromRecord(row, updated);

  if (betaCurrentUnit?.expectedSequence === sequence) {
    betaCurrentUnit = null;
    armedRow = null;
  }

  await updateBetaRunSummary();
  notifyRunDataChanged('marked-failed-pulled');
  return true;
}

async function handleBetaMarkFailedScan(scannedRaw: string) {
  const record = await findBetaRecordBySequenceScan(scannedRaw);
  if (!record) {
    updateStatus('Sequence not found in this run. Pair the LRM first before marking failed.', 'error');
    return;
  }

  if (record.leakTestStatus === 'fail') {
    updateStatus(`Sequence ${record.sequenceNumber} is already marked Failed / Pulled.`, 'info');
    clearBetaSpecialAction();
    return;
  }

  const confirmed = window.confirm(`Mark ${record.sequenceNumber} as Failed / Pulled? This will lock it out of Cartridge OCR.`);
  if (!confirmed) {
    updateStatus('Failure mark canceled.', 'info');
    clearBetaSpecialAction();
    return;
  }

  const marked = await markBetaRecordFailed(record);
  clearBetaSpecialAction();
  if (marked) updateStatus(`Marked ${record.sequenceNumber} as Failed / Pulled. Scan next unit.`, 'success');
}

async function handleBetaPostOcrRejectScan(scannedRaw: string) {
  const record = await findBetaRecordBySequenceScan(scannedRaw);
  if (!record || !record.id) {
    updateStatus('Sequence not found in this run. Cannot mark post-OCR reject.', 'error');
    clearBetaSpecialAction();
    return;
  }

  if (!isBetaCartridgeCompleteRecord(record)) {
    updateStatus(`Sequence ${record.sequenceNumber} is not complete yet. Use Mark Failed/Pulled before cartridge OCR, or complete OCR first.`, 'error');
    clearBetaSpecialAction();
    return;
  }

  const reason = window.prompt('Post-OCR reject reason:', 'Motor Test Fail')?.trim();
  if (!reason) {
    updateStatus('Post-OCR reject canceled. No reason entered.', 'info');
    clearBetaSpecialAction();
    return;
  }

  await db.update(record.id, {
    workflowStatus: 'post_ocr_reject',
    postOcrRejectTs: Date.now(),
    postOcrRejectReason: reason,
    lockedByStation: undefined,
    lockedAt: undefined,
  });

  const updated = await db.get(record.id);
  const sequence = getBetaRecordSequence(updated ?? record);
  let row = getBetaTableRowBySequence(sequence);
  if (!row) {
    row = createBetaTableRow({
      build: getBetaRecordBuild(updated ?? record),
      lyoCondition: getBetaRecordLyo(updated ?? record),
      expectedSequence: sequence,
    });
  }
  if (updated) populateBetaTableRowFromRecord(row, updated);

  await updateBetaRunSummary();
  notifyRunDataChanged('post-ocr-reject');
  clearBetaSpecialAction();
  updateStatus(`Marked ${sequence} as Post-OCR Reject. Cartridge data preserved and export will flag it.`, 'success');
}

function removeBetaMissingNumber(sequenceNum: number) {
  const updated = getBetaMissingNumbers().filter((n) => n !== sequenceNum);
  setBetaMissingNumbers(updated);
  updateBetaRunUI();
}

async function beginRecoveredMissingSequence(scannedRaw: string) {
  const parsedSequence = parseShroudQrSequence(scannedRaw);
  if (parsedSequence === null) {
    updateStatus('Could not read a sequence number from the recovered Sequence QR.', 'error');
    return false;
  }

  if (!isBetaMissingSequenceNumber(parsedSequence)) {
    updateStatus(`${formatBetaSequenceNumber(parsedSequence, getBetaExpectedSequence())} is not currently marked missing.`, 'error');
    return false;
  }

  const sequenceLabel = formatBetaSequenceNumber(parsedSequence, getBetaExpectedSequence());
  const existing = await findBetaRecordBySequenceScan(sequenceLabel);
  if (existing) {
    updateStatus(`Sequence ${sequenceLabel} already exists in the run table. It cannot be recovered as missing.`, 'error');
    return false;
  }

  // Do not remove from the missing list until the recovered LRM pair is actually saved.
  clearBetaRowActiveStates();

  const row = createBetaTableRow({
    build: getBetaBuild(),
    lyoCondition: getBetaLyo(),
    expectedSequence: sequenceLabel,
  });

  betaCurrentUnit = {
    build: getBetaBuild(),
    lyoCondition: getBetaLyo(),
    expectedSequence: sequenceLabel,
    shroudRaw: scannedRaw,
    lrm: null,
    row,
    recovered: true,
  };

  row.dataset.shroud = scannedRaw;
  showBetaRowStatus(row, 'Recovered - scan LRM', 'ok');
  setBetaRowActive(row, true);
  resetBetaInputsAfterCompletion();
  setBetaStep('scan_lrm');
  state = 'WAITING_LRM';
  await updateBetaRunSummary();
  updateStatus(`Recovered ${sequenceLabel}. Scan exposed LRM now.`, 'success');
  return true;
}

async function handleBetaRecoverMissingScan(scannedRaw: string) {
  const recovered = await beginRecoveredMissingSequence(scannedRaw);
  clearBetaSpecialAction();
  if (recovered) setBetaStep('scan_lrm');
}

async function resolvePendingBeforeCartridgeOcr(targetRecord: ScanRecord) {
  const targetSequenceNum = expectedSequenceNumericValue(getBetaRecordSequence(targetRecord));
  if (targetSequenceNum === null) return true;

  while (true) {
    const records = await getActiveRunBetaRecords();
    const pendingBefore = records
      .filter((record) => {
        const seqNum = expectedSequenceNumericValue(getBetaRecordSequence(record));
        return (
          seqNum !== null &&
          seqNum < targetSequenceNum &&
          isNonEmptyString(record.lrm) &&
          record.leakTestStatus !== 'fail' &&
          !isBetaCartridgeCompleteRecord(record)
        );
      })
      .sort((a, b) => betaRecordSortValue(a) - betaRecordSortValue(b));

    const firstPending = pendingBefore[0];
    if (!firstPending) return true;

    const pendingSeq = getBetaRecordSequence(firstPending);
    const targetSeq = getBetaRecordSequence(targetRecord);
    const markFailed = window.confirm(
      `${pendingSeq} is still pending before ${targetSeq}.\n\nOK = mark ${pendingSeq} Failed/Pulled and continue.\nCancel = choose whether to continue out of order.`,
    );

    if (markFailed) {
      const marked = await markBetaRecordFailed(firstPending, `Mixwheel Leak Test Fail - skipped before ${targetSeq}`);
      if (!marked) return false;
      continue;
    }

    const continueOutOfOrder = window.confirm(`Continue out of order with ${targetSeq} without marking ${pendingSeq} failed?`);
    return continueOutOfOrder;
  }
}

async function saveBetaRunBackup() {
  if (!hasActiveBetaRun()) {
    updateStatus('No active run to back up.', 'error');
    return;
  }

  const records = await getActiveRunBetaRecords();
  const backup = {
    version: 2,
    savedAt: new Date().toISOString(),
    app: 'Smart Cartridge Build Tracker',
    localStorage: {
      [BETA_RUN_ID_KEY]: getBetaRunId(),
      [BETA_BUILD_KEY]: getBetaBuild(),
      [BETA_LYO_KEY]: getBetaLyo(),
      [BETA_NEXT_SEQUENCE_KEY]: getBetaExpectedSequence(),
      [BETA_MISSING_KEY]: JSON.stringify(getBetaMissingNumbers()),
      [BETA_WORKFLOW_PHASE_KEY]: getBetaWorkflowPhase(),
      [BETA_QR_INFO_MAP_KEY]: JSON.stringify(getBetaQrInfoMap()),
      [BETA_MIXWHEEL_LOT_KEY]: getBetaMixwheelLot(),
      [BETA_SAMPLE_CAP_LOT_KEY]: getBetaSampleCapLot(),
      [APP_MODE_KEY]: 'traceability_beta',
    },
    records,
  };

  const safeLyo = getBetaLyo().replace(/[^a-z0-9_-]+/gi, '_');
  const filename = `Build_${getBetaBuild()}_${safeLyo}_run_backup_${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  updateStatus(`Run backup saved: ${filename}`, 'success');
}

async function loadBetaRunBackupFromFile(file: File) {
  const text = await file.text();
  let parsed: any;

  try {
    parsed = JSON.parse(text);
  } catch {
    updateStatus('Backup file is not valid JSON.', 'error');
    return;
  }

  if (!parsed || !Array.isArray(parsed.records) || !parsed.localStorage) {
    updateStatus('Backup file is missing run records or run setup data.', 'error');
    return;
  }

  const confirmed = window.confirm('Load this run backup? Current scan records in this browser will be cleared first.');
  if (!confirmed) {
    updateStatus('Load backup canceled.', 'info');
    return;
  }

  await db.clearAll();

  for (const [key, value] of Object.entries(parsed.localStorage as Record<string, string>)) {
    if (typeof value === 'string') localStorage.setItem(key, value);
  }

  localStorage.setItem(APP_MODE_KEY, 'traceability_beta');
  currentAppMode = 'traceability_beta';

  for (const record of parsed.records as ScanRecord[]) {
    const { id: _id, ...recordWithoutId } = record as ScanRecord;
    await db.add(recordWithoutId);
  }

  betaCurrentUnit = null;
  armedRow = null;
  betaSpecialAction = null;
  state = 'WAITING_QR';

  applyAppModeUI();
  console.info(`Smart Cartridge Build Tracker loaded: ${APP_BUILD_LABEL}`);
  updateBetaRunUI();
  await renderBetaTableForActiveRun();
  refreshBetaEnhancementPanel();
  await updateBetaRunSummary();
  notifyRunDataChanged('run-backup-loaded');
  updateStatus(`Loaded run backup for Build ${getBetaBuild()}, ${getBetaLyo()}.`, 'success');
}


function setBetaStep(step: BetaStep) {
  ensureBetaWorkflowPhaseControl();

  const phase = getBetaWorkflowPhase();
  if (betaWorkflowPhaseSelectEl) betaWorkflowPhaseSelectEl.value = phase;
  updateBetaWorkflowPhaseHelp();

  if (betaSpecialAction) {
    if (betaSequenceScanLabelEl) {
      betaSequenceScanLabelEl.textContent =
        betaSpecialAction === 'mark_failed'
          ? 'Step 1: Failed Unit Sequence QR Scan'
          : betaSpecialAction === 'post_ocr_reject'
            ? 'Step 1: Post-OCR Reject Sequence QR Scan'
            : 'Step 1: Recovered Missing Sequence QR Scan';
    }
    if (betaLrmScanLabelEl) {
      betaLrmScanLabelEl.textContent =
        betaSpecialAction === 'mark_failed'
          ? 'Step 2: Unit Pulled'
          : betaSpecialAction === 'post_ocr_reject'
            ? 'Step 2: Downstream Reject'
            : 'Step 2: Scan Recovered LRM';
    }
    if (betaShroudScanInputEl) {
      betaShroudScanInputEl.disabled = false;
      betaShroudScanInputEl.placeholder =
        betaSpecialAction === 'mark_failed'
          ? 'Scan failed/pulled unit sequence QR...'
          : betaSpecialAction === 'post_ocr_reject'
            ? 'Scan post-OCR reject sequence QR...'
            : 'Scan recovered missing sequence QR...';
    }
    if (betaLrmScanInputEl) {
      betaLrmScanInputEl.disabled = true;
      betaLrmScanInputEl.placeholder =
        betaSpecialAction === 'mark_failed'
          ? 'Failure mode active'
          : betaSpecialAction === 'post_ocr_reject'
            ? 'Post-OCR reject mode active'
            : 'LRM scan opens after recovery';
    }
    if (betaCurrentStepValueEl) {
      betaCurrentStepValueEl.textContent =
        betaSpecialAction === 'mark_failed'
          ? 'Scan failed unit Sequence QR'
          : betaSpecialAction === 'post_ocr_reject'
            ? 'Scan completed unit Sequence QR to reject'
            : 'Scan recovered missing Sequence QR';
    }
    focusAndSelect(betaShroudScanInputEl);
    refreshLrmOperatorDock();
    return;
  }

  if (betaSequenceScanLabelEl) {
    betaSequenceScanLabelEl.textContent =
      phase === 'lrm_pairing' ? 'Step 1: Sequence QR Scan' : 'Step 1: Passing Unit Sequence QR Scan';
  }

  if (betaLrmScanLabelEl) {
    betaLrmScanLabelEl.textContent =
      phase === 'lrm_pairing' ? 'Step 2: LRM Scan' : 'Step 2: LRM Loaded From Pair';
  }

  if (betaShroudScanInputEl) {
    betaShroudScanInputEl.placeholder =
      phase === 'lrm_pairing' ? 'Scan sequence QR...' : 'Scan sequence QR on passing unit...';
  }

  if (betaLrmScanInputEl) {
    betaLrmScanInputEl.placeholder =
      phase === 'lrm_pairing' ? 'Scan exposed LRM...' : 'LRM loads from saved pair';
  }

  if (!betaCurrentStepValueEl) return;

  const labels: Record<BetaStep, string> =
    phase === 'lrm_pairing'
      ? {
        scan_shroud: 'Scan Sequence QR',
        scan_lrm: 'Scan exposed LRM',
        place_part: 'LRM pair saved',
      }
      : {
        scan_shroud: 'Scan passing unit Sequence QR',
        scan_lrm: 'LRM pair loaded',
        place_part: 'Place cartridge for OCR',
      };

  betaCurrentStepValueEl.textContent = labels[step];

  if (betaShroudScanInputEl) betaShroudScanInputEl.disabled = step !== 'scan_shroud';
  if (betaLrmScanInputEl) {
    betaLrmScanInputEl.disabled = phase !== 'lrm_pairing' || step !== 'scan_lrm';
  }

  if (step === 'scan_shroud') focusAndSelect(betaShroudScanInputEl);
  if (phase === 'lrm_pairing' && step === 'scan_lrm') focusAndSelect(betaLrmScanInputEl);
  refreshLrmOperatorDock();
}

function updateBetaRunUI() {
  ensureTraceabilityEnhancementPanel();
  if (isLrmOnlyStation()) ensureLrmOperatorDock();
  refreshBetaEnhancementPanel();
  void updateBetaRunSummary();
  const active = hasActiveBetaRun();

  if (traceabilityEmptyEl) traceabilityEmptyEl.classList.toggle('hidden', active);
  if (traceabilityActiveEl) traceabilityActiveEl.classList.toggle('hidden', !active);

  if (betaActiveBuildValueEl) betaActiveBuildValueEl.textContent = active ? getBetaBuild() : '';
  if (betaActiveLyoValueEl) betaActiveLyoValueEl.textContent = active ? getBetaLyo() : '';
  void updateBetaSequenceCallout();

  const betaSequenceTemplate = active ? getBetaExpectedSequence() : '';

  if (betaActiveMissingSequencesValueEl) {
    betaActiveMissingSequencesValueEl.textContent = active
      ? formatBetaMissingNumbers(getBetaMissingNumbers(), betaSequenceTemplate)
      : 'None';
  }

  if (betaActiveMissingSequencesInputEl) {
    betaActiveMissingSequencesInputEl.value = active
      ? getBetaMissingNumbers()
        .map((n) => formatBetaSequenceNumber(n, betaSequenceTemplate))
        .join(', ')
      : '';
  }

  if (!active) {
    if (betaShroudScanInputEl) betaShroudScanInputEl.value = '';
    if (betaLrmScanInputEl) betaLrmScanInputEl.value = '';
    if (betaMissingSequencesInputEl) betaMissingSequencesInputEl.value = '';
    if (betaCurrentStepValueEl) betaCurrentStepValueEl.textContent = 'Scan Sequence QR';
  } else if (betaCurrentUnit) {
    if (!betaCurrentUnit.shroudRaw) setBetaStep('scan_shroud');
    else if (!betaCurrentUnit.lrm) setBetaStep('scan_lrm');
    else setBetaStep('place_part');
  } else {
    setBetaStep('scan_shroud');
  }
}

function startBetaRun(
  buildRaw: string,
  lyoRaw: string,
  startSequenceRaw: string,
  missingRaw: string,
) {
  const build = normalizeBuildNumber(buildRaw);
  const lyo = lyoRaw.trim();
  const sequence = normalizeSequence(startSequenceRaw);

  if (!build) return { ok: false as const, reason: 'invalid-build' as const };
  if (!lyo) return { ok: false as const, reason: 'invalid-lyo' as const };
  if (!sequence) return { ok: false as const, reason: 'invalid-sequence' as const };

  const parsedMissing = parseBetaMissingNumbersInput(missingRaw);
  if (!parsedMissing.ok) {
    return {
      ok: false as const,
      reason: 'invalid-missing' as const,
      invalidTokens: parsedMissing.invalidTokens,
    };
  }

  const sequenceNum = expectedSequenceNumericValue(sequence);
  const normalizedMissing =
    sequenceNum === null
      ? parsedMissing.values
      : parsedMissing.values.filter((n) => n >= sequenceNum);

  setBetaMissingNumbers(normalizedMissing);
  const startingNext = getNextAssignableBetaSequence(sequence);

  localStorage.setItem(BETA_BUILD_KEY, build);
  localStorage.setItem(BETA_LYO_KEY, lyo);
  localStorage.setItem(BETA_NEXT_SEQUENCE_KEY, startingNext);
  setBetaRunId(createBetaRunId(build, lyo));

  betaCurrentUnit = null;
  state = 'IDLE';

  return {
    ok: true as const,
    build,
    lyo,
    sequence: startingNext,
    skippedAtStart: startingNext !== sequence,
    missingNumbers: normalizedMissing,
  };
}

function advanceBetaSequence() {
  const current = getBetaExpectedSequence();
  if (!current) return;

  const rawNext = incrementSequence(current);
  const next = getNextAssignableBetaSequence(rawNext);

  setBetaExpectedSequence(next);
  updateBetaRunUI();
}

function resetBetaInputsAfterCompletion() {
  if (betaShroudScanInputEl) betaShroudScanInputEl.value = '';
  if (betaLrmScanInputEl) betaLrmScanInputEl.value = '';
}

function getExistingBetaSequenceNumbersInTable() {
  return Array.from(tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-sequence]'))
    .map((row) => expectedSequenceNumericValue(row.dataset.sequence ?? ''))
    .filter((value): value is number => value !== null);
}

function updateBetaMissingNumbersLive(raw: string) {
  if (!hasActiveBetaRun()) {
    return { ok: false as const, reason: 'no-run' as const };
  }

  const parsed = parseBetaMissingNumbersInput(raw);
  if (!parsed.ok) {
    return {
      ok: false as const,
      reason: 'invalid-missing' as const,
      invalidTokens: parsed.invalidTokens,
    };
  }

  const currentExpected = expectedSequenceNumericValue(getBetaExpectedSequence());
  const existingRows = new Set(getExistingBetaSequenceNumbersInTable());

  const invalidPast =
    currentExpected === null ? [] : parsed.values.filter((n) => n < currentExpected);
  if (invalidPast.length) {
    return {
      ok: false as const,
      reason: 'past-values' as const,
      values: invalidPast,
    };
  }

  const rowConflicts = parsed.values.filter((n) => existingRows.has(n));
  if (rowConflicts.length) {
    return {
      ok: false as const,
      reason: 'row-conflict' as const,
      values: rowConflicts,
    };
  }

  setBetaMissingNumbers(parsed.values);

  const currentExpectedRaw = getBetaExpectedSequence();
  if (currentExpectedRaw) {
    setBetaExpectedSequence(getNextAssignableBetaSequence(currentExpectedRaw));
  }

  updateBetaRunUI();

  return {
    ok: true as const,
    values: parsed.values,
  };
}

function renderTableHeaders() {
  if (!tableHeadRowEl) return;

  if (currentAppMode === 'traceability_beta') {
    tableHeadRowEl.innerHTML = `
    <th class="min-w-[56px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Build</th>
    <th class="min-w-[52px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Lyo</th>
    <th class="min-w-[120px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Sequence #</th>
    <th class="min-w-[120px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">LRM #</th>
    <th class="min-w-[88px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Leak Test</th>
    <th class="min-w-[104px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Top Plate #</th>
    <th class="min-w-[140px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Status</th>
    <th class="min-w-[96px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Actions</th>
  `;
  } else {
    tableHeadRowEl.innerHTML = `
      <th class="px-2 py-2 text-center font-semibold text-gray-600 uppercase">CONDITION</th>
      <th class="px-2 py-2 text-center font-semibold text-gray-600 uppercase">LRM #</th>
      <th class="px-2 py-2 text-center font-semibold text-gray-600 uppercase">Top Plate #</th>
      <th class="px-2 py-2 text-center font-semibold text-gray-600 uppercase">Actions</th>
    `;
  }
}

function applyAppModeUI() {
  if (currentAppMode === 'standard') {
    currentAppMode = 'traceability_beta';
  }

  localStorage.setItem(APP_MODE_KEY, currentAppMode);

  if (appModeSelectEl) appModeSelectEl.value = currentAppMode;

  // Standard is intentionally hidden for now. Keep the internal mode structure
  // so a future Manual workflow can be added without rewriting the app shell.
  standardRunPanelEl?.classList.add('hidden');
  traceabilityRunPanelEl?.classList.remove('hidden');

  if (appSubtitleEl) {
    appSubtitleEl.textContent = `Traceability: Sequence QR + LRM pairing → leak test → passing unit cartridge OCR. ${APP_BUILD_LABEL}`;
  }

  const buildBadgeEl = document.getElementById('app-build-badge');
  if (buildBadgeEl) buildBadgeEl.textContent = APP_BUILD_LABEL;

  renderTableHeaders();
  resetOcrPreviews();
}

function showBetaRowStatus(
  row: HTMLTableRowElement,
  text: string,
  tone: 'neutral' | 'ok' | 'error' = 'neutral',
) {
  const cell = row.querySelector('.beta-status-cell') as HTMLElement | null;
  if (!cell) return;

  cell.textContent = text;
  cell.className = 'px-2 py-2 text-center whitespace-nowrap beta-status-cell';

  if (tone === 'ok') cell.classList.add('text-emerald-700', 'font-semibold');
  else if (tone === 'error') cell.classList.add('text-rose-700', 'font-semibold');
  else cell.classList.add('text-gray-700');
}

function setBetaRowActive(row: HTMLTableRowElement, active: boolean) {
  row.dataset.active = active ? 'true' : 'false';
  row.classList.toggle('bg-amber-50', active);
  row.classList.toggle('ring-1', active);
  row.classList.toggle('ring-amber-300', active);
}

async function completeBetaUnitAfterVerification(
  row: HTMLTableRowElement,
  topFinalValue: string,
) {
  const sequence = row.dataset.sequence ?? '';
  const matches = topMatchesExpectedSequence(topFinalValue, sequence);
  if (!matches) return false;

  const topCell = row.querySelector('.beta-top-cell') as HTMLElement | null;
  if (topCell) {
    topCell.classList.remove('text-yellow-600', 'text-rose-700');
    topCell.classList.add('text-emerald-700', 'font-semibold');
  }

  setOcrPreview(`${topFinalValue} ✓`, 'ok', 'Top Plate / Sequence Check');

  const idStr = row.dataset.scanId;
  if (idStr) {
    await db.update(Number(idStr), {
      workflowStatus: 'complete',
      leakTestStatus: 'pass',
      lockedByStation: undefined,
      lockedAt: undefined,
    });
    notifyRunDataChanged('cartridge-complete-after-top-verification');
  }

  showBetaRowStatus(row, 'Complete', 'ok');
  setBetaRowActive(row, false);

  if (betaCurrentUnit?.row === row) {
    const completedSequence = betaCurrentUnit.expectedSequence;
    lastOcrFocusedSequence = completedSequence;

    if (getBetaWorkflowPhase() === 'lrm_pairing') {
      advanceBetaSequence();
      ensureBetaActiveRow();
    }

    resetBetaInputsAfterCompletion();
    betaCurrentUnit = null;
    armedRow = null;
    state = 'WAITING_QR';
    setBetaStep('scan_shroud');

    if (getBetaWorkflowPhase() === 'cartridge_ocr') {
      await renderBetaTableForActiveRun();
    }

    updateStatus(
      getBetaWorkflowPhase() === 'cartridge_ocr'
        ? `Top Plate verified for ${completedSequence}. Scan next passing unit Sequence QR.`
        : `Top Plate verified for ${completedSequence}. Scan next Sequence QR.`,
      'success',
    );
  }

  return true;
}

async function promptAndApplyBetaTopOverrideasync function promptAndApplyBetaTopOverride(
  row: HTMLTableRowElement,
  currentValue: string,
  autoOpened = false,
) {
  const topCell = row.querySelector('.beta-top-cell') as HTMLElement | null;
  if (!topCell) return false;

  const sequence = row.dataset.sequence ?? '';
  const current = currentValue === 'NO_CODE_FOUND' ? '' : currentValue;

  const res = await promptOverride('TOP', current, {
    title: autoOpened ? 'Top Plate mismatch' : 'Override Top Plate',
    helperText: sequence
      ? `Expected sequence: ${sequence}. Update the Top Plate result so it matches the expected sequence.`
      : 'Update the Top Plate result.',
    saveLabel: 'Update Top Plate',
    placement: autoOpened ? 'right' : 'center',
  });

  if (!res) {
    if (autoOpened) {
      showBetaRowStatus(row, 'Top mismatch', 'error');
      setBetaRowActive(row, true);
      updateStatus(
        'Top Plate correction is required before this traceability row can continue.',
        'error',
      );
    }

    return false;
  }

  topCell.textContent = res.value;
  topCell.classList.remove('text-yellow-600', 'font-semibold', 'text-rose-700', 'text-emerald-700');

  showOverrideBadge(row);
  row.querySelector('.beta-override-badge')?.classList.remove('hidden');

  const matches = topMatchesExpectedSequence(res.value, sequence);

  if (matches) {
    topCell.classList.add('text-emerald-700', 'font-semibold');
    setOcrPreview(`${res.value} ✓`, 'ok', 'Top Plate / Sequence Check');
  } else {
    topCell.classList.add('text-rose-700', 'font-semibold');
    setOcrPreview(`${res.value} ✕`, 'error', 'Top Plate / Sequence Check');
  }

  const idStr = row.dataset.scanId;
  if (idStr) {
    await db.update(Number(idStr), {
      topFinal: res.value,
      topOverrideReason: res.reason,
    });
  }

  if (matches) {
    await completeBetaUnitAfterVerification(row, res.value);
    return true;
  }

  showBetaRowStatus(row, 'Top mismatch', 'error');
  setBetaRowActive(row, true);
  state = 'COOLDOWN';
  cooldownUntil = performance.now() + POST_SCAN_COOLDOWN_MS;
  updateStatus('Updated Top Plate value still does not match the expected sequence.', 'error');

  return false;
}

async function commitBetaLrmOverride(row: HTMLTableRowElement, nextValue: string) {
  const lrmCell = row.querySelector('.beta-lrm-cell') as HTMLElement | null;
  if (!lrmCell) return false;

  const previous = row.dataset.lrm ?? '';
  const value = nextValue.trim();

  if (!value) {
    updateStatus('LRM cannot be blank. Reverted to previous value.', 'error');
    return false;
  }

  if (isLikelyDuplicateQrAtLrmStep(value, row.dataset.shroud ?? null, row.dataset.sequence ?? '')) {
    updateStatus('LRM scan appears to be the Sequence QR. Please scan the LRM label.', 'error');
    return false;
  }

  row.dataset.lrm = value;
  lrmCell.textContent = value;
  row.querySelector('.beta-override-badge')?.classList.remove('hidden');

  const idStr = row.dataset.scanId;
  if (idStr) {
    await db.update(Number(idStr), { lrm: value });
  }

  if (betaCurrentUnit?.row === row) {
    betaCurrentUnit.lrm = value;
  }

  if (previous !== value) {
    updateStatus('LRM override saved.', 'success');
  } else {
    updateStatus('LRM unchanged.', 'info');
  }

  return true;
}

function startBetaLrmInlineEdit(row: HTMLTableRowElement) {
  const lrmCell = row.querySelector('.beta-lrm-cell') as HTMLElement | null;
  if (!lrmCell) return;

  const currentValue = (row.dataset.lrm ?? lrmCell.textContent ?? '').trim();
  if (!currentValue) return;
  if (lrmCell.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.className = 'table-cell-input text-xs font-mono text-center';
  lrmCell.textContent = '';
  lrmCell.appendChild(input);

  const cancel = () => {
    lrmCell.textContent = currentValue;
  };

  const commit = async () => {
    const ok = await commitBetaLrmOverride(row, input.value);
    if (!ok) {
      lrmCell.textContent = currentValue;
      return;
    }
    lrmCell.textContent = row.dataset.lrm ?? input.value.trim();
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void commit();
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });

  input.addEventListener('blur', () => {
    void commit();
  });

  input.focus();
  input.select();
  updateStatus('Editing LRM. Press Enter or click away to save.', 'info');
}

function createBetaTableRow(unit: Pick<BetaUnit, 'build' | 'lyoCondition' | 'expectedSequence'>) {
  const existingRow = getBetaTableRowBySequence(unit.expectedSequence);
  if (existingRow) {
    existingRow.dataset.build = unit.build;
    existingRow.dataset.lyo = unit.lyoCondition;
    return existingRow;
  }

  const row = document.createElement('tr');
  row.classList.add('hover:bg-gray-50');
  row.dataset.sequence = unit.expectedSequence;
  row.dataset.build = unit.build;
  row.dataset.lyo = unit.lyoCondition;
  row.dataset.active = 'true';
  row.dataset.mode = 'traceability_beta';

  row.innerHTML = `
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-build-cell">${unit.build}</td>
  <td class="px-2 py-2 text-center align-top text-xs beta-lyo-cell">${unit.lyoCondition}</td>
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-sequence-cell">${unit.expectedSequence}</td>
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-lrm-cell break-all"></td>
  <td class="px-2 py-2 text-center align-top text-xs beta-leak-cell break-all">Pending</td>
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-top-cell break-all"></td>
  <td class="px-2 py-2 align-top text-center text-xs beta-status-cell text-gray-700 break-words">Waiting Sequence QR</td>
  <td class="px-1 py-2 align-top whitespace-nowrap actions-cell">
  <div class="actions-wrap flex flex-col items-center justify-center gap-1 w-full">
      <button type="button" class="beta-rescan-btn bg-gray-100 hover:bg-gray-200 rounded border px-2 py-1 text-xs">
        Rescan OCR
      </button>
      <span
        class="beta-override-badge hidden text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200"
        title="Override used"
      >
        OV
      </span>
    </div>
  </td>
`;

  tableBody.appendChild(row);
  setBetaRowActive(row, true);

  const lrmCell = row.querySelector('.beta-lrm-cell') as HTMLElement;
  const topCell = row.querySelector('.beta-top-cell') as HTMLElement;

  lrmCell.addEventListener('dblclick', () => {
    startBetaLrmInlineEdit(row);
  });

  topCell.addEventListener('dblclick', async () => {
    const current = (topCell.textContent || '').trim();
    await promptAndApplyBetaTopOverride(row, current, false);
  });

  const rescanBtn = row.querySelector('.beta-rescan-btn') as HTMLButtonElement | null;
  rescanBtn?.addEventListener('click', async () => {
    if (currentAppMode !== 'traceability_beta') return;
    if (scanInFlight) return;

    if (!betaCurrentUnit || betaCurrentUnit.row !== row) {
      updateStatus('Only the active beta row can be rescanned.', 'error');
      return;
    }

    if (!betaCurrentUnit.shroudRaw || !betaCurrentUnit.lrm) {
      updateStatus('Load Sequence QR / LRM pair first.', 'error');
      return;
    }

    if (stablePresence && state !== 'SCANNING') {
      armedRow = row;
      state = 'ARMED';
      await runBetaOcrScan(row);
    } else {
      updateStatus('Place the part on the sensor to rescan OCR.', 'info');
    }
  });

  return row;
}


function clearBetaRowActiveStates() {
  for (const row of Array.from(tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-mode="traceability_beta"]'))) {
    setBetaRowActive(row, false);
  }
}

function getBetaTableRowBySequence(sequence: string) {
  const target = normalizeScannerText(sequence);
  if (!target) return null;

  return (
    Array.from(tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-mode="traceability_beta"]')).find(
      (row) => normalizeScannerText(row.dataset.sequence) === target,
    ) ?? null
  );
}

function betaRecordSortValue(record: ScanRecord) {
  return expectedSequenceNumericValue(record.sequenceNumber ?? record.condition ?? '') ?? Number.MAX_SAFE_INTEGER;
}

function betaRecordSequenceKey(record: ScanRecord | { sequenceNumber?: string; condition?: string }) {
  return normalizeScannerText(record.sequenceNumber ?? record.condition ?? '');
}

function betaRecordPriority(record: ScanRecord) {
  let score = 0;

  if (record.workflowStatus === 'complete') score += 1000;
  else if (record.workflowStatus === 'post_ocr_reject') score += 950;
  else if (record.workflowStatus === 'failed_pulled' || record.leakTestStatus === 'fail') score += 900;
  else if (
    record.workflowStatus === 'needs_top_correction' ||
    record.workflowStatus === 'needs_rescan'
  ) score += 800;
  else if (record.workflowStatus === 'ocr_in_progress') score += 700;
  else if (record.workflowStatus === 'loaded_for_cartridge_ocr') score += 650;
  else if (record.workflowStatus === 'lrm_paired_pending_leak') score += 500;
  else if (record.workflowStatus === 'recovered_waiting_lrm') score += 300;
  else if (record.workflowStatus === 'missing') score += 200;

  if (isNonEmptyString(record.topFinal ?? record.top ?? '')) score += 40;
  if (isNonEmptyString(record.lrm)) score += 20;
  if (record.customerQrCode) score += 5;

  return score;
}

function pickBestBetaRecord(records: ScanRecord[]) {
  return records
    .slice()
    .sort((a, b) => {
      const scoreDiff = betaRecordPriority(b) - betaRecordPriority(a);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.ts ?? 0) - (a.ts ?? 0);
    })[0];
}

function dedupeBetaRecordsBySequence(records: ScanRecord[]) {
  const bySequence = new Map<string, ScanRecord[]>();

  for (const record of records) {
    const key = betaRecordSequenceKey(record);
    if (!key) continue;
    const group = bySequence.get(key) ?? [];
    group.push(record);
    bySequence.set(key, group);
  }

  const bestRecords: ScanRecord[] = [];
  for (const group of bySequence.values()) {
    const best = pickBestBetaRecord(group);
    if (best) bestRecords.push(best);
  }

  return bestRecords;
}

function getBetaRecordSequence(record: ScanRecord) {
  return record.sequenceNumber ?? record.condition ?? '';
}

function getBetaRecordBuild(record: ScanRecord) {
  return record.buildNumber ?? getBetaBuild();
}

function getBetaRecordLyo(record: ScanRecord) {
  return record.lyoCondition ?? getBetaLyo();
}

function getBetaRecordTopDisplay(record: ScanRecord) {
  return record.topFinal ?? record.top ?? '';
}

function populateBetaTableRowFromRecord(row: HTMLTableRowElement, record: ScanRecord) {
  const sequence = getBetaRecordSequence(record);
  const build = getBetaRecordBuild(record);
  const lyo = getBetaRecordLyo(record);
  const lrm = record.lrm ?? '';
  const topDisplay = getBetaRecordTopDisplay(record);
  const cartridgeComplete = isBetaCartridgeCompleteRecord(record);

  row.dataset.sequence = sequence;
  row.dataset.build = build;
  row.dataset.lyo = lyo;
  row.dataset.shroud = record.shroudQr ?? sequence;
  row.dataset.lrm = lrm;
  row.dataset.mode = 'traceability_beta';
  if (record.id) row.dataset.scanId = String(record.id);
  else delete row.dataset.scanId;

  const buildCell = row.querySelector('.beta-build-cell') as HTMLElement | null;
  const lyoCell = row.querySelector('.beta-lyo-cell') as HTMLElement | null;
  const sequenceCell = row.querySelector('.beta-sequence-cell') as HTMLElement | null;
  const lrmCell = row.querySelector('.beta-lrm-cell') as HTMLElement | null;
  const leakCell = row.querySelector('.beta-leak-cell') as HTMLElement | null;
  const topCell = row.querySelector('.beta-top-cell') as HTMLElement | null;

  if (buildCell) buildCell.textContent = build;
  if (lyoCell) lyoCell.textContent = lyo;
  if (sequenceCell) sequenceCell.textContent = sequence;
  if (lrmCell) lrmCell.textContent = lrm;
  updateBetaLeakCell(row, record.leakTestStatus === 'fail' ? 'fail' : record.leakTestStatus === 'pass' || cartridgeComplete ? 'pass' : 'pending');

  if (topCell) {
    topCell.textContent = topDisplay;
    topCell.classList.remove('text-yellow-600', 'text-rose-700', 'text-emerald-700', 'font-semibold');

    if (topDisplay && topDisplay !== 'NO_CODE_FOUND') {
      if (topMatchesExpectedSequence(topDisplay, sequence)) {
        topCell.classList.add('text-emerald-700', 'font-semibold');
      } else {
        topCell.classList.add('text-rose-700', 'font-semibold');
      }
    }
  }

  if (record.topOverrideReason) {
    row.querySelector('.beta-override-badge')?.classList.remove('hidden');
  } else {
    row.querySelector('.beta-override-badge')?.classList.add('hidden');
  }

  const rescanBtn = row.querySelector('.beta-rescan-btn') as HTMLButtonElement | null;
  if (rescanBtn) rescanBtn.disabled = record.leakTestStatus === 'fail' || record.workflowStatus === 'post_ocr_reject' || record.workflowStatus === 'complete';

  if (record.workflowStatus === 'post_ocr_reject') {
    showBetaRowStatus(row, 'Post-OCR Reject', 'error');
  } else if (record.leakTestStatus === 'fail' || record.workflowStatus === 'failed_pulled') {
    showBetaRowStatus(row, 'Failed / Pulled', 'error');
  } else if (record.workflowStatus === 'ocr_in_progress') {
    showBetaRowStatus(row, 'OCR in progress');
  } else if (record.workflowStatus === 'loaded_for_cartridge_ocr') {
    showBetaRowStatus(row, 'Loaded / Pending OCR');
  } else if (record.workflowStatus === 'needs_top_correction') {
    showBetaRowStatus(row, 'Needs Top Correction', 'error');
  } else if (record.workflowStatus === 'needs_rescan') {
    showBetaRowStatus(row, 'Needs Rescan', 'error');
  } else if (cartridgeComplete) {
    showBetaRowStatus(row, 'Complete', 'ok');
  } else {
    showBetaRowStatus(row, 'LRM paired / leak test pending', 'ok');
  }

  setBetaRowActive(row, false);
}

async function getActiveRunBetaRecords() {
  const records = await db.getAll();
  const activeRecords = records
    .filter(betaRecordMatchesActiveRun)
    .filter((record) => isNonEmptyString(getBetaRecordSequence(record)));

  return dedupeBetaRecordsBySequence(activeRecords).sort((a, b) => {
    const seqDiff = betaRecordSortValue(a) - betaRecordSortValue(b);
    if (seqDiff !== 0) return seqDiff;
    return a.ts - b.ts;
  });
}

async function renderBetaTableForActiveRun() {
  const renderGeneration = ++betaTableRenderGeneration;
  const records = await getActiveRunBetaRecords();

  // A newer render started while this one was waiting on IndexedDB.
  // Letting this stale render continue would append a second copy of the list.
  if (renderGeneration !== betaTableRenderGeneration) return;

  tableBody.replaceChildren();
  betaCurrentUnit = null;
  armedRow = null;

  for (const record of records) {
    const sequence = getBetaRecordSequence(record);
    const row = createBetaTableRow({
      build: getBetaRecordBuild(record),
      lyoCondition: getBetaRecordLyo(record),
      expectedSequence: sequence,
    });
    populateBetaTableRowFromRecord(row, record);
  }

  if (hasActiveBetaRun() && getBetaWorkflowPhase() === 'lrm_pairing') {
    ensureBetaActiveRow();
  } else {
    setBetaStep('scan_shroud');
  }

  scrollBetaTableAfterRender();
  void updateBetaRunSummary();
  void updateBetaSequenceCallout();
}

function ensureBetaActiveRow() {
  if (betaCurrentUnit) return betaCurrentUnit.row;
  if (getBetaWorkflowPhase() === 'cartridge_ocr') {
    setBetaStep('scan_shroud');
    return null;
  }

  const build = getBetaBuild();
  const lyoCondition = getBetaLyo();
  const expectedSequence = getBetaExpectedSequence();
  if (!build || !lyoCondition || !expectedSequence) return null;

  const row = createBetaTableRow({ build, lyoCondition, expectedSequence });

  betaCurrentUnit = {
    build,
    lyoCondition,
    expectedSequence,
    shroudRaw: null,
    lrm: null,
    row,
  };

  setBetaStep('scan_shroud');
  if (getBetaWorkflowPhase() === 'lrm_pairing' || isLrmOnlyStation()) {
    scrollTableRowIntoView(row, 'end');
  }
  return row;
}

async function resetTableForCurrentMode() {
  tableBody.replaceChildren();

  if (currentAppMode === 'standard') {
    // Standard is intentionally hidden for now, but kept in code for a future manual workflow.
    resetOcrPreviews();
    return;
  }

  await renderBetaTableForActiveRun();
  resetOcrPreviews();
}

function setAppMode(nextMode: AppMode) {
  if (nextMode === 'standard') {
    nextMode = 'traceability_beta';
  }

  if (currentAppMode === nextMode) return;

  currentAppMode = nextMode;
  state = 'IDLE';
  scanInFlight = false;
  armedRow = null;
  betaCurrentUnit = null;

  applyAppModeUI();
  void resetTableForCurrentMode();

  updateStatus(
    hasActiveBetaRun()
      ? `Traceability ready. Next LRM sequence: ${getBetaExpectedSequence()}`
      : 'Traceability selected. Enter Build, Lyo Condition, and Starting Sequence.',
    'info',
  );
  updateBetaRunUI();
}

// ---------- Standard table ----------
function createStandardTableRow() {
  const row = document.createElement('tr');
  row.dataset.mode = 'standard';
  row.innerHTML = `
    <td class="px-2 py-2 font-mono cond-cell text-center whitespace-nowrap"></td>
    <td class="px-2 py-2 whitespace-nowrap">
      <input
        type="text"
        class="table-cell-input lrm-input"
        placeholder="Scan barcode..."
        inputmode="numeric"
        autocomplete="off"
      />
    </td>
    <td class="px-2 py-2 font-mono top-plate-cell text-center whitespace-nowrap"></td>
    <td class="px-2 py-2 whitespace-nowrap actions-cell">
      <div class="actions-wrap">
        <button type="button" class="rescan-btn bg-gray-100 hover:bg-gray-200 rounded border px-2 py-1">
          Rescan
        </button>
        <span
          class="override-badge hidden text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200"
          title="Override used"
        >
          OV
        </span>
      </div>
    </td>
  `;

  tableBody.appendChild(row);
  row.classList.add('hover:bg-gray-50');
  scrollTableToBottom();

  const input = row.querySelector('.lrm-input') as HTMLInputElement;
  input.dataset.accepted = 'false';
  input.readOnly = false;

  input.addEventListener('change', handleLrmScan);
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;

    ev.preventDefault();

    if (input.dataset.accepted === 'true' && !input.readOnly) {
      void commitLrmOverride(input, row);
      return;
    }

    if (input.dataset.accepted !== 'true') {
      void handleLrmScan(ev as unknown as Event);
    }
  });

  attachLrmOverride(input, row);
  input.focus();

  const tpCell = row.querySelector('.top-plate-cell') as HTMLElement;
  attachOverride(tpCell, row);

  const rescanBtn = row.querySelector('.rescan-btn') as HTMLButtonElement;
  rescanBtn.addEventListener('click', async () => {
    if (currentAppMode !== 'standard') return;
    if (scanInFlight) return;
    if (stablePresence && state !== 'SCANNING') {
      armedRow = row;
      await runStandardScan(row);
    } else {
      updateStatus('Place the part to rescan.', 'info');
    }
  });

  return row;
}

// ---------- Standard overrides ----------
function showOverrideBadge(row: HTMLTableRowElement) {
  const overrideBadge =
    (row.querySelector('.override-badge') as HTMLElement | null) ??
    (row.querySelector('.beta-override-badge') as HTMLElement | null);

  overrideBadge?.classList.remove('hidden');
}

function attachOverride(cell: HTMLElement, row: HTMLTableRowElement) {
  cell.addEventListener('dblclick', async () => {
    const raw = (cell.textContent || '').trim();
    const current = raw === 'NO_CODE_FOUND' ? '' : raw;

    const res = await promptOverride('TOP', current);
    if (!res) return;

    cell.textContent = res.value;
    cell.classList.remove('text-yellow-600', 'font-semibold');
    showOverrideBadge(row);
    setOcrPreview(res.value || 'NO_CODE_FOUND', 'ok', 'Top Plate');

    const idStr = row.dataset.scanId;
    if (idStr) {
      await db.update(Number(idStr), {
        topFinal: res.value,
        topOverrideReason: res.reason,
      });
    }
  });
}

function attachLrmOverridefunction attachLrmOverride(input: HTMLInputElement, row: HTMLTableRowElement) {
  input.addEventListener('dblclick', () => {
    if (input.dataset.accepted !== 'true') return;

    input.readOnly = false;
    input.focus();
    input.select();

    updateStatus('Editing LRM. Press Enter or click away to save.', 'info');
  });

  input.addEventListener('blur', () => {
    if (input.dataset.accepted === 'true' && !input.readOnly) {
      void commitLrmOverride(input, row);
    }
  });
}

async function commitLrmOverride(input: HTMLInputElement, row: HTMLTableRowElement) {
  const previous = input.dataset.lastAcceptedLrm ?? input.value.trim();
  const nextValue = input.value.trim();

  if (!nextValue) {
    input.value = previous;
    input.readOnly = true;
    updateStatus('LRM cannot be blank. Reverted to previous value.', 'error');
    return;
  }

  if (nextValue.startsWith(CONDITION_PREFIX)) {
    input.value = previous;
    input.readOnly = true;
    updateStatus(
      'Condition scan disabled. Use the Condition + Lyo inputs to start the run.',
      'error',
    );
    return;
  }

  const assignedCondition = row.dataset.condition ?? '';
  const syncResult = syncLrmMapForOverride(
    previous || input.dataset.lastAcceptedLrm || '',
    nextValue,
    assignedCondition,
  );

  if (!syncResult.ok) {
    input.value = previous;
    input.readOnly = true;
    updateStatus(
      `LRM ${nextValue} is already assigned to ${syncResult.conflictCondition}. Reverted.`,
      'error',
    );
    return;
  }

  input.value = nextValue;
  input.dataset.lastAcceptedLrm = nextValue;
  input.dataset.accepted = 'true';
  input.readOnly = true;

  if (nextValue !== previous) {
    showOverrideBadge(row);

    const idStr = row.dataset.scanId;
    if (idStr) {
      await db.update(Number(idStr), {
        lrm: nextValue,
        condition: assignedCondition || undefined,
      });
    }

    updateStatus('LRM override saved.', 'success');
  } else {
    updateStatus('LRM unchanged.', 'info');
  }
}

// ---------- Standard scanning ----------
async function handleLrmScan(e: Event) {
  if (currentAppMode !== 'standard') return;

  const input = e.target as HTMLInputElement;

  if (input.dataset.accepted === 'true') return;

  const raw = input.value.trim();
  if (!raw) return;

  if (raw.startsWith(CONDITION_PREFIX)) {
    updateStatus(
      'Condition scan disabled. Use the Condition + Lyo inputs to start the run.',
      'error',
    );
    input.value = '';
    input.focus();
    return;
  }

  if (!hasActiveRun()) {
    updateStatus('Start the run by entering Condition seed AND Lyo Condition.', 'error');
    input.value = '';
    conditionInputEl?.focus();
    return;
  }

  const assigned = assignConditionForLrm(raw);
  const row = input.closest('tr') as HTMLTableRowElement | null;
  if (row) row.dataset.condition = assigned;

  const condCell = row?.querySelector('.cond-cell') as HTMLElement | null;
  if (condCell) condCell.textContent = assigned;

  input.dataset.lastAcceptedLrm = raw;
  input.dataset.accepted = 'true';
  input.readOnly = true;

  armedRow = row ?? null;
  state = 'ARMED';
  await sendToArduino(TOKEN.READY_FOR_OCR);
  updateStatus(`LRM accepted. Assigned: ${assigned}. Place part on sensor.`, 'success');
}

async function runStandardScan(rowToScan: HTMLTableRowElement) {
  if (scanInFlight) return;
  scanInFlight = true;

  state = 'SCANNING';
  await sendToArduino(TOKEN.IN_PROGRESS);
  updateStatus('Part detected. Stabilizing image...', 'loading');

  await settleBeforeOcr();

  updateStatus('Scanning Top Plate...', 'loading');
  setOcrPreviewsScanning();

  let hasError = false;

  try {
    const topVote = await adaptiveBurstRead(
      webcam2,
      crop2,
      filter2,
      'Top Plate',
      readNumberFromCamera,
      getOcrMaxAttempts(),
      OCR_MIN_GAP_FRAMES,
      waitForFreshFrame,
    );

    const topDisplay = topVote.value ?? 'NO_CODE_FOUND';
    const tpCell = rowToScan.querySelector('.top-plate-cell') as HTMLElement;

    tpCell.textContent = topDisplay;

    const isTopAmber = topVote.conf < 2 / 3;
    tpCell.classList.toggle('text-yellow-600', isTopAmber);
    tpCell.classList.toggle('font-semibold', isTopAmber);

    setOcrPreview(
      topDisplay,
      topDisplay === 'NO_CODE_FOUND' ? 'error' : isTopAmber ? 'warn' : 'ok',
      'Top Plate',
    );

    hasError = topDisplay === 'NO_CODE_FOUND';
    updateStatus(
      hasError ? 'Scan complete. Top Plate number not found. Remove part.' : 'Top Plate scan complete. Remove part.',
      hasError ? 'error' : 'success',
    );

    const lrm = ((rowToScan.querySelector('.lrm-input') as HTMLInputElement)?.value ?? '').trim();
    const assignedCondition =
      rowToScan.dataset.condition || (lrm ? assignConditionForLrm(lrm) : undefined);

    if (assignedCondition) {
      rowToScan.dataset.condition = assignedCondition;
      const condCell = rowToScan.querySelector('.cond-cell') as HTMLElement | null;
      if (condCell) condCell.textContent = assignedCondition;
    }

    const recId = await db.add({
      ts: Date.now(),
      condition: assignedCondition ?? undefined,
      lyoCondition: getRunLyo() || undefined,
      lrm,
      top: topVote.value,
      topConf: topVote.conf,
      topHist: topVote.histogram,
      topFinal: topVote.value,
    });

    rowToScan.dataset.scanId = String(recId);
  } catch (err) {
    console.error('OCR process failed:', err);
    updateStatus('A critical OCR error occurred. Remove part.', 'error');
    setOcrPreview('Scan failed', 'error', 'Top Plate');
    hasError = true;
  }

  await sendToArduino(hasError ? TOKEN.OCR_FAIL : TOKEN.OCR_OK);
  state = 'COOLDOWN';
  cooldownUntil = performance.now() + POST_SCAN_COOLDOWN_MS;
  armedRow = null;
  scanInFlight = false;
}

// ---------- Beta pairing/cartridge workflow helpers ----------
async function saveCurrentBetaLrmPair(row: HTMLTableRowElement, sequenceQrRaw: string, lrmRaw: string) {
  if (!betaCurrentUnit) return false;

  const existingSequence = await findBetaRecordBySequenceScan(betaCurrentUnit.expectedSequence);
  if (existingSequence && existingSequence.id && Number(row.dataset.scanId || 0) !== existingSequence.id) {
    updateStatus(
      `Sequence ${betaCurrentUnit.expectedSequence} is already paired. Do not create a duplicate.`,
      'error',
    );
    showBetaRowStatus(row, 'Duplicate sequence', 'error');
    return false;
  }

  const existingLrm = await findBetaRecordByLrm(lrmRaw);
  if (existingLrm && existingLrm.sequenceNumber !== betaCurrentUnit.expectedSequence) {
    updateStatus(
      `LRM ${lrmRaw} is already paired to ${existingLrm.sequenceNumber}. Stop and verify the assembly.`,
      'error',
    );
    showBetaRowStatus(row, 'Duplicate LRM', 'error');
    return false;
  }

  const nowTs = Date.now();
  const recId = await db.add({
    ts: nowTs,
    runId: getBetaRunId(),
    mode: 'traceability_beta',
    workflowPhase: 'lrm_pairing',
    workflowStatus: 'lrm_paired_pending_leak',
    buildNumber: betaCurrentUnit.build,
    lyoCondition: betaCurrentUnit.lyoCondition,
    sequenceNumber: betaCurrentUnit.expectedSequence,
    shroudQr: sequenceQrRaw,
    customerQrCode: getImportedCustomerQr(betaCurrentUnit.expectedSequence),
    customerQrSequence: extractCustomerQrSequence(getImportedCustomerQr(betaCurrentUnit.expectedSequence)),
    lrm: lrmRaw,
    leakTestStatus: 'pending',
    mixwheelLot: getBetaMixwheelLot(),
    lrmPairTs: nowTs,
    top: null,
    topConf: 0,
    topHist: {},
    topFinal: null,
  });

  row.dataset.scanId = String(recId);
  betaCurrentUnit.recordId = recId;

  const leakCell = row.querySelector('.beta-leak-cell') as HTMLElement | null;
  updateBetaLeakCell(row, 'pending');
  void updateBetaRunSummary();
  notifyRunDataChanged('lrm-pair-saved');

  return true;
}

async function loadBetaPairForCartridgeOcr(sequenceQrRaw: string) {
  const existing = await findBetaRecordBySequenceScan(sequenceQrRaw);

  if (!existing || !existing.id) {
    updateStatus(
      'Sequence not found. Complete LRM Pairing first, then leak test. Only passing units go to Cartridge OCR.',
      'error',
    );
    return null;
  }

  if (!(existing.lrm ?? '').trim()) {
    updateStatus('Saved sequence exists, but no LRM is paired. Stop and verify traceability.', 'error');
    return null;
  }

  if (existing.leakTestStatus === 'fail') {
    updateStatus(`Sequence ${existing.sequenceNumber} is marked Failed / Pulled and cannot go to Cartridge OCR.`, 'error');
    return null;
  }

  const orderOk = await resolvePendingBeforeCartridgeOcr(existing);
  if (!orderOk) {
    updateStatus('Cartridge OCR canceled so sequence order can be verified.', 'warn');
    return null;
  }

  if (isBetaCartridgeCompleteRecord(existing)) {
    updateStatus(
      `Sequence ${existing.sequenceNumber} already has completed cartridge data. Use Post-OCR Reject if it failed downstream, or rescan only before completion.`,
      'error',
    );
    return null;
  }

  const lockAge = existing.lockedAt ? Date.now() - existing.lockedAt : Number.MAX_SAFE_INTEGER;
  if (
    existing.workflowStatus === 'ocr_in_progress' &&
    existing.lockedByStation &&
    existing.lockedByStation !== STATION_ID &&
    lockAge < OCR_STATION_LOCK_TIMEOUT_MS
  ) {
    updateStatus(
      `Sequence ${existing.sequenceNumber} is already being processed on another OCR station.`,
      'error',
    );
    return null;
  }

  await db.update(existing.id, {
    workflowStatus: 'loaded_for_cartridge_ocr',
    lockedByStation: STATION_ID,
    lockedAt: Date.now(),
  });
  notifyRunDataChanged('cartridge-row-loaded');

  clearBetaRowActiveStates();

  const existingSequence = existing.sequenceNumber ?? '';
  const row =
    getBetaTableRowBySequence(existingSequence) ??
    createBetaTableRow({
      build: existing.buildNumber ?? getBetaBuild(),
      lyoCondition: existing.lyoCondition ?? getBetaLyo(),
      expectedSequence: existingSequence,
    });

  populateBetaTableRowFromRecord(row, existing);
  row.dataset.shroud = existing.shroudQr ?? sequenceQrRaw;

  const leakCell = row.querySelector('.beta-leak-cell') as HTMLElement | null;
  if (leakCell) leakCell.textContent = 'PASS';

  showBetaRowStatus(row, 'Loaded / Pending OCR');

  betaCurrentUnit = {
    build: existing.buildNumber ?? getBetaBuild(),
    lyoCondition: existing.lyoCondition ?? getBetaLyo(),
    expectedSequence: existing.sequenceNumber ?? '',
    shroudRaw: sequenceQrRaw,
    lrm: existing.lrm ?? '',
    row,
    recordId: existing.id,
  };

  setBetaStep('place_part');
  setBetaRowActive(row, true);
  armedRow = row;
  state = 'ARMED';
  await sendToArduino(TOKEN.READY_FOR_OCR);

  updateStatus(
    `Loaded ${existing.sequenceNumber} paired to LRM ${existing.lrm}. Place cartridge for OCR.`,
    'success',
  );

  return row;
}

// ---------- Beta scanning ----------
async function handleBetaShroudScan() {
  if (currentAppMode !== 'traceability_beta') return;
  if (!hasActiveBetaRun()) {
    updateStatus('Start the traceability run first.', 'error');
    betaBuildInputEl?.focus();
    return;
  }
  if (!betaShroudScanInputEl) return;

  const raw = betaShroudScanInputEl.value.trim();
  if (!raw) return;
  if (shouldIgnoreDuplicateScan('sequence-input', raw)) {
    betaShroudScanInputEl.value = '';
    return;
  }

  if (betaSpecialAction === 'mark_failed') {
    betaShroudScanInputEl.value = '';
    await handleBetaMarkFailedScan(raw);
    return;
  }

  if (betaSpecialAction === 'recover_missing') {
    betaShroudScanInputEl.value = '';
    await handleBetaRecoverMissingScan(raw);
    return;
  }

  if (betaSpecialAction === 'post_ocr_reject') {
    betaShroudScanInputEl.value = '';
    await handleBetaPostOcrRejectScan(raw);
    return;
  }

  if (getBetaWorkflowPhase() === 'cartridge_ocr') {
    betaShroudScanInputEl.value = '';

    if (scanInFlight) {
      updateStatus('Finish the active cartridge OCR row before scanning another sequence.', 'warn');
      return;
    }

    betaCurrentUnit = null;
    await loadBetaPairForCartridgeOcr(raw);
    return;
  }

  const row = ensureBetaActiveRow();
  if (!row || !betaCurrentUnit) return;

  if (betaCurrentUnit.shroudRaw) {
    updateStatus('Duplicate Sequence QR ignored. Scan the exposed LRM label for the current row.', 'warn');
    betaShroudScanInputEl.value = '';
    focusAndSelect(betaLrmScanInputEl);
    return;
  }

  const parsedSequence = parseShroudQrSequence(raw);
  const expectedSequence = betaCurrentUnit.expectedSequence;

  if (!parsedSequence) {
    updateStatus('Could not find a sequence number in the Sequence QR scan.', 'error');
    betaShroudScanInputEl.value = '';
    focusAndSelect(betaShroudScanInputEl);
    return;
  }

  const expectedNum = expectedSequenceNumericValue(expectedSequence);

  if (parsedSequence !== expectedNum) {
    if (isBetaMissingSequenceNumber(parsedSequence)) {
      const confirmedRecover = window.confirm(
        `Sequence ${formatBetaSequenceNumber(parsedSequence, expectedSequence)} was marked missing. Restore it and scan its LRM now?`,
      );

      if (confirmedRecover) {
        betaShroudScanInputEl.value = '';
        await beginRecoveredMissingSequence(raw);
        return;
      }
    }

    updateStatus(
      `Wrong Sequence QR scanned. Expected ${expectedSequence}, but received ${parsedSequence}.`,
      'error',
    );
    if (betaExpectedSequenceValueEl) {
      betaExpectedSequenceValueEl.classList.remove('text-indigo-700', 'text-emerald-700');
      betaExpectedSequenceValueEl.classList.add('text-rose-700');
    }
    showBetaRowStatus(row, 'Sequence mismatch', 'error');
    betaShroudScanInputEl.value = '';
    focusAndSelect(betaShroudScanInputEl);
    return;
  }

  const existingSequence = await findBetaRecordBySequenceScan(expectedSequence);
  if (existingSequence) {
    updateStatus(
      `Sequence ${expectedSequence} already exists in the LRM list. Do not duplicate the pair.`,
      'error',
    );
    showBetaRowStatus(row, 'Duplicate sequence', 'error');
    betaShroudScanInputEl.value = '';
    focusAndSelect(betaShroudScanInputEl);
    return;
  }

  betaCurrentUnit.shroudRaw = raw;
  row.dataset.shroud = raw;

  if (betaExpectedSequenceValueEl) {
    betaExpectedSequenceValueEl.classList.remove('text-indigo-700', 'text-rose-700');
    betaExpectedSequenceValueEl.classList.add('text-emerald-700');
  }

  showBetaRowStatus(row, 'Sequence confirmed');
  betaShroudScanInputEl.value = '';
  setBetaStep('scan_lrm');
  state = 'WAITING_LRM';
  updateStatus(`Sequence QR verified for ${expectedSequence}. Scan exposed LRM next.`, 'success');
}

async function handleBetaLrmScan() {
  if (currentAppMode !== 'traceability_beta') return;
  if (getBetaWorkflowPhase() !== 'lrm_pairing') return;
  if (!betaLrmScanInputEl) return;

  const raw = betaLrmScanInputEl.value.trim();
  if (!raw) return;
  if (shouldIgnoreDuplicateScan('lrm-input', raw)) {
    betaLrmScanInputEl.value = '';
    return;
  }

  const row = ensureBetaActiveRow();
  if (!row || !betaCurrentUnit) return;

  if (!betaCurrentUnit.shroudRaw) {
    updateStatus('Scan Sequence QR first.', 'error');
    betaLrmScanInputEl.value = '';
    focusAndSelect(betaShroudScanInputEl);
    return;
  }

  if (betaCurrentUnit.lrm) {
    updateStatus('LRM already captured for this row.', 'error');
    betaLrmScanInputEl.value = '';
    return;
  }

  if (
    isLikelyDuplicateQrAtLrmStep(raw, betaCurrentUnit.shroudRaw, betaCurrentUnit.expectedSequence)
  ) {
    updateStatus('LRM scan appears to be the Sequence QR. Please scan the exposed LRM label.', 'error');
    betaLrmScanInputEl.value = '';
    focusAndSelect(betaLrmScanInputEl);
    return;
  }

  betaCurrentUnit.lrm = raw;
  row.dataset.lrm = raw;

  const lrmCell = row.querySelector('.beta-lrm-cell') as HTMLElement | null;
  if (lrmCell) lrmCell.textContent = raw;

  const saved = await saveCurrentBetaLrmPair(row, betaCurrentUnit.shroudRaw, raw);
  if (!saved) {
    betaLrmScanInputEl.value = '';
    focusAndSelect(betaLrmScanInputEl);
    return;
  }

  betaLrmScanInputEl.value = '';
  showBetaRowStatus(row, 'LRM paired / leak test pending', 'ok');
  setBetaRowActive(row, false);

  const completedSequence = betaCurrentUnit.expectedSequence;
  const wasRecovered = betaCurrentUnit.recovered === true;
  if (!wasRecovered) {
    advanceBetaSequence();
  } else {
    const recoveredNum = expectedSequenceNumericValue(completedSequence);
    if (recoveredNum !== null) removeBetaMissingNumber(recoveredNum);
    updateBetaRunUI();
  }
  resetBetaInputsAfterCompletion();
  betaCurrentUnit = null;
  armedRow = null;
  state = 'WAITING_QR';
  ensureBetaActiveRow();
  void updateBetaRunSummary();
  void updateBetaSequenceCallout();

  updateStatus(
    `Paired ${completedSequence} to LRM ${raw}. Shroud and leak test this assembly. Scan next Sequence QR.`,
    'success',
  );
}

async function runBetaOcrScan(rowToScan: HTMLTableRowElement) {
  if (scanInFlight || !betaCurrentUnit) return;
  scanInFlight = true;
  lastOcrFocusedSequence = betaCurrentUnit.expectedSequence;

  const existingRecordForSequence = await findBetaRecordBySequenceScan(
    betaCurrentUnit.expectedSequence,
  );
  const existingOcrId = Number(
    rowToScan.dataset.scanId ||
      betaCurrentUnit.recordId ||
      existingRecordForSequence?.id ||
      0,
  );

  if (existingOcrId) {
    rowToScan.dataset.scanId = String(existingOcrId);
    betaCurrentUnit.recordId = existingOcrId;

    await db.update(existingOcrId, {
      workflowStatus: 'ocr_in_progress',
      lockedByStation: STATION_ID,
      lockedAt: Date.now(),
    });
    notifyRunDataChanged('ocr-in-progress');
  }

  state = 'SCANNING';
  await sendToArduino(TOKEN.IN_PROGRESS);
  updateStatus('Part detected. Stabilizing Top Plate image...', 'loading');
  showBetaRowStatus(rowToScan, 'Reading Top Plate...');

  await settleBeforeOcr();
  setOcrPreviewsScanning();

  let hasError = false;

  try {
    const topVote = await adaptiveBurstRead(
      webcam2,
      crop2,
      filter2,
      'Top Plate',
      readNumberFromCamera,
      getOcrMaxAttempts(),
      OCR_MIN_GAP_FRAMES,
      waitForFreshFrame,
    );

    const topDisplay = topVote.value ?? 'NO_CODE_FOUND';
    const topCell = rowToScan.querySelector('.beta-top-cell') as HTMLElement;

    topCell.textContent = topDisplay;

    const isTopAmber = topVote.conf < 2 / 3;
    topCell.classList.toggle('text-yellow-600', isTopAmber);
    topCell.classList.toggle('font-semibold', isTopAmber);

    const topMatches = topMatchesExpectedSequence(
      topVote.value,
      betaCurrentUnit.expectedSequence,
    );

    if (topDisplay !== 'NO_CODE_FOUND') {
      topCell.classList.remove('text-rose-700', 'text-emerald-700');

      if (topMatches) {
        topCell.classList.add('text-emerald-700', 'font-semibold');
      } else {
        topCell.classList.add('text-rose-700', 'font-semibold');
      }
    }

    if (topDisplay === 'NO_CODE_FOUND') {
      setOcrPreview('NO_CODE_FOUND', 'error', 'Top Plate / Sequence Check');
    } else if (!topMatches) {
      setOcrPreview(
        `${topDisplay} ✕`,
        isTopAmber ? 'warn' : 'error',
        'Top Plate / Sequence Check',
      );
    } else {
      setOcrPreview(
        `${topDisplay} ✓`,
        isTopAmber ? 'warn' : 'ok',
        'Top Plate / Sequence Check',
      );
    }

    hasError = topDisplay === 'NO_CODE_FOUND' || !topMatches;

    const nowTs = Date.now();
    const existingId = Number(
      rowToScan.dataset.scanId ||
        betaCurrentUnit.recordId ||
        existingRecordForSequence?.id ||
        0,
    );

    const nextWorkflowStatus: ScanRecord['workflowStatus'] = hasError
      ? 'needs_top_correction'
      : 'complete';

    const cartridgePatch = {
      mode: 'traceability_beta' as const,
      workflowPhase: 'cartridge_ocr' as const,
      workflowStatus: nextWorkflowStatus,
      runId: getBetaRunId(),
      buildNumber: betaCurrentUnit.build,
      lyoCondition: betaCurrentUnit.lyoCondition,
      sequenceNumber: betaCurrentUnit.expectedSequence,
      shroudQr: betaCurrentUnit.shroudRaw ?? undefined,
      customerQrCode: getImportedCustomerQr(betaCurrentUnit.expectedSequence),
      customerQrSequence: extractCustomerQrSequence(
        getImportedCustomerQr(betaCurrentUnit.expectedSequence),
      ),
      lrm: betaCurrentUnit.lrm ?? undefined,
      leakTestStatus: 'pass' as const,
      mixwheelLot: getBetaMixwheelLot(),
      sampleCapLot: getBetaSampleCapLot(),
      cartridgeScanTs: nowTs,
      top: topVote.value ?? null,
      topConf: topVote.conf,
      topHist: topVote.histogram,
      topFinal: topVote.value ?? null,
      lockedByStation: hasError ? STATION_ID : undefined,
      lockedAt: hasError ? Date.now() : undefined,
    };

    if (existingId) {
      await db.update(existingId, cartridgePatch);
      rowToScan.dataset.scanId = String(existingId);
      betaCurrentUnit.recordId = existingId;
    } else {
      const matchingRecord = await findBetaRecordBySequenceScan(
        betaCurrentUnit.expectedSequence,
      );

      if (matchingRecord?.id) {
        await db.update(matchingRecord.id, cartridgePatch);
        rowToScan.dataset.scanId = String(matchingRecord.id);
        betaCurrentUnit.recordId = matchingRecord.id;
      } else {
        const recId = await db.add({ ts: nowTs, ...cartridgePatch });
        rowToScan.dataset.scanId = String(recId);
        betaCurrentUnit.recordId = recId;
      }
    }

    updateBetaLeakCell(rowToScan, 'pass');
    scrollTableToSequence(lastOcrFocusedSequence, 'center');
    notifyRunDataChanged('cartridge-ocr-saved');
    void updateBetaRunSummary();

    const shouldOpenTopCorrectionModal =
      topDisplay === 'NO_CODE_FOUND' || !topMatches;

    if (shouldOpenTopCorrectionModal) {
      showBetaRowStatus(
        rowToScan,
        topDisplay === 'NO_CODE_FOUND' ? 'Top OCR failed' : 'Top mismatch',
        'error',
      );
      setBetaRowActive(rowToScan, true);

      updateStatus(
        topDisplay === 'NO_CODE_FOUND'
          ? 'Top OCR failed. Opening Top Plate correction modal.'
          : `Top OCR mismatch. Expected numeric value from ${betaCurrentUnit.expectedSequence}, got ${topDisplay}.`,
        'error',
      );
    } else {
      await completeBetaUnitAfterVerification(rowToScan, topDisplay);
    }

    await sendToArduino(hasError ? TOKEN.OCR_FAIL : TOKEN.OCR_OK);
    state = hasError ? 'COOLDOWN' : 'WAITING_QR';
    cooldownUntil = performance.now() + POST_SCAN_COOLDOWN_MS;
    armedRow = null;

    if (shouldOpenTopCorrectionModal) {
      window.setTimeout(() => {
        void promptAndApplyBetaTopOverride(rowToScan, topDisplay, true);
      }, 0);
    }
  } catch (err) {
    console.error('Beta OCR failed:', err);
    updateStatus('A critical Top Plate OCR error occurred.', 'error');
    showBetaRowStatus(rowToScan, 'OCR error', 'error');
    setBetaRowActive(rowToScan, true);
    setOcrPreview('Scan failed', 'error', 'Top Plate / Sequence Check');
    hasError = true;

    const failedId = Number(
      rowToScan.dataset.scanId || betaCurrentUnit?.recordId || 0,
    );

    if (failedId) {
      await db.update(failedId, {
        workflowStatus: 'needs_rescan',
        lockedByStation: undefined,
        lockedAt: undefined,
      });
      notifyRunDataChanged('ocr-error');
    }

    await sendToArduino(TOKEN.OCR_FAIL);
    state = 'COOLDOWN';
    cooldownUntil = performance.now() + POST_SCAN_COOLDOWN_MS;
    armedRow = null;
  }

  scanInFlight = false;
}

// ---------- Persistence helpers ----------
function bindFilterPersistence() {
  const saveTop = (deviceId: string) => {
    const settings = loadDeviceSettings(deviceId);
    settings.filter = { ...filter2 };
    settings.crop = { ...crop2 };
    settings.hw = loadDeviceSettings(deviceId).hw;
    saveDeviceSettings(deviceId, settings);
  };

  brightness2.addEventListener('input', () => {
    filter2.brightness = Number(brightness2.value);
    saveTop((document.getElementById('camera-select-2') as HTMLSelectElement).value);
  });

  contrast2.addEventListener('input', () => {
    filter2.contrast = Number(contrast2.value);
    saveTop((document.getElementById('camera-select-2') as HTMLSelectElement).value);
  });
}

function applyDeviceSettingsToUI(deviceId: string) {
  const settings = loadDeviceSettings(deviceId);

  Object.assign(crop2, settings.crop);
  Object.assign(filter2, settings.filter);

  zoom2.value = String(Math.round(crop2.width * 100));
  x2.value = String(Math.round(crop2.x * 100));
  y2.value = String(Math.round(crop2.y * 100));
  brightness2.value = String(filter2.brightness);
  contrast2.value = String(filter2.contrast);

  zoom2.dispatchEvent(new Event('input'));
}

function wireCropControls() {
  const cameraId = (document.getElementById('camera-select-2') as HTMLSelectElement).value;
  setupCropControls(zoom2, x2, y2, crop2, filter2, cameraId);
}

// ---------- Presence handling ----------
async function onPresenceStable(present: boolean) {
  const now = performance.now();
  if (state === 'COOLDOWN' && now < cooldownUntil) return;

  if (
    currentAppMode === 'traceability_beta' &&
    getBetaWorkflowPhase() === 'lrm_pairing'
  ) {
    return;
  }

  if (present) {
    if (state === 'IDLE' || state === 'WAITING_QR' || state === 'WAITING_LRM') {
      updateStatus('Sensor blocked. Remove part to continue.', 'error');
      await sendToArduino(TOKEN.PART_PRESENT);
      return;
    }

    if (state === 'ARMED') {
      if (currentAppMode === 'traceability_beta') {
        const rowToScan = betaCurrentUnit?.row ?? armedRow;

        if (rowToScan && betaCurrentUnit?.shroudRaw && betaCurrentUnit?.lrm) {
          state = 'PRESENT';
          await new Promise((r) => setTimeout(r, SETTLE_AFTER_PRESENT_MS));
          await runBetaOcrScan(rowToScan);
        } else {
          updateStatus('Complete QR and LRM first.', 'error');
          await sendToArduino(TOKEN.READY_FOR_OCR);
        }

        return;
      }

      const rowToScan = armedRow;
      const rowInput = rowToScan?.querySelector('.lrm-input') as HTMLInputElement | null;

      if (rowToScan && rowInput && rowInput.dataset.accepted === 'true') {
        state = 'PRESENT';
        await new Promise((r) => setTimeout(r, SETTLE_AFTER_PRESENT_MS));
        await runStandardScan(rowToScan);
      } else {
        updateStatus('LRM accepted, but no armed row found. Rescan LRM.', 'error');
        await sendToArduino(TOKEN.READY_FOR_OCR);
      }
    }

    return;
  }

  if (currentAppMode === 'traceability_beta') {
    if (state !== 'IDLE') {
      await new Promise((r) => setTimeout(r, SETTLE_AFTER_REMOVAL_MS));

      if (betaCurrentUnit?.shroudRaw && betaCurrentUnit?.lrm) {
        state = 'ARMED';
        updateStatus('Ready for Top Plate OCR. Place the part on the sensor.', 'info');
      } else if (betaCurrentUnit?.shroudRaw) {
        state = 'WAITING_LRM';
      } else if (betaCurrentUnit) {
        state = 'WAITING_QR';
      } else {
        state = 'IDLE';
      }
    }

    if (!betaCurrentUnit) {
      updateStatus(
        hasActiveBetaRun()
          ? 'Ready for next Sequence QR scan.'
          : 'Start traceability run to begin.',
        'info',
      );
    }

    await sendToArduino(TOKEN.NO_PART);
    return;
  }

  if (state !== 'IDLE') {
    await new Promise((r) => setTimeout(r, SETTLE_AFTER_REMOVAL_MS));
    state = 'IDLE';
    armedRow = null;
    createStandardTableRow();
    await sendToArduino(TOKEN.NO_PART);
    updateStatus('Ready for next LRM scan.', 'info');
  } else {
    updateStatus('Ready for next LRM scan.', 'info');
    await sendToArduino(TOKEN.NO_PART);
  }
}

// ---------- Clear table confirmation modal ----------
let clearTableModalEl: HTMLDivElement | null = null;

function ensureClearTableModal() {
  if (clearTableModalEl) return clearTableModalEl;

  clearTableModalEl = document.createElement('div');
  clearTableModalEl.className = 'fixed inset-0 z-[1100] hidden';
  clearTableModalEl.setAttribute('role', 'dialog');
  clearTableModalEl.setAttribute('aria-modal', 'true');
  clearTableModalEl.setAttribute('aria-labelledby', 'clearTableModalTitle');

  clearTableModalEl.innerHTML = `
    <div id="clear-table-backdrop" class="absolute inset-0 bg-black/40"></div>
    <div class="absolute inset-0 flex items-center justify-center p-4">
      <div class="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-200">
          <h2 id="clearTableModalTitle" class="text-lg font-semibold text-gray-900">Clear table?</h2>
          <p class="mt-1 text-sm text-gray-600">
            Are you sure you want to clear the table? This will remove rows for the active traceability run from this browser. Save a run backup first if you may need to restore them.
          </p>
        </div>

        <div class="px-5 py-4 flex justify-end gap-2">
          <button id="clear-table-cancel" type="button"
            class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button id="clear-table-confirm" type="button"
            class="rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700">
            Clear Table
          </button>
        </div>
      </div>
    </div>
  `.trim();

  document.body.appendChild(clearTableModalEl);
  return clearTableModalEl;
}

function confirmClearTable(): Promise<boolean> {
  ensureClearTableModal();
  clearTableModalEl!.classList.remove('hidden');

  const btnCancel = clearTableModalEl!.querySelector('#clear-table-cancel') as HTMLButtonElement;
  const btnConfirm = clearTableModalEl!.querySelector('#clear-table-confirm') as HTMLButtonElement;
  const backdrop = clearTableModalEl!.querySelector('#clear-table-backdrop') as HTMLDivElement;

  return new Promise((resolve) => {
    const cleanup = () => {
      clearTableModalEl!.classList.add('hidden');
      btnCancel.onclick = null;
      btnConfirm.onclick = null;
      backdrop.onclick = null;
      clearTableModalEl!.onkeydown = null;
    };

    const cancel = () => {
      cleanup();
      resolve(false);
    };

    const confirm = () => {
      cleanup();
      resolve(true);
    };

    btnCancel.onclick = cancel;
    btnConfirm.onclick = confirm;
    backdrop.onclick = cancel;

    clearTableModalEl!.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };

    btnCancel.focus();
  });
}

// ---------- Export / Clear ----------
async function exportFromDB() {
  if (currentAppMode === 'traceability_beta' && hasActiveBetaRun()) {
    const records = await getActiveRunBetaRecords();
    const pending = records.filter(
      (record) => isNonEmptyString(record.lrm) && record.leakTestStatus !== 'fail' && !isBetaCartridgeCompleteRecord(record),
    ).length;
    const needsReview = records.filter((record) =>
      ['loaded_for_cartridge_ocr', 'ocr_in_progress', 'needs_top_correction', 'needs_rescan'].includes(record.workflowStatus ?? ''),
    ).length;
    const missing = getBetaMissingNumbers().length;

    if (pending || needsReview) {
      const proceed = window.confirm(
        `Export reconciliation warning:\n\nPending cartridge OCR/leak-test rows: ${pending}\nRows needing OCR review/rescan: ${needsReview}\nMissing sequences still reserved: ${missing}\n\nExport anyway?`,
      );
      if (!proceed) {
        updateStatus('Export canceled after reconciliation warning.', 'info');
        return;
      }
    }
  }

  await exportCsv(db);
}

async function clearTable() {
  if (currentAppMode === 'traceability_beta' && hasActiveBetaRun()) {
    const records = await getActiveRunBetaRecords();
    for (const record of records) {
      if (record.id) await db.delete(record.id);
    }
  } else {
    await db.clearAll();
  }

  tableBody.replaceChildren();
  betaCurrentUnit = null;
  state = 'IDLE';

  if (currentAppMode === 'standard') {
    createStandardTableRow();
  } else if (hasActiveBetaRun()) {
    await renderBetaTableForActiveRun();
  }

  resetOcrPreviews();
  notifyRunDataChanged('table-cleared');
  updateStatus(currentAppMode === 'traceability_beta' ? 'Active run table records cleared.' : 'Table cleared.', 'info');
}

// ---------- Bootstrap ----------
async function start() {
  // Put the UI into the current Traceability shell before touching hardware.
  // This prevents Electron from looking like the old static page if camera/media startup fails.
  currentAppMode = 'traceability_beta';
  localStorage.setItem(APP_MODE_KEY, currentAppMode);
  applyAppModeUI();
  updateBetaRunUI();
  applyStationRoleUI();

  try {
    await loadHardwareModules();
  } catch (error) {
    showStartupError(error, 'Hardware module load');
    return;
  }

  await db.init();

  setupAutoReconnect();

  if (!isLrmOnlyStation()) {
    try {
      await initWebcams();
      wireCropControls();
      livePreviewLoop(crop2, filter2);
      bindFilterPersistence();
    } catch (error) {
      showStartupError(error, 'Camera startup');
    }
  } else {
    applyStationRoleUI();
  }

  const closeMenu = () => {
    if (!menuDropdown) return;
    menuDropdown.classList.add('hidden');
    menuBtn?.setAttribute('aria-expanded', 'false');
  };

  const toggleMenu = () => {
    if (!menuDropdown) return;
    const isHidden = menuDropdown.classList.contains('hidden');
    if (isHidden) {
      menuDropdown.classList.remove('hidden');
      menuBtn?.setAttribute('aria-expanded', 'true');
    } else {
      closeMenu();
    }
  };

  menuBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      closeArduinoModal();
    }
  });

  updateRunUI();
  updateBetaRunUI();
  applyAppModeUI();
  applyStationRoleUI();
  await resetTableForCurrentMode();

  appModeSelectEl?.addEventListener('change', (e) => {
    setAppMode((e.target as HTMLSelectElement).value as AppMode);
  });

  singleWindowModeMenuBtn?.addEventListener('click', () => {
    closeMenu();

    if (isCartridgeStation() && window.opener) {
      notifyStationModeCommand('single-window');
      window.setTimeout(() => window.close(), 75);
      return;
    }

    void enterSingleWindowStationMode(true);
  });

  // ---------- Standard run ----------
  const startRun = async () => {
    const seed = (conditionInputEl?.value ?? '').trim();
    const lyo = (lyoConditionInputEl?.value ?? '').trim();
    const missingRaw = (missingCartridgesInputEl?.value ?? '').trim();

    if (!seed) {
      updateStatus('Enter a Condition seed (e.g., ME-043-A-001).', 'error');
      conditionInputEl?.focus();
      return;
    }
    if (!lyo) {
      updateStatus('Enter the Lyo Condition (e.g., Lyo H (Lot 1)).', 'error');
      lyoConditionInputEl?.focus();
      return;
    }

    const result = startRunFromSeedAndLyo(seed, lyo, missingRaw);
    if (!result.ok) {
      if (result.reason === 'invalid-seed') {
        updateStatus(
          'Condition format invalid. Expected something ending in digits, like ME-043-A-001',
          'error',
        );
        conditionInputEl?.focus();
        return;
      }

      if (result.reason === 'invalid-missing') {
        updateStatus(
          `Missing Cartridges contains invalid values: ${result.invalidTokens.join(', ')}`,
          'error',
        );
        missingCartridgesInputEl?.focus();
        return;
      }
    }

    updateRunUI();

    const missingSummary = result.missingNumbers.length
      ? ` Missing reserved: ${formatRunMissingNumbers(result.missingNumbers, getRunPad())}.`
      : '';

    const startAdjustedSummary = result.skippedAtStart
      ? ` First assignable number is ${getRunBase()}${padNum(result.startingNext, getRunPad())}.`
      : '';

    updateStatus(
      `Run started: ${seed} | ${lyo}.${missingSummary}${startAdjustedSummary} Scan LRM to begin.`,
      'success',
    );

    const lastRow = tableBody.querySelector('tr:last-child') as HTMLTableRowElement | null;
    const lastInput = lastRow?.querySelector('.lrm-input') as HTMLInputElement | null;
    lastInput?.focus();

    resetOcrPreviews();
  };

  startRunBtn?.addEventListener('click', () => void startRun());

  conditionInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startRun();
    }
  });

  lyoConditionInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startRun();
    }
  });

  missingCartridgesInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startRun();
    }
  });

  updateMissingCartridgesBtn?.addEventListener('click', () => {
    const raw = activeMissingCartridgesInputEl?.value ?? '';
    const result = updateRunMissingNumbersLive(raw);

    if (!result.ok) {
      if (result.reason === 'no-run') {
        updateStatus('Start the run before updating missing cartridges.', 'error');
        return;
      }
      if (result.reason === 'invalid-missing') {
        updateStatus(
          `Missing Cartridges contains invalid values: ${result.invalidTokens.join(', ')}`,
          'error',
        );
        activeMissingCartridgesInputEl?.focus();
        return;
      }
      if (result.reason === 'past-values') {
        updateStatus(
          `Cannot mark already used numbers as missing. Remove these values: ${result.values
            .map((n) => padNum(n, getRunPad()))
            .join(', ')}`,
          'error',
        );
        activeMissingCartridgesInputEl?.focus();
        return;
      }
    }

    updateStatus(
      result.values.length
        ? `Missing cartridges updated. Future skips: ${formatRunMissingNumbers(result.values, getRunPad())}.`
        : 'Missing cartridges cleared.',
      'success',
    );
  });

  activeMissingCartridgesInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      updateMissingCartridgesBtn?.click();
    }
  });

  clearConditionBtn?.addEventListener('click', () => {
    clearRunStateOnly();
    updateRunUI();
    resetOcrPreviews();
    updateStatus('Run ended. Enter Condition seed + Lyo Condition to start again.', 'info');
    state = 'IDLE';
    conditionInputEl?.focus();
  });

  // ---------- Traceability run ----------
  const startBetaRunFlow = async () => {
    setBetaMaterialLots(
      (document.getElementById('betaMixwheelLotInput') as HTMLInputElement | null)?.value ?? getBetaMixwheelLot(),
      (document.getElementById('betaSampleCapLotInput') as HTMLInputElement | null)?.value ?? getBetaSampleCapLot(),
    );

    const result = startBetaRun(
      betaBuildInputEl?.value ?? '',
      betaLyoInputEl?.value ?? '',
      betaStartSequenceInputEl?.value ?? '',
      betaMissingSequencesInputEl?.value ?? '',
    );

    if (!result.ok) {
      if (result.reason === 'invalid-build') {
        updateStatus('Enter a valid Build #, such as 053.', 'error');
        betaBuildInputEl?.focus();
      } else if (result.reason === 'invalid-lyo') {
        updateStatus('Enter a valid Lyo Condition.', 'error');
        betaLyoInputEl?.focus();
      } else if (result.reason === 'invalid-missing') {
        updateStatus(
          `Missing Sequences contains invalid values: ${result.invalidTokens.join(', ')}`,
          'error',
        );
        betaMissingSequencesInputEl?.focus();
      } else {
        updateStatus('Enter a valid Starting Sequence, such as Z0000000001.', 'error');
        betaStartSequenceInputEl?.focus();
      }
      return;
    }

    tableBody.replaceChildren();
    betaCurrentUnit = null;
    setBetaWorkflowPhase('lrm_pairing');
    ensureBetaActiveRow();
    updateBetaRunUI();
    setBetaStep('scan_shroud');
    state = 'WAITING_QR';

    const missingSummary = result.missingNumbers.length
      ? ` Missing reserved: ${formatBetaMissingNumbers(result.missingNumbers)}.`
      : '';

    const startAdjustedSummary = result.skippedAtStart
      ? ` First live sequence is ${result.sequence}.`
      : '';

    resetOcrPreviews();
    notifyRunDataChanged('traceability-run-started');
    updateStatus(
      `Traceability started. Build ${result.build}, ${result.lyo}, expected sequence ${result.sequence}.${missingSummary}${startAdjustedSummary}`,
      'success',
    );
  };

  startBetaRunBtn?.addEventListener('click', () => void startBetaRunFlow());
  clearBetaRunBtn?.addEventListener('click', () => {
    clearBetaRunStateOnly();
    updateBetaRunUI();
    resetBetaInputsAfterCompletion();
    tableBody.replaceChildren();
    resetOcrPreviews();
    updateStatus(
      'Traceability run ended. Enter Build, Lyo Condition, and Starting Sequence to start again.',
      'info',
    );
    betaBuildInputEl?.focus();
  });

  betaBuildInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startBetaRunFlow();
    }
  });

  betaLyoInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startBetaRunFlow();
    }
  });

  betaStartSequenceInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startBetaRunFlow();
    }
  });

  betaMissingSequencesInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startBetaRunFlow();
    }
  });

  updateBetaMissingSequencesBtn?.addEventListener('click', () => {
    const raw = betaActiveMissingSequencesInputEl?.value ?? '';
    const result = updateBetaMissingNumbersLive(raw);

    if (!result.ok) {
      if (result.reason === 'no-run') {
        updateStatus('Start the traceability run before updating missing sequences.', 'error');
        return;
      }
      if (result.reason === 'invalid-missing') {
        updateStatus(
          `Missing Sequences contains invalid values: ${result.invalidTokens.join(', ')}`,
          'error',
        );
        betaActiveMissingSequencesInputEl?.focus();
        return;
      }
      if (result.reason === 'past-values') {
        updateStatus(
          `Cannot mark already passed sequences as missing. Remove these values: ${result.values
            .map((n) => formatBetaSequenceNumber(n, getBetaExpectedSequence()))
            .join(', ')}`,
          'error',
        );
        betaActiveMissingSequencesInputEl?.focus();
        return;
      }
      if (result.reason === 'row-conflict') {
        updateStatus(
          `Cannot mark sequences already on the table as missing. Remove these values: ${result.values
            .map((n) => formatBetaSequenceNumber(n, getBetaExpectedSequence()))
            .join(', ')}`,
          'error',
        );
        betaActiveMissingSequencesInputEl?.focus();
        return;
      }
    }

    updateStatus(
      result.values.length
        ? `Missing sequences updated. Future skips: ${formatBetaMissingNumbers(result.values)}.`
        : 'Missing sequences cleared.',
      'success',
    );
  });

  betaActiveMissingSequencesInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      updateBetaMissingSequencesBtn?.click();
    }
  });

  betaShroudScanInputEl?.addEventListener('change', () => void handleBetaShroudScan());
  betaShroudScanInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleBetaShroudScan();
    }
  });

  betaLrmScanInputEl?.addEventListener('change', () => void handleBetaLrmScan());
  betaLrmScanInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleBetaLrmScan();
    }
  });

  installOcrKeyboardScannerRouter();

  // ---------- Hardware / Arduino modal ----------
  applyArduinoUiState();
  onArduinoConnectionChange?.((stateInfo: ArduinoUiState) => {
    applyArduinoUiState(stateInfo);
  });

  arduinoConnectionMenuBtn?.addEventListener('click', () => {
    closeMenu();
    openArduinoModal();
  });

  arduinoCloseModalBtn?.addEventListener('click', closeArduinoModal);
  arduinoModalBackdrop?.addEventListener('click', closeArduinoModal);

  arduinoConnectModalBtn?.addEventListener('click', () => {
    void connectAndListenToArduino(arduinoPresenceHandler);
  });

  arduinoReconnectModalBtn?.addEventListener('click', () => {
    void reconnectArduino(arduinoPresenceHandler);
  });

  arduinoDisconnectModalBtn?.addEventListener('click', () => {
    void disconnectArduino();
  });

  arduinoForgetPortModalBtn?.addEventListener('click', () => {
    void forgetArduinoPort();
  });

  addRowBtn?.addEventListener('click', () => {
    if (currentAppMode !== 'standard') return;
    createStandardTableRow();
  });

  exportCsvBtn?.addEventListener('click', exportFromDB);
  clearBtn?.addEventListener('click', async () => {
    closeMenu();

    const confirmed = await confirmClearTable();
    if (!confirmed) {
      updateStatus('Clear table canceled.', 'info');
      return;
    }

    await clearTable();
  });

  const cameraSelect2El = document.getElementById('camera-select-2') as HTMLSelectElement | null;

  cameraSelect2El?.addEventListener('change', (event) => {
    if (isLrmOnlyStation()) return;

    const selectedDeviceId = (event.target as HTMLSelectElement).value;
    applyDeviceSettingsToUI(selectedDeviceId);
    wireCropControls();
    void startStreams();
  });

  if (import.meta.env.VITE_SIM_MODE === 'true') {
    console.log('[SIM MODE] Keyboard controls enabled: P = present, R = remove');

    window.addEventListener('keydown', (e) => {
      if (isEditableKeyboardTarget(e.target)) return;
      const key = (e.key ?? '').toLowerCase();
      if (!key) return;

      if (key === 'p') schedulePresenceChange(true, SETTLE_AFTER_PRESENT_MS);
      if (key === 'r') schedulePresenceChange(false, SETTLE_AFTER_REMOVAL_MS);
    });
  }

  resetOcrPreviews();
  updateStatus(
    hasActiveBetaRun()
      ? getBetaWorkflowPhase() === 'cartridge_ocr'
        ? 'Cartridge OCR ready. Scan passing unit Sequence QR.'
        : `Ready for Sequence QR scan. Next LRM sequence: ${getBetaExpectedSequence()}`
      : 'Traceability selected. Start the traceability run to begin.',
    'info',
  );
}

void start().catch((error) => showStartupError(error, 'Startup')); 
