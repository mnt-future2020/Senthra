// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, wait } from "@/test/dom";
import type { AppearanceProps } from "./types";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  params: new URLSearchParams(),
  brandingCard: vi.fn(() => null),
  fieldsCard: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => h.params }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ admin: null, can: (p: string) => h.perms.has(p) }) }));
vi.mock("@/providers/NavigationGuardProvider", () => ({ useNavigationGuard: () => ({ attemptLeave: (fn: () => void) => fn() }) }));
vi.mock("./purchase-orders/PoDocumentBrandingCard", () => ({ PoDocumentBrandingCard: h.brandingCard }));
vi.mock("./purchase-orders/PoCustomFieldsCard", () => ({ PoCustomFieldsCard: h.fieldsCard }));

import { SettingsPanel } from "./SettingsPanel";

const navButton = (label: string) =>
  Array.from(document.querySelectorAll("nav button")).find((b) => b.textContent?.includes(label));

beforeEach(() => {
  h.perms = new Set(["settings.view"]);
  h.params = new URLSearchParams("section=purchase-orders");
  h.brandingCard.mockClear();
  h.fieldsCard.mockClear();
});
afterEach(cleanup);

describe("Settings → Purchase Orders", () => {
  it("is a Settings section for anyone who can view settings, holding both PO cards", async () => {
    await render(<SettingsPanel {...({} as AppearanceProps)} />);
    await wait();
    expect(navButton("Purchase Orders")).toBeDefined();
    expect(h.brandingCard).toHaveBeenCalled();
    expect(h.fieldsCard).toHaveBeenCalled();
  });

  it("is not offered without settings.view", async () => {
    h.perms = new Set(["purchase_orders.view", "purchase_orders.create"]);
    await render(<SettingsPanel {...({} as AppearanceProps)} />);
    await wait();
    expect(navButton("Purchase Orders")).toBeUndefined();
    expect(h.brandingCard).not.toHaveBeenCalled();
  });
});
