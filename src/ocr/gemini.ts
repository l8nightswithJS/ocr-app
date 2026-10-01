// src/ocr/gemini.ts

const apiKey = ((import.meta as any).env?.VITE_GEMINI_KEY ?? '') as string;
const SIM_MODE = import.meta.env.VITE_SIM_MODE === 'true';
const SIM_OCR_MODE = ((import.meta as any).env?.VITE_SIM_OCR_MODE ?? 'gemini') as
  | 'gemini'
  | 'fixed';

// Pin the stable model by default so the request schema does not change
// unexpectedly when Google's "latest" alias moves to another model.
const configuredModel = (
  (import.meta as any).env?.VITE_GEMINI_MODEL as string | undefined
)?.trim();
const GEMINI_MODEL = configuredModel || 'gemini-3.5-flash';

const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export type Crop = { x: number; y: number; width: number; height: number };
export type Filter = { brightness: number; contrast: number };

// ---- Orientation knobs ----
const PCB_ROTATION: 0 | 90 | 180 | 270 = 270;
const PCB_FLIP_H = false;
const TOP_ROTATION: 0 | 90 | 180 | 270 = 0;
const TOP_FLIP_H = false;
// ---------------------------

const MAX_DIGITS = 5;
const GEMINI_TIMEOUT_MS = 8000;

// Safe speed tuning only
const OCR_TARGET_HEIGHT = 220;
const OCR_JPEG_FAST = 0.72;
const OCR_JPEG_RETRY = 0.9;

export async function readNumberFromCamera(
  videoEl: HTMLVideoElement,
  crop: Crop,
  filter: Filter,
  label: 'Top Plate' | 'PCB',
): Promise<string> {
  if (SIM_MODE && SIM_OCR_MODE === 'fixed') {
    return getFixedSimValue(videoEl, label) ?? 'NONE';
  }

  const { source, w: vw, h: vh } = captureFrameSource(videoEl);
  if (!source || !vw || !vh) return 'NONE';

  const cssFilter = `brightness(${filter.brightness}%) contrast(${filter.contrast}%)`;
  const isPcb = label === 'PCB';

  const finalCanvas = drawCropToOffscreen(
    source,
    vw,
    vh,
    crop,
    cssFilter,
    isPcb ? PCB_ROTATION : TOP_ROTATION,
    isPcb ? PCB_FLIP_H : TOP_FLIP_H,
  );

  const prompt = buildPrompt(label, MAX_DIGITS);

  try {
    const fastCanvas = resizeCanvasToHeight(finalCanvas, OCR_TARGET_HEIGHT);
    const fastImage = canvasToBase64JPEG(fastCanvas, OCR_JPEG_FAST);

    if (fastImage) {
      const fastResult = await callGeminiDigits([fastImage], prompt, label, MAX_DIGITS);
      if (fastResult && isValidOcrResult(fastResult, MAX_DIGITS)) {
        return fastResult;
      }
    }

    const retryImage = canvasToBase64JPEG(finalCanvas, OCR_JPEG_RETRY);
    if (!retryImage) return 'NONE';

    const retryResult = await callGeminiDigits([retryImage], prompt, label, MAX_DIGITS);
    return retryResult || 'NONE';
  } catch (error) {
    console.error(`[OCR:${label}] Gemini OCR failed:`, error);
    return 'NONE';
  }
}

function getFixedSimValue(videoEl: HTMLVideoElement, label: 'Top Plate' | 'PCB'): string | null {
  const direct = normalizeDigits(videoEl.dataset.simOcrValue ?? '', MAX_DIGITS);
  if (direct) return direct;

  if (label === 'PCB') {
    return normalizeDigits(videoEl.dataset.simPcbValue ?? '', MAX_DIGITS);
  }

  return normalizeDigits(videoEl.dataset.simTopValue ?? '', MAX_DIGITS);
}

function buildPrompt(label: 'Top Plate' | 'PCB', maxDigits: number) {
  if (label === 'PCB') {
    return [
      `Extract the handwritten number from the image.`,
      `Return ONLY digits, with no spaces, punctuation, or extra words.`,
      `The number may contain between 1 and ${maxDigits} digits.`,
      `The original writing was vertical top-to-bottom.`,
      `The image has already been rotated so the digits should read left-to-right.`,
      `Be careful with confusing digits like 9/4/6, 8/6, and 5/2.`,
      `If no number is clearly readable, return NONE.`,
    ].join(' ');
  }

  return [
    `Extract the handwritten number from the image.`,
    `Return ONLY digits, with no spaces, punctuation, or extra words.`,
    `The number may contain between 1 and ${maxDigits} digits.`,
    `The writing is horizontal.`,
    `If no number is clearly readable, return NONE.`,
  ].join(' ');
}

