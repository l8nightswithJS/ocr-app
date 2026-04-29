import './index.css';
const SIM_MODE = import.meta.env.VITE_SIM_MODE === 'true';

// Camera module (real vs mock)
let initWebcams: any;
let startStreams: any;
let waitForFreshFrame: any;

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

  ({ initWebcams, startStreams, waitForFreshFrame } = cameras);
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
import { DB } from './modules/db';
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

const brightness1 = document.getElementById('brightness-1') as HTMLInputElement;
const contrast1 = document.getElementById('contrast-1') as HTMLInputElement;
const brightness2 = document.getElementById('brightness-2') as HTMLInputElement;
const contrast2 = document.getElementById('contrast-2') as HTMLInputElement;

const zoom1 = document.getElementById('zoom-1') as HTMLInputElement;
const x1 = document.getElementById('x-1') as HTMLInputElement;
const y1 = document.getElementById('y-1') as HTMLInputElement;
const zoom2 = document.getElementById('zoom-2') as HTMLInputElement;
const x2 = document.getElementById('x-2') as HTMLInputElement;
const y2 = document.getElementById('y-2') as HTMLInputElement;

const webcam1 = document.getElementById('webcam1') as HTMLVideoElement;
const webcam2 = document.getElementById('webcam2') as HTMLVideoElement;

// ---------- OCR preview result UI ----------
type OcrPreviewTone = 'idle' | 'busy' | 'ok' | 'warn' | 'error';

const ocrResultCard1 = document.getElementById('ocr-result-card-1') as HTMLDivElement | null;
const ocrResultCard2 = document.getElementById('ocr-result-card-2') as HTMLDivElement | null;
const ocrResultLabel1 = document.getElementById('ocr-result-label-1') as HTMLDivElement | null;
const ocrResultLabel2 = document.getElementById('ocr-result-label-2') as HTMLDivElement | null;
const ocrResultValue1 = document.getElementById('ocr-result-value-1') as HTMLDivElement | null;
const ocrResultValue2 = document.getElementById('ocr-result-value-2') as HTMLDivElement | null;

const pcbMatchControlsEl = document.getElementById('pcb-match-controls') as HTMLDivElement | null;
const pcbMatchPromptEl = document.getElementById('pcb-match-prompt') as HTMLDivElement | null;
const pcbMatchYesBtn = document.getElementById('pcb-match-yes-btn') as HTMLButtonElement | null;
const pcbMatchNoBtn = document.getElementById('pcb-match-no-btn') as HTMLButtonElement | null;

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
  camera: 1 | 2,
  value: string,
  tone: OcrPreviewTone = 'idle',
  labelOverride?: string,
) {
  const card = camera === 1 ? ocrResultCard1 : ocrResultCard2;
  const label = camera === 1 ? ocrResultLabel1 : ocrResultLabel2;
  const valueEl = camera === 1 ? ocrResultValue1 : ocrResultValue2;

  if (label && labelOverride) {
    label.textContent = labelOverride;
  }

  if (valueEl) {
    valueEl.textContent = value;
  }

  applyOcrPreviewTone(card, valueEl, tone);
}

function setPcbMatchButtonState(selected: 'yes' | 'no' | null) {
  const configs = [
    { btn: pcbMatchYesBtn, active: selected === 'yes' },
    { btn: pcbMatchNoBtn, active: selected === 'no' },
  ];

  for (const { btn, active } of configs) {
    if (!btn) continue;

    btn.classList.remove(
      'border-gray-300',
      'bg-white',
      'text-gray-700',
      'hover:bg-gray-50',
      'border-indigo-600',
      'bg-indigo-600',
      'text-white',
      'hover:bg-indigo-700',
    );

    if (active) {
      btn.classList.add('border-indigo-600', 'bg-indigo-600', 'text-white', 'hover:bg-indigo-700');
    } else {
      btn.classList.add('border-gray-300', 'bg-white', 'text-gray-700', 'hover:bg-gray-50');
    }
  }
}

function hidePcbMatchControls() {
  if (!pcbMatchControlsEl) return;
  pcbMatchControlsEl.classList.add('hidden');
  setPcbMatchButtonState(null);

  if (pcbMatchYesBtn) pcbMatchYesBtn.disabled = true;
  if (pcbMatchNoBtn) pcbMatchNoBtn.disabled = true;
}

function showPcbMatchControls(pcbValue: string) {
  if (!pcbMatchControlsEl) return;

  if (pcbMatchPromptEl) {
    pcbMatchPromptEl.textContent = `PCB result ${pcbValue}. Do these match?`;
  }

  pcbMatchControlsEl.classList.remove('hidden');
  if (pcbMatchYesBtn) pcbMatchYesBtn.disabled = false;
  if (pcbMatchNoBtn) pcbMatchNoBtn.disabled = false;
  setPcbMatchButtonState(null);
}

function getPendingPcbConfirmationRow() {
  const rows = Array.from(tableBody.querySelectorAll<HTMLTableRowElement>('tr'));

  for (const row of rows) {
    if (row.dataset.pcbConfirmRequired === 'true' && row.dataset.pcbConfirmed !== 'true') {
      return row;
    }
  }

  return null;
}

function getPendingStandardPcbConfirmationRow() {
  const row = getPendingPcbConfirmationRow();
  if (!row) return null;
  return row.dataset.mode === 'standard' ? row : null;
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
  if (getPendingStandardPcbConfirmationRow()) return false;
  if (hasOpenStandardEntryRow()) return false;

  state = 'IDLE';
  armedRow = null;
  createStandardTableRow();
  await sendToArduino(TOKEN.NO_PART);
  return true;
}

