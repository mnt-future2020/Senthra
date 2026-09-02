import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSignedOutNotice, takeSignedOutNotice } from "./signedOutNotice";

// The suite runs in Node (no jsdom in this project), so stand up the minimum of the Storage API
// this module uses. `throws` flips it into the private-mode browser behaviour, where every access
// raises instead of returning null.
function stubStorage(opts: { throws?: boolean } = {}) {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => {
        if (opts.throws) throw new Error("denied");
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.throws) throw new Error("denied");
        map.set(k, v);
      },
      removeItem: (k: string) => {
        if (opts.throws) throw new Error("denied");
        map.delete(k);
      },
    },
  });
}

beforeEach(() => stubStorage());
afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("signed-out notice", () => {
  it("explains the one-device cap in the user's own terms, not the server's enum", () => {
    setSignedOutNotice("signed_in_elsewhere");
    const notice = takeSignedOutNotice();
    expect(notice?.title).toBe("Signed out on this device");
    expect(notice?.body).toContain("Only one device");
    expect(JSON.stringify(notice)).not.toContain("signed_in_elsewhere");
  });

  it("leads with what happened and keeps the why in the second line", () => {
    // The banner sits above the email field on a screen someone is trying to get past. A title
    // short enough to read at a glance is the difference between it being read and skipped.
    for (const reason of ["signed_in_elsewhere", "signed_out_remotely", "anything_else"]) {
      setSignedOutNotice(reason);
      const notice = takeSignedOutNotice();
      expect(notice?.title.length).toBeLessThanOrEqual(30);
      expect(notice?.body).toBeTruthy();
    }
  });

  it("is consumed by the read, so a refresh of /login doesn't repeat the accusation", () => {
    setSignedOutNotice("signed_in_elsewhere");
    expect(takeSignedOutNotice()).not.toBeNull();
    expect(takeSignedOutNotice()).toBeNull();
  });

  it("says nothing when the user simply opened the login page", () => {
    expect(takeSignedOutNotice()).toBeNull();
  });

  it("falls back to a generic line for a reason this build has never heard of", () => {
    // A newer server may send a reason added after this bundle shipped. Signing the user out is not
    // optional, so an unknown reason must degrade to plain copy — never render the raw value.
    setSignedOutNotice("some_future_reason");
    expect(takeSignedOutNotice()).toEqual({
      title: "Signed out",
      body: "Sign in again to continue.",
    });
  });

  it("survives storage being unavailable instead of throwing into the sign-out path", () => {
    // Private-mode browsers throw on sessionStorage access. The sign-out itself must still happen;
    // only the explanation is lost. A throw here would abort the redirect and strand the user on a
    // dead screen — the exact failure this mechanism exists to prevent.
    stubStorage({ throws: true });

    expect(() => setSignedOutNotice("signed_in_elsewhere")).not.toThrow();
    expect(takeSignedOutNotice()).toBeNull();
  });
});
