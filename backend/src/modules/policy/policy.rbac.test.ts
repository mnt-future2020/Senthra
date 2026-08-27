import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  SYSTEM_ADMIN_PERMISSIONS,
  applyImpliedPermissions,
} from "#modules/role/permissions.js";

/**
 * Guards on the permission SPLIT, which is the reason this module exists.
 *
 * Drafting a policy and putting it in front of the public are different acts by different people.
 * If `policy.edit` ever became sufficient to publish — through a route change, an implied-permission
 * rule, or a seed grant — the approval step would vanish silently: nothing would error, and the
 * first sign would be an unapproved document live on the internet.
 */

const routes = readFileSync(join(import.meta.dirname, "policy.routes.ts"), "utf8");

/** One route declaration as a flat string, however it was wrapped across lines. */
function declaration(match: string): string {
  const at = routes.indexOf(match);
  expect(at, `route not found: ${match}`).toBeGreaterThan(-1);
  return routes.slice(at, routes.indexOf(");", at)).replace(/\s+/g, " ");
}

describe("route gating", () => {
  it("publishing requires policy.publish", () => {
    expect(declaration('router.post("/privacy/publish"')).toContain("canPublish");
  });

  it("publishing does NOT accept the edit permission", () => {
    const decl = declaration('router.post("/privacy/publish"');
    expect(decl).not.toContain("canEdit");
    expect(decl).not.toContain('requirePermission("policy.edit")');
  });

  it("saving the draft requires policy.edit", () => {
    const decl = declaration('router.put("/privacy/draft"');
    expect(decl).toContain("canEdit");
    expect(decl).not.toContain("canPublish");
  });

  it("reading the draft and previewing require policy.view", () => {
    expect(declaration('router.get("/privacy/admin"')).toContain("canView");
    expect(declaration('router.post("/privacy/preview"')).toContain("canView");
  });

  // Reading what WAS published is neither publishing nor editing. Gating it on either would mean the
  // people who audit the policy need the rights to change it, which inverts the point of the split.
  it("viewing one historical version requires policy.view and nothing more", () => {
    const decl = declaration('router.get("/privacy/versions/:id"');
    expect(decl).toContain("canView");
    expect(decl).not.toContain("canEdit");
    expect(decl).not.toContain("canPublish");
  });

  // Discard rewrites the WORKING COPY and can reach no published version, so it is an edit.
  // Requiring publish for it would mean an author cannot undo their own unsaved mistake.
  it("discarding the draft requires policy.edit, not policy.publish", () => {
    const decl = declaration('router.post("/privacy/draft/discard"');
    expect(decl).toContain("canEdit");
    expect(decl).not.toContain("canPublish");
  });

  // The parameterised route must not be able to swallow a sibling literal path.
  it("registers /privacy/versions/:id after the literal /privacy/admin route", () => {
    expect(routes.indexOf('router.get("/privacy/versions/:id"')).toBeGreaterThan(
      routes.indexOf('router.get("/privacy/admin"'),
    );
  });

  it("binds each helper to exactly the permission its name claims", () => {
    expect(routes).toContain('const canView = requirePermission("policy.view")');
    expect(routes).toContain('const canEdit = requirePermission("policy.edit")');
    expect(routes).toContain('const canPublish = requirePermission("policy.publish")');
  });
});

describe("the public surface is exactly one read route", () => {
  it("declares the public GET before the auth wall", () => {
    const publicGet = routes.indexOf('router.get("/privacy"');
    const authWall = routes.indexOf("router.use(requireAuth)");
    expect(publicGet).toBeGreaterThan(-1);
    expect(authWall).toBeGreaterThan(-1);
    expect(publicGet).toBeLessThan(authWall);
  });

  it("declares every other route AFTER it", () => {
    const authWall = routes.indexOf("router.use(requireAuth)");
    for (const r of [
      '"/privacy/admin"',
      '"/privacy/preview"',
      '"/privacy/draft"',
      '"/privacy/draft/discard"',
      '"/privacy/versions/:id"',
      '"/privacy/publish"',
    ]) {
      expect(routes.indexOf(r), `${r} must be behind requireAuth`).toBeGreaterThan(authWall);
    }
  });

  it("exposes no public WRITE route", () => {
    const authWall = routes.indexOf("router.use(requireAuth)");
    const before = routes.slice(0, authWall);
    for (const verb of ["router.post(", "router.put(", "router.patch(", "router.delete("]) {
      expect(before).not.toContain(verb);
    }
  });
});

describe("permission catalogue", () => {
  const group = PERMISSION_GROUPS.find((g) => g.key === "policy");

  it("registers the three keys as one group", () => {
    expect(group).toBeDefined();
    expect(group!.permissions.map((p) => p.key).sort()).toEqual([
      "policy.edit",
      "policy.publish",
      "policy.view",
    ]);
  });

  it("uses policy.view as the group's base access key", () => {
    // Implicit via the action labelled "View" — without it the group opts out of the implied
    // closure and a role could hold `policy.edit` with no screen to edit on.
    expect(group!.permissions.find((p) => p.action === "View")?.key).toBe("policy.view");
  });
});

describe("edit never implies publish", () => {
  it("expands policy.edit to view + edit only", () => {
    const expanded = applyImpliedPermissions(["policy.edit"]);
    expect(expanded).toContain("policy.edit");
    expect(expanded).toContain("policy.view");
    expect(expanded).not.toContain("policy.publish");
  });

  it("expands policy.publish without silently adding edit rights", () => {
    const expanded = applyImpliedPermissions(["policy.publish"]);
    expect(expanded).toContain("policy.publish");
    expect(expanded).not.toContain("policy.edit");
  });

  it("leaves a role holding neither with neither", () => {
    expect(applyImpliedPermissions(["users.view"])).not.toContain("policy.publish");
  });
});

describe("seeded grants", () => {
  it("gives system_admin the draft permissions", () => {
    expect(SYSTEM_ADMIN_PERMISSIONS).toContain("policy.view");
    expect(SYSTEM_ADMIN_PERMISSIONS).toContain("policy.edit");
  });

  it("does NOT give system_admin publish — approval is the super-admin's", () => {
    expect(SYSTEM_ADMIN_PERMISSIONS).not.toContain("policy.publish");
  });

  it("still reaches the super-admin, who holds everything", () => {
    expect(applyImpliedPermissions([ALL_PERMISSIONS])).toContain(ALL_PERMISSIONS);
  });
});

describe("schema guarantees", () => {
  const schema = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "prisma", "schema.prisma"),
    "utf8",
  );
  const model = (name: string) => {
    const at = schema.indexOf(`model ${name} {`);
    expect(at, `model ${name} not found`).toBeGreaterThan(-1);
    return schema.slice(at, schema.indexOf("\n}", at));
  };

  it("allows only ONE Privacy Policy document — enforced by a unique key", () => {
    // A service-layer check could be skipped by a second code path; the index cannot.
    expect(model("PolicyDocument")).toMatch(/key\s+String\s+@unique/);
  });

  it("cannot produce two rows for the same version number", () => {
    expect(model("PolicyVersion")).toContain("@@unique([documentKey, version])");
  });

  it("keeps the published pointer optional, so 'nothing published' is representable", () => {
    expect(model("PolicyDocument")).toMatch(/publishedVersionId\s+String\?/);
  });

  it("carries publication metadata on the version row, not only in the audit log", () => {
    const m = model("PolicyVersion");
    for (const field of ["version", "body", "publishedAt", "publishedBy"]) {
      expect(m).toContain(field);
    }
  });
});
