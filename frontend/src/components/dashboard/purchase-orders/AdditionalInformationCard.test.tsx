// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { byText, cleanup, render } from "@/test/dom";

vi.mock("@/hooks/usePurchaseOrderSocket", () => ({ usePurchaseOrderSocket: () => {} }));

import { AdditionalInformationCard } from "./PurchaseOrderDetail";

afterEach(cleanup);

describe("AdditionalInformationCard (PO detail)", () => {
  it("shows each stored value under the label it was saved with", async () => {
    await render(
      <AdditionalInformationCard
        po={{
          customFields: [
            { fieldId: "a", label: "Cost centre", value: "CC-42", printOnPdf: true },
            // Not printed on the PDF — still part of the order's record, so still shown here.
            { fieldId: "b", label: "Internal ref", value: "IR-7", printOnPdf: false },
            { fieldId: "c", label: "Blank", value: "   ", printOnPdf: true },
          ],
        }}
      />,
    );
    expect(byText("Additional information")).not.toBeNull();
    expect(byText("Cost centre")).not.toBeNull();
    expect(byText("CC-42")).not.toBeNull();
    expect(byText("Internal ref")).not.toBeNull();
    expect(byText("IR-7")).not.toBeNull();
    expect(byText("Blank")).toBeNull();
  });

  it("renders nothing for an order without custom-field values", async () => {
    const empty = await render(<AdditionalInformationCard po={{ customFields: [] }} />);
    const legacy = await render(<AdditionalInformationCard po={{}} />);
    expect(empty.innerHTML).toBe("");
    expect(legacy.innerHTML).toBe("");
  });
});
