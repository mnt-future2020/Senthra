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

// Decode a base64 `data:` URI (e.g. from FileReader.readAsDataURL) into a Blob. Returns null for a
// non-data URI. Used to preview a client-side file before it has been uploaded anywhere.
export function dataUriToBlob(dataUri: string): Blob | null {
  // `[\s\S]` (not `.` + the /s flag) so the payload match spans any newlines without needing
  // the ES2018 dotAll flag, which the project's TS target predates.
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUri);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

// Open an in-memory file (a data URI) in a new browser tab for preview. Goes via a blob: URL —
// modern browsers (Chrome) block a top-level navigation straight to a data: URL, so
// `window.open(dataUri)` silently fails for PDFs; a blob: URL opens reliably. The URL is revoked
// after a delay so the new tab has time to load it. Returns false if the URI couldn't be decoded.
export function viewDataUriInNewTab(dataUri: string): boolean {
  const blob = dataUriToBlob(dataUri);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
