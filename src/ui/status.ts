// src/ui/status.ts

import { ensureDiv, getEl, queryAll } from './dom';

type StatusTone = 'idle' | 'warn' | 'busy' | 'ok' | 'error';

// Prefer your existing nodes; create safe fallbacks if missing.
function ensureHost(): HTMLElement {
  const host = getEl<HTMLElement>('status-container');
  if (host) return host;

  const div = document.createElement('div');
  div.id = 'status-container';
  document.body.prepend(div);
  return div;
}

function ensureStatusDiv(id: string, hidden = false): HTMLDivElement {
  return ensureDiv(id, {
    hidden,
    parent: ensureHost(),
  });
}

// Use your panel’s message div if it exists, else make one.
const statusEl = () => getEl<HTMLDivElement>('status-message') || ensureStatusDiv('status-message');

const startupWarnEl = () =>
  getEl<HTMLDivElement>('startup-warning') || ensureStatusDiv('startup-warning', true);

function setTone(node: HTMLElement, tone: StatusTone) {
  node.className =
    'font-medium min-h-[44px] flex items-center justify-start rounded-md px-3 py-2 border ' +
    (tone === 'ok'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : tone === 'warn'
        ? 'bg-amber-50 text-amber-800 border-amber-200'
        : tone === 'busy'
          ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
          : tone === 'error'
            ? 'bg-rose-50 text-rose-700 border-rose-200'
            : 'bg-gray-50 text-gray-700 border-gray-200');
}

export const UI = {
  showStatus(text: string, tone: StatusTone = 'idle') {
    const n = statusEl();
    n.textContent = text;
    setTone(n, tone);
  },

  showStartupWarning(show: boolean, msg?: string) {
    const n = startupWarnEl();

    if (show) {
      n.style.display = '';
      n.textContent = msg || '⚠️ Chip detected — remove before scanning LRM.';
      setTone(n, 'warn');
    } else {
      n.style.display = 'none';
      n.textContent = '';
    }
  },

  enableScanInput(enable: boolean) {
    const inputs = queryAll<HTMLInputElement>('.lrm-input');

    for (const i of inputs) {
      i.disabled = !enable;
      i.classList.toggle('opacity-60', !enable);
    }
  },

  // table helpers
  ensureActiveRow(lrm: string): HTMLElement {
    let row = document.querySelector<HTMLElement>('tr[data-active="true"]');

    if (!row) {
      const tbody = document.querySelector('tbody#data-table-body');

      if (!tbody) {
        throw new Error('Table body #data-table-body was not found.');
      }

      row = document.createElement('tr');
      row.setAttribute('data-active', 'true');
      row.innerHTML = `
        <td class="px-6 py-3">
          <input type="text" class="table-cell-input lrm-input" value="${lrm}" />
        </td>
        <td class="px-6 py-3 font-mono top-plate-cell"></td>
        <td class="px-6 py-3">
          <button class="rescan-btn bg-gray-100 hover:bg-gray-200 px-3 py-1 rounded border">
            Rescan
          </button>
        </td>
      `;
      tbody.appendChild(row);
    }

    return row;
  },

  setRowOCR(row: HTMLElement, value: string) {
    const cell = row.querySelector<HTMLElement>('.top-plate-cell');
    if (cell) cell.textContent = value;
  },

  setRowBusy(row: HTMLElement, busy: boolean, note?: string) {
    row.classList.toggle('opacity-70', busy);
    if (note) this.showStatus(note, 'busy');
  },

  lockRow(row: HTMLElement) {
    row.removeAttribute('data-active');

    const input = row.querySelector<HTMLInputElement>('.lrm-input');
    if (input) input.disabled = true;
  },
};

// ---- Compatibility shim used by your code
export type Tone = 'idle' | 'warn' | 'busy' | 'ok' | 'error' | 'success' | 'info' | 'loading';

export function updateStatus(text: string, tone: Tone = 'idle') {
  const map: Record<Tone, StatusTone> = {
    idle: 'idle',
    warn: 'warn',
    busy: 'busy',
    ok: 'ok',
    error: 'error',
    success: 'ok',
    info: 'idle',
    loading: 'busy',
  };

  UI.showStatus(text, map[tone]);
}
