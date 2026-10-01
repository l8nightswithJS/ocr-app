import {
  saveDevicesMeta,
  loadDeviceSettings,
  saveDeviceSettings,
  loadPersistedIds,
  savePersistedIds,
} from '../state/store';
import { updateStatus } from '../ui/status';

const cameraSelect = document.getElementById('camera-select-2') as HTMLSelectElement;
const focusControl = document.getElementById('focus-control-container-2')!;
const focusSlider = document.getElementById('focus-slider-2') as HTMLInputElement;
const exposureControl = document.getElementById('exposure-control-container-2')!;
const exposureSlider = document.getElementById('exposure-slider-2') as HTMLInputElement;

export const webcam2 = document.getElementById('webcam2') as HTMLVideoElement;

export let videoDevices: MediaDeviceInfo[] = [];
export let currentStream2: MediaStream | null = null;
let restartTimer: number | null = null;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function inRange(n: number, min: number, max: number) {
  return Number.isFinite(n) && n >= min && n <= max;
}

function applyAdvanced(track: MediaStreamTrack, set: Record<string, unknown>) {
  return track.applyConstraints({ advanced: [set] } as unknown as MediaTrackConstraints);
}

function setupFocusSlider(stream: MediaStream, deviceId: string) {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    focusControl.classList.add('hidden');
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
    focusControl.classList.add('hidden');
    return;
  }

  focusControl.classList.remove('hidden');
  const min = Number(focusCap?.min ?? 0);
  const max = Number(focusCap?.max ?? 0);
  const step = Number(focusCap?.step ?? 1);

  focusSlider.min = String(min);
  focusSlider.max = String(max);
  focusSlider.step = String(step);

  const settings = loadDeviceSettings(deviceId);
  const saved = settings.hw.focus;
  const startValue = clamp(
    Number(saved ?? (track.getSettings?.() as any)?.focusDistance ?? min),
    min,
    max,
  );

  focusSlider.value = String(startValue);

  if (saved != null) {
    void applyAdvanced(track, { focusMode: 'manual', focusDistance: startValue }).catch(async () => {
      try {
        await applyAdvanced(track, { focusMode: 'continuous' });
      } catch {}
    });
  }

  focusSlider.oninput = async (event) => {
    const value = clamp(Number((event.target as HTMLInputElement).value), min, max);

    try {
      await applyAdvanced(track, { focusMode: 'manual', focusDistance: value });
      const next = loadDeviceSettings(deviceId);
      next.hw.focus = value;
      saveDeviceSettings(deviceId, next);
    } catch {
      try {
        await applyAdvanced(track, { focusMode: 'continuous' });
      } catch {}
    }
  };
}

function setupExposureSlider(stream: MediaStream, deviceId: string) {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    exposureControl.classList.add('hidden');
    return;
  }

  const caps = (track.getCapabilities?.() || {}) as MediaTrackCapabilities;
  const settings = (track.getSettings?.() || {}) as MediaTrackSettings;
  const exposureCap = (caps as any).exposureTime as
    | { min: number; max: number; step?: number }
    | undefined;

  if (!exposureCap || exposureCap.min === exposureCap.max) {
    exposureControl.classList.add('hidden');
    return;
  }

  exposureControl.classList.remove('hidden');

  const min = Number(exposureCap.min);
  const max = Number(exposureCap.max);
  const step = Number(exposureCap.step ?? 1);

  exposureSlider.min = String(min);
  exposureSlider.max = String(max);
  exposureSlider.step = String(step);

  const saved = loadDeviceSettings(deviceId).hw.exposure;
  const startValue = clamp(Number(saved ?? (settings as any).exposureTime ?? min), min, max);
  exposureSlider.value = String(startValue);

  if (saved != null) {
    void applyAdvanced(track, { exposureMode: 'manual', exposureTime: startValue }).catch(async () => {
      try {
        await applyAdvanced(track, { exposureMode: 'continuous' });
      } catch {}
    });
  }

  exposureSlider.oninput = async (event) => {
    const value = clamp(Number((event.target as HTMLInputElement).value), min, max);

    try {
      if (!inRange(value, min, max)) return;
      await applyAdvanced(track, { exposureMode: 'manual', exposureTime: value });
      const next = loadDeviceSettings(deviceId);
      next.hw.exposure = value;
      saveDeviceSettings(deviceId, next);
    } catch {
      try {
        await applyAdvanced(track, { exposureMode: 'continuous' });
      } catch {}
    }
  };
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {}
  });
}

export function stopAllCameraStreams() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  stopStream(currentStream2);
  currentStream2 = null;

  if (webcam2) {
    (webcam2 as any).srcObject = null;
  }
}