async function maybeAdvanceBetaAfterPcbConfirmation(row: HTMLTableRowElement) {
  if (currentAppMode !== 'traceability_beta') return false;
  if (!betaCurrentUnit || betaCurrentUnit.row !== row) return false;
  if (row.dataset.pcbConfirmed !== 'true') return false;
  if (!betaRowTopIsVerified(row)) return false;

  const completedSequence = betaCurrentUnit.expectedSequence;

  showBetaRowStatus(row, 'Complete', 'ok');
  setBetaRowActive(row, false);

  advanceBetaSequence();
  resetBetaInputsAfterCompletion();
  betaCurrentUnit = null;
  armedRow = null;
  state = 'WAITING_QR';

  ensureBetaActiveRow();
  updateStatus(
    `Traceability row complete for ${completedSequence}. Scan next shroud QR.`,
    'success',
  );
  return true;
}

function resetOcrPreviews() {
  setOcrPreview(1, '—', 'idle', 'PCB');
  setOcrPreview(
    2,
    '—',
    'idle',
    currentAppMode === 'traceability_beta' ? 'Top Plate / Sequence Check' : 'Top Plate',
  );
  hidePcbMatchControls();
}

function setOcrPreviewsScanning() {
  setOcrPreview(1, 'Scanning...', 'busy', 'PCB');
  setOcrPreview(
    2,
    'Scanning...',
    'busy',
    currentAppMode === 'traceability_beta' ? 'Top Plate / Sequence Check' : 'Top Plate',
  );
  hidePcbMatchControls();
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
let crop1: Crop = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
let crop2: Crop = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
let filter1: Filter = { brightness: 100, contrast: 100 };
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
let currentAppMode: AppMode = (localStorage.getItem(APP_MODE_KEY) as AppMode) || 'standard';

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
};

let betaCurrentUnit: BetaUnit | null = null;

// ---------- DB ----------
const db = new DB();

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

function scrollTableToBottom() {
  const target = tableScrollContainer;
  if (!target) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const lastRow = tableBody.querySelector('tr:last-child') as HTMLTableRowElement | null;

      if (lastRow) {
        lastRow.scrollIntoView({
          behavior: 'smooth',
          block: 'end',
          inline: 'nearest',
        });
      } else {
        target.scrollTop = target.scrollHeight;
      }
    });
  });
}

function getOcrMaxAttempts() {
  return SIM_MODE ? SIM_OCR_MAX_ATTEMPTS : OCR_MAX_ATTEMPTS;
}

async function settleBeforeOcr() {
  if (!SIM_MODE) {
    await waitForFreshFrame(webcam1, CAPTURE_SETTLE_FRAMES);
    await waitForFreshFrame(webcam2, CAPTURE_SETTLE_FRAMES);
    await settleAfterPresence([webcam1, webcam2], 1, 0, waitForFreshFrame);

    if (CAPTURE_EXTRA_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, CAPTURE_EXTRA_DELAY_MS));
    }
  } else {
    await waitForFreshFrame(webcam1, 1);
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
  betaCurrentUnit = null;
  state = 'IDLE';
}

function setBetaStep(step: BetaStep) {
  if (!betaCurrentStepValueEl) return;

  const labels: Record<BetaStep, string> = {
    scan_shroud: 'Scan shroud QR',
    scan_lrm: 'Scan LRM',
    place_part: 'Place part for OCR',
  };

  betaCurrentStepValueEl.textContent = labels[step];

  if (betaShroudScanInputEl) betaShroudScanInputEl.disabled = step !== 'scan_shroud';
  if (betaLrmScanInputEl) betaLrmScanInputEl.disabled = step !== 'scan_lrm';

  if (step === 'scan_shroud') focusAndSelect(betaShroudScanInputEl);
  if (step === 'scan_lrm') focusAndSelect(betaLrmScanInputEl);
}

function updateBetaRunUI() {
  const active = hasActiveBetaRun();

  if (traceabilityEmptyEl) traceabilityEmptyEl.classList.toggle('hidden', active);
  if (traceabilityActiveEl) traceabilityActiveEl.classList.toggle('hidden', !active);

  if (betaActiveBuildValueEl) betaActiveBuildValueEl.textContent = active ? getBetaBuild() : '';
  if (betaActiveLyoValueEl) betaActiveLyoValueEl.textContent = active ? getBetaLyo() : '';
  if (betaExpectedSequenceValueEl) {
    betaExpectedSequenceValueEl.textContent = active ? getBetaExpectedSequence() : 'Z0000000001';
    betaExpectedSequenceValueEl.classList.remove('text-emerald-700', 'text-rose-700');
    betaExpectedSequenceValueEl.classList.add('text-indigo-700');
  }

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
    if (betaCurrentStepValueEl) betaCurrentStepValueEl.textContent = 'Scan shroud QR';
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
    <th class="min-w-[96px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Sequence #</th>
    <th class="min-w-[84px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">LRM #</th>
    <th class="min-w-[72px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">PCB #</th>
    <th class="min-w-[104px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Top Plate #</th>
    <th class="min-w-[88px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Status</th>
    <th class="min-w-[96px] px-2 py-2 text-center font-semibold text-gray-600 uppercase whitespace-nowrap">Actions</th>
  `;
  } else {
    tableHeadRowEl.innerHTML = `
      <th class="px-2 py-2 text-center font-semibold text-gray-600 uppercase">CONDITION</th>
      <th class="px-2 py-2 text-center font-semibold text-gray-600 uppercase">LRM #</th>
      <th class="px-2 py-2 text-center font-semibold text-gray-600 uppercase">PCB #</th>
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
    appSubtitleEl.textContent = 'Traceability: QR confirm → LRM → PCB OCR + top OCR verification.';
  }

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

