import { loadDeviceSettings, saveDeviceSettings, type Crop, type Filter } from '../state/store';

const roiPreview1 = document.getElementById('roi-preview-1') as HTMLCanvasElement;
const roiPreview2 = document.getElementById('roi-preview-2') as HTMLCanvasElement;
const webcam1 = document.getElementById('webcam1') as HTMLVideoElement;
const webcam2 = document.getElementById('webcam2') as HTMLVideoElement;

function fitWidth(canvas: HTMLCanvasElement) {
  // Use the actual available width of the column
  const w = Math.max(200, Math.floor(canvas.parentElement?.clientWidth || 260));
  return w;
}

export function updateRoiPreview(
  videoElement: HTMLVideoElement,
  canvasElement: HTMLCanvasElement,
  crop: Crop,
  filter: Filter,
) {
  if (videoElement.readyState < 2) return;
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  const roiX = crop.x * vw,
    roiY = crop.y * vh;
  const roiW = crop.width * vw,
    roiH = crop.height * vh;

  const targetW = fitWidth(canvasElement);
  const targetH = Math.max(100, Math.round(targetW * (crop.height / crop.width)));

  canvasElement.width = targetW;
  canvasElement.height = targetH;

  const ctx = canvasElement.getContext('2d')!;
  ctx.filter = `brightness(${filter.brightness}%) contrast(${filter.contrast}%)`;
  ctx.drawImage(videoElement, roiX, roiY, roiW, roiH, 0, 0, targetW, targetH);
}

export function livePreviewLoop(crop1: Crop, crop2: Crop, filter1: Filter, filter2: Filter) {
  updateRoiPreview(webcam1, roiPreview1, crop1, filter1);
  updateRoiPreview(webcam2, roiPreview2, crop2, filter2);
  requestAnimationFrame(() => livePreviewLoop(crop1, crop2, filter1, filter2));
}

export function setupCropControls(
  zoomSlider: HTMLInputElement,
  xSlider: HTMLInputElement,
  ySlider: HTMLInputElement,
  cropState: Crop,
  filterState: Filter,
  deviceId: string,
) {
  zoomSlider.value = String(Math.round((cropState.width || 0.9) * 100));
  xSlider.value = String(Math.round((cropState.x || 0.05) * 100));
  ySlider.value = String(Math.round((cropState.y || 0.05) * 100));

  function update() {
    const zoom = parseFloat(zoomSlider.value) / 100;
    const x = parseFloat(xSlider.value) / 100;
    const y = parseFloat(ySlider.value) / 100;

    cropState.width = zoom;
    cropState.height = zoom;
    cropState.x = x;
    cropState.y = y;

    const maxOffset = (1.0 - zoom) * 100;
    xSlider.max = String(Math.max(0, maxOffset));
    ySlider.max = String(Math.max(0, maxOffset));

    const s = loadDeviceSettings(deviceId);
    s.crop = { ...cropState };
    s.filter = { ...filterState };
    s.hw = loadDeviceSettings(deviceId).hw;
    saveDeviceSettings(deviceId, s);
  }

  zoomSlider.addEventListener('input', update);
  xSlider.addEventListener('input', update);
  ySlider.addEventListener('input', update);

  update();
}
