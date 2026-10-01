// src/modules/exporter.ts
// CSV export for production runs:
// - Exports ONLY today's scans (local time)
// - Supports BOTH standard mode and traceability beta mode
// - Standard mode exports:
//   condition, lyoCondition, ts, lrm, top
// - Traceability beta mode exports:
//   buildNumber, lyoCondition, sequenceNumber, shroudQr, pairTs, cartridgeTs, lrm, leakTestStatus, workflowStatus, top
// - Injects reserved "missing cartridge" rows for both standard mode and traceability beta mode
// - Sorts output appropriately for each mode
// - Deduplicates beta export rows by sequence number, keeping the latest scan for each sequence

import type { DB, ScanRecord } from './db';

const RUN_BASE_KEY = 'ocr-run-base';
const RUN_PAD_KEY = 'ocr-run-pad';
const RUN_LYO_KEY = 'ocr-run-lyo-condition';
const RUN_MISSING_KEY = 'ocr-run-missing-numbers';
const BETA_RUN_ID_KEY = 'ocr-beta-run-id';
const BETA_BUILD_KEY = 'ocr-beta-build';
const BETA_LYO_KEY = 'ocr-beta-lyo';
const BETA_NEXT_SEQUENCE_KEY = 'ocr-beta-next-sequence';
const BETA_MISSING_KEY = 'ocr-beta-missing-numbers';
const BETA_QR_INFO_MAP_KEY = 'ocr-beta-qr-info-map';
const BETA_MIXWHEEL_LOT_KEY = 'ocr-beta-mixwheel-lot';
const BETA_SAMPLE_CAP_LOT_KEY = 'ocr-beta-sample-cap-lot';

type StandardExportRow = {
  mode: 'standard';
  condition: string;
  lyoCondition: string;
  ts: string;
  lrm: string;
  top: string;
  sortBase: string;
  sortNum: number;
};

type BetaExportRow = {
  mode: 'traceability_beta';
  buildNumber: string;
  lyoCondition: string;
  sequenceNumber: string;
  shroudQr: string;
  customerQrCode: string;
  customerQrSequence: string;
  pairTs: string;
  cartridgeTs: string;
  failureTs: string;
  lrm: string;
  mixwheelLot: string;
  sampleCapLot: string;
  leakTestStatus: string;
  workflowStatus: string;
  failureReason: string;
  postOcrRejectTs: string;
  postOcrRejectReason: string;
  top: string;
};

