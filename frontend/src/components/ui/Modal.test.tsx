// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, click, render, wait } from "@/test/dom";

import { Modal } from "./Modal";

// ── Modal ─────────────────────────────────────────────────────────────────────────────────────
//
// Two groups, and the split is the point.
//
// WITHOUT `busy`, Modal must behave exactly as it always has. Every existing caller omits it, so
// anything that changes here changes every dialog in the app.
//
// WITH `busy`, every way out is locked: Escape, the backdrop and the header X. That is what
// ConfirmDialog has always done for its own action, and what callers here approximated with
// `onClose={busy ? () => {} : onClose}` — which silenced the close but left the header X looking
// perfectly clickable, beside a footer button that was visibly disabled. Clicking it did nothing,
// with nothing to say why.

afterEach(cleanup);

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const headerClose = () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
/** The dimmed overlay the panel sits in — a click on it, outside the panel, dismisses. */
const backdrop = () => dialog()!.parentElement!;
const pressEscape = async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait();
};

describe("without busy — exactly as before", () => {
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    await render(<Modal open title="Title" onClose={onClose}>Body</Modal>);

    await pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the header X", async () => {
    const onClose = vi.fn();
    await render(<Modal open title="Title" onClose={onClose}>Body</Modal>);

    expect(headerClose().disabled).toBe(false);
    await click(headerClose());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click", async () => {
    const onClose = vi.fn();
    await render(<Modal open title="Title" onClose={onClose}>Body</Modal>);

    await click(backdrop());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a click inside the panel", async () => {
    const onClose = vi.fn();
    await render(<Modal open title="Title" onClose={onClose}>Body</Modal>);

    await click(dialog());

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("while busy — every way out is locked", () => {
  it("disables the header X, so it no longer looks clickable", async () => {
    await render(<Modal open busy title="Title" onClose={vi.fn()}>Body</Modal>);

    expect(headerClose().disabled).toBe(true);
  });

  it("ignores Escape", async () => {
    const onClose = vi.fn();
    await render(<Modal open busy title="Title" onClose={onClose}>Body</Modal>);

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });

  it("ignores a backdrop click", async () => {
    const onClose = vi.fn();
    await render(<Modal open busy title="Title" onClose={onClose}>Body</Modal>);

    await click(backdrop());

    expect(onClose).not.toHaveBeenCalled();
  });

  // `busy` is read LIVE by the Escape listener, not captured when the dialog opened — otherwise a
  // dialog that opened busy would ignore Escape for ever, and one that opened idle would never lock.
  it("closes normally again once the work has finished", async () => {
    const onClose = vi.fn();
    function Harness() {
      const [busy, setBusy] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setBusy(false)}>
            finish
          </button>
          <Modal open busy={busy} title="Title" onClose={onClose}>
            Body
          </Modal>
        </>
      );
    }
    await render(<Harness />);

    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();

    await click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "finish"));
    await pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
