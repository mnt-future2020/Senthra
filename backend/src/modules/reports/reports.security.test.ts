import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PERMISSION_GROUPS } from "#modules/role/permissions.js";

// ── The financial-visibility boundary, enforced at BUILD time ─────────────────────────────────
//
// A source scan rather than a runtime assertion, for the same reason rental.boundary.test.ts is one:
// the failure this prevents is somebody WIRING money into a customer-facing surface. No unit test of
// either module would notice, and the leak would ship looking like a feature.
//
// The client requirement is explicit and is a security boundary, not a UI preference:
//   "Customer-facing reports → NO pricing / cost data shown. Internal reports → Full data."

const REPORTS_DIR = join(process.cwd(), "src", "modules", "reports");
const sourceFilesIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

/** Comments are prose; a word in one is a note, not a wiring. */
const codeLinesOf = (src: string) =>
  src
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

describe("finance permissions", () => {
  const reports = PERMISSION_GROUPS.find((g) => g.key === "reports");

  it("registers a Reports group with exactly the three permissions the module needs", () => {
    expect(reports).toBeDefined();
    expect(reports!.permissions.map((p) => p.key).sort()).toEqual([
      "reports.export",
      "reports.finance.view",
      "reports.view",
    ]);
  });

  // The split is the whole security design: seeing a stock report and seeing what it cost are
  // different rights. Collapsing them into one `reports.view` would hand spend to everyone who needs
  // a movement report.
  it("keeps the money permission separate from the module permission", () => {
    const keys = reports!.permissions.map((p) => p.key);
    expect(keys).toContain("reports.view");
    expect(keys).toContain("reports.finance.view");
    expect(reports!.category).toBe("Reports");
  });
});

