// src/modules/db.ts
// IndexedDB wrapper for OCR scan records.

export type ScanRecord = {
  id?: number;
  ts: number;

  // Run/condition info
  runId?: string;
  condition?: string;
  lyoCondition?: string;
  lrm?: string;

  // Beta traceability fields
  mode?: 'standard' | 'traceability_beta';
  workflowPhase?: 'lrm_pairing' | 'cartridge_ocr';
  workflowStatus?:
    | 'lrm_paired_pending_leak'
    | 'loaded_for_cartridge_ocr'
    | 'ocr_in_progress'
    | 'needs_pcb_confirmation'
    | 'needs_top_correction'
    | 'needs_rescan'
    | 'complete'
    | 'failed_pulled'
    | 'missing'
    | 'recovered_waiting_lrm'
    | 'post_ocr_reject';
  lockedByStation?: string;
  lockedAt?: number;
  buildNumber?: string;
  sequenceNumber?: string;
  shroudQr?: string;
  leakTestStatus?: 'pending' | 'pass' | 'fail';
  customerQrCode?: string;
  customerQrSequence?: string;
  mixwheelLot?: string;
  sampleCapLot?: string;
  failureTs?: number;
  failureReason?: string;
  postOcrRejectTs?: number;
  postOcrRejectReason?: string;
  lrmPairTs?: number;
  cartridgeScanTs?: number;

  // voted raw
  pcb: string | null;
  top: string | null;
  pcbConf: number;
  topConf: number;
  pcbHist: Record<string, number>;
  topHist: Record<string, number>;

  // final (after override)
  pcbFinal: string | null;
  topFinal: string | null;
  pcbOverrideReason?: string | null;
  topOverrideReason?: string | null;

  // optional
  pcbEvidence?: string[];
  topEvidence?: string[];
};

const STORE = 'scans';

export class DB {
  private db: IDBDatabase | null = null;

  constructor(
    private name: string = 'ocr_scans',
    private version: number = 1,
  ) {}

  async init() {
    if (this.db) return;

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.name, this.version);

      req.onupgradeneeded = () => {
        const db = req.result;

        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts', { unique: false });

          // IndexedDB stores whole objects and does not require schema changes
          // for additional optional properties on future records.
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async add(rec: ScanRecord): Promise<number> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.add(rec);

      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error);
    });
  }

  async update(id: number, patch: Partial<ScanRecord>): Promise<void> {
    await this.init();

    const existing = await this.get(id);
    if (!existing) return;

    const merged: ScanRecord = { ...existing, ...patch, id };

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.put(merged);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async get(id: number): Promise<ScanRecord | undefined> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(id);

      req.onsuccess = () => resolve(req.result as ScanRecord | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(): Promise<ScanRecord[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();

      req.onsuccess = () => resolve((req.result as ScanRecord[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }


  async delete(id: number): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.delete(id);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async clearAll(): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
