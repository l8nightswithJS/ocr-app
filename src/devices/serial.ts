import { updateStatus } from '../ui/status';

export const TOKEN = {
  NO_PART: 'N',
  PART_PRESENT: 'P',
  READY_FOR_OCR: 'R',
  IN_PROGRESS: 'I',
  OCR_OK: 'O',
  OCR_FAIL: 'F',

  // Diagnostic / hardware confirmation tokens from config.h
  HANDSHAKE: '?',
  STATUS: 'S',
  VERSION: 'V',
  BRIGHTNESS_REPORT: 'B',
  BRIGHTNESS_UP: '+',
  BRIGHTNESS_DOWN: '-',
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

type ArduinoHelloEvent = {
  evt?: string;
  device?: string;
  ready?: boolean;
  version?: string;
  baud?: number;
  pixels?: number;
  t?: number;
};

type ArduinoStatusEvent = {
  evt?: string;
  presence?: boolean;
  rawPresence?: boolean;
  state?: string;
  override?: boolean;
  brightness?: number;
  t?: number;
};

type ArduinoPresenceEvent = {
  evt?: string;
  value?: boolean;
  t?: number;
};

const EXPECTED_DEVICE_NAME = 'ocr_fixture';
const SERIAL_BAUD = 115200;
const HANDSHAKE_TIMEOUT_MS = 2500;
const AUTO_RECONNECT_DELAY_MS = 700;

const listeners = new Set<StateListener>();

let connectionState: ArduinoConnectionState = {
  status: 'disconnected',
  message: 'Disconnected',
  portLabel: 'No port selected',
};

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => window.setTimeout(resolve, ms)),
  ]);
}

function serialAvailable() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function isUserCancelError(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('No port selected') || msg.includes('The user cancelled');
}

function isHandshakeError(error: unknown) {
  if (!(error instanceof Error)) return false;

  return [
    'HANDSHAKE_TIMEOUT',
    'HANDSHAKE_WRONG_DEVICE',
    'HANDSHAKE_NOT_READY',
    'HANDSHAKE_SEND_FAILED',
  ].includes(error.message);
}

function publishConnectionState(next: ArduinoConnectionState) {
  connectionState = next;

  for (const listener of listeners) {
    listener(connectionState);
  }
}

function setConnectionState(
  status: ArduinoConnectionStatus,
  message?: string,
  portLabel = Serial.getPortLabel(),
) {
  publishConnectionState({ status, message, portLabel });
}

function parseSerialJson(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isHelloEvent(event: unknown): event is ArduinoHelloEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as ArduinoHelloEvent;
  return e.evt === 'hello';
}

function isPresenceEvent(event: unknown): event is ArduinoPresenceEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as ArduinoPresenceEvent;
  return e.evt === 'presence';
}

function isStatusEvent(event: unknown): event is ArduinoStatusEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as ArduinoStatusEvent;
  return e.evt === 'status';
}

class SerialManager {
  private port: SerialPort | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;

  private encoder: TextEncoderStream | null = null;
  private decoder: TextDecoderStream | null = null;

  private encoderPipe: Promise<void> | null = null;
  private decoderPipe: Promise<void> | null = null;

  private _open = false;
  private _connecting = false;

  get isOpen() {
    return this._open;
  }

  get isConnecting() {
    return this._connecting;
  }

  getPortLabel() {
    if (!this.port) return 'No port selected';

    const infoGetter = (
      this.port as unknown as { getInfo?: () => { usbVendorId?: number; usbProductId?: number } }
    ).getInfo;

    const info = typeof infoGetter === 'function' ? infoGetter.call(this.port) : null;

    if (info?.usbVendorId || info?.usbProductId) {
      const vendor = info.usbVendorId
        ? `VID ${info.usbVendorId.toString(16).toUpperCase()}`
        : 'VID unknown';

      const product = info.usbProductId
        ? `PID ${info.usbProductId.toString(16).toUpperCase()}`
        : 'PID unknown';

      return `${vendor} / ${product}`;
    }

    return 'Selected serial port';
  }

