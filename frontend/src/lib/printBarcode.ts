// Barcode label printing. Prints ONLY the label (image + code) via a hidden iframe sized to the
// physical sticker — not the whole page — so there's no A4 white space and no popup-blocker issue.
// The Code128 PNG already renders the human-readable code beneath the bars.

// 50×30mm thermal sticker stock. Adjust if your label stock differs.
const LABEL_W = "50mm";
const LABEL_H = "30mm";

export interface BarcodeLabel {
  dataUri: string; // base64 PNG of the rendered barcode
  code: string; // human-readable value (used as the print title / alt)
}

// Print a SINGLE barcode label. Waits for the image to load before printing, then cleans up.
export function printSingleLabel(label: BarcodeLabel): void {
  if (!label.dataUri) return;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  // @page margin:0 removes the browser's auto date/title/URL/page-number header & footer
  // (they're only drawn in the page margin), so the label prints clean. The quiet-zone
  // padding lives on the body instead.
  doc.write(
    `<!doctype html><html><head><title>${label.code}</title>` +
      `<style>@page{size:${LABEL_W} ${LABEL_H};margin:0}html,body{margin:0;padding:0}` +
      `body{display:flex;align-items:center;justify-content:center;min-height:${LABEL_H};padding:2mm;box-sizing:border-box}` +
      `img{width:100%;height:auto;max-height:calc(${LABEL_H} - 4mm);object-fit:contain}</style></head>` +
      `<body><img src="${label.dataUri}" alt="${label.code}"/></body></html>`,
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
  const img = doc.querySelector("img");
  if (img && !img.complete) {
    img.onload = run;
    img.onerror = run;
  } else {
    run();
  }
}
