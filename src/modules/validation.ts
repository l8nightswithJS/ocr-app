// src/modules/validation.ts
// Adaptive burst capture + early-exit majority vote validator.

import type { Crop, Filter } from '../state/store';
import type { DB } from './db';

export type VoteHistogram = Record<string, number>;

export type VoteResult = {
  value: string | null;
  conf: number;
  histogram: VoteHistogram;
};

export type OcrOnceFn = (
  videoEl: HTMLVideoElement,
  crop: Crop,
  filter: Filter,
  label: 'Top Plate' | 'PCB',
) => Promise<string | null>;

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

function normalizeVote(raw: string | null | undefined): string {
  return raw && raw.trim() ? raw.trim() : 'NONE';
}

function finalizeVotes(votes: Map<string, number>, attemptsUsed: number): VoteResult {
  let winner = 'NONE';
  let max = 0;

  for (const [key, count] of votes) {
    if (count > max) {
      max = count;
      winner = key;
    }
  }

  return {
    value: winner === 'NONE' ? null : winner,
    conf: attemptsUsed > 0 ? max / attemptsUsed : 0,
    histogram: Object.fromEntries(votes),
  };
}

/**
 * Adaptive OCR:
 * - attempt #1
 * - attempt #2
 * - if #1 and #2 agree, stop early
 * - else do attempt #3, up to maxAttempts
 *
 * This keeps vote behavior but saves a full OCR call in the common stable case.
 */
export async function adaptiveBurstRead(
  videoEl: HTMLVideoElement,
  crop: Crop,
  filter: Filter,
  label: 'Top Plate' | 'PCB',
  ocrOnce: OcrOnceFn,
  maxAttempts = 3,
  minGapFrames = 1,
  waitForFreshFrameFn: WaitForFreshFrameFn = fallbackWaitForFreshFrame,
): Promise<VoteResult> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  const votes = new Map<string, number>();

  const firstRaw = await ocrOnce(videoEl, crop, filter, label);
  const first = normalizeVote(firstRaw);
  votes.set(first, 1);

  if (attempts === 1) {
    return finalizeVotes(votes, 1);
  }

  await waitForFreshFrameFn(videoEl, minGapFrames);

  const secondRaw = await ocrOnce(videoEl, crop, filter, label);
  const second = normalizeVote(secondRaw);
  votes.set(second, (votes.get(second) ?? 0) + 1);

  // Early exit if the first two match.
  if (first === second) {
    return finalizeVotes(votes, 2);
  }

  if (attempts === 2) {
    return finalizeVotes(votes, 2);
  }

  await waitForFreshFrameFn(videoEl, minGapFrames);

  const thirdRaw = await ocrOnce(videoEl, crop, filter, label);
  const third = normalizeVote(thirdRaw);
  votes.set(third, (votes.get(third) ?? 0) + 1);

  return finalizeVotes(votes, 3);
}

/** Legacy compatibility hook. */
export function mountValidationRunner(_db?: DB): void {
  // No-op
}
