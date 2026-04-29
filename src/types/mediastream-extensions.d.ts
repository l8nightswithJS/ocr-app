// global augmentations for MediaStream constraints/capabilities we actually use
declare global {
  interface MediaTrackConstraintSet {
    // Not in lib.dom.d.ts across all TS versions, but supported by browsers we use
    focusMode?: 'manual' | 'continuous' | 'single-shot' | string;
    focusDistance?: number;
    exposureMode?: 'manual' | 'continuous' | string;
    exposureTime?: number;
  }

  interface MediaTrackCapabilities {
    // Some browsers expose these as capabilities
    focusMode?: string[];
    focusDistance?: { min: number; max: number; step?: number };
    exposureMode?: string[];
    exposureTime?: { min: number; max: number; step?: number };
  }

  interface MediaTrackSettings {
    focusMode?: string;
    focusDistance?: number;
    exposureMode?: string;
    exposureTime?: number;
  }
}

export {};
