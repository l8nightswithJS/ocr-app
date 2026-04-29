// Minimal Web Serial typings used by this app.
interface SerialPort {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  forget?: () => Promise<void>;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
}

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface Navigator {
  serial: {
    requestPort(options?: { filters?: Array<Record<string, unknown>> }): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
    addEventListener?: EventTarget['addEventListener'];
    removeEventListener?: EventTarget['removeEventListener'];
  };
}