  async disconnect() {
    this._connecting = false;
    this._open = false;

    const reader = this.reader;
    const writer = this.writer;
    const encoderPipe = this.encoderPipe;
    const decoderPipe = this.decoderPipe;
    const port = this.port;

    this.reader = null;
    this.writer = null;
    this.encoderPipe = null;
    this.decoderPipe = null;
    this.encoder = null;
    this.decoder = null;
    this.port = null;

    if (reader) {
      try {
        await withTimeout(reader.cancel(), 500);
      } catch {
        // Reader may already be closed during reconnect/unplug recovery.
      }

      try {
        reader.releaseLock();
      } catch {
        // Ignore release errors during recovery.
      }
    }

    if (decoderPipe) {
      try {
        await withTimeout(decoderPipe, 700);
      } catch {
        // Expected during disconnect/reconnect.
      }
    }

    if (writer) {
      try {
        const closed = await withTimeout(writer.close(), 500);

        if (closed === undefined) {
          try {
            await withTimeout(writer.abort('serial disconnect timeout'), 300);
          } catch {
            // Ignore abort errors during recovery.
          }
        }
      } catch {
        try {
          await withTimeout(writer.abort('serial disconnect error'), 300);
        } catch {
          // Ignore abort errors during recovery.
        }
      }

      try {
        writer.releaseLock();
      } catch {
        // Ignore release errors during recovery.
      }
    }

    if (encoderPipe) {
      try {
        await withTimeout(encoderPipe, 700);
      } catch {
        // Expected during disconnect/reconnect.
      }
    }

    if (port) {
      try {
        await withTimeout(port.close(), 800);
      } catch {
        // Port may already be closed, unplugged, or held during recovery.
      }
    }
  }

