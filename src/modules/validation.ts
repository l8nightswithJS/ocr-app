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
  label: 'Top Plate',
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
  label: 'Top Plate',
  ocrOnce: OcrOnceFn,
  maxAttempts = 3,
  minGapFrames = 1,
  waitForFreshFrameFn: WaitForFreshFrameFn = fallbackWaitForFreshFrame,
): Promise<VoteResult> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  const votes = new Map<string, number>();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await waitForFreshFrameFn(videoEl, minGapFrames);
    }

    const raw = await ocrOnce(videoEl, crop, filter, label);
    const vote = normalizeVote(raw);
    votes.set(vote, (votes.get(vote) ?? 0) + 1);

    // Stable digit reads can exit early after two matching votes. Keep retrying NONE
    // through maxAttempts because a later fresh frame may still produce a readable crop.
    if (attempt >= 2 && vote !== 'NONE' && (votes.get(vote) ?? 0) >= 2) {
      return finalizeVotes(votes, attempt);
    }
  }

  return finalizeVotes(votes, attempts);
}

/** Legacy compatibility hook. */
export function mountValidationRunner(_db?: DB): void {
  // No-op
}
