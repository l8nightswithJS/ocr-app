import {
  saveDevicesMeta,
  loadDeviceSettings,
  saveDeviceSettings,
  loadPersistedIds,
} from '../state/store';
import { updateStatus } from '../ui/status';

const cameraSelect1 = document.getElementById('camera-select-1') as HTMLSelectElement;
const cameraSelect2 = document.getElementById('camera-select-2') as HTMLSelectElement;

const focusControl1 = document.getElementById('focus-control-container-1')!;
const focusSlider1 = document.getElementById('focus-slider-1') as HTMLInputElement;
const exposureControl1 = document.getElementById('exposure-control-container-1')!;
const exposureSlider1 = document.getElementById('exposure-slider-1') as HTMLInputElement;

const focusControl2 = document.getElementById('focus-control-container-2')!;
const focusSlider2 = document.getElementById('focus-slider-2') as HTMLInputElement;
const exposureControl2 = document.getElementById('exposure-control-container-2')!;
const exposureSlider2 = document.getElementById('exposure-slider-2') as HTMLInputElement;

export const webcam1 = document.getElementById('webcam1') as HTMLVideoElement;
export const webcam2 = document.getElementById('webcam2') as HTMLVideoElement;

export let videoDevices: MediaDeviceInfo[] = [];
export let currentStream1: MediaStream | null = null;
export let currentStream2: MediaStream | null = null;
let restartTimer: number | null = null;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function ensureDistinctSelection(
  changedSelect: HTMLSelectElement,
  otherSelect: HTMLSelectElement,
) {
  if (!changedSelect || !otherSelect) return;
  if (changedSelect.value === otherSelect.value) {
    const opts = Array.from(otherSelect.options);
    const next = opts.find((o) => o.value !== changedSelect.value);
    if (next) otherSelect.value = next.value;
  }
}

function inRange(n: number, min: number, max: number) {
  return Number.isFinite(n) && n >= min && n <= max;
}

function applyAdvanced(track: MediaStreamTrack, set: Record<string, unknown>) {
  // Cast through unknown to satisfy TS while still sending the advanced set we need.
  return track.applyConstraints({ advanced: [set] } as unknown as MediaTrackConstraints);
}

function setupFocusSlider(
  stream: MediaStream,
  containerEl: HTMLElement,
  sliderEl: HTMLInputElement,
  deviceId: string,
) {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    containerEl.classList.add('hidden');
    return;
  }

  const caps = (track.getCapabilities?.() || {}) as MediaTrackCapabilities;
  const focusCap = (caps as any).focusDistance as
    | { min: number; max: number; step?: number }
    | undefined;
  const focusModes = (caps as any).focusMode as string[] | undefined;

  const supportedManual =
    !!focusCap || (Array.isArray(focusModes) && focusModes.includes('manual'));
  if (!supportedManual) {
    containerEl.classList.add('hidden');
    return;
  }

  containerEl.classList.remove('hidden');
  const min = Number(focusCap?.min ?? 0);
  const max = Number(focusCap?.max ?? 0);
  const step = Number(focusCap?.step ?? 1);
  sliderEl.min = String(min);
  sliderEl.max = String(max);
  sliderEl.step = String(step);

  const s = loadDeviceSettings(deviceId);
  const saved = s.hw.focus;
  const startValue = clamp(
    Number(saved ?? (track.getSettings?.() as any)?.focusDistance ?? min),
    min,
    max,
  );
  sliderEl.value = String(startValue);

  if (saved != null) {
    (async () => {
      try {
        await applyAdvanced(track, { focusMode: 'manual', focusDistance: startValue });
      } catch (e) {
        console.warn('Manual focus not applied; fallback auto', (e as any)?.name || e);
        try {
          await applyAdvanced(track, { focusMode: 'continuous' });
        } catch {}
      }
    })();
  }

  sliderEl.oninput = async (e) => {
    const val = clamp(Number((e.target as HTMLInputElement).value), min, max);
    try {
      await applyAdvanced(track, { focusMode: 'manual', focusDistance: val });
      const s2 = loadDeviceSettings(deviceId);
      s2.hw.focus = val;
      saveDeviceSettings(deviceId, s2);
    } catch (err) {
      console.warn('Focus not applied; reverting to auto', (err as any)?.name || err);
      try {
        await applyAdvanced(track, { focusMode: 'continuous' });
      } catch {}
    }
  };
}

