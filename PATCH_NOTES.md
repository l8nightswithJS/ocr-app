# OCR App Patch Notes — Stability + Dual-Station UX Hardening

Baseline: current working OCR app after Gemini key recovery, input-field fix, single-window switch fix, and duplicate-table render guard.

## Changed

### Dual-station traceability UX
- Split the top callout into station-aware sequence guidance:
  - LRM station / LRM workflow shows `Next LRM Sequence` from the LRM pairing counter.
  - Cartridge OCR station / OCR workflow shows `Next OCR Sequence` from the earliest paired, not-complete record ready for OCR attention.
- Kept OCR table focus on the last OCR sequence instead of jumping to the bottom after LRM-side updates.
- Reduced the LRM operator dock footprint and lowered its z-index so it no longer blocks the top-right menu.
- Raised the top-right menu z-index so Arduino/export/single-window options remain clickable above the LRM dock.
- Improved dual-window to single-window switching:
  - LRM/main station becomes the single-window station.
  - Cartridge OCR popup receives the station-mode command and closes itself when it was opened as the popup.

### OCR reliability
- Gemini calls now send the API key in the `x-goog-api-key` header instead of the request URL.
- Added deterministic generation settings: `temperature: 0` and compact max output tokens.
- A fast OCR pass returning `NONE` now retries the higher-quality crop instead of immediately accepting `NONE`.
- Adaptive burst OCR now honors `maxAttempts` beyond 3 and only exits early after stable matching digit reads, not repeated `NONE` results.

### Camera / ROI stability
- Camera permission probe stream is stopped immediately after permission is granted.
- If camera 1 opens but camera 2 fails, camera 1 is now cleaned up to avoid later `camera already in use` failures.
- `startStreams()` now resolves after the delayed camera restart actually finishes instead of immediately after scheduling the restart.
- ROI crop control listeners are replaced on rewire instead of accumulating across station switches/camera changes.

### Source structure
- Removed generated duplicate `src/**/*.js` files that had matching `.ts` files so Vite resolves the TypeScript source of truth.
- Removed `tsconfig.tsbuildinfo` from the deliverable.
- Preserved `package-lock.json` in the project baseline for reproducible installs.

## Not changed
- No `.env` file included.
- No Gemini key included.
- Camera ROI math and OCR prompt intent remain equivalent except for safer retry behavior and deterministic generation config.

## Validation performed
- TypeScript compile check passed using a temporary local Vite type stub because dependencies are not vendored in the zip.
- Full `npm run build` was not completed in this sandbox because dependency install could not fetch a GitHub-hosted Electron dependency (`EAI_AGAIN` network resolution failure). Run `npm ci` / `npm run build` on the station before adopting outside sim testing.

## Recommended test order
1. `npm ci`
2. Confirm `.env` contains the new working Gemini key.
3. `npm run dev`
4. Test sim mode single-window.
5. Test dual-window LRM/OCR sequence callouts.
6. Test manual input typing in OCR window.
7. Test OCR scan and confirm table stays focused on the completed OCR row.
8. Test menu access while LRM dock is visible.
9. Test switching from dual-window back to single-window.
