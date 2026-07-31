import { describe, expect, it } from "vitest";

import { createTemplateSchema, updateTemplateSchema } from "./emailTemplate.validation.js";

// An email template's three content fields all have to survive an EDIT, not just a create. The
// update schema originally let `textContent` through with no minimum, so an ENABLED template could
// be saved with an empty body and the next customer email would go out blank — the branded HTML is
// generated FROM this text, so there is nothing to fall back on.
describe("updateTemplateSchema keeps a template sendable", () => {
  it.each([
    ["name", "Name can't be empty."],
    ["subject", "Subject can't be empty."],
    ["textContent", "Message can't be empty."],
  ])("rejects a blank %s", (field, message) => {
    const r = updateTemplateSchema.safeParse({ [field]: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message === message)).toBe(true);
  });

  // `min(1)` alone only catches the truly empty string, and "   " is not empty — it is just as
  // unsendable. The distinction matters because the frontend's own guard is `!message.trim()`, so the
  // only payload that can reach the API with a spaces-only body is one that skipped the editor; the
  // schema is the last line of defence, not a duplicate of the UI's.
  it.each([["   "], ["\t "], ["\n\n"]])("rejects a whitespace-only message (%j), not just an empty string", (blank) => {
    const r = updateTemplateSchema.safeParse({ textContent: blank });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message === "Message can't be empty.")).toBe(true);
  });

  // …but the check must be on the TRIMMED length only. The stored value stays byte-for-byte what the
  // author typed: leading blank lines are meaningful in a plain-text email, and trimming the field
  // would silently rewrite their message.
  it("keeps surrounding whitespace on a message that has real content", () => {
    const r = updateTemplateSchema.safeParse({ textContent: "\n\nHi {{name}}\n" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.textContent).toBe("\n\nHi {{name}}\n");
  });

  it("still allows a PARTIAL patch that mentions none of them", () => {
    expect(updateTemplateSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("accepts real content", () => {
    const r = updateTemplateSchema.safeParse({ name: "Welcome", subject: "Hello", textContent: "Hi {{name}}" });
    expect(r.success).toBe(true);
  });
});

// Pinned so the pair can't drift apart again — whichever schema is laxer is the one an empty template
// gets in through, and create has exactly the same blank-body consequence as update.
describe("createTemplateSchema requires all three", () => {
  it.each([["name"], ["subject"], ["textContent"]])("rejects a payload missing %s", (field) => {
    const full: Record<string, string> = { name: "Welcome", subject: "Hello", textContent: "Hi" };
    delete full[field];
    expect(createTemplateSchema.safeParse(full).success).toBe(false);
  });

  it("rejects a whitespace-only message, exactly like updateTemplateSchema", () => {
    expect(createTemplateSchema.safeParse({ name: "Welcome", subject: "Hello", textContent: "   " }).success).toBe(false);
  });
});
