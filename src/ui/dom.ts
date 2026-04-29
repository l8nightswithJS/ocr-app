// src/ui/dom.ts
// Small DOM helpers used by UI modules.
// Keep these helpers simple and dependency-free so they are safe to use across the app.

export function getEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function requireEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = getEl<T>(id);

  if (!el) {
    throw new Error(`Required DOM element #${id} was not found.`);
  }

  return el;
}

export function ensureDiv(id: string, options?: { hidden?: boolean; parent?: HTMLElement }) {
  let el = getEl<HTMLDivElement>(id);

  if (!el) {
    el = document.createElement('div');
    el.id = id;

    if (options?.hidden) {
      el.style.display = 'none';
    }

    const parent = options?.parent ?? document.body;
    parent.appendChild(el);
  }

  return el;
}

export function queryAll<T extends Element = Element>(
  selector: string,
  root: ParentNode = document,
) {
  return Array.from(root.querySelectorAll<T>(selector));
}
