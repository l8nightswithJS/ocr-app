import { updateStatus } from '../ui/status';

export const TOKEN = {
  NO_PART: 'N',
  PART_PRESENT: 'P',
  READY_FOR_OCR: 'R',
  IN_PROGRESS: 'I',
  OCR_OK: 'O',
  OCR_FAIL: 'F',
} as const;

type PresenceHandler = (present: boolean) => Promise<void> | void;

type ArduinoConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export type ArduinoConnectionState = {
  status: ArduinoConnectionStatus;
  message?: string;
  portLabel?: string;
};

type StateListener = (state: ArduinoConnectionState) => void;

const listeners = new Set<StateListener>();
let connectionState: ArduinoConnectionState = {
  status: 'disconnected',
  message: 'Disconnected',
  portLabel: 'SIM serial port',
};

let onPresenceCb: PresenceHandler | null = null;
let simKeyListenerAttached = false;
let connected = false;

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function publishConnectionState(next: ArduinoConnectionState) {
  connectionState = next;
  for (const listener of listeners) listener(connectionState);
}

function setConnectionState(status: ArduinoConnectionStatus, message?: string) {
  publishConnectionState({ status, message, portLabel: 'SIM serial port' });
}

export function onArduinoConnectionChange(listener: StateListener) {
  listeners.add(listener);
  listener(connectionState);
  return () => listeners.delete(listener);
}

export function getArduinoConnectionState() {
  return connectionState;
}

function handleSimKeydown(e: KeyboardEvent) {
  if (!connected || !onPresenceCb) return;

  const key = (e.key ?? '').toLowerCase();
  if (!key) return;

  if (key === 'p') void onPresenceCb(true);
  if (key === 'r') void onPresenceCb(false);
}

function attachSimKeyListenerOnce() {
  if (simKeyListenerAttached) return;
  window.addEventListener('keydown', handleSimKeydown);
  simKeyListenerAttached = true;
}

export async function connectAndListenToArduino(onPresence: PresenceHandler) {
  if (connected) return;

  setConnectionState('connecting', 'SIM connecting...');
  await delay(150);

  onPresenceCb = onPresence;
  connected = true;
  attachSimKeyListenerOnce();

  setConnectionState('connected', 'SIM connected');
  updateStatus('SIM MODE: Arduino connected. Use keys P/R for presence.', 'success');
  await sendToArduino(TOKEN.NO_PART);
}

export async function reconnectArduino(onPresence?: PresenceHandler) {
  setConnectionState('reconnecting', 'SIM reconnecting...');
  await disconnectArduino(false);
  await delay(250);
  await connectAndListenToArduino(onPresence ?? onPresenceCb ?? (() => undefined));
}

export async function disconnectArduino(showMessage = true) {
  connected = false;
  setConnectionState('disconnected', 'SIM disconnected');

  if (showMessage) {
    updateStatus('SIM MODE: Arduino disconnected.', 'info');
  }
}

export async function forgetArduinoPort() {
  await disconnectArduino(false);
  onPresenceCb = null;
  setConnectionState('disconnected', 'SIM saved port cleared');
  updateStatus('SIM MODE: saved Arduino port cleared.', 'success');
}

export async function sendToArduino(_token: string) {
  return;
}