function completeBetaUnitAfterVerification(row: HTMLTableRowElement, topFinalValue: string) {
  const sequence = row.dataset.sequence ?? '';
  const matches = topMatchesExpectedSequence(topFinalValue, sequence);
  if (!matches) return false;

  const topCell = row.querySelector('.beta-top-cell') as HTMLElement | null;
  if (topCell) {
    topCell.classList.remove('text-yellow-600', 'text-rose-700');
    topCell.classList.add('text-emerald-700', 'font-semibold');
  }

  setOcrPreview(2, `${topFinalValue} ✓`, 'ok', 'Top Plate / Sequence Check');

  if (row.dataset.pcbConfirmRequired === 'true' && row.dataset.pcbConfirmed !== 'true') {
    showBetaRowStatus(row, 'Confirm PCB');
    setBetaRowActive(row, true);
    updateStatus('Top Plate verified. Confirm PCB match Yes or No to continue.', 'warn');
    return true;
  }

  showBetaRowStatus(row, 'Complete', 'ok');
  setBetaRowActive(row, false);

  if (betaCurrentUnit?.row === row) {
    const completedSequence = betaCurrentUnit.expectedSequence;
    advanceBetaSequence();

    resetBetaInputsAfterCompletion();
    betaCurrentUnit = null;
    armedRow = null;
    state = 'WAITING_QR';
    ensureBetaActiveRow();
    updateStatus(
      `Top Plate corrected and verified for ${completedSequence}. Scan next shroud QR.`,
      'success',
    );
  }

  return true;
}

