// Trigger a browser download for an in-memory Blob (e.g. a CSV export). Creates a
// temporary object URL + anchor, clicks it, then revokes the URL.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has initiated the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Pull the filename out of a Content-Disposition header, falling back to a default.
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="?([^"]+)"?/.exec(header);
  return match?.[1] ?? fallback;
}