function setupExposureSlider(
  stream: MediaStream,
  containerEl: HTMLElement,
  sliderEl: HTMLInputElement,
  deviceId: string,
) {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    containerEl.classList.add('hidden');
    return;
  }

  const caps = (track.getCapabilities?.() || {}) as MediaTrackCapabilities;
  const settings = (track.getSettings?.() || {}) as MediaTrackSettings;

  const exposureCap = (caps as any).exposureTime as
    | { min: number; max: number; step?: number }
    | undefined;

  if (!exposureCap || exposureCap.min === exposureCap.max) {
    containerEl.classList.add('hidden');
    return;
  }
  containerEl.classList.remove('hidden');

  const min = Number(exposureCap.min);
  const max = Number(exposureCap.max);
  const step = Number(exposureCap.step ?? 1);
  sliderEl.min = String(min);
  sliderEl.max = String(max);
  sliderEl.step = String(step);

  const s = loadDeviceSettings(deviceId);
  const saved = s.hw.exposure;
  const startValue = clamp(Number(saved ?? (settings as any).exposureTime ?? min), min, max);
  sliderEl.value = String(startValue);

  (async () => {
    if (saved != null) {
      try {
        await applyAdvanced(track, { exposureMode: 'manual', exposureTime: startValue });
      } catch (e) {
        console.warn('Manual exposure not applied; fallback auto', (e as any)?.name || e);
        try {
          await applyAdvanced(track, { exposureMode: 'continuous' });
        } catch {}
      }
    }
  })();

  sliderEl.oninput = async (e) => {
    const val = clamp(Number((e.target as HTMLInputElement).value), min, max);
    try {
      if (inRange(val, min, max)) {
        await applyAdvanced(track, { exposureMode: 'manual', exposureTime: val });
        const s2 = loadDeviceSettings(deviceId);
        s2.hw.exposure = val;
        saveDeviceSettings(deviceId, s2);
      }
    } catch (err) {
      console.warn('Exposure not applied; reverting to auto', (err as any)?.name || err);
      try {
        await applyAdvanced(track, { exposureMode: 'continuous' });
      } catch {}
    }
  };
}

export async function startStreams() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    if (!cameraSelect1.value || !cameraSelect2.value) return;
    if (cameraSelect1.value === cameraSelect2.value) {
      updateStatus('Choose two different cameras.', 'error');
      return;
    }

    // stop previous
    [currentStream1, currentStream2].forEach((s) => {
      s?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    });
    (webcam1 as any).srcObject = null;
    (webcam2 as any).srcObject = null;

    await new Promise((r) => setTimeout(r, 80));

    try {
      const common: MediaTrackConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      };
      const stream1 = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cameraSelect1.value }, ...common },
        audio: false,
      });
      const stream2 = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cameraSelect2.value }, ...common },
        audio: false,
      });

      (webcam1 as any).srcObject = stream1;
      (webcam2 as any).srcObject = stream2;
      currentStream1 = stream1;
      currentStream2 = stream2;

      setupFocusSlider(stream1, focusControl1, focusSlider1, cameraSelect1.value);
      setupExposureSlider(stream1, exposureControl1, exposureSlider1, cameraSelect1.value);
      setupFocusSlider(stream2, focusControl2, focusSlider2, cameraSelect2.value);
      setupExposureSlider(stream2, exposureControl2, exposureSlider2, cameraSelect2.value);

      updateStatus('Cameras ready.', 'success');
    } catch (err: any) {
      console.error('startStreams error:', err);
      if (err?.name === 'OverconstrainedError' || err?.name === 'NotReadableError') {
        updateStatus(
          'That camera is already in use or cannot be opened. Pick a different device.',
          'error',
        );
      } else if (err?.name === 'NotAllowedError') {
        updateStatus('Camera permission denied. Allow access to use cameras.', 'error');
      } else {
        updateStatus(`Failed to start cameras: ${err?.name || 'Unknown'}`, 'error');
      }
    }
  }, 120) as unknown as number;
}

