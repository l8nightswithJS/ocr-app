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

function publishConnectionState(next: ArduinoConnectionState) {
  connectionState = next;
  for (const listener of listeners) listener(connectionState);
}

function setConnectionState(
  status: ArduinoConnectionStatus,
  message?: string,
  portLabel = Serial.getPortLabel(),
) {
  publishConnectionState({ status, message, portLabel });
}

export function onArduinoConnectionChange(listener: StateListener) {
  listeners.add(listener);
  listener(connectionState);
  return () => listeners.delete(listener);
}

export function getArduinoConnectionState() {
  return connectionState;
}

function serialAvailable() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function isUserCancelError(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('No port selected') || msg.includes('The user cancelled');
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

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // Expected if the port was unplugged or the stream is already closed.
      }

      try {
        this.reader.releaseLock();
      } catch {
        // Ignore release errors during recovery.
      }

      this.reader = null;
    }

    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        // Expected if the serial device was removed.
      }

      try {
        this.writer.releaseLock();
      } catch {
        // Ignore release errors during recovery.
      }

      this.writer = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // Port may already be closed or unavailable after a USB disconnect.
      }
    }

    if (this.encoderPipe) {
      await withTimeout(this.encoderPipe, 500).catch(() => undefined);
      this.encoderPipe = null;
    }

    if (this.decoderPipe) {
      await withTimeout(this.decoderPipe, 500).catch(() => undefined);
      this.decoderPipe = null;
    }

    this.encoder = null;
    this.decoder = null;
    this.port = null;
    this._open = false;
  }

  async connect(options: SerialOptions = { baudRate: 115200 }) {
    if (this._open || this._connecting) return this.reader;

    this._connecting = true;

    try {
      await this.disconnect();

      if (!serialAvailable()) {
        throw new Error('WEB_SERIAL_UNAVAILABLE');
      }

      let port: SerialPort | null = null;
      const existingPorts = await navigator.serial.getPorts();

      if (existingPorts.length > 0) {
        port = existingPorts[0];
      } else {
        port = await navigator.serial.requestPort();
      }

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
      return;
    }

    await this.writer.write(String(token));
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

let disconnectListenerAttached = false;
let activePresenceHandler: PresenceHandler | null = null;
let activeReadLoop: Promise<void> | null = null;
let intentionalDisconnect = false;

function attachDisconnectListenerOnce() {
  if (disconnectListenerAttached || !serialAvailable()) return;

  const serialWithEvents = navigator.serial as unknown as EventTarget;

  serialWithEvents.addEventListener('disconnect', () => {
    void (async () => {
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

  if (msg === 'SERIAL_STREAMS_UNAVAILABLE') {
    return 'Serial port opened, but readable/writable streams were unavailable.';
  }

  if (msg.includes('already open')) {
    return 'Serial port already open in another app or tab. Close it and try again.';
  }

  if (msg.includes('Failed to open serial port')) {
    return 'Could not open serial port. Use Reconnect or Clear Saved Port, then select the Arduino again.';
  }

  return 'Could not open serial port. Ensure no other app is using it.';
}

async function readPresenceLoop(
  reader: ReadableStreamDefaultReader<string>,
  onPresence: PresenceHandler,
) {
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += value ?? '';

    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (line.startsWith('{"evt":"presence"')) {
        try {
          const event = JSON.parse(line) as { evt?: string; value?: unknown };
          if (event.evt === 'presence') {
            await onPresence(Boolean(event.value));
          }
        } catch {
          // Ignore malformed serial lines.
        }
      }

      nl = buffer.indexOf('\n');
    }
  }
}

export function sendToArduino(token: string) {
  return Serial.send(token);
}

export async function connectAndListenToArduino(onPresence: PresenceHandler) {
  if (Serial.isOpen || Serial.isConnecting) return;

  activePresenceHandler = onPresence;
  intentionalDisconnect = false;

  try {
    attachDisconnectListenerOnce();
    setConnectionState('connecting', 'Connecting...', Serial.getPortLabel());

    const reader = await Serial.connect({ baudRate: 115200 });

    if (!reader) {
      throw new Error('SERIAL_READER_UNAVAILABLE');
    }

    setConnectionState('connected', 'Connected', Serial.getPortLabel());
    updateStatus('Arduino connected. Scan LRM #.', 'success');

    await sendToArduino(TOKEN.NO_PART);

    activeReadLoop = readPresenceLoop(reader, onPresence);
    await activeReadLoop;

    if (!intentionalDisconnect) {
      await Serial.disconnect();
      setConnectionState('disconnected', 'Arduino disconnected', 'No port selected');
      updateStatus('Arduino disconnected. Open Arduino Connection to reconnect.', 'error');
    }
  } catch (error: unknown) {
    console.error('Serial connection error:', error);

    const message = statusForConnectError(error);
    await Serial.disconnect();

    if (isUserCancelError(error)) {
      setConnectionState('disconnected', 'Disconnected', 'No port selected');
    } else {
      setConnectionState('error', message, 'No port selected');
    }

    updateStatus(message, isUserCancelError(error) ? 'warn' : 'error');
  } finally {
    activeReadLoop = null;
  }
}

export async function disconnectArduino() {
  intentionalDisconnect = true;
  await Serial.disconnect();
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
  await delay(400);
  intentionalDisconnect = false;
  await connectAndListenToArduino(handler);
}

export async function forgetArduinoPort() {
  try {
    intentionalDisconnect = true;
    setConnectionState('reconnecting', 'Clearing saved port...', Serial.getPortLabel());
    await Serial.forgetSavedPorts();
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