export async function startStreams() {
  if (restartTimer) clearTimeout(restartTimer);

  return new Promise<void>((resolve) => {
    restartTimer = window.setTimeout(async () => {
      restartTimer = null;

      if (!cameraSelect?.value) {
        resolve();
        return;
      }

      stopAllCameraStreams();
      await new Promise((r) => setTimeout(r, 80));

      let stream: MediaStream | null = null;

      try {
        const common: MediaTrackConstraints = {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        };

        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cameraSelect.value }, ...common },
          audio: false,
        });

        (webcam2 as any).srcObject = stream;
        currentStream2 = stream;

        savePersistedIds({ cam2: cameraSelect.value });
        setupFocusSlider(stream, cameraSelect.value);
        setupExposureSlider(stream, cameraSelect.value);

        updateStatus('Top Plate camera ready.', 'success');
      } catch (err: any) {
        stopStream(stream);

        console.error('startStreams error:', err);

        if (err?.name === 'OverconstrainedError' || err?.name === 'NotReadableError') {
          updateStatus('That camera is already in use or cannot be opened.', 'error');
        } else if (err?.name === 'NotAllowedError') {
          updateStatus('Camera permission denied. Allow access to use the Top Plate camera.', 'error');
        } else {
          updateStatus(`Failed to start camera: ${err?.name || 'Unknown'}`, 'error');
        }
      } finally {
        resolve();
      }
    }, 120);
  });
}

export async function initWebcams() {
  try {
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      console.warn('Not a secure context. Use http://localhost or https:// for stable device IDs/labels.');
    }

    const permissionProbeStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    stopStream(permissionProbeStream);

    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter((device) => device.kind === 'videoinput');

    if (videoDevices.length < 1) {
      updateStatus('Error: A Top Plate webcam is required.', 'error');
      return;
    }

    saveDevicesMeta(videoDevices);
    cameraSelect.innerHTML = '';

    videoDevices.forEach((device, index) => {
      cameraSelect.add(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
    });

    const persisted = loadPersistedIds();
    const savedTopCamera = persisted.cam2 && videoDevices.some((d) => d.deviceId === persisted.cam2);

    cameraSelect.value = savedTopCamera ? persisted.cam2! : videoDevices[0].deviceId;
    savePersistedIds({ cam2: cameraSelect.value });

    await startStreams();
  } catch (err: any) {
    console.error('Error initializing webcam:', err);

    if (err?.name === 'NotFoundError') {
      updateStatus('Top Plate camera not found.', 'error');
    } else {
      updateStatus('Could not access Top Plate camera.', 'error');
    }
  }
}

let deviceChangeTimer: number | null = null;

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (deviceChangeTimer) window.clearTimeout(deviceChangeTimer);

  deviceChangeTimer = window.setTimeout(() => {
    deviceChangeTimer = null;
    void initWebcams();
  }, 500);
});

export async function waitForFreshFrame(videoEl: HTMLVideoElement, frames = 1) {
  const anyVid = videoEl as any;
  const requestFrame:
    | ((cb: (now: number, meta: VideoFrameCallbackMetadata) => void) => number)
    | undefined =
    typeof anyVid.requestVideoFrameCallback === 'function'
      ? anyVid.requestVideoFrameCallback.bind(videoEl)
      : undefined;

  if (videoEl.readyState < 2) {
    await new Promise<void>((resolve) => {
      const onCanPlay = () => {
        videoEl.removeEventListener('loadeddata', onCanPlay);
        videoEl.removeEventListener('canplay', onCanPlay);
        resolve();
      };

      videoEl.addEventListener('loadeddata', onCanPlay, { once: true });
      videoEl.addEventListener('canplay', onCanPlay, { once: true });
    });
  }

  if (requestFrame) {
    try {
      await new Promise<void>((resolve) => {
        let seen = 0;

        const cb = () => {
          seen += 1;

          if (seen >= Math.max(1, frames)) {
            resolve();
            return;
          }

          requestFrame(cb);
        };

        requestFrame(cb);
      });
      return;
    } catch {}
  }

  await new Promise<void>((resolve) => {
    let left = Math.max(1, frames);
    let lastTime = videoEl.currentTime;
    let rafId = 0;

    const cleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      videoEl.removeEventListener('timeupdate', onTimeUpdate);
      videoEl.removeEventListener('playing', onTimeUpdate);
      videoEl.removeEventListener('seeked', onTimeUpdate);
    };

    const done = () => {
      cleanup();
      resolve();
    };

    const tick = () => {
      if (videoEl.currentTime !== lastTime || videoEl.readyState >= 2) {
        lastTime = videoEl.currentTime;
        left -= 1;
        if (left <= 0) {
          done();
          return;
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    const onTimeUpdate = () => {
      lastTime = videoEl.currentTime;
      left -= 1;
      if (left <= 0) done();
    };

    rafId = requestAnimationFrame(tick);
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('playing', onTimeUpdate);
    videoEl.addEventListener('seeked', onTimeUpdate);
  });
}

export async function captureFreshSource(
  videoEl: HTMLVideoElement,
): Promise<HTMLCanvasElement | HTMLVideoElement | ImageBitmap> {
  await waitForFreshFrame(videoEl, 1);
  return videoEl;
}

export function sourceDims(src: any, videoEl: HTMLVideoElement) {
  if ('width' in src && 'height' in src && !(src instanceof HTMLVideoElement)) {
    return { w: (src as any).width, h: (src as any).height };
  }

  return { w: videoEl.videoWidth, h: videoEl.videoHeight };
}