async function promptAndApplyBetaTopOverride(
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
    setOcrPreview(2, `${res.value} ✓`, 'ok', 'Top Plate / Sequence Check');
  } else {
    topCell.classList.add('text-rose-700', 'font-semibold');
    setOcrPreview(2, `${res.value} ✕`, 'error', 'Top Plate / Sequence Check');
  }

  const idStr = row.dataset.scanId;
  if (idStr) {
    await db.update(Number(idStr), {
      topFinal: res.value,
      topOverrideReason: res.reason,
    });
  }

  if (matches) {
    completeBetaUnitAfterVerification(row, res.value);
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
    updateStatus('LRM scan appears to be the shroud QR. Please scan the LRM label.', 'error');
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
  const row = document.createElement('tr');
  row.classList.add('hover:bg-gray-50');
  row.dataset.sequence = unit.expectedSequence;
  row.dataset.build = unit.build;
  row.dataset.lyo = unit.lyoCondition;
  row.dataset.active = 'true';
  row.dataset.mode = 'traceability_beta';
  row.dataset.pcbConfirmRequired = 'false';
  row.dataset.pcbConfirmed = 'true';
  row.dataset.pcbConfirmAnswer = '';

  row.innerHTML = `
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-build-cell">${unit.build}</td>
  <td class="px-2 py-2 text-center align-top text-xs beta-lyo-cell">${unit.lyoCondition}</td>
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-sequence-cell">${unit.expectedSequence}</td>
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-lrm-cell break-all"></td>
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-pcb-cell break-all"></td>
  <td class="px-2 py-2 text-center align-top text-xs font-mono beta-top-cell break-all"></td>
  <td class="px-2 py-2 align-top text-center text-xs beta-status-cell text-gray-700 break-words">Waiting QR</td>
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
  scrollTableToBottom();

  const lrmCell = row.querySelector('.beta-lrm-cell') as HTMLElement;
  const pcbCell = row.querySelector('.beta-pcb-cell') as HTMLElement;
  const topCell = row.querySelector('.beta-top-cell') as HTMLElement;

  lrmCell.addEventListener('dblclick', () => {
    startBetaLrmInlineEdit(row);
  });

  pcbCell.addEventListener('dblclick', async () => {
    const current = (pcbCell.textContent || '').trim();
    const res = await promptOverride('PCB', current === 'NO_CODE_FOUND' ? '' : current);
    if (!res) return;

    pcbCell.textContent = res.value;
    pcbCell.classList.remove('text-yellow-600', 'font-semibold');
    row.querySelector('.beta-override-badge')?.classList.remove('hidden');
    setOcrPreview(1, res.value || 'NO_CODE_FOUND', 'ok', 'PCB');

    const idStr = row.dataset.scanId;
    if (idStr) {
      await db.update(Number(idStr), { pcbFinal: res.value, pcbOverrideReason: res.reason });
    }

    if (row.dataset.pcbConfirmRequired === 'true' && row.dataset.pcbConfirmed !== 'true') {
      showPcbMatchControls(res.value || '—');
    }
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
      updateStatus('Finish QR and LRM first.', 'error');
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

function ensureBetaActiveRow() {
  if (betaCurrentUnit) return betaCurrentUnit.row;

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
  return row;
}

function resetTableForCurrentMode() {
  tableBody.replaceChildren();

  if (currentAppMode === 'standard') {
    // Standard is intentionally hidden for now, but kept in code for a future manual workflow.
    resetOcrPreviews();
    return;
  }

  if (hasActiveBetaRun()) {
    ensureBetaActiveRow();
  }

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
  resetTableForCurrentMode();

  updateStatus(
    hasActiveBetaRun()
      ? `Traceability ready. Expected sequence: ${getBetaExpectedSequence()}`
      : 'Traceability selected. Enter Build, Lyo Condition, and Starting Sequence.',
    'info',
  );
  updateBetaRunUI();
}

// ---------- Standard table ----------
function createStandardTableRow() {
  const row = document.createElement('tr');
  row.dataset.mode = 'standard';
  row.dataset.pcbConfirmRequired = 'false';
  row.dataset.pcbConfirmed = 'true';
  row.dataset.pcbConfirmAnswer = '';

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
    <td class="px-2 py-2 font-mono pcb-cell text-center whitespace-nowrap"></td>
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

  const pcbCell = row.querySelector('.pcb-cell') as HTMLElement;
  const tpCell = row.querySelector('.top-plate-cell') as HTMLElement;
  [pcbCell, tpCell].forEach((cell) => attachOverride(cell, row));

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

    const isPcb = cell.classList.contains('pcb-cell');
    const label = isPcb ? ('PCB' as const) : ('TOP' as const);

    const res = await promptOverride(label, current);
    if (!res) return;

    cell.textContent = res.value;
    cell.classList.remove('text-yellow-600', 'font-semibold');
    showOverrideBadge(row);

    if (isPcb) {
      setOcrPreview(1, res.value || 'NO_CODE_FOUND', 'ok', 'PCB');
    } else {
      setOcrPreview(2, res.value || 'NO_CODE_FOUND', 'ok', 'Top Plate');
    }

    const idStr = row.dataset.scanId;
    if (idStr) {
      const id = Number(idStr);
      if (isPcb) {
        await db.update(id, { pcbFinal: res.value, pcbOverrideReason: res.reason });
      } else {
        await db.update(id, { topFinal: res.value, topOverrideReason: res.reason });
      }
    }
  });
}

function attachLrmOverride(input: HTMLInputElement, row: HTMLTableRowElement) {
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

async function handlePcbMatchDecision(choice: 'yes' | 'no') {
  const row = getPendingPcbConfirmationRow();
  if (!row) {
    hidePcbMatchControls();
    return;
  }

  const isBeta = row.dataset.mode === 'traceability_beta';
  const pcbCell =
    (row.querySelector('.pcb-cell') as HTMLElement | null) ??
    (row.querySelector('.beta-pcb-cell') as HTMLElement | null);

  const currentValue = (pcbCell?.textContent ?? '').trim();

  if (choice === 'no') {
    setPcbMatchButtonState('no');

    const res = await promptOverride('PCB', currentValue === 'NO_CODE_FOUND' ? '' : currentValue);
    if (!res) {
      setPcbMatchButtonState(null);
      showPcbMatchControls(currentValue || '—');
      updateStatus('PCB confirmation is still required before continuing.', 'warn');
      return;
    }

    if (pcbCell) {
      pcbCell.textContent = res.value;
      pcbCell.classList.remove('text-yellow-600', 'font-semibold');
    }

    showOverrideBadge(row);
    setOcrPreview(1, res.value || 'NO_CODE_FOUND', res.value ? 'ok' : 'error', 'PCB');

    const idStr = row.dataset.scanId;
    if (idStr) {
      await db.update(Number(idStr), { pcbFinal: res.value, pcbOverrideReason: res.reason });
    }
  } else {
    setPcbMatchButtonState('yes');
  }

  row.dataset.pcbConfirmRequired = 'true';
  row.dataset.pcbConfirmed = 'true';
  row.dataset.pcbConfirmAnswer = choice;

  hidePcbMatchControls();

  if (isBeta) {
    const advanced = await maybeAdvanceBetaAfterPcbConfirmation(row);
    if (!advanced) {
      updateStatus(
        choice === 'yes'
          ? 'PCB match confirmed. Finish Top verification to continue.'
          : 'PCB corrected and confirmed. Finish Top verification to continue.',
        'success',
      );
    }
    return;
  }

  const createdNextRow = await maybeCreateNextStandardRowIfReady();

  if (choice === 'yes') {
    updateStatus(
      createdNextRow ? 'PCB match confirmed. Ready for next LRM scan.' : 'PCB match confirmed.',
      'success',
    );
  } else {
    updateStatus(
      createdNextRow
        ? 'PCB corrected and confirmed. Ready for next LRM scan.'
        : 'PCB corrected and confirmed.',
      'success',
    );
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

  updateStatus('Scanning...', 'loading');
  setOcrPreviewsScanning();

  let hasError = false;
  try {
    const ocrAttempts = getOcrMaxAttempts();

    const [topVote, pcbVote] = await Promise.all([
      adaptiveBurstRead(
        webcam2,
        crop2,
        filter2,
        'Top Plate',
        readNumberFromCamera,
        ocrAttempts,
        OCR_MIN_GAP_FRAMES,
        waitForFreshFrame,
      ),
      adaptiveBurstRead(
        webcam1,
        crop1,
        filter1,
        'PCB',
        readNumberFromCamera,
        ocrAttempts,
        OCR_MIN_GAP_FRAMES,
        waitForFreshFrame,
      ),
    ]);

    const topDisplay = topVote.value ?? 'NO_CODE_FOUND';
    const pcbDisplay = pcbVote.value ?? 'NO_CODE_FOUND';

    const tpCell = rowToScan.querySelector('.top-plate-cell') as HTMLElement;
    const pcbCell = rowToScan.querySelector('.pcb-cell') as HTMLElement;

    tpCell.textContent = topDisplay;
    pcbCell.textContent = pcbDisplay;

    const isTopAmber = topVote.conf < 2 / 3;
    const isPcbAmber = pcbVote.conf < 2 / 3;

    tpCell.classList.toggle('text-yellow-600', isTopAmber);
    tpCell.classList.toggle('font-semibold', isTopAmber);
    pcbCell.classList.toggle('text-yellow-600', isPcbAmber);
    pcbCell.classList.toggle('font-semibold', isPcbAmber);

    setOcrPreview(
      1,
      pcbDisplay,
      pcbDisplay === 'NO_CODE_FOUND' ? 'error' : isPcbAmber ? 'warn' : 'ok',
      'PCB',
    );
    setOcrPreview(
      2,
      topDisplay,
      topDisplay === 'NO_CODE_FOUND' ? 'error' : isTopAmber ? 'warn' : 'ok',
      'Top Plate',
    );

    rowToScan.dataset.pcbConfirmRequired = pcbDisplay === 'NO_CODE_FOUND' ? 'false' : 'true';
    rowToScan.dataset.pcbConfirmed = pcbDisplay === 'NO_CODE_FOUND' ? 'true' : 'false';
    rowToScan.dataset.pcbConfirmAnswer = '';

    if (pcbDisplay !== 'NO_CODE_FOUND') {
      showPcbMatchControls(pcbDisplay);
    } else {
      hidePcbMatchControls();
    }

    hasError = topDisplay === 'NO_CODE_FOUND' || pcbDisplay === 'NO_CODE_FOUND';
    updateStatus(
      pcbDisplay === 'NO_CODE_FOUND'
        ? 'Scan complete. PCB not found. Remove part.'
        : 'Scan complete. Confirm PCB match, then remove part.',
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
      pcb: pcbVote.value,
      top: topVote.value,
      pcbConf: pcbVote.conf,
      topConf: topVote.conf,
      pcbHist: pcbVote.histogram,
      topHist: topVote.histogram,
      pcbFinal: pcbVote.value,
      topFinal: topVote.value,
    });

    rowToScan.dataset.scanId = String(recId);
  } catch (err) {
    console.error('OCR process failed:', err);
    updateStatus('A critical error occurred. Remove part.', 'error');
    setOcrPreview(1, 'Scan failed', 'error', 'PCB');
    setOcrPreview(2, 'Scan failed', 'error', 'Top Plate');
    hidePcbMatchControls();
    rowToScan.dataset.pcbConfirmRequired = 'false';
    rowToScan.dataset.pcbConfirmed = 'true';
    hasError = true;
  }

  await sendToArduino(hasError ? TOKEN.OCR_FAIL : TOKEN.OCR_OK);
  state = 'COOLDOWN';
  cooldownUntil = performance.now() + POST_SCAN_COOLDOWN_MS;
  armedRow = null;
  scanInFlight = false;
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

  const row = ensureBetaActiveRow();
  if (!row || !betaCurrentUnit) return;

  if (betaCurrentUnit.shroudRaw) {
    updateStatus('Shroud QR already accepted for this row.', 'error');
    betaShroudScanInputEl.value = '';
    return;
  }

  const parsedSequence = parseShroudQrSequence(raw);
  const expectedSequence = betaCurrentUnit.expectedSequence;

  if (!parsedSequence) {
    updateStatus('Could not find a sequence number in the shroud QR scan.', 'error');
    betaShroudScanInputEl.value = '';
    focusAndSelect(betaShroudScanInputEl);
    return;
  }

  const expectedNum = expectedSequenceNumericValue(expectedSequence);

  if (parsedSequence !== expectedNum) {
    updateStatus(
      `Wrong shroud scanned. Expected ${expectedSequence}, but received ${parsedSequence}.`,
      'error',
    );
    if (betaExpectedSequenceValueEl) {
      betaExpectedSequenceValueEl.classList.remove('text-indigo-700', 'text-emerald-700');
      betaExpectedSequenceValueEl.classList.add('text-rose-700');
    }
    showBetaRowStatus(row, 'QR mismatch', 'error');
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

  showBetaRowStatus(row, 'QR confirmed');
  betaShroudScanInputEl.value = '';
  setBetaStep('scan_lrm');
  state = 'WAITING_LRM';
  updateStatus(`Shroud QR verified for ${expectedSequence}. Scan LRM next.`, 'success');
}

async function handleBetaLrmScan() {
  if (currentAppMode !== 'traceability_beta') return;
  if (!betaLrmScanInputEl) return;

  const raw = betaLrmScanInputEl.value.trim();
  if (!raw) return;

  const row = ensureBetaActiveRow();
  if (!row || !betaCurrentUnit) return;

  if (!betaCurrentUnit.shroudRaw) {
    updateStatus('Scan shroud QR first.', 'error');
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
    updateStatus('LRM scan appears to be the shroud QR. Please scan the LRM label.', 'error');
    betaLrmScanInputEl.value = '';
    focusAndSelect(betaLrmScanInputEl);
    return;
  }

  betaCurrentUnit.lrm = raw;
  row.dataset.lrm = raw;

  const lrmCell = row.querySelector('.beta-lrm-cell') as HTMLElement | null;
  if (lrmCell) lrmCell.textContent = raw;

  betaLrmScanInputEl.value = '';
  setBetaStep('place_part');
  showBetaRowStatus(row, 'Place part for OCR');
  armedRow = row;
  state = 'ARMED';

  await sendToArduino(TOKEN.READY_FOR_OCR);
  updateStatus(
    `LRM accepted for ${betaCurrentUnit.expectedSequence}. Place the part for OCR.`,
    'success',
  );
}

async function runBetaOcrScan(rowToScan: HTMLTableRowElement) {
  if (scanInFlight || !betaCurrentUnit) return;
  scanInFlight = true;

  state = 'SCANNING';
  await sendToArduino(TOKEN.IN_PROGRESS);
  updateStatus('Part detected. Stabilizing image...', 'loading');
  showBetaRowStatus(rowToScan, 'Reading OCR...');

  await settleBeforeOcr();

  setOcrPreviewsScanning();

  let hasError = false;

  try {
    const ocrAttempts = getOcrMaxAttempts();

    const [topVote, pcbVote] = await Promise.all([
      adaptiveBurstRead(
        webcam2,
        crop2,
        filter2,
        'Top Plate',
        readNumberFromCamera,
        ocrAttempts,
        OCR_MIN_GAP_FRAMES,
        waitForFreshFrame,
      ),
      adaptiveBurstRead(
        webcam1,
        crop1,
        filter1,
        'PCB',
        readNumberFromCamera,
        ocrAttempts,
        OCR_MIN_GAP_FRAMES,
        waitForFreshFrame,
      ),
    ]);

    const pcbDisplay = pcbVote.value ?? 'NO_CODE_FOUND';
    const topDisplay = topVote.value ?? 'NO_CODE_FOUND';

    const pcbCell = rowToScan.querySelector('.beta-pcb-cell') as HTMLElement;
    const topCell = rowToScan.querySelector('.beta-top-cell') as HTMLElement;

    pcbCell.textContent = pcbDisplay;
    topCell.textContent = topDisplay;

    const isPcbAmber = pcbVote.conf < 2 / 3;
    const isTopAmber = topVote.conf < 2 / 3;

    pcbCell.classList.toggle('text-yellow-600', isPcbAmber);
    pcbCell.classList.toggle('font-semibold', isPcbAmber);
    topCell.classList.toggle('text-yellow-600', isTopAmber);
    topCell.classList.toggle('font-semibold', isTopAmber);

    const topMatches = topMatchesExpectedSequence(topVote.value, betaCurrentUnit.expectedSequence);

    if (topDisplay !== 'NO_CODE_FOUND') {
      topCell.classList.remove('text-rose-700', 'text-emerald-700');
      if (topMatches) topCell.classList.add('text-emerald-700', 'font-semibold');
      else topCell.classList.add('text-rose-700', 'font-semibold');
    }

    setOcrPreview(
      1,
      pcbDisplay,
      pcbDisplay === 'NO_CODE_FOUND' ? 'error' : isPcbAmber ? 'warn' : 'ok',
      'PCB',
    );

    if (topDisplay === 'NO_CODE_FOUND') {
      setOcrPreview(2, 'NO_CODE_FOUND', 'error', 'Top Plate / Sequence Check');
    } else if (!topMatches) {
      setOcrPreview(
        2,
        `${topDisplay} ✕`,
        isTopAmber ? 'warn' : 'error',
        'Top Plate / Sequence Check',
      );
    } else {
      setOcrPreview(2, `${topDisplay} ✓`, isTopAmber ? 'warn' : 'ok', 'Top Plate / Sequence Check');
    }

    rowToScan.dataset.pcbConfirmRequired = pcbDisplay === 'NO_CODE_FOUND' ? 'false' : 'true';
    rowToScan.dataset.pcbConfirmed = pcbDisplay === 'NO_CODE_FOUND' ? 'true' : 'false';
    rowToScan.dataset.pcbConfirmAnswer = '';

    if (pcbDisplay !== 'NO_CODE_FOUND') {
      showPcbMatchControls(pcbDisplay);
    } else {
      hidePcbMatchControls();
    }

    hasError = pcbDisplay === 'NO_CODE_FOUND' || topDisplay === 'NO_CODE_FOUND' || !topMatches;

    const recId = await db.add({
      ts: Date.now(),
      mode: 'traceability_beta',
      buildNumber: betaCurrentUnit.build,
      lyoCondition: betaCurrentUnit.lyoCondition,
      sequenceNumber: betaCurrentUnit.expectedSequence,
      shroudQr: betaCurrentUnit.shroudRaw ?? undefined,
      lrm: betaCurrentUnit.lrm ?? undefined,
      pcb: pcbVote.value ?? null,
      top: topVote.value ?? null,
      pcbConf: pcbVote.conf,
      topConf: topVote.conf,
      pcbHist: pcbVote.histogram,
      topHist: topVote.histogram,
      pcbFinal: pcbVote.value ?? null,
      topFinal: topVote.value ?? null,
    });

    rowToScan.dataset.scanId = String(recId);

    const shouldOpenTopCorrectionModal = topDisplay === 'NO_CODE_FOUND' || !topMatches;

    if (pcbDisplay === 'NO_CODE_FOUND') {
      showBetaRowStatus(rowToScan, 'PCB OCR failed', 'error');
      setBetaRowActive(rowToScan, true);
      updateStatus('PCB OCR failed. Remove part and rescan.', 'error');
    } else if (topDisplay === 'NO_CODE_FOUND') {
      showBetaRowStatus(rowToScan, 'Top OCR failed', 'error');
      setBetaRowActive(rowToScan, true);
      updateStatus('Top OCR failed. Opening Top Plate correction modal.', 'error');
    } else if (!topMatches) {
      showBetaRowStatus(rowToScan, 'Top mismatch', 'error');
      setBetaRowActive(rowToScan, true);
      updateStatus(
        `Top OCR mismatch. Opening Top Plate correction modal. Expected numeric value from ${betaCurrentUnit.expectedSequence}, got ${topDisplay}.`,
        'error',
      );
    } else {
      showBetaRowStatus(rowToScan, 'Confirm PCB');
      setBetaRowActive(rowToScan, true);
      updateStatus('Top verified. Confirm PCB match Yes or No to continue.', 'warn');
    }

    await sendToArduino(hasError ? TOKEN.OCR_FAIL : TOKEN.OCR_OK);
    state = 'COOLDOWN';
    cooldownUntil = performance.now() + POST_SCAN_COOLDOWN_MS;
    armedRow = null;

    if (shouldOpenTopCorrectionModal) {
      window.setTimeout(() => {
        void promptAndApplyBetaTopOverride(rowToScan, topDisplay, true);
      }, 0);
    }
  } catch (err) {
    console.error('Beta OCR failed:', err);
    updateStatus('A critical OCR error occurred.', 'error');
    showBetaRowStatus(rowToScan, 'OCR error', 'error');
    setBetaRowActive(rowToScan, true);
    setOcrPreview(1, 'Scan failed', 'error', 'PCB');
    setOcrPreview(2, 'Scan failed', 'error', 'Top Plate / Sequence Check');
    hidePcbMatchControls();
    hasError = true;
    await sendToArduino(TOKEN.OCR_FAIL);
    state = 'COOLDOWN';
    cooldownUntil = performance.now() + POST_SCAN_COOLDOWN_MS;
    armedRow = null;
  }

  scanInFlight = false;
}

// ---------- Persistence helpers ----------
function bindFilterPersistence() {
  const save1 = (deviceId: string) => {
    const s = loadDeviceSettings(deviceId);
    s.filter = { ...filter1 };
    s.crop = { ...crop1 };
    s.hw = loadDeviceSettings(deviceId).hw;
    saveDeviceSettings(deviceId, s);
  };
  const save2 = (deviceId: string) => {
    const s = loadDeviceSettings(deviceId);
    s.filter = { ...filter2 };
    s.crop = { ...crop2 };
    s.hw = loadDeviceSettings(deviceId).hw;
    saveDeviceSettings(deviceId, s);
  };

  brightness1.addEventListener('input', () => {
    filter1.brightness = Number(brightness1.value);
    save1((document.getElementById('camera-select-1') as HTMLSelectElement).value);
  });
  contrast1.addEventListener('input', () => {
    filter1.contrast = Number(contrast1.value);
    save1((document.getElementById('camera-select-1') as HTMLSelectElement).value);
  });
  brightness2.addEventListener('input', () => {
    filter2.brightness = Number(brightness2.value);
    save2((document.getElementById('camera-select-2') as HTMLSelectElement).value);
  });
  contrast2.addEventListener('input', () => {
    filter2.contrast = Number(contrast2.value);
    save2((document.getElementById('camera-select-2') as HTMLSelectElement).value);
  });
}

function applyDeviceSettingsToUI(camIndex: 1 | 2, deviceId: string) {
  const s = loadDeviceSettings(deviceId);
  if (camIndex === 1) {
    Object.assign(crop1, s.crop);
    Object.assign(filter1, s.filter);
    zoom1.value = String(Math.round(crop1.width * 100));
    x1.value = String(Math.round(crop1.x * 100));
    y1.value = String(Math.round(crop1.y * 100));
    brightness1.value = String(filter1.brightness);
    contrast1.value = String(filter1.contrast);
    zoom1.dispatchEvent(new Event('input'));
  } else {
    Object.assign(crop2, s.crop);
    Object.assign(filter2, s.filter);
    zoom2.value = String(Math.round(crop2.width * 100));
    x2.value = String(Math.round(crop2.x * 100));
    y2.value = String(Math.round(crop2.y * 100));
    brightness2.value = String(filter2.brightness);
    contrast2.value = String(filter2.contrast);
    zoom2.dispatchEvent(new Event('input'));
  }
}

function wireCropControls() {
  const cam1Id = (document.getElementById('camera-select-1') as HTMLSelectElement).value;
  const cam2Id = (document.getElementById('camera-select-2') as HTMLSelectElement).value;
  setupCropControls(zoom1, x1, y1, crop1, filter1, cam1Id);
  setupCropControls(zoom2, x2, y2, crop2, filter2, cam2Id);
}

// ---------- Presence handling ----------
async function onPresenceStable(present: boolean) {
  const now = performance.now();
  if (state === 'COOLDOWN' && now < cooldownUntil) return;

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
  } else {
    if (currentAppMode === 'traceability_beta') {
      if (state !== 'IDLE') {
        await new Promise((r) => setTimeout(r, SETTLE_AFTER_REMOVAL_MS));

        if (betaCurrentUnit?.shroudRaw && betaCurrentUnit?.lrm) {
          state = 'ARMED';
          updateStatus('Ready for OCR. Place the part on the sensor.', 'info');
        } else if (betaCurrentUnit?.shroudRaw) {
          state = 'WAITING_LRM';
        } else if (betaCurrentUnit) {
          state = 'WAITING_QR';
        } else {
          state = 'IDLE';
        }
      }

      const pendingPcbConfirmationRow = getPendingPcbConfirmationRow();
      if (
        pendingPcbConfirmationRow &&
        pendingPcbConfirmationRow.dataset.mode === 'traceability_beta'
      ) {
        const pcbValue =
          (
            (pendingPcbConfirmationRow.querySelector('.beta-pcb-cell') as HTMLElement | null)
              ?.textContent ?? ''
          ).trim() || '—';

        showPcbMatchControls(pcbValue);
        await sendToArduino(TOKEN.NO_PART);
        updateStatus('Confirm PCB match Yes or No before the next traceability row.', 'warn');
        pcbMatchYesBtn?.focus();
        return;
      }

      if (!betaCurrentUnit) {
        updateStatus(
          hasActiveBetaRun()
            ? 'Ready for next shroud QR scan.'
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

      const pendingPcbConfirmationRow = getPendingStandardPcbConfirmationRow();
      if (pendingPcbConfirmationRow) {
        const pcbValue =
          (
            pendingPcbConfirmationRow.querySelector('.pcb-cell') as HTMLElement | null
          )?.textContent?.trim() || '—';

        showPcbMatchControls(pcbValue);
        await sendToArduino(TOKEN.NO_PART);
        updateStatus('Confirm PCB match Yes or No before the next row.', 'warn');
        pcbMatchYesBtn?.focus();
        return;
      }

      createStandardTableRow();
      await sendToArduino(TOKEN.NO_PART);
      updateStatus('Ready for next LRM scan.', 'info');
    } else {
      updateStatus('Ready for next LRM scan.', 'info');
      await sendToArduino(TOKEN.NO_PART);
    }
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
            Are you sure you want to clear the table? This will remove the current rows from the screen and clear saved scan records.
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
  await exportCsv(db);
}

async function clearTable() {
  await db.clearAll();
  tableBody.replaceChildren();
  betaCurrentUnit = null;
  state = 'IDLE';

  if (currentAppMode === 'standard') {
    createStandardTableRow();
  } else if (hasActiveBetaRun()) {
    ensureBetaActiveRow();
  }

  resetOcrPreviews();
  updateStatus('Table cleared.', 'info');
}

// ---------- Bootstrap ----------
async function start() {
  await loadHardwareModules();
  await db.init();

  if (import.meta.env.DEV) {
    clearRunStateOnly();
    clearBetaRunStateOnly();
  }

  setupAutoReconnect();

  await initWebcams();
  wireCropControls();
  livePreviewLoop(crop1, crop2, filter1, filter2);
  bindFilterPersistence();

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
  resetTableForCurrentMode();

  appModeSelectEl?.addEventListener('change', (e) => {
    setAppMode((e.target as HTMLSelectElement).value as AppMode);
  });

  pcbMatchYesBtn?.addEventListener('click', () => {
    void handlePcbMatchDecision('yes');
  });

  pcbMatchNoBtn?.addEventListener('click', () => {
    void handlePcbMatchDecision('no');
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

    if (getPendingStandardPcbConfirmationRow()) {
      updateStatus('Confirm PCB match Yes or No before adding a new row.', 'warn');
      const pendingRow = getPendingStandardPcbConfirmationRow();
      const pcbValue =
        (pendingRow?.querySelector('.pcb-cell') as HTMLElement | null)?.textContent?.trim() || '—';
      showPcbMatchControls(pcbValue);
      pcbMatchYesBtn?.focus();
      return;
    }

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

  const cameraSelect1El = document.getElementById('camera-select-1') as HTMLSelectElement | null;
  const cameraSelect2El = document.getElementById('camera-select-2') as HTMLSelectElement | null;

  const ensureDifferentCameraSelection = (
    changedSelect: HTMLSelectElement,
    otherSelect: HTMLSelectElement,
  ) => {
    if (!changedSelect.value || !otherSelect.value) return;

    if (changedSelect.value !== otherSelect.value) return;

    const replacementOption = Array.from(otherSelect.options).find(
      (option) => option.value !== changedSelect.value,
    );

    if (replacementOption) {
      otherSelect.value = replacementOption.value;
    }
  };

  cameraSelect1El?.addEventListener('change', (e) => {
    const selectedDeviceId = (e.target as HTMLSelectElement).value;

    if (cameraSelect2El) {
      ensureDifferentCameraSelection(cameraSelect1El, cameraSelect2El);
    }

    applyDeviceSettingsToUI(1, selectedDeviceId);
    wireCropControls();
    void startStreams();
  });

  cameraSelect2El?.addEventListener('change', (e) => {
    const selectedDeviceId = (e.target as HTMLSelectElement).value;

    if (cameraSelect1El) {
      ensureDifferentCameraSelection(cameraSelect2El, cameraSelect1El);
    }

    applyDeviceSettingsToUI(2, selectedDeviceId);
    wireCropControls();
    void startStreams();
  });

  if (import.meta.env.VITE_SIM_MODE === 'true') {
    console.log('[SIM MODE] Keyboard controls enabled: P = present, R = remove');

    window.addEventListener('keydown', (e) => {
      const key = (e.key ?? '').toLowerCase();
      if (!key) return;

      if (key === 'p') schedulePresenceChange(true, SETTLE_AFTER_PRESENT_MS);
      if (key === 'r') schedulePresenceChange(false, SETTLE_AFTER_REMOVAL_MS);
    });
  }

  resetOcrPreviews();
  updateStatus(
    currentAppMode === 'standard'
      ? 'Ready for next LRM scan.'
      : hasActiveBetaRun()
        ? `Ready for shroud QR scan. Expected sequence: ${getBetaExpectedSequence()}`
        : 'Traceability selected. Start the traceability run to begin.',
    'info',
  );
}

void start();