  async connect(options: SerialOptions = { baudRate: SERIAL_BAUD }) {
    if (this._open || this._connecting) return this.reader;

    this._connecting = true;

    try {
      await this.disconnect();

      if (!serialAvailable()) {
        throw new Error('WEB_SERIAL_UNAVAILABLE');
      }

      // Always prompt for the Arduino/fixture port instead of automatically grabbing
      // the first permitted serial device. Once barcode scanners are also used in
      // USB COM mode, navigator.serial.getPorts() may include scanner ports.
      // Prompting prevents the OCR fixture connection from accidentally opening
      // a scanner COM port.
      const port = await navigator.serial.requestPort();

      await port.open(options);
      this.port = port;

      if (!port.readable || !port.writable) {
        throw new Error('SERIAL_STREAMS_UNAVAILABLE');
      }

      this.encoder = new TextEncoderStream();
      this.decoder = new TextDecoderStream();

      this.encoderPipe = (this.encoder.readable as ReadableStream<Uint8Array>)
        .pipeTo(port.writable as WritableStream<Uint8Array>)
        .catch(() => {
          // Expected during unplug, reconnect, or app-side disconnect.
        });

      this.decoderPipe = (port.readable as ReadableStream<Uint8Array>)
        .pipeTo(this.decoder.writable as WritableStream<Uint8Array>)
        .catch(() => {
          // Expected during unplug, reconnect, or app-side disconnect.
        });

      this.writer = this.encoder.writable.getWriter();
      this.reader = this.decoder.readable.getReader();

      this._open = true;
      return this.reader;
    } catch (error) {
      await this.disconnect();
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  async send(token: string) {
    if (!this._open || !this.writer) {
      return false;
    }

    try {
      await this.writer.write(String(token));
      return true;
    } catch {
      return false;
    }
  }

  async forgetSavedPorts() {
    await this.disconnect();

    if (!serialAvailable()) {
      throw new Error('WEB_SERIAL_UNAVAILABLE');
    }

    const ports = await navigator.serial.getPorts();

    for (const port of ports) {
      const forget = (port as unknown as { forget?: () => Promise<void> }).forget;

      if (typeof forget === 'function') {
        await forget.call(port);
      }
    }
  }
}

export const Serial = new SerialManager();

export function onArduinoConnectionChange(listener: StateListener) {
  listeners.add(listener);
  listener(connectionState);

  return () => listeners.delete(listener);
}

export function getArduinoConnectionState() {
  return connectionState;
}

let disconnectListenerAttached = false;
let activePresenceHandler: PresenceHandler | null = null;
let activeReadLoop: Promise<void> | null = null;
let intentionalDisconnect = false;

function attachDisconnectListenerOnce() {
  if (disconnectListenerAttached || !serialAvailable()) return;

  const serialWithEvents = navigator.serial as unknown as EventTarget;

  serialWithEvents.addEventListener('disconnect', () => {
    void (async () => {
      intentionalDisconnect = true;
      activeReadLoop = null;

      await Serial.disconnect();

      setConnectionState('disconnected', 'Arduino disconnected', 'No port selected');
      updateStatus('Arduino disconnected. Open Arduino Connection to reconnect.', 'error');
    })();
  });

  disconnectListenerAttached = true;
}

function statusForConnectError(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);

  if (msg === 'WEB_SERIAL_UNAVAILABLE') {
    return 'Web Serial API not available in this build. Check Electron serial settings.';
  }

  if (isUserCancelError(error)) {
    return 'Serial connection canceled. Open Arduino Connection when ready.';
  }

  if (msg === 'SERIAL_READER_UNAVAILABLE') {
    return 'Serial reader unavailable after opening the port.';
  }

  if (msg === 'SERIAL_STREAMS_UNAVAILABLE') {
    return 'Serial port opened, but readable/writable streams were unavailable.';
  }

  if (msg === 'HANDSHAKE_TIMEOUT') {
    return 'Serial port opened, but the OCR fixture did not respond to handshake.';
  }

  if (msg === 'HANDSHAKE_WRONG_DEVICE') {
    return 'Serial device responded, but it is not the OCR fixture.';
  }

  if (msg === 'HANDSHAKE_NOT_READY') {
    return 'OCR fixture responded, but did not report ready.';
  }

  if (msg === 'HANDSHAKE_SEND_FAILED') {
    return 'Serial port opened, but handshake command could not be sent.';
  }

  if (msg.includes('already open')) {
    return 'Serial port already open in another app or tab. Close Arduino IDE Serial Monitor and try again.';
  }

  if (msg.includes('Failed to open serial port')) {
    return 'Could not open serial port. Use Reconnect or Clear Saved Port, then select the Arduino again.';
  }

  return 'Could not open serial port. Ensure no other app is using it.';
}

async function waitForHelloHandshake(
  reader: ReadableStreamDefaultReader<string>,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<ArduinoHelloEvent> {
  const start = performance.now();
  let buffer = '';

  while (performance.now() - start < timeoutMs) {
    const remaining = Math.max(50, timeoutMs - (performance.now() - start));
    const result = await withTimeout(reader.read(), remaining);

    if (!result) break;
    if (result.done) break;

    buffer += result.value ?? '';

    let nl = buffer.indexOf('\n');

    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      const event = parseSerialJson(line);

      if (isHelloEvent(event)) {
        if (event.device !== EXPECTED_DEVICE_NAME) {
          throw new Error('HANDSHAKE_WRONG_DEVICE');
        }

        if (event.ready !== true) {
          throw new Error('HANDSHAKE_NOT_READY');
        }

        return event;
      }

      nl = buffer.indexOf('\n');
    }
  }

  throw new Error('HANDSHAKE_TIMEOUT');
}

async function confirmHardwareHandshake(
  reader: ReadableStreamDefaultReader<string>,
): Promise<ArduinoHelloEvent> {
  const sentHandshake = await sendToArduino(TOKEN.HANDSHAKE);

  if (!sentHandshake) {
    throw new Error('HANDSHAKE_SEND_FAILED');
  }

  return waitForHelloHandshake(reader);
}

async function readPresenceLoop(
  reader: ReadableStreamDefaultReader<string>,
  onPresence: PresenceHandler,
) {
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += value ?? '';

      let nl = buffer.indexOf('\n');

      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        const event = parseSerialJson(line);

        if (isPresenceEvent(event)) {
          await onPresence(Boolean(event.value));
        }

        if (isStatusEvent(event)) {
          // Status JSON is currently informational.
          // Presence events drive the app workflow.
        }

        nl = buffer.indexOf('\n');
      }
    }
  } catch {
    // Expected when disconnect/reconnect cancels the active reader.
  }
}

function startReadLoop(reader: ReadableStreamDefaultReader<string>, onPresence: PresenceHandler) {
  const loop = readPresenceLoop(reader, onPresence);
  activeReadLoop = loop;

  void loop.finally(() => {
    if (activeReadLoop !== loop) return;

    activeReadLoop = null;

    if (!intentionalDisconnect) {
      void (async () => {
        await Serial.disconnect();
        setConnectionState('disconnected', 'Arduino disconnected', 'No port selected');
        updateStatus('Arduino disconnected. Open Arduino Connection to reconnect.', 'error');
      })();
    }
  });
}

export function sendToArduino(token: string) {
  return Serial.send(token);
}

