// Barcode label printing. Prints ONLY the label (image + code) via a hidden iframe sized to the
// physical sticker — not the whole page — so there's no A4 white space and no popup-blocker issue.
// The Code128 PNG already renders the human-readable code beneath the bars.

// 50×30mm thermal sticker stock. Adjust if your label stock differs.
const LABEL_W = "50mm";
const LABEL_H = "30mm";

// Upper bound on a single print job. Guards against a mistyped copy count (e.g. 99999) locking the
// browser up building the document. Callers validate against this and surface the cap themselves.
export const MAX_LABEL_COPIES = 500;

export interface BarcodeLabel {
  dataUri: string; // base64 PNG of the rendered barcode
  code: string; // human-readable value (used as the print title / alt)
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

// Print `copies` identical barcode labels as ONE print job (one sticker per physical unit).
// Copies is clamped to 1..MAX_LABEL_COPIES. Waits for the images to load before printing, then
// cleans up. Every label repeats the same image — the barcode encodes the item's permanent code,
// so all units of an item carry the same sticker.
export function printLabels(label: BarcodeLabel & { copies?: number }): void {
  if (!label.dataUri) return;
  const copies = Math.min(MAX_LABEL_COPIES, Math.max(1, Math.floor(label.copies ?? 1)));
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  const code = escapeHtml(label.code);
  const src = escapeHtml(label.dataUri);
  // Each label is its own page: a forced break after every sticker EXCEPT the last, so a 3-copy job
  // prints 3 stickers rather than 3 + a trailing blank.
  const labels = Array.from({ length: copies }, () => `<div class="l"><img src="${src}" alt="${code}"/></div>`).join("");
  doc.open();
  // @page margin:0 removes the browser's auto date/title/URL/page-number header & footer
  // (they're only drawn in the page margin), so the label prints clean. The quiet-zone
  // padding lives on each label instead.
  doc.write(
    `<!doctype html><html><head><title>${code}</title>` +
      `<style>@page{size:${LABEL_W} ${LABEL_H};margin:0}html,body{margin:0;padding:0}` +
      `.l{display:flex;align-items:center;justify-content:center;width:${LABEL_W};height:${LABEL_H};` +
      `padding:2mm;box-sizing:border-box;break-after:page;page-break-after:always}` +
      `.l:last-child{break-after:auto;page-break-after:auto}` +
      `img{width:100%;height:auto;max-height:calc(${LABEL_H} - 4mm);object-fit:contain}</style></head>` +
      `<body>${labels}</body></html>`,
  );
  doc.close();
  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    return;
  }
  const run = () => {
    win.focus();
    win.print();
    setTimeout(() => iframe.remove(), 500);
  };
  // Every copy shares one src (fetched once), but wait for them all to settle before printing so no
  // sticker prints blank. onerror still counts — a broken image must not hang the job forever.
  const imgs = Array.from(doc.querySelectorAll("img"));
  const pending = imgs.filter((img) => !img.complete);
  if (pending.length === 0) {
    run();
    return;
  }
  let left = pending.length;
  const settle = () => {
    left -= 1;
    if (left === 0) run();
  };
  for (const img of pending) {
    img.onload = settle;
    img.onerror = settle;
  }
}

// Print a SINGLE barcode label.
export function printSingleLabel(label: BarcodeLabel): void {
  printLabels({ ...label, copies: 1 });
}
