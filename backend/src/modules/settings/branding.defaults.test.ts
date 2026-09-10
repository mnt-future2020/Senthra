import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BRAND_NAME,
  DEFAULT_LOGIN_HEADLINE,
  DEFAULT_LOGIN_SUBTEXT,
  defaultFooterText,
  resolveBrandName,
  resolveFooterText,
  resolveLoginHeadline,
  resolveLoginSubtext,
  storedFooterText,
  storedLoginHeadline,
  storedLoginSubtext,
} from "./branding.defaults.js";

// The retired subtext, verbatim. Rows saved while it was the default hold exactly this string.
const RETIRED_SUBTEXT = "Sign in to access your admin dashboard and run everything from one place.";

describe("login copy defaults", () => {
  it("never says 'admin' — the login screen serves every staff role and every customer", () => {
    expect(DEFAULT_LOGIN_SUBTEXT).not.toMatch(/admin/i);
    expect(DEFAULT_LOGIN_HEADLINE).not.toMatch(/admin/i);
  });
});

describe("resolveLoginSubtext (stored → shown)", () => {
  it("falls back to the default when nothing is stored", () => {
    expect(resolveLoginSubtext(null)).toBe(DEFAULT_LOGIN_SUBTEXT);
    expect(resolveLoginSubtext(undefined)).toBe(DEFAULT_LOGIN_SUBTEXT);
    expect(resolveLoginSubtext("   ")).toBe(DEFAULT_LOGIN_SUBTEXT);
  });

  // The regression: an install that saved branding while the old default was current has it frozen
  // in its Settings row. It must pick up the new default without a data migration.
  it("treats a frozen retired default as unset", () => {
    expect(resolveLoginSubtext(RETIRED_SUBTEXT)).toBe(DEFAULT_LOGIN_SUBTEXT);
  });

  it("keeps genuinely custom copy untouched", () => {
    expect(resolveLoginSubtext("Welcome to the Electra portal.")).toBe("Welcome to the Electra portal.");
  });
});

describe("storedLoginSubtext (submitted → stored)", () => {
  it("stores null for blank input, so the default applies", () => {
    expect(storedLoginSubtext("")).toBeNull();
    expect(storedLoginSubtext("  ")).toBeNull();
  });

  // The form posts the effective value back on every save; storing it would re-freeze it.
  it("stores null when the form echoes the current default back", () => {
    expect(storedLoginSubtext(DEFAULT_LOGIN_SUBTEXT)).toBeNull();
    expect(storedLoginSubtext(`  ${DEFAULT_LOGIN_SUBTEXT}  `)).toBeNull();
  });

  it("stores null for a retired default too", () => {
    expect(storedLoginSubtext(RETIRED_SUBTEXT)).toBeNull();
  });

  it("stores custom copy trimmed", () => {
    expect(storedLoginSubtext("  Welcome back.  ")).toBe("Welcome back.");
  });
});

describe("login headline follows the same contract", () => {
  it("resolves blank to the default and keeps custom copy", () => {
    expect(resolveLoginHeadline(null)).toBe(DEFAULT_LOGIN_HEADLINE);
    expect(resolveLoginHeadline("Run the depot.")).toBe("Run the depot.");
  });

  it("does not freeze the default when it is echoed back", () => {
    expect(storedLoginHeadline(DEFAULT_LOGIN_HEADLINE)).toBeNull();
    expect(storedLoginHeadline("Run the depot.")).toBe("Run the depot.");
  });
});

describe("resolveBrandName", () => {
  it("falls back to the install default when blank, and trims a set name", () => {
    expect(resolveBrandName(null)).toBe(DEFAULT_BRAND_NAME);
    expect(resolveBrandName("   ")).toBe(DEFAULT_BRAND_NAME);
    expect(resolveBrandName(" Electra ")).toBe("Electra");
  });
});

describe("footer text", () => {
  // Pinned to a year AFTER the one these rows were frozen in, so a stale year is visible.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-01T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the default with the current year and brand", () => {
    expect(defaultFooterText("Electra")).toBe("© 2027 Electra. All rights reserved.");
    expect(resolveFooterText(null, "Electra")).toBe("© 2027 Electra. All rights reserved.");
    expect(resolveFooterText("  ", "Electra")).toBe("© 2027 Electra. All rights reserved.");
  });

  // The January bug: a footer frozen in 2026 must not still say 2026 in 2027.
  it("rolls a frozen default forward to the current year", () => {
    expect(resolveFooterText("© 2026 Senthra. All rights reserved.", "Senthra")).toBe(
      "© 2027 Senthra. All rights reserved.",
    );
  });

  // The rebrand bug: rows frozen before a rename carry the install default name.
  it("never shows the install default name under a client's own brand", () => {
    expect(resolveFooterText("© 2026 Senthra. All rights reserved.", "Electra")).toBe(
      "© 2027 Electra. All rights reserved.",
    );
  });

  it("keeps a custom footer exactly as typed", () => {
    const custom = "Electra Networks Ltd · Registered in England 01234567";
    expect(resolveFooterText(custom, "Electra")).toBe(custom);
  });

  // Only BRAND names are recognised. A legal-name footer has the default's shape but is deliberate.
  it("keeps a default-shaped footer that names someone other than the brand", () => {
    const legal = "© 2024 Electra Networks Limited. All rights reserved.";
    expect(resolveFooterText(legal, "Electra")).toBe(legal);
    expect(storedFooterText(legal, ["Electra"])).toBe(legal);
  });

  it("recognises the default for a brand name that itself ends in a full stop", () => {
    expect(resolveFooterText("© 2026 Acme Inc.. All rights reserved.", "Acme Inc.")).toBe(
      "© 2027 Acme Inc.. All rights reserved.",
    );
  });

  describe("storedFooterText (submitted → stored)", () => {
    it("stores null for blank input and for the echoed default", () => {
      expect(storedFooterText("", ["Electra"])).toBeNull();
      expect(storedFooterText(" © 2027 Electra. All rights reserved. ", ["Electra"])).toBeNull();
    });

    // The form may have been loaded before New Year, or be echoing a row frozen long ago.
    it("stores null for a default with a stale year", () => {
      expect(storedFooterText("© 2025 Electra. All rights reserved.", ["Electra"])).toBeNull();
    });

    it("stores null for the footer rendered under the previous brand during a rename", () => {
      expect(storedFooterText("© 2027 Northwind. All rights reserved.", ["Northwind", "Electra"])).toBeNull();
      expect(storedFooterText("© 2027 Senthra. All rights reserved.", ["Electra"])).toBeNull();
    });

    it("stores custom text trimmed", () => {
      expect(storedFooterText("  Electra Group plc  ", ["Electra"])).toBe("Electra Group plc");
    });
  });
});
