import { describe, expect, it, vi } from "vitest";

// ── sharp is loaded LATE, and that is a deployment guarantee ──────────────────────────────────
//
// `sharp` is a native binary. When its prebuilt artifact does not match the host's platform,
// architecture or libc, importing it THROWS — and an import that throws while the module graph is
// still loading takes the whole process with it.
//
// derivatives.ts is reached from settings.service and user.service, both of which load during boot.
// So a top-level `import sharp from "sharp"` meant a bad binary stopped the backend from STARTING,
// for every install — including the Cloudinary-only ones, which never render a derivative and never
// needed sharp at all. The blast radius of a broken optional dependency was "nothing works".
//
// This file pins the fix as a property rather than a promise: importing the module must not reach
// sharp, and only an actual transformation may.
//
// It lives apart from derivatives.test.ts deliberately — that file imports sharp itself, to read the
// PNG bytes back, which would load it before this could observe anything.

const loads = vi.hoisted(() => ({ count: 0 }));

// The interception. A `vi.mock` factory runs when the module is FIRST imported, not when the mock
// is registered, so this counter is a faithful record of when sharp was actually reached. The real
// module is handed back afterwards, so the transformation below is the genuine one.
vi.mock("sharp", async () => {
  loads.count++;
  const actual = await vi.importActual<typeof import("sharp")>("sharp");
  return { default: actual.default };
});

/** A 1×1 red PNG, as the data URI the renderer takes. */
const RED_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("sharp is not loaded by importing the module", () => {
  it("stays unloaded through a full import of derivatives.ts", async () => {
    const mod = await import("./derivatives.js");

    // The module is genuinely loaded — its exports are here — and sharp still is not.
    expect(typeof mod.renderDerivative).toBe("function");
    expect(mod.DERIVATIVE_SPECS.pdf.maxHeight).toBe(400);
    expect(mod.DERIVATIVE_SPECS.email.maxHeight).toBe(80);
    expect(loads.count).toBe(0);
  });

  // Everything except the transformation itself must stay reachable without the native binary,
  // otherwise "lazy" would only have moved the crash somewhere else on the same boot path.
  it("stays unloaded while the pure helpers are used", async () => {
    const { derivativeKey } = await import("./derivatives.js");

    expect(derivativeKey("senthra/branding/logo", "pdf")).toBe("senthra/branding/logo__pdf.png");
    expect(derivativeKey("senthra/branding/logo", "email")).toBe("senthra/branding/logo__email.png");
    expect(loads.count).toBe(0);
  });

  it("stays unloaded when the source is rejected before any transformation", async () => {
    const { renderDerivative } = await import("./derivatives.js");

    await expect(renderDerivative("not-a-data-uri", "pdf")).rejects.toThrow(/base64 data URI/i);
    expect(loads.count).toBe(0);
  });
});

describe("sharp is loaded when a derivative is actually rendered", () => {
  it("loads it on the first render, and reuses it on the next", async () => {
    const { renderDerivative } = await import("./derivatives.js");
    expect(loads.count).toBe(0);

    const png = await renderDerivative(RED_DOT, "pdf");
    expect(loads.count).toBe(1);

    // The real encoder ran: a PNG signature, and the RGBA shape pdfkit needs (bit depth 8, colour
    // type 6) rather than the palette form that renders as scrambled blocks.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);

    // A second render must not re-import — the module cache holds it, so this stays one load.
    await renderDerivative(RED_DOT, "email");
    expect(loads.count).toBe(1);
  });
});
