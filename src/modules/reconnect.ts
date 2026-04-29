// src/modules/reconnect.ts
// Best-effort auto-reconnect hooks for webcams & serial.

export function setupAutoReconnect() {
  // If you maintain MediaStreamTracks, add track.onended to surface UI hints.
  if ('serial' in navigator) {
    (navigator as any).serial.addEventListener?.('disconnect', () => {
      console.warn('[reconnect] serial disconnected');
    });
  }
}
