import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_BYTES, shrinkImage } from "./image";

// `shrinkImage` runs on the way to Cloudinary for every picture the app uploads, and its failures
// are the quiet kind: a file that still works but is no longer what the user picked. These cover the
// cases where NOT touching the file is the correct answer, plus the promise the pickers rely on —
// that it degrades to the original rather than throwing and blocking an upload.

const fileOf = (name: string, type: string, bytes = 4096) =>
  new File([new Uint8Array(bytes)], name, { type });

describe("shrinkImage", () => {
  // The pickers now route documents through this too, because uploadDirect is the single choke
  // point every direct upload passes through. Re-encoding a PDF through a canvas would destroy it.
  it("returns a PDF untouched", async () => {
    const pdf = fileOf("quote.pdf", "application/pdf");
    expect(await shrinkImage(pdf)).toBe(pdf);
  });

  it("returns a DOCX untouched", async () => {
    const docx = fileOf("spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await shrinkImage(docx)).toBe(docx);
  });

  // A GIF may be animated, and a canvas holds ONE frame. Re-encoding would succeed, look right in
  // the thumbnail, and have silently discarded every frame after the first.
  it("returns an animated-capable GIF untouched", async () => {
    const gif = fileOf("damage.gif", "image/gif");
    expect(await shrinkImage(gif)).toBe(gif);
  });

  // Rasterising an SVG loses the one property it was chosen for. Branding accepts it.
  it("returns an SVG untouched", async () => {
    const svg = fileOf("logo.svg", "image/svg+xml");
    expect(await shrinkImage(svg)).toBe(svg);
  });

  // A favicon is a container of sizes, not a picture. Both media types are accepted by branding,
  // because Windows and everyone else disagree on its name — so both must be skipped.
  it.each(["image/x-icon", "image/vnd.microsoft.icon"])("returns an ICO (%s) untouched", async (type) => {
    const ico = fileOf("favicon.ico", type);
    expect(await shrinkImage(ico)).toBe(ico);
  });

  // The contract every picker depends on. With no browser APIs present, an image lands in the catch —
  // which is precisely the production failure mode (a format the browser will not decode, a canvas
  // the device refuses to allocate). Blocking the upload there would be worse than not shrinking:
  // an engineer in a warehouse needs the photo to go. The server's cap is the backstop.
  it("falls back to the original file when the browser cannot decode it", async () => {
    const photo = fileOf("damage.jpg", "image/jpeg", 5 * 1024 * 1024);
    const out = await shrinkImage(photo);
    expect(out).toBe(photo);
  });

  it("never rejects, whatever the image", async () => {
    await expect(shrinkImage(fileOf("x.png", "image/png"))).resolves.toBeInstanceOf(File);
  });

  // A file with no media type at all — some machines report "" for a .docx. Nothing claims to be an
  // image, so nothing is re-encoded.
  it("returns a file with an unknown media type untouched", async () => {
    const unknown = fileOf("mystery.docx", "");
    expect(await shrinkImage(unknown)).toBe(unknown);
  });
});

describe("MAX_IMAGE_BYTES", () => {
  // Checked AFTER shrinking, never before — the pickers were rejecting phone photos on their
  // original size while what they would actually store was a fraction of it.
  it("is 2 MB", () => {
    expect(MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024);
  });
});

// The downscale path needs a browser. The suite runs in Node with no DOM environment installed, so
// rather than pull one in for one file, stub the three APIs shrinkImage actually touches — an object
// URL, an <img> that loads, and a canvas that encodes — and assert the DECISIONS it makes: which
// encoding is chosen, and whether the result is kept at all.
describe("shrinkImage, with a working canvas", () => {
  function stubCanvas(opts: { width: number; height: number; outBytes: number }) {
    const drawn: { type?: string; quality?: number } = {};
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = opts.width;
      naturalHeight = opts.height;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", {
      createElement: (tag: string) => {
        if (tag !== "canvas") throw new Error(`unexpected ${tag}`);
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => {} }),
          toBlob: (cb: (b: Blob | null) => void, type: string, quality?: number) => {
            drawn.type = type;
            drawn.quality = quality;
            cb(new Blob([new Uint8Array(opts.outBytes)], { type }));
          },
        };
      },
    });
    return drawn;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A signature is a transparent PNG printed onto the purchase-order PDF. JPEG has no transparency,
  // so re-encoding one fills the background with WHITE and prints a white box onto the document.
  it("keeps a PNG as PNG, so transparency survives", async () => {
    const drawn = stubCanvas({ width: 4000, height: 3000, outBytes: 1000 });
    const out = await shrinkImage(fileOf("signature.png", "image/png", 900_000));
    expect(drawn.type).toBe("image/png");
    // Quality is meaningless for a lossless encoding, and passing one would imply otherwise.
    expect(drawn.quality).toBeUndefined();
    expect(out.name).toBe("signature.png");
  });

  it("keeps a WEBP as PNG rather than flattening its alpha", async () => {
    const drawn = stubCanvas({ width: 4000, height: 3000, outBytes: 1000 });
    await shrinkImage(fileOf("shot.webp", "image/webp", 900_000));
    expect(drawn.type).toBe("image/png");
  });

  // A photograph has no alpha to protect, and JPEG is where the saving is.
  it("re-encodes a photo as JPEG and renames it to match", async () => {
    const drawn = stubCanvas({ width: 4032, height: 3024, outBytes: 300_000 });
    const out = await shrinkImage(fileOf("IMG_0421.jpeg", "image/jpeg", 8 * 1024 * 1024));
    expect(drawn.type).toBe("image/jpeg");
    expect(drawn.quality).toBeCloseTo(0.85);
    // The extension has to follow the bytes: mediaTypeFor reads it at BOTH ends of the upload, and
    // finalize rejects a media type whose resource type disagrees with the signature's.
    expect(out.name).toBe("IMG_0421.jpg");
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(300_000);
  });

  // Dimension, not byte count, decides. A 1.8 MB 6000px photo passes every size rule and then costs
  // the viewer a 6000px download on every page that renders it.
  it("leaves an image that is already small enough alone", async () => {
    stubCanvas({ width: 800, height: 600, outBytes: 10 });
    const small = fileOf("avatar.png", "image/png", 40_000);
    expect(await shrinkImage(small)).toBe(small);
  });

  // A flat-colour PNG screenshot is the usual case: PNG's own compression already beats a canvas
  // round trip. Keeping whichever is smaller means this can never make an upload worse.
  it("keeps the original when re-encoding would make it bigger", async () => {
    stubCanvas({ width: 4000, height: 3000, outBytes: 500_000 });
    const original = fileOf("screenshot.png", "image/png", 200_000);
    expect(await shrinkImage(original)).toBe(original);
  });
});
