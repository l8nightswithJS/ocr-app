// src/modules/settle.ts
// Presence settling utilities.

export type WaitForFreshFrameFn = (videoEl: HTMLVideoElement, frames?: number) => Promise<void>;

function fallbackWaitForFreshFrame(videoEl: HTMLVideoElement, frames = 1): Promise<void> {
  const frameCount = Math.max(1, Math.floor(frames));

  return new Promise((resolve) => {
    let remaining = frameCount;

    const step = () => {
      remaining -= 1;

      if (remaining <= 0) {
        resolve();
        return;
      }

      if ('requestVideoFrameCallback' in videoEl) {
        videoEl.requestVideoFrameCallback(() => step());
      } else {
        window.requestAnimationFrame(() => step());
      }
    };

    if ('requestVideoFrameCallback' in videoEl) {
      videoEl.requestVideoFrameCallback(() => step());
    } else {
      window.requestAnimationFrame(() => step());
    }
  });
}

export async function settleAfterPresence(
  videoEls: HTMLVideoElement[],
  minFrames = 2,
  extraMs = 150,
  waitForFreshFrameFn: WaitForFreshFrameFn = fallbackWaitForFreshFrame,
) {
  for (let i = 0; i < minFrames; i += 1) {
    for (const videoEl of videoEls) {
      await waitForFreshFrameFn(videoEl, 1);
    }
  }

  if (extraMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, extraMs));
  }
}

/** Legacy class expected by production-pack. */
export class Settler {
  private videoEls: HTMLVideoElement[];
  private minFrames: number;
  private extraMs: number;
  private waitForFreshFrameFn: WaitForFreshFrameFn;

  constructor(
    videoEls: HTMLVideoElement[] = [],
    minFrames = 2,
    extraMs = 150,
    waitForFreshFrameFn: WaitForFreshFrameFn = fallbackWaitForFreshFrame,
  ) {
    this.videoEls = videoEls;
    this.minFrames = minFrames;
    this.extraMs = extraMs;
    this.waitForFreshFrameFn = waitForFreshFrameFn;
  }

  setVideos(videoEls: HTMLVideoElement[]) {
    this.videoEls = videoEls;
  }

  setParams(minFrames: number, extraMs: number) {
    this.minFrames = minFrames;
    this.extraMs = extraMs;
  }

  setWaitForFreshFrame(waitForFreshFrameFn: WaitForFreshFrameFn) {
    this.waitForFreshFrameFn = waitForFreshFrameFn;
  }

  async run() {
    if (!this.videoEls?.length) return;

    await settleAfterPresence(
      this.videoEls,
      this.minFrames,
      this.extraMs,
      this.waitForFreshFrameFn,
    );
  }
}
