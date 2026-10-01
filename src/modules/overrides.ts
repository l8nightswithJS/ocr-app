// src/modules/overrides.ts
// Operator override UI: modal + reason capture.

type OverrideResult = { value: string; reason: string };

type OverridePromptOptions = {
  title?: string;
  helperText?: string;
  saveLabel?: string;
  placement?: 'center' | 'right';
};

const REASONS = [
  'Bad handwriting',
  'Glare',
  'Partial occlusion',
  'Angle/rotation',
  'Smudge/damage',
  'Other',
];

let modalEl: HTMLDivElement | null = null;

function ensureModal() {
  if (modalEl) return modalEl;

  modalEl = document.createElement('div');
  modalEl.className = 'fixed inset-0 z-[1000] hidden';
  modalEl.innerHTML = `
    <div class="absolute inset-0 bg-black/40"></div>

    <div id="ov-position-wrap" class="absolute inset-0 flex items-center justify-center p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-4 border border-gray-200">
        <h3 id="ov-title" class="text-lg font-semibold mb-2">Override value</h3>

        <p id="ov-helper" class="hidden text-sm text-gray-600 mb-3"></p>

        <label class="block text-sm mb-1 font-medium text-gray-700">New value</label>
        <input id="ov-value" class="w-full border rounded-md px-3 py-2 mb-3" />

        <label class="block text-sm mb-1 font-medium text-gray-700">Reason</label>
        <select id="ov-reason" class="w-full border rounded-md px-3 py-2 mb-4">
          ${REASONS.map((r) => `<option>${r}</option>`).join('')}
        </select>

        <div class="flex justify-end gap-2">
          <button id="ov-cancel" class="px-3 py-2 rounded-md border hover:bg-gray-50">Cancel</button>
          <button id="ov-save" class="px-3 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Save</button>
        </div>
      </div>
    </div>
  `.trim();

  document.body.appendChild(modalEl);
  return modalEl;
}

function applyPlacement(placement: OverridePromptOptions['placement']) {
  const wrap = modalEl!.querySelector('#ov-position-wrap') as HTMLDivElement | null;
  if (!wrap) return;

  wrap.className = 'absolute inset-0 flex p-4';

  if (placement === 'right') {
    wrap.classList.add('items-center', 'justify-end', 'pr-[7vw]');
  } else {
    wrap.classList.add('items-center', 'justify-center');
  }
}

export function promptOverride(
  fieldLabel: 'TOP',
  currentValue: string | null,
  options: OverridePromptOptions = {},
): Promise<OverrideResult | null> {
  ensureModal();

  const titleEl = modalEl!.querySelector('#ov-title') as HTMLHeadingElement;
  const helperEl = modalEl!.querySelector('#ov-helper') as HTMLParagraphElement;
  const input = modalEl!.querySelector('#ov-value') as HTMLInputElement;
  const reasonSel = modalEl!.querySelector('#ov-reason') as HTMLSelectElement;
  const btnCancel = modalEl!.querySelector('#ov-cancel') as HTMLButtonElement;
  const btnSave = modalEl!.querySelector('#ov-save') as HTMLButtonElement;

  titleEl.textContent = options.title ?? 'Override value';

  if (options.helperText) {
    helperEl.textContent = options.helperText;
    helperEl.classList.remove('hidden');
  } else {
    helperEl.textContent = '';
    helperEl.classList.add('hidden');
  }

  btnSave.textContent = options.saveLabel ?? 'Save';
  applyPlacement(options.placement ?? 'center');

  modalEl!.classList.remove('hidden');

  input.value = currentValue ?? '';
  input.placeholder = `${fieldLabel} number`;
  reasonSel.selectedIndex = 0;
  input.focus();
  input.select();

  return new Promise((resolve) => {
    const cleanup = () => {
      modalEl!.classList.add('hidden');
      btnCancel.onclick = null;
      btnSave.onclick = null;
      input.onkeydown = null;
      reasonSel.onkeydown = null;
      modalEl!.onkeydown = null;
      applyPlacement('center');
    };

    const cancel = () => {
      cleanup();
      resolve(null);
    };

    const save = () => {
      const value = input.value.trim();
      const reason = reasonSel.value;
      cleanup();

      if (!value) {
        resolve(null);
        return;
      }

      resolve({ value, reason });
    };

    btnCancel.onclick = cancel;
    btnSave.onclick = save;

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };

    reasonSel.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };

    modalEl!.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
  });
}