async function openPortConfirmHandshakeAndListen(
  onPresence: PresenceHandler,
  statusMessage: string,
) {
  setConnectionState('connecting', statusMessage, Serial.getPortLabel());

  const reader = await Serial.connect({ baudRate: SERIAL_BAUD });

  if (!reader) {
    throw new Error('SERIAL_READER_UNAVAILABLE');
  }

  setConnectionState('connecting', 'Confirming OCR fixture handshake...', Serial.getPortLabel());

  const hello = await confirmHardwareHandshake(reader);
  const versionLabel = hello.version ? `Firmware ${hello.version}` : 'Fixture confirmed';

  setConnectionState('connected', `Connected — ${versionLabel}`, Serial.getPortLabel());
  updateStatus(`Arduino connected. ${versionLabel}.`, 'success');

  await sendToArduino(TOKEN.NO_PART);

  startReadLoop(reader, onPresence);

  return true;
}

async function reconnectAfterHandshakeFailure(onPresence: PresenceHandler) {
  setConnectionState(
    'reconnecting',
    'Connection failed. Standing by while attempting reconnect...',
    Serial.getPortLabel(),
  );

  updateStatus('Arduino handshake failed. Standing by while attempting reconnect...', 'warn');

  intentionalDisconnect = true;
  await Serial.disconnect();
  activeReadLoop = null;

  await delay(AUTO_RECONNECT_DELAY_MS);

  try {
    intentionalDisconnect = false;

    await openPortConfirmHandshakeAndListen(
      onPresence,
      'Reopening serial port after handshake failure...',
    );

    return true;
  } catch (error) {
    console.error('Auto reconnect after handshake failure failed:', error);

    intentionalDisconnect = true;
    await Serial.disconnect();
    activeReadLoop = null;

    setConnectionState(
      'error',
      'Reconnect failed. Clear Saved Port, unplug/replug Arduino, then connect again.',
      'No port selected',
    );

    updateStatus(
      'Reconnect failed. Clear Saved Port, unplug/replug Arduino, then connect again.',
      'error',
    );

    return false;
  }
}

export async function connectAndListenToArduino(onPresence: PresenceHandler) {
  if (Serial.isConnecting) {
    updateStatus('Arduino connection already in progress.', 'info');
    return;
  }

  if (Serial.isOpen) {
    setConnectionState('connected', 'Connected', Serial.getPortLabel());
    updateStatus('Arduino is already connected.', 'info');
    return;
  }

  activePresenceHandler = onPresence;
  intentionalDisconnect = false;

  try {
    attachDisconnectListenerOnce();

    await openPortConfirmHandshakeAndListen(onPresence, 'Opening serial port...');
  } catch (error: unknown) {
    console.error('Serial connection error:', error);

    if (isHandshakeError(error)) {
      const recovered = await reconnectAfterHandshakeFailure(onPresence);
      if (recovered) return;
    }

    const message = statusForConnectError(error);

    intentionalDisconnect = true;
    await Serial.disconnect();

    activeReadLoop = null;

    if (isUserCancelError(error)) {
      setConnectionState('disconnected', 'Disconnected', 'No port selected');
    } else {
      setConnectionState('error', message, 'No port selected');
    }

    updateStatus(message, isUserCancelError(error) ? 'warn' : 'error');
  }
}

export async function disconnectArduino() {
  intentionalDisconnect = true;

  setConnectionState('reconnecting', 'Releasing serial port...', Serial.getPortLabel());

  await Serial.disconnect();

  activeReadLoop = null;

  setConnectionState('disconnected', 'Disconnected', 'No port selected');
  updateStatus('Arduino disconnected and serial port released.', 'info');
}

export async function reconnectArduino(onPresence?: PresenceHandler) {
  const handler = onPresence ?? activePresenceHandler;

  if (!handler) {
    updateStatus('Open Arduino Connection and click Connect Arduino first.', 'warn');
    return;
  }

  intentionalDisconnect = true;
  setConnectionState('reconnecting', 'Reconnecting...', Serial.getPortLabel());

  await Serial.disconnect();

  activeReadLoop = null;

  await delay(AUTO_RECONNECT_DELAY_MS);

  intentionalDisconnect = false;
  await connectAndListenToArduino(handler);
}

export async function forgetArduinoPort() {
  try {
    intentionalDisconnect = true;
    setConnectionState('reconnecting', 'Clearing saved port...', Serial.getPortLabel());

    await Serial.forgetSavedPorts();

    activeReadLoop = null;

    setConnectionState('disconnected', 'Saved port cleared', 'No port selected');
    updateStatus(
      'Saved Arduino port cleared. Click Connect Arduino and select the Arduino again.',
      'success',
    );
  } catch (error) {
    console.error('Could not clear saved serial port:', error);

    setConnectionState('error', 'Could not clear saved port', Serial.getPortLabel());
    updateStatus('Could not clear saved port. Disconnect Arduino, then try again.', 'error');
  }
}
