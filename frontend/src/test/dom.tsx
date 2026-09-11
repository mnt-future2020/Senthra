import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Minimal DOM-test helpers for the few tests that must exercise real browser behaviour (clicks,
// portals, label activation). Opt a file in with `// @vitest-environment jsdom`.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

export async function render(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mounted.push({ root, container });
  return container;
}

export async function cleanup(): Promise<void> {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.replaceChildren();
}

/** A real `click()` — so the browser's own activation behaviour (a wrapping <label>) runs too. */
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("click: element not found");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Choose an option on a native <select> (the Select stub below). */
export async function choose(el: Element | null | undefined, value: string): Promise<void> {
  if (!(el instanceof HTMLSelectElement)) throw new Error("choose: not a <select>");
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Let timers (debounces) and settled promises run inside act. */
export async function wait(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

export const byLabel = (label: string): HTMLElement | null => document.querySelector(`[aria-label="${label}"]`);

/** The innermost element whose own text is exactly `text`. */
export function byText(text: string): HTMLElement | null {
  const all = Array.from(document.body.querySelectorAll<HTMLElement>("*")).filter((e) => e.textContent?.trim() === text);
  return all.find((e) => !all.some((o) => o !== e && e.contains(o))) ?? null;
}

type StubOption = { value: string; label: string };

/** A native <select> standing in for the Base UI `Select`, whose popup is portalled and animated. */
export function SelectStub({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: StubOption[];
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