export async function initWebcams() {
  let retriedAfterNotFound = false;
  try {
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      console.warn(
        'Not a secure context. Use http://localhost or https:// for stable device IDs/labels.',
      );
    }
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter((d) => d.kind === 'videoinput');
    if (videoDevices.length < 2) {
      if (!retriedAfterNotFound) {
        try {
          localStorage.removeItem('c920_cam1_deviceId');
          localStorage.removeItem('c920_cam2_deviceId');
        } catch {}
        retriedAfterNotFound = true;
        updateStatus('Camera selection cleared. Retrying...', 'info');
        await initWebcams();
        return;
      }
      updateStatus('Error: At least two webcams are required.', 'error');
      return;
    }

    saveDevicesMeta(videoDevices);

    [cameraSelect1, cameraSelect2].forEach((select) => {
      if (select) select.innerHTML = '';
    });
    videoDevices.forEach((device, index) => {
      cameraSelect1?.add(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
      cameraSelect2?.add(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
    });

    const persisted = loadPersistedIds();
    const has1 = !!persisted.cam1 && videoDevices.some((d) => d.deviceId === persisted.cam1);
    const has2 = !!persisted.cam2 && videoDevices.some((d) => d.deviceId === persisted.cam2);

    cameraSelect1.value = has1 ? persisted.cam1! : videoDevices[0]?.deviceId!;
    const fallback2 =
      videoDevices.find((d) => d.deviceId !== cameraSelect1.value) || videoDevices[0]!;
    cameraSelect2.value =
      has2 && persisted.cam2 !== cameraSelect1.value ? persisted.cam2! : fallback2.deviceId;
    ensureDistinctSelection(cameraSelect1, cameraSelect2);

    await startStreams();
  } catch (err: any) {
    console.error('Error initializing webcams:', err);
    if (err?.name === 'NotFoundError') {
      updateStatus('Requested device not found', 'error');
    } else {
      try {
        updateStatus('Could not access cameras.', 'error');
      } catch {}
    }
  }
}

// Rebind on changes
cameraSelect1?.addEventListener('change', () => {
  ensureDistinctSelection(cameraSelect1, cameraSelect2);
  void startStreams();
});
cameraSelect2?.addEventListener('change', () => {
  ensureDistinctSelection(cameraSelect2, cameraSelect1);
  void startStreams();
});

// Debounced devicechange
let deviceChangeTimer: any = null;
navigator.mediaDevices.addEventListener?.('devicechange', () => {
  console.log('devicechange detected (debounced)');
  clearTimeout(deviceChangeTimer);
  deviceChangeTimer = setTimeout(() => {
    void initWebcams();
  }, 500);
});

// Frame helpers
// Utilities exported for OCR
export async function waitForFreshFrame(videoEl: HTMLVideoElement, frames = 1) {
  // Prefer rVFC when available, but bind safely and fall back if the env is hostile.
  const anyVid = videoEl as any;
  const rVFC:
    | ((cb: (now: number, meta: VideoFrameCallbackMetadata) => void) => number)
    | undefined =
    typeof anyVid.requestVideoFrameCallback === 'function'
      ? anyVid.requestVideoFrameCallback.bind(videoEl)
      : undefined;

  // Defensive: ensure the element is ready to render frames
  if (videoEl.readyState < 2) {
    await new Promise<void>((res) => {
      const onCanPlay = () => {
        videoEl.removeEventListener('loadeddata', onCanPlay);
        videoEl.removeEventListener('canplay', onCanPlay);
        res();
      };
      videoEl.addEventListener('loadeddata', onCanPlay, { once: true });
      videoEl.addEventListener('canplay', onCanPlay, { once: true });
    });
  }

  // Path A: rVFC works and won’t throw in this environment
  if (rVFC) {
    try {
      await new Promise<void>((resolve) => {
        let seen = 0;
        const cb = () => {
          if (++seen >= frames) resolve();
          else rVFC(cb);
        };
        rVFC(cb);
      });
      return;
    } catch {
      // fall through to robust fallback
    }
  }

  // Path B: robust fallback — wait for time to advance, or for paint via RAF ticks
  await new Promise<void>((resolve) => {
    let left = Math.max(1, frames);
    let lastT = videoEl.currentTime;

    const done = () => {
      cleanup();
      resolve();
    };

    const tick = () => {
      // If playback advanced or the video is paused but a paint occurred, count it
      if (videoEl.currentTime !== lastT || videoEl.readyState >= 2) {
        lastT = videoEl.currentTime;
        if (--left <= 0) return done();
      }
      rafId = requestAnimationFrame(tick);
    };

    const onTimeUpdate = () => {
      lastT = videoEl.currentTime;
      if (--left <= 0) return done();
    };

    const cleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      videoEl.removeEventListener('timeupdate', onTimeUpdate);
      videoEl.removeEventListener('playing', onTimeUpdate);
      videoEl.removeEventListener('seeked', onTimeUpdate);
    };

    let rafId = requestAnimationFrame(tick);
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('playing', onTimeUpdate, { once: false });
    videoEl.addEventListener('seeked', onTimeUpdate, { once: false });
  });
}

export async function captureFreshSource(
  videoEl: HTMLVideoElement,
): Promise<HTMLCanvasElement | HTMLVideoElement | ImageBitmap> {
  // Always return the <video> after ensuring a fresh frame.
  // (ImageCapture frequently throws in Windows/Chrome; it’s not needed here.)
  await waitForFreshFrame(videoEl, 1);
  return videoEl;
}

export function sourceDims(src: any, videoEl: HTMLVideoElement) {
  if ('width' in src && 'height' in src && !(src instanceof HTMLVideoElement)) {
    return { w: (src as any).width, h: (src as any).height };
  }
  return { w: videoEl.videoWidth, h: videoEl.videoHeight };
}
