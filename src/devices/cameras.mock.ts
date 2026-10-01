// src/devices/cameras.mock.ts
import { updateStatus } from '../ui/status';

let topStream: MediaStream | null = null;

async function imageToVideoStream(imgSrc: string, videoEl: HTMLVideoElement) {
  const img = new Image();
  img.src = imgSrc;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  window.setInterval(() => {
    ctx.drawImage(img, 0, 0);
  }, 33);

  const stream = canvas.captureStream(30);
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  topStream = stream;
}

export async function initWebcams() {
  const cameraSelect = document.getElementById('camera-select-2') as HTMLSelectElement | null;
  const webcam = document.getElementById('webcam2') as HTMLVideoElement | null;

  if (cameraSelect) {
    cameraSelect.innerHTML = '';
    cameraSelect.add(new Option('Sim Top Plate Camera', 'sim-top-camera'));
    cameraSelect.value = 'sim-top-camera';
  }

  if (webcam) {
    await imageToVideoStream('/sim/top.png', webcam);
  }

  updateStatus('SIM MODE: Top Plate camera ready.', 'success');
}

export async function startStreams() {
  return;
}

export async function waitForFreshFrame(_videoEl: HTMLVideoElement, _frames = 1) {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

export function stopAllCameraStreams() {
  topStream?.getTracks().forEach((track) => track.stop());
  topStream = null;

  const webcam = document.getElementById('webcam2') as HTMLVideoElement | null;
  if (webcam) webcam.srcObject = null;
}
