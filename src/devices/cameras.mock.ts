// src/devices/cameras.mock.ts
import { updateStatus } from '../ui/status';

export async function initWebcams() {
  // Pretend we found 2 cameras and populate the selects so the UI doesn't break.
  const cameraSelect1 = document.getElementById('camera-select-1') as HTMLSelectElement | null;
  const cameraSelect2 = document.getElementById('camera-select-2') as HTMLSelectElement | null;

  async function imageToVideoStream(imgSrc: string, videoEl: HTMLVideoElement) {
    const img = new Image();
    img.src = imgSrc;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;

    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    // Redraw at ~30 FPS so frames actually advance
    setInterval(() => {
      ctx.drawImage(img, 0, 0);
    }, 33);

    const stream = canvas.captureStream(30);
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
  }

  if (cameraSelect1) cameraSelect1.innerHTML = '';
  if (cameraSelect2) cameraSelect2.innerHTML = '';

  const mockDevices = [
    { label: 'Sim Camera 1', deviceId: 'sim-cam-1' },
    { label: 'Sim Camera 2', deviceId: 'sim-cam-2' },
  ];

  mockDevices.forEach((d) => {
    cameraSelect1?.add(new Option(d.label, d.deviceId));
    cameraSelect2?.add(new Option(d.label, d.deviceId));
  });

  // Ensure different selection like the real code expects.
  if (cameraSelect1) cameraSelect1.value = mockDevices[0].deviceId;
  if (cameraSelect2) cameraSelect2.value = mockDevices[1].deviceId;

  // ---- Deterministic SIM images ----
  const webcam1 = document.getElementById('webcam1') as HTMLVideoElement | null;
  const webcam2 = document.getElementById('webcam2') as HTMLVideoElement | null;

  if (webcam1) {
    await imageToVideoStream('/sim/pcb.png', webcam1);
  }

  if (webcam2) {
    await imageToVideoStream('/sim/top.png', webcam2);
  }

  updateStatus('SIM MODE: Cameras ready (static images).', 'success');
}

export async function startStreams() {
  // No-op in sim mode. main.ts still calls this on camera changes.
  return;
}

export async function waitForFreshFrame(_videoEl: HTMLVideoElement, _frames = 1) {
  // Mimic the real timing behavior without relying on real frames.
  await new Promise((r) => setTimeout(r, 30));
}

export function stopAllCameraStreams() {
  const webcam1 = document.getElementById('webcam1') as HTMLVideoElement | null;
  const webcam2 = document.getElementById('webcam2') as HTMLVideoElement | null;
  [webcam1, webcam2].forEach((video) => {
    const stream = video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    if (video) video.srcObject = null;
  });
}
