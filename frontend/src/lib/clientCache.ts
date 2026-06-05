// A central registry of the app's in-memory SWR caches so they can all be cleared
// at once — notably on logout, so a different user signing in on the same tab (no
// page reload) never momentarily sees the previous user's cached data (most
// importantly their per-user device sessions). Each cache-holding service registers
// its clear function when the module loads.
const clearers = new Set<() => void>();

export function registerClientCache(clear: () => void): void {
  clearers.add(clear);
}

export function clearAllClientCaches(): void {
  for (const clear of clearers) clear();
}
