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

/**
 * Preview a picked-but-not-yet-uploaded File in a new tab.
 *
 * Goes via a blob: URL because a File already IS a Blob — no decode, no copy. The pair of helpers
 * this replaced took a base64 `data:` URI and parsed it back into bytes, which was only ever needed
 * because the forms held their staged files as base64 strings. They upload the File directly now, so
 * there is no string to parse: the same preview costs a pointer instead of 1.33× the file.
 *
 * A blob: URL rather than the File's own bytes inline: Chrome blocks a top-level navigation straight
 * to a `data:` URL, so the old path opened a blank tab for PDFs. blob: opens reliably.
 */
export function viewFileInNewTab(file: File): boolean {
  const url = URL.createObjectURL(file);
  window.open(url, "_blank", "noopener,noreferrer");
  // Revoked on a delay rather than immediately: the new tab has to fetch it first, and revoking
  // before it does leaves the user with a blank viewer.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
