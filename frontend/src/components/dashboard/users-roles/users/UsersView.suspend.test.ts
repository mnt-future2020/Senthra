import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Suspend must ask, activate must not, and neither may fire twice ────────────────────────────
//
// Suspending is the only status toggle in the product that acts on a PERSON: on their next request
// they are signed out of an application they were using, with no explanation, and only another staff
// member can undo it. It sits one row under Edit in a 176px menu.
//
// Read rather than rendered, for the reason set out at length in
// rentals/RentalItemsView.actions.test.ts: this suite runs in Node, jsdom is opt-in per file, and
// neither @testing-library/react nor jsdom is installed. Adding a component-testing stack to assert
// which handler a menu item calls is a larger change than the feature it would be testing. Each
// assertion below names a specific way an ordinary edit could put the old one-click suspend back.

const SRC = readFileSync(
  join(process.cwd(), "src", "components", "dashboard", "users-roles", "users", "UsersView.tsx"),
  "utf8",
);

/** Comments blanked, not removed — the prose above the code discusses these same call shapes by
 *  name and must not be what satisfies an assertion. Byte offsets are preserved. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(
  /\/\/[^\n]*/g,
  (m) => " ".repeat(m.length),
);

describe("UsersView — suspend confirmation", () => {
  it("routes an active user through the dialog instead of mutating", () => {
    // The menu still calls toggleStatus; toggleStatus is what changed. If this branch is removed the
    // click falls through to applyStatus and the confirmation is gone with no other visible change.
    expect(code).toMatch(/const toggleStatus = \(user: DirectoryUser\) => \{/);
    expect(code).toMatch(/if \(user\.status === "active"\) \{\s*setSuspendConfirm\(\{ open: true, user \}\);/);
  });

  it("keeps ACTIVATING immediate — a confirmation on the recovery path is confirm fatigue", () => {
    expect(code).toContain('void applyStatus(user, "active");');
  });

  it("mutates from exactly one place, reached only by the dialog's confirm", () => {
    // setUserStatus must not be reachable from the menu handler directly.
    const calls = [...code.matchAll(/userService\.setUserStatus\(/g)];
    expect(calls.length).toBe(1);
    expect(code).toMatch(/const applyStatus = async \(user: DirectoryUser, next: UserStatus\) => \{/);
    expect(code).toContain("onConfirm={doSuspend}");
  });

  it("cannot double-submit", () => {
    // Two independent guards: the re-entrancy check and the dialog's own disabled state.
    expect(code).toMatch(/if \(!suspendConfirm\.user \|\| suspending\) return;/);
    expect(code).toContain("busy={suspending}");
    expect(code).toMatch(/setSuspending\(true\);[\s\S]*?finally \{\s*setSuspending\(false\);/);
  });

  it("dismissal closes and nothing else", () => {
    // Escape and backdrop both route to onClose. If this ever called doSuspend, pressing Escape
    // would perform the action it was pressed to avoid.
    expect(code).toContain("onClose={() => setSuspendConfirm({ open: false, user: null })}");
    expect(code).not.toMatch(/onClose=\{[^}]*doSuspend/);
  });

  it("leaves the existing refresh, toast and error handling on the mutation", () => {
    expect(code).toContain("refresh();");
    expect(code).toMatch(/pushToast\(`\$\{user\.firstName\} \$\{next === "active" \? "activated" : "suspended"\}\.`/);
    expect(code).toContain('pushToast(e instanceof Error ? e.message : "Action failed.", "alert");');
  });

  it("adds no permission and no new service call for the dialog", () => {
    const services = [...code.matchAll(/userService\.(\w+)\(/g)].map((m) => m[1]);
    expect(new Set(services)).toEqual(
      new Set(["listUsers", "getCachedUsers", "setUserStatus", "resendInvite", "deleteUser", "exportUsersCsv"]),
    );
  });

  it("stays separate from the DELETE confirmation's state", () => {
    // One shared `confirm` for two different destructive answers is how "Cancel" on one dialog ends
    // up dismissing the other, or worse, how confirming one runs both.
    expect(code).toContain("const [suspendConfirm, setSuspendConfirm]");
    expect(code).toContain("onConfirm={doDelete}");
    expect(code).toContain("onConfirm={doSuspend}");
  });
});