describe("every finance route is gated server-side", () => {
  const routes = readFileSync(join(REPORTS_DIR, "reports.routes.ts"), "utf8");

  // Authorisation is a 403, not a blanked payload: no financial figure is ever serialised for an
  // actor who may not see it. That is only true if EVERY finance route carries the guard.
  it("guards every /finance route with reports.finance.view", () => {
    const financeRoutes = codeLinesOf(routes)
      .split(/router\.get\(/)
      .slice(1)
      .filter((block) => block.includes("/finance"));
    expect(financeRoutes.length).toBeGreaterThan(0);
    for (const block of financeRoutes) {
      expect(block, `a /finance route is missing requirePermission("reports.finance.view")`).toContain(
        'requirePermission("reports.finance.view")',
      );
    }
  });

  // Reading a figure on screen and walking out with the whole spend file are different acts — the
  // same split the other twelve *.export rights in this codebase make.
  //
  // Matches ANY download extension, not just .csv: XLSX reuses this exact gate, and a test keyed on
  // one extension would silently stop covering the next format added.
  it("additionally requires reports.export on every download, whatever the format", () => {
    const exportRoutes = codeLinesOf(routes)
      .split(/router\.get\(/)
      .slice(1)
      .filter((block) => /export\.(csv|xlsx)/.test(block));
    // Both formats must be present — if someone removes a route this asserts the count, not just the guard.
    expect(exportRoutes.filter((b) => b.includes("export.csv")).length).toBeGreaterThan(0);
    expect(exportRoutes.filter((b) => b.includes("export.xlsx")).length).toBeGreaterThan(0);
    for (const block of exportRoutes) {
      expect(block).toContain('requirePermission("reports.export")');
      // A finance export is the heaviest read in the product; it shares the throttle every other
      // export uses rather than inventing its own.
      expect(block).toContain("exportLimiter");
    }
  });

  it("requires authentication for the whole router", () => {
    expect(codeLinesOf(routes)).toContain("router.use(requireAuth)");
  });
});

describe("custom report routes are gated on reports.view, not the finance right", () => {
  const routes = readFileSync(join(REPORTS_DIR, "reports.routes.ts"), "utf8");
  const blocks = () =>
    codeLinesOf(routes)
      .split(/router\.get\(/)
      .slice(1)
      .filter((b) => b.includes("/custom"));

  // Custom Reports are stock/project/engineer data and carry no money, so demanding the finance right
  // would lock out the very people the feature is for. The separation is the point of the two perms.
  it("guards every /custom route with reports.view and never with reports.finance.view", () => {
    const custom = blocks();
    expect(custom.length).toBeGreaterThan(0);
    for (const b of custom) {
      expect(b).toContain('requirePermission("reports.view")');
      expect(b, "a custom report must not require the finance permission").not.toContain(
        'requirePermission("reports.finance.view")',
      );
    }
  });

  it("still requires reports.export on the custom downloads", () => {
    for (const b of blocks().filter((x) => /export\.(csv|xlsx)/.test(x))) {
      expect(b).toContain('requirePermission("reports.export")');
      expect(b).toContain("exportLimiter");
    }
  });
});

describe("customer-facing reports are a separate, session-scoped surface", () => {
  const controller = readFileSync(join(REPORTS_DIR, "reports.controller.ts"), "utf8");

  // The requirement is a security boundary: a customer's own id must come from their SESSION, so no
  // query string can address another customer's data. Hiding columns in React is not the mechanism.
  it("takes the customer id from req.principal, never from the request", () => {
    expect(codeLinesOf(controller)).toContain("req.principal.customerId");
    expect(codeLinesOf(controller)).toContain('req.principal?.type !== "customer"');
  });

  // Mounted on the PORTAL router so requireCustomer applies — not on the staff reports router, where
  // it would sit behind a staff permission a customer can never hold.
  it("is mounted on the customer portal router, not the staff reports router", () => {
    const customerRoutes = readFileSync(join(process.cwd(), "src", "modules", "customer", "customer.routes.ts"), "utf8");
    expect(customerRoutes).toContain('portalRouter.get("/reports"');
    expect(readFileSync(join(REPORTS_DIR, "reports.routes.ts"), "utf8")).not.toContain("/customer/reports");
  });
});

describe("the reports module never reaches a customer surface", () => {
  // Today every reports route is staff-only and finance-gated. This pins that: the moment somebody
  // adds a customer-portal report, it must be built as its own price-free DTO rather than by handing
  // the finance result to a customer controller.
  // Narrowed since customer reports shipped: the module now legitimately serves a customer surface,
  // but it must still never import the portal's own modules or a CustomerUser identity — the customer
  // handlers work purely from `req.principal.customerId` and the registry's customerVisible flag.
  it("does not import the customer portal or a customer identity", () => {
    const forbidden = /customerPortal|customer\.portal|CustomerUser/;
    const offenders = sourceFilesIn(REPORTS_DIR).filter((f) =>
      forbidden.test(codeLinesOf(readFileSync(join(REPORTS_DIR, f), "utf8"))),
    );
    expect(offenders, "a reports file reaches customer-facing code — money must not travel there").toEqual([]);
  });
});

describe("schedule routes reach the surface, the service decides the report", () => {
  const routes = readFileSync(join(REPORTS_DIR, "reports.routes.ts"), "utf8");
  const scheduleBlocks = () =>
    codeLinesOf(routes)
      .split(/router\.(get|post|put|patch|delete)\(/)
      .filter((b) => b.includes("/schedules"));

  // The two reporting rights are independent by design, and BOTH lead to scheduling: `reports.view`
  // alone would lock the Finance report away from a finance-only role whose own service rule says
  // they may schedule it, and the finance right alone would do the mirror image to stock reports.
  it("admits either reporting right on every schedule route", () => {
    const blocks = scheduleBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    expect(codeLinesOf(routes)).toContain('requireAnyPermission("reports.view", "reports.finance.view")');
    for (const b of blocks) {
      expect(b, "a /schedules route is not gated").toContain("GATE");
      // A route-level finance gate would be wrong in both directions — the per-report check lives in
      // the service, which is the only layer that knows which report a stored schedule names.
      expect(b, "a /schedules route hard-codes a single reporting right").not.toContain("requirePermission(");
    }
  });

  // Learning who can receive a Finance report is itself Finance information, so the recipient
  // directory sits behind the same gate and the service re-checks the report named in the query.
  it("gates the recipient directory like every other schedule route", () => {
    const dir = scheduleBlocks().filter((b) => b.includes("/schedules/recipients"));
    expect(dir).toHaveLength(1);
    expect(dir[0]).toContain("GATE");
  });

  it("throttles every schedule write", () => {
    const writes = codeLinesOf(routes)
      .split(/router\.(post|put|patch|delete)\(/)
      .filter((b) => b.includes("/schedules"));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (const b of writes) expect(b).toContain("writeLimiter");
  });

  // Scheduling introduces no fourth right: it is the report's view right PLUS `reports.export`, the
  // same pair the download routes ask for. If that ever stops being true, this is where the decision
  // gets made again.
  it("invents no reports.schedule permission", () => {
    expect(PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key))).not.toContain("reports.schedule");
  });
});

// ── Scheduling is an export, and the routes say so ─────────────────────────────────────────────
//
// A scheduled report generates a file with the SAME builders the download routes use and mails it
// out. Treating it as anything less than an export would make `reports.export` bypassable: refuse
// someone the download button, and they schedule the same workbook to their own inbox instead.
describe("writing a schedule additionally requires reports.export", () => {
  const routes = readFileSync(join(REPORTS_DIR, "reports.routes.ts"), "utf8");
  // Split on every router verb, then keep the blocks for the verbs asked for. Built from a literal
  // regex rather than an interpolated one so the escaping cannot rot.
  const blocksFor = (verbs: readonly string[]) =>
    codeLinesOf(routes)
      .split(/router\.(get|post|put|patch|delete)\(/)
      .filter((b, i, all) => b.includes("/schedules") && verbs.includes(all[i - 1] ?? ""));

  it("declares the export gate once, from the same permission the downloads use", () => {
    expect(codeLinesOf(routes)).toContain('const EXPORT = requirePermission("reports.export");');
  });

  // Create and edit are the acts that DEFINE a recurring extraction and who receives it.
  it("gates create and edit on it", () => {
    const writes = blocksFor(["post", "put"]);
    expect(writes).toHaveLength(2);
    for (const b of writes) expect(b, "a /schedules write is missing the export gate").toContain("EXPORT");
  });

  // The picker exists only to fill in a form an actor without export cannot save.
  it("gates the recipient directory on it", () => {
    const dir = blocksFor(["get"]).filter((b) => b.includes("/schedules/recipients"));
    expect(dir).toHaveLength(1);
    expect(dir[0]).toContain("EXPORT");
  });

  // Reading configuration and delivery state extracts nothing — no file, no figure.
  it("leaves the read routes on the view rights alone", () => {
    const reads = blocksFor(["get"]).filter((b) => !b.includes("/schedules/recipients"));
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const b of reads) expect(b, "a /schedules read wrongly demands export").not.toContain("EXPORT");
  });

  // Enable/disable is one route carrying two acts: resuming restarts an extraction, pausing stops
  // one. Only the service can see which is which, so the route must NOT gate it — a gate here would
  // block the off switch, failing in the unsafe direction.
  it("does not gate the enable/disable route, which the service splits by direction", () => {
    const toggle = blocksFor(["patch"]);
    expect(toggle).toHaveLength(1);
    expect(toggle[0]).not.toContain("EXPORT");
    const service = readFileSync(join(REPORTS_DIR, "reportSchedule.service.ts"), "utf8");
    expect(codeLinesOf(service), "resume must ask for the export right").toContain("if (enabled) requireExport(actor);");
  });

  // Delete DOES carry the export right — and pause deliberately does not.
  //
  // The two were treated alike on the reasoning that both "stop files leaving". Only pause does. It
  // is reversible, leaves the configuration and the run history intact, and is the lever an operator
  // reaches for when a schedule misfires — which is the one moment an authorization check must not
  // stand in the way. Delete destroys a schedule a view-only user could never have created, and takes
  // its delivery history with it. Anyone who cannot create one has no business removing one.
  it("gates delete on the export right, like create and edit", () => {
    const del = blocksFor(["delete"]);
    expect(del).toHaveLength(1);
    expect(del[0]).toContain("EXPORT");
    const service = codeLinesOf(readFileSync(join(REPORTS_DIR, "reportSchedule.service.ts"), "utf8"));
    const body = service.split("export async function deleteSchedule(")[1] ?? "";
    expect(body.slice(0, 600), "the service must re-check it too").toContain("requireExport(actor)");
  });

  // Defence in depth: the route answers for THIS request, the service for a standing instruction
  // that outlives it. Both write paths funnel through validate(), so the check cannot drift.
  it("re-checks in the service, on the single path both writes share", () => {
    const service = codeLinesOf(readFileSync(join(REPORTS_DIR, "reportSchedule.service.ts"), "utf8"));
    expect(service).toContain("requireExport(actor);");
    const validateBody = service.split("async function validate(")[1] ?? "";
    expect(validateBody.slice(0, 800), "validate() must ask for the export right").toContain("requireExport(actor)");
  });

  // The catalogue must keep describing what the right actually covers, or an admin granting View
  // without Export cannot know they have also withheld scheduling.
  it("says so in the permission catalogue", () => {
    const p = PERMISSION_GROUPS.flatMap((g) => g.permissions).find((x) => x.key === "reports.export");
    expect(p?.description).toMatch(/schedul/i);
  });
});
