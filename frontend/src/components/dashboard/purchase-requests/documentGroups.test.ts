import { describe, expect, it } from "vitest";

import { DOCUMENT_GROUPS, documentChipLabel, filesInGroup, removeDocument } from "./documentGroups";

type Doc = { _key: string; documentType: "quote" | "other"; name: string };

const DOCS: Doc[] = [
  { _key: "k1", documentType: "quote", name: "quote.pdf" },
  { _key: "k2", documentType: "other", name: "spec.pdf" },
  { _key: "k3", documentType: "quote", name: "quote-rev2.pdf" },
  { _key: "k4", documentType: "other", name: "comparison.xlsx" },
];

describe("DOCUMENT_GROUPS", () => {
  it("names exactly the two groups the server persists", () => {
    expect(DOCUMENT_GROUPS.map((g) => g.type)).toEqual(["quote", "other"]);
  });

  // The two groups are told apart by their WORDS. A screen-reader user gets the label and nothing
  // else — no position, no colour — so two groups sharing a label would be two groups they cannot
  // distinguish at all.
  it("gives every group a distinct label, help text and empty state", () => {
    for (const key of ["formLabel", "detailLabel", "help", "emptyText"] as const) {
      const values = DOCUMENT_GROUPS.map((g) => g[key]);
      expect(new Set(values).size, key).toBe(values.length);
      expect(values.every((v) => v.trim().length > 0), key).toBe(true);
    }
  });
});

describe("filesInGroup", () => {
  it("returns only that group, in the order they were added", () => {
    expect(filesInGroup(DOCS, "quote").map((d) => d.name)).toEqual(["quote.pdf", "quote-rev2.pdf"]);
    expect(filesInGroup(DOCS, "other").map((d) => d.name)).toEqual(["spec.pdf", "comparison.xlsx"]);
  });

  // A group with nothing in it renders its own empty state, not the other group's list.
  it("is empty for a group with no documents", () => {
    expect(filesInGroup([DOCS[0]], "other")).toEqual([]);
  });

  it("never puts one document in both groups", () => {
    const partitioned = [...filesInGroup(DOCS, "quote"), ...filesInGroup(DOCS, "other")];
    expect(partitioned).toHaveLength(DOCS.length);
    expect(new Set(partitioned.map((d) => d._key)).size).toBe(DOCS.length);
  });
});

describe("removeDocument", () => {
  // THE property the two sections exist to have. Removing a quote file must not disturb the
  // supporting documents, and vice versa — the client asked for this explicitly, and it is the one
  // thing an index-based removal would break while still looking correct on screen.
  it("removing a quote document leaves every other document untouched", () => {
    const after = removeDocument(DOCS, "k1");
    expect(after.map((d) => d._key)).toEqual(["k2", "k3", "k4"]);
    expect(filesInGroup(after, "other")).toEqual(filesInGroup(DOCS, "other"));
  });

  it("removing an other document leaves every quote document untouched", () => {
    const after = removeDocument(DOCS, "k2");
    expect(after.map((d) => d._key)).toEqual(["k1", "k3", "k4"]);
    expect(filesInGroup(after, "quote")).toEqual(filesInGroup(DOCS, "quote"));
  });

  it("emptying one group entirely leaves the other whole", () => {
    const after = removeDocument(removeDocument(DOCS, "k1"), "k3");
    expect(filesInGroup(after, "quote")).toEqual([]);
    expect(filesInGroup(after, "other").map((d) => d.name)).toEqual(["spec.pdf", "comparison.xlsx"]);
  });

  it("does not mutate the list it was given", () => {
    const before = [...DOCS];
    removeDocument(DOCS, "k1");
    expect(DOCS).toEqual(before);
  });

  it("is a no-op for a key that is not there", () => {
    expect(removeDocument(DOCS, "nope")).toEqual(DOCS);
  });
});

/**
 * The purchase ORDER shows the same two groups, carried over when a request was converted — but as a
 * tag on each file rather than as a section, because a PO's own uploads have no group at all and a
 * section per group would leave them homeless.
 *
 * A tag needs a singular noun ("Supporting document"), a heading needs the plural ("Other
 * documents"). Both live in the one table here so the two screens cannot end up calling the same
 * stored value different things — which is exactly what happened when the order screen spelled its
 * own chip text inline.
 */
describe("documentChipLabel", () => {
  it("tags a carried-over quote as the quotation", () => {
    expect(documentChipLabel("quote")).toBe("Quotation");
  });

  it("tags the other group in the singular, as a tag on one file", () => {
    expect(documentChipLabel("other")).toBe("Supporting document");
  });

  /**
   * NULL is not "quote" here, and this is the one place the purchase order deliberately reads the
   * column differently from the request. On a REQUEST an absent group means quote — every row
   * predating the second group came out of a field labelled "Quote document(s)". On an ORDER it
   * means uncategorised, because an order's own uploads never had a group picker. Labelling those
   * would assert something nobody chose.
   */
  it("leaves an order's own upload untagged rather than guessing a group", () => {
    expect(documentChipLabel(null)).toBeNull();
    expect(documentChipLabel(undefined)).toBeNull();
    expect(documentChipLabel("something-else")).toBeNull();
  });
});