function dayBoundsLocal(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function esc(s: unknown) {
  if (s === null || s === undefined) return '""';
  const str = typeof s === 'string' ? s : String(s);
  return `"${str.replace(/"/g, '""')}"`;
}

function padNum(n: number, width: number) {
  return String(n).padStart(width, '0');
}

function parseCondition(condition: string) {
  const trimmed = (condition ?? '').trim();
  const m = trimmed.match(/^(.*?)(\d+)$/);
  if (!m) return null;

  return {
    base: m[1],
    num: Number(m[2]),
    pad: m[2].length,
  };
}

function parseSequenceNumber(sequenceNumber: string) {
  const trimmed = (sequenceNumber ?? '').trim();
  const match = trimmed.match(/(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]);
}

function formatSequenceFromTemplate(template: string, n: number) {
  const trimmed = (template ?? '').trim();
  const match = trimmed.match(/^(.*?)(\d+)$/);

  if (!match) return String(n);

  const [, prefix, digits] = match;
  return `${prefix}${String(n).padStart(digits.length, '0')}`;
}

function getRunBase() {
  return localStorage.getItem(RUN_BASE_KEY) ?? '';
}

function getRunPad() {
  return Number(localStorage.getItem(RUN_PAD_KEY) ?? '3');
}

function getRunLyo() {
  return localStorage.getItem(RUN_LYO_KEY) ?? '';
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

function getBetaRunId() {
  return localStorage.getItem(BETA_RUN_ID_KEY) ?? '';
}

function getBetaBuild() {
  return localStorage.getItem(BETA_BUILD_KEY) ?? '';
}

function getBetaLyo() {
  return localStorage.getItem(BETA_LYO_KEY) ?? '';
}

function getBetaNextSequence() {
  return localStorage.getItem(BETA_NEXT_SEQUENCE_KEY) ?? '';
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

function normalizeLookupKey(value: string | null | undefined) {
  return (value ?? '').trim().toUpperCase();
}

function getBetaQrInfoMap(): Record<string, string> {
  try {
    const runId = getBetaRunId();
    const scopedKey = runId ? `${BETA_QR_INFO_MAP_KEY}:${runId}` : BETA_QR_INFO_MAP_KEY;
    const parsed = JSON.parse(localStorage.getItem(scopedKey) ?? localStorage.getItem(BETA_QR_INFO_MAP_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function lookupCustomerQrCode(label: string) {
  const map = getBetaQrInfoMap();
  const direct = map[normalizeLookupKey(label)];
  if (direct) return direct;

  const labelNum = parseSequenceNumber(label);
  if (!Number.isFinite(labelNum)) return '';

  for (const [key, value] of Object.entries(map)) {
    if (parseSequenceNumber(key) === labelNum) return value;
  }

  return '';
}

function extractCustomerQrSequence(qrCode: string) {
  const parts = qrCode
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const zValue = [...parts].reverse().find((part) => /^Z\d+$/i.test(part));
  return zValue ?? '';
}

function getBetaMixwheelLot() {
  return localStorage.getItem(BETA_MIXWHEEL_LOT_KEY) ?? '';
}

function getBetaSampleCapLot() {
  return localStorage.getItem(BETA_SAMPLE_CAP_LOT_KEY) ?? '';
}

function isBetaRecord(r: ScanRecord) {
  return r.mode === 'traceability_beta' || !!r.sequenceNumber || !!r.buildNumber || !!r.shroudQr;
}

function toStandardExportRow(r: ScanRecord): StandardExportRow {
  const condition = (r.condition ?? '').trim();
  const parsed = parseCondition(condition);

  return {
    mode: 'standard',
    condition,
    lyoCondition: (r.lyoCondition ?? '').trim(),
    ts: new Date(r.ts).toISOString(),
    lrm: (r.lrm ?? '').trim(),
    top: (r.topFinal ?? r.top ?? '').trim(),
    sortBase: parsed?.base ?? '',
    sortNum: parsed?.num ?? Number.MAX_SAFE_INTEGER,
  };
}

function toBetaExportRow(r: ScanRecord): BetaExportRow {
  const top = (r.topFinal ?? r.top ?? '').trim();
  const label = (r.sequenceNumber ?? r.condition ?? '').trim();
  const complete = r.workflowStatus === 'complete' || r.workflowStatus === 'post_ocr_reject';
  const hasLegacyComplete = !r.workflowStatus && isNonEmpty(top) && top !== 'NO_CODE_FOUND';
  const customerQrCode = (r.customerQrCode ?? lookupCustomerQrCode(label)).trim();
  const failureTs = r.failureTs ? new Date(r.failureTs).toISOString() : '';
  const postOcrRejectTs = r.postOcrRejectTs ? new Date(r.postOcrRejectTs).toISOString() : '';
  const leakTestStatus = (r.leakTestStatus ?? (complete || hasLegacyComplete ? 'pass' : 'pending')).trim();

  let leakDisplay = 'Pending / Not Scanned';
  let workflowStatus = 'LRM Paired / Pending Cartridge';

  if (leakTestStatus === 'pass' || complete || hasLegacyComplete) {
    leakDisplay = 'PASS';
    workflowStatus = complete || hasLegacyComplete ? 'Complete' : 'PASS / Pending Cartridge OCR';
  }

  if (r.workflowStatus === 'post_ocr_reject') {
    leakDisplay = 'PASS';
    workflowStatus = 'Post-OCR Reject';
  }

  if (r.workflowStatus === 'needs_top_correction') workflowStatus = 'Needs Top Correction';
  if (r.workflowStatus === 'needs_rescan') workflowStatus = 'Needs Rescan';
  if (r.workflowStatus === 'loaded_for_cartridge_ocr') workflowStatus = 'Loaded / Pending OCR';
  if (r.workflowStatus === 'ocr_in_progress') workflowStatus = 'OCR In Progress';

  if (leakTestStatus === 'fail' || r.workflowStatus === 'failed_pulled') {
    leakDisplay = 'FAIL';
    workflowStatus = 'Failed / Pulled';
  }

  return {
    mode: 'traceability_beta',
    buildNumber: (r.buildNumber ?? '').trim(),
    lyoCondition: (r.lyoCondition ?? '').trim(),
    sequenceNumber: label,
    shroudQr: (r.shroudQr ?? '').trim(),
    customerQrCode,
    customerQrSequence: (r.customerQrSequence ?? extractCustomerQrSequence(customerQrCode)).trim(),
    pairTs: r.lrmPairTs ? new Date(r.lrmPairTs).toISOString() : new Date(r.ts).toISOString(),
    cartridgeTs: r.cartridgeScanTs ? new Date(r.cartridgeScanTs).toISOString() : '',
    failureTs,
    lrm: (r.lrm ?? '').trim(),
    mixwheelLot: (r.mixwheelLot ?? getBetaMixwheelLot()).trim(),
    sampleCapLot: (r.sampleCapLot ?? (complete || hasLegacyComplete ? getBetaSampleCapLot() : '')).trim(),
    leakTestStatus: leakDisplay,
    workflowStatus,
    failureReason: (r.failureReason ?? '').trim(),
    postOcrRejectTs,
    postOcrRejectReason: (r.postOcrRejectReason ?? '').trim(),
    top,
  };
}

function isNonEmpty(value: string | null | undefined) {
  return typeof value === 'string' && value.trim().length > 0;
}

function dedupeBetaRows(rows: BetaExportRow[]): BetaExportRow[] {
  const latestBySequence = new Map<string, BetaExportRow>();

  for (const row of rows) {
    const key = row.sequenceNumber.trim();
    if (!key) continue;

    const existing = latestBySequence.get(key);
    if (!existing) {
      latestBySequence.set(key, row);
      continue;
    }

    const existingTs = existing.cartridgeTs
      ? new Date(existing.cartridgeTs).getTime()
      : existing.pairTs
        ? new Date(existing.pairTs).getTime()
        : 0;
    const currentTs = row.cartridgeTs
      ? new Date(row.cartridgeTs).getTime()
      : row.pairTs
        ? new Date(row.pairTs).getTime()
        : 0;

    if (currentTs >= existingTs) {
      latestBySequence.set(key, row);
    }
  }

  return Array.from(latestBySequence.values());
}

function buildMissingRowsFromRunState(existingConditions: Set<string>): StandardExportRow[] {
  const base = getRunBase().trim();
  const pad = getRunPad();
  const lyoCondition = getRunLyo().trim();
  const missingNumbers = getRunMissingNumbers();

  if (!base || !missingNumbers.length) return [];

  const rows: StandardExportRow[] = [];

  for (const num of missingNumbers) {
    const condition = `${base}${padNum(num, pad)}`;
    if (existingConditions.has(condition)) continue;

    rows.push({
      mode: 'standard',
      condition,
      lyoCondition,
      ts: '',
      lrm: 'Missing Cartridge',
      top: '',
      sortBase: base,
      sortNum: num,
    });
  }

  return rows;
}

function buildMissingRowsFromBetaState(
  existingSequences: Set<string>,
  sequenceTemplate?: string,
): BetaExportRow[] {
  const buildNumber = getBetaBuild().trim();
  const lyoCondition = getBetaLyo().trim();
  const missingNumbers = getBetaMissingNumbers();
  const template = (sequenceTemplate ?? getBetaNextSequence()).trim();

  if (!buildNumber || !lyoCondition || !missingNumbers.length) return [];

  const rows: BetaExportRow[] = [];

  for (const num of missingNumbers) {
    const sequenceNumber = template ? formatSequenceFromTemplate(template, num) : String(num);
    if (existingSequences.has(sequenceNumber)) continue;

    rows.push({
      mode: 'traceability_beta',
      buildNumber,
      lyoCondition,
      sequenceNumber,
      shroudQr: 'Missing Cartridge',
      customerQrCode: lookupCustomerQrCode(sequenceNumber),
      customerQrSequence: extractCustomerQrSequence(lookupCustomerQrCode(sequenceNumber)),
      pairTs: '',
      cartridgeTs: '',
      failureTs: '',
      lrm: 'Missing Cartridge',
      mixwheelLot: getBetaMixwheelLot(),
      sampleCapLot: getBetaSampleCapLot(),
      leakTestStatus: '',
      workflowStatus: 'Missing Cartridge',
      failureReason: '',
      postOcrRejectTs: '',
      postOcrRejectReason: '',
      top: '',
    });
  }

  return rows;
}

function getBetaHeaders() {
  return [
    'Build #',
    'Lyo Condition',
    'Label',
    'QR Sequence',
    'Customer QR Code',
    'Sequence QR Scan',
    'LRM Pair TS',
    'Cartridge OCR TS',
    'Failure TS',
    'LRM',
    'Top Plate',
    'Mixwheel Lot#',
    'Sample Cap Lot#',
    'Leak Test',
    'Workflow Status',
    'Failure Reason',
    'Post-OCR Reject TS',
    'Post-OCR Reject Reason',
  ];
}

function betaRowToCsvLine(r: BetaExportRow) {
  return [
    esc(r.buildNumber),
    esc(r.lyoCondition),
    esc(r.sequenceNumber),
    esc(r.customerQrSequence),
    esc(r.customerQrCode),
    esc(r.shroudQr),
    esc(r.pairTs),
    esc(r.cartridgeTs),
    esc(r.failureTs),
    esc(r.lrm),
    esc(r.top),
    esc(r.mixwheelLot),
    esc(r.sampleCapLot),
    esc(r.leakTestStatus),
    esc(r.workflowStatus),
    esc(r.failureReason),
    esc(r.postOcrRejectTs),
    esc(r.postOcrRejectReason),
  ].join(',');
}

function downloadCsv(filename: string, lines: string[]) {
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function exportCsv(db: DB): Promise<string> {
  const rows = await db.getAll();

  const { startMs, endMs } = dayBoundsLocal();
  const currentRunId = getBetaRunId().trim();
  const currentBuild = getBetaBuild().trim();
  const currentLyo = getBetaLyo().trim();

  const betaRowsRaw = rows
    .filter(isBetaRecord)
    .filter((r) => !currentRunId || !r.runId || r.runId === currentRunId)
    .filter((r) => !currentBuild || (r.buildNumber ?? '').trim() === currentBuild)
    .filter((r) => !currentLyo || (r.lyoCondition ?? '').trim() === currentLyo);

  const standardRowsRaw = rows.filter(
    (r: ScanRecord) => !isBetaRecord(r) && r.ts >= startMs && r.ts < endMs,
  );

  const ymd = new Date().toISOString().slice(0, 10);

  if (betaRowsRaw.length > 0 && standardRowsRaw.length === 0) {
    const scannedBetaRows = dedupeBetaRows(betaRowsRaw.map(toBetaExportRow));
    const existingSequences = new Set(scannedBetaRows.map((r) => r.sequenceNumber).filter(Boolean));
    const betaSequenceTemplate =
      scannedBetaRows.find((r) => r.sequenceNumber)?.sequenceNumber ?? getBetaNextSequence();
    const missingBetaRows = buildMissingRowsFromBetaState(existingSequences, betaSequenceTemplate);

    const betaRows = [...scannedBetaRows, ...missingBetaRows].sort(
      (a, b) => parseSequenceNumber(a.sequenceNumber) - parseSequenceNumber(b.sequenceNumber),
    );

    const headers = getBetaHeaders();
    const lines = [headers.join(','), ...betaRows.map(betaRowToCsvLine)];

    const filename = `ocr_traceability_beta_${ymd}.csv`;
    downloadCsv(filename, lines);
    return filename;
  }

  if (standardRowsRaw.length > 0 && betaRowsRaw.length === 0) {
    const scannedRows = standardRowsRaw.map(toStandardExportRow);
    const existingConditions = new Set(scannedRows.map((r) => r.condition).filter(Boolean));
    const missingRows = buildMissingRowsFromRunState(existingConditions);

    const combined = [...scannedRows, ...missingRows].sort((a, b) => {
      const sameBase = a.sortBase === b.sortBase;
      if (sameBase) return a.sortNum - b.sortNum;
      return a.condition.localeCompare(b.condition);
    });

    const headers = ['Condition', 'Lyo Condition', 'TS', 'LRM', 'Top'];
    const lines = [
      headers.join(','),
      ...combined.map((r) =>
        [esc(r.condition), esc(r.lyoCondition), esc(r.ts), esc(r.lrm), esc(r.top)].join(
          ',',
        ),
      ),
    ];

    const filename = `ocr_${ymd}.csv`;
    downloadCsv(filename, lines);
    return filename;
  }

  const standardRows = standardRowsRaw.map(toStandardExportRow);
  const scannedBetaRows = dedupeBetaRows(betaRowsRaw.map(toBetaExportRow));
  const existingBetaSequences = new Set(
    scannedBetaRows.map((r) => r.sequenceNumber).filter(Boolean),
  );
  const betaSequenceTemplate =
    scannedBetaRows.find((r) => r.sequenceNumber)?.sequenceNumber ?? getBetaNextSequence();
  const missingBetaRows = buildMissingRowsFromBetaState(
    existingBetaSequences,
    betaSequenceTemplate,
  );

  const betaRows = [...scannedBetaRows, ...missingBetaRows].sort(
    (a, b) => parseSequenceNumber(a.sequenceNumber) - parseSequenceNumber(b.sequenceNumber),
  );

  const standardExistingConditions = new Set(standardRows.map((r) => r.condition).filter(Boolean));
  const missingRows = buildMissingRowsFromRunState(standardExistingConditions);

  const standardCombined = [...standardRows, ...missingRows].sort((a, b) => {
    const sameBase = a.sortBase === b.sortBase;
    if (sameBase) return a.sortNum - b.sortNum;
    return a.condition.localeCompare(b.condition);
  });

  const lines: string[] = [];

  lines.push('STANDARD MODE EXPORT');
  lines.push(['Condition', 'Lyo Condition', 'TS', 'LRM', 'Top'].join(','));
  lines.push(
    ...standardCombined.map((r) =>
      [esc(r.condition), esc(r.lyoCondition), esc(r.ts), esc(r.lrm), esc(r.top)].join(
        ',',
      ),
    ),
  );

  lines.push('');
  lines.push('TRACEABILITY BETA EXPORT');
  lines.push(getBetaHeaders().join(','));
  lines.push(...betaRows.map(betaRowToCsvLine));

  const filename = `ocr_mixed_${ymd}.csv`;
  downloadCsv(filename, lines);
  return filename;
}
