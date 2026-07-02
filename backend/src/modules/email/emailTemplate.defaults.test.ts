import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMAIL_TEMPLATES,
  findDefaultTemplate,
  requiredVariablesFor,
} from "./emailTemplate.defaults.js";

// Pure guards over the built-in email templates. These protect the invariants the template
// editor + send path rely on — no DB, no mocks.

describe("findDefaultTemplate", () => {
  it("returns the matching built-in template by key", () => {
    const t = findDefaultTemplate("user.created");
    expect(t).toBeDefined();
    expect(t?.key).toBe("user.created");
  });

  it("returns undefined for an unknown key", () => {
    expect(findDefaultTemplate("does.not.exist")).toBeUndefined();
  });
});

describe("requiredVariablesFor", () => {
  it("returns the template's required variables", () => {
    expect(requiredVariablesFor("user.created")).toEqual(["email", "temporaryPassword"]);
  });

  it("returns an empty array for an unknown key", () => {
    expect(requiredVariablesFor("does.not.exist")).toEqual([]);
  });
});

describe("DEFAULT_EMAIL_TEMPLATES invariants", () => {
  it("has unique template keys", () => {
    const keys = DEFAULT_EMAIL_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares every required variable within the offered variables list", () => {
    for (const t of DEFAULT_EMAIL_TEMPLATES) {
      for (const req of t.requiredVariables) {
        expect(t.variables, `${t.key} requiredVariable "${req}" not in variables`).toContain(req);
      }
    }
  });

  it("keeps every required token present in the default subject or body", () => {
    // The editor rejects an edit that drops a required token; the shipped defaults must
    // themselves satisfy that rule, else a system template would be un-saveable as-is.
    for (const t of DEFAULT_EMAIL_TEMPLATES) {
      const haystack = `${t.subject}\n${t.body}`;
      for (const req of t.requiredVariables) {
        expect(haystack, `${t.key} is missing required token {{${req}}}`).toContain(`{{${req}}}`);
      }
    }
  });
});