function captureFrameSource(videoEl: HTMLVideoElement): {
  source: HTMLCanvasElement | null;
  w: number;
  h: number;
} {
  const vw = videoEl.videoWidth || videoEl.clientWidth || 0;
  const vh = videoEl.videoHeight || videoEl.clientHeight || 0;

  if (!vw || !vh) {
    return { source: null, w: 0, h: 0 };
  }

  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { source: null, w: 0, h: 0 };
  }

  ctx.drawImage(videoEl, 0, 0, vw, vh);
  return { source: canvas, w: vw, h: vh };
}

function drawCropToOffscreen(
  source: CanvasImageSource,
  vw: number,
  vh: number,
  crop: Crop,
  cssFilter: string,
  rotation: 0 | 90 | 180 | 270 = 0,
  flipH = false,
): HTMLCanvasElement {
  const sx = clamp(crop.x, 0, 1) * vw;
  const sy = clamp(crop.y, 0, 1) * vh;
  const sw = clamp(crop.width, 0, 1) * vw;
  const sh = clamp(crop.height, 0, 1) * vh;

  const w = Math.max(1, Math.round(sw));
  const h = Math.max(1, Math.round(sh));

  const canvas = document.createElement('canvas');

  if (rotation === 90 || rotation === 270) {
    canvas.width = h;
    canvas.height = w;
  } else {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.filter = cssFilter || 'none';

  switch (rotation) {
    case 90:
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case 180:
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
      break;
    case 270:
      ctx.translate(0, canvas.height);
      ctx.rotate((3 * Math.PI) / 2);
      break;
  }

  if (flipH) {
    ctx.translate(rotation === 90 || rotation === 270 ? h : w, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return canvas;
}

function resizeCanvasToHeight(source: HTMLCanvasElement, targetHeight: number): HTMLCanvasElement {
  if (source.height <= targetHeight) return source;

  const scale = targetHeight / source.height;
  const targetWidth = Math.max(1, Math.round(source.width * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return source;

  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
  return canvas;
}

function canvasToBase64JPEG(canvas: HTMLCanvasElement, quality = 0.9) {
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.split(',')[1] ?? '';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDigits(raw: string, maxDigits: number): string | null {
  if (!raw) return null;

  const digitsOnly = raw.replace(/\D/g, '').trim();
  if (!digitsOnly) return null;
  if (digitsOnly.length < 1 || digitsOnly.length > maxDigits) return null;

  return digitsOnly;
}

function extractDigits(text: string, maxDigits: number): string | null {
  if (!text) return null;

  const direct = text.match(new RegExp(`\\b(\\d{1,${maxDigits}})\\b`));
  if (direct?.[1]) return direct[1];

  return normalizeDigits(text, maxDigits);
}

function collectCandidateTexts(result: any): string[] {
  const texts: string[] = [];

  const pushIfString = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      texts.push(value.trim());
    }
  };

  pushIfString(result?.text);

  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];

  for (const candidate of candidates) {
    pushIfString(candidate?.output);

    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        pushIfString(part?.text);
      }
    }
  }

  return texts;
}

function isValidOcrResult(value: string | null, maxDigits: number): boolean {
  if (value === null) return false;
  return new RegExp(`^\\d{1,${maxDigits}}$`).test(value);
}

function buildGenerationConfig(model: string): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: 64,
  };

  // Gemini 3.x uses thinkingLevel. "minimal" is the lowest supported
  // level and avoids the invalid thinkingBudget: 0 request.
  if (/^gemini-3(?:[.-]|$)/i.test(model)) {
    generationConfig.thinkingConfig = {
      thinkingLevel: 'minimal',
    };
  }

  // Preserve compatibility if the .env is intentionally changed back
  // to a Gemini 2.5 model, which uses thinkingBudget instead.
  if (/^gemini-2\.5(?:[.-]|$)/i.test(model)) {
    generationConfig.thinkingConfig = {
      thinkingBudget: 0,
    };
  }

  return generationConfig;
}

async function callGeminiDigits(
  base64ImageArray: string[],
  promptText: string,
  type: string,
  maxDigits: number,
): Promise<string | null> {
  if (!apiKey) throw new Error('API Key is missing.');

  const parts: any[] = [{ text: promptText }];

  base64ImageArray.forEach((data) => {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data,
      },
    });
  });

  const payload = {
    contents: [{ parts }],
    generationConfig: buildGenerationConfig(GEMINI_MODEL),
  };

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `API request failed for ${type}: ${response.status} ${response.statusText} ${errorText}`,
      );
    }

    const result = await response.json();
    const candidates = collectCandidateTexts(result);

    for (const text of candidates) {
      const parsed = extractDigits(text, maxDigits);
      if (parsed) return parsed;

      if (text.toUpperCase().includes('NONE')) {
        return null;
      }
    }

    return null;
  } finally {
    window.clearTimeout(timer);
  }
}