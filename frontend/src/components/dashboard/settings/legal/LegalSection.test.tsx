// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, click, render, wait } from "@/test/dom";

// ── Settings → Privacy Policy, while it is still loading ──────────────────────────────────────
//
// This section used to replace ITSELF with a single line of text — `if (loading) return <spinner>`
// — and it renders four cards when it arrives. So the whole screen was an empty expanse with one
// small spinner floating at the top, and then four cards slammed in at once.
//
// Two things were wrong with that, and only one of them was the spinner:
//
//   • SCOPE. The card titles and descriptions are STATIC STRINGS. They need no data at all, so
//     hiding them behind a network request hid known content behind an unknown, and guaranteed a
//     full-height layout jump when it resolved.
//   • CONVENTION. `Skeleton` is what this app uses to wait — 112 files across every dashboard area,
//     including EmailTemplatesSection, the other settings section that loads a list.
//
// What these pin is that the page's SHAPE is constant across the load, which is the property a
// skeleton exists to provide and a spinner cannot.
const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  getPolicyForAdmin: vi.fn(),
  publishPolicy: vi.fn(),
  discardDraft: vi.fn(),
  getPublishedVersion: vi.fn(),
  saveDraft: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ can: (p: string) => h.perms.has(p) }) }));
vi.mock("@/hooks/useDashboard", () => ({ useDashboard: () => ({ pushToast: h.toast }) }));
vi.mock("@/services/policy.service", () => ({
  getPolicyForAdmin: h.getPolicyForAdmin,
  previewPolicy: vi.fn(),
  saveDraft: h.saveDraft,
  publishPolicy: h.publishPolicy,
  getPublishedVersion: h.getPublishedVersion,
  discardDraft: h.discardDraft,
}));

import { LegalSection } from "./LegalSection";

const policy = (over: Record<string, unknown> = {}) => ({
  key: "privacy",
  draftBody: "# Privacy\n\nWe keep very little.",
  draftRevision: 3,
  draftUpdatedAt: "2026-09-01T10:00:00.000Z",
  draftUpdatedBy: "shahul@mntfuture.com",
  published: null,
  hasUnpublishedChanges: false,
  history: [],
  ...over,
});

/** A promise this test decides when to settle — the only way to observe the loading state at all. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const text = () => document.body.textContent ?? "";
const skeletons = () => document.querySelectorAll(".skeleton").length;
/** Every card heading currently on screen — the page's visible shape. */
const headings = () =>
  Array.from(document.querySelectorAll("h1,h2,h3,h4"))
    .map((el) => el.textContent?.trim())
    .filter(Boolean);

beforeEach(() => {
  h.perms = new Set(["policy.view", "policy.edit", "policy.publish"]);
  h.getPolicyForAdmin.mockReset().mockResolvedValue(policy());
  h.publishPolicy.mockReset().mockResolvedValue(policy());
  h.discardDraft.mockReset().mockResolvedValue(policy());
  h.getPublishedVersion.mockReset();
  h.saveDraft.mockReset().mockResolvedValue(policy());
  h.toast.mockReset();
});
afterEach(cleanup);

describe("while the policy is loading", () => {
  it("keeps the page's shape — the cards are already there", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    expect(text()).toMatch(/Published policy/i);
    expect(text()).toMatch(/Draft/i);
  });

  it("shows skeletons rather than a spinner", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    expect(skeletons()).toBeGreaterThan(0);
    // The old behaviour, named explicitly so it cannot quietly return.
    expect(text()).not.toMatch(/Loading policy/i);
  });

  // The cards' own copy is static, so showing it early is not a guess about what will arrive.
  it("shows each card's real description, not a placeholder for it", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    expect(text()).toMatch(/What the public privacy notice shows today/i);
    expect(text()).toMatch(/Saving it never changes the published policy/i);
  });

  // The whole point. A skeleton that does not preserve the layout is just a slower spinner.
  it("renders the SAME headings before and after the data arrives", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);
    const during = headings();

    d.resolve(policy());
    await wait();

    expect(during).toEqual(headings());
    expect(during.length).toBeGreaterThan(0);
  });

  // Nothing is claimed about content that may never appear: Preview only exists once the user asks
  // for one, and Previous versions only once something has been superseded. Skeletons for those
  // would promise cards that never arrive.
  it("does not pretend the conditional cards are coming", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    expect(text()).not.toMatch(/Previous versions/i);
    expect(text()).not.toMatch(/Exactly how the published page will render/i);
  });

  // The old spinner carried the visible words "Loading policy…", which a screen reader read out.
  // A skeleton is silent by construction, so replacing one with the other took away the only
  // announcement this screen had and left a blind user with two apparently empty cards.
  //
  // The status region is the SENTENCE, and nothing else. An earlier version made the whole
  // skeleton the live region, so a screen reader that did speak it would read both card titles and
  // both descriptions as one run-on announcement.
  it("tells a screen reader it is loading, in one sentence", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    const status = document.querySelectorAll('[role="status"]');
    expect(status).toHaveLength(1);
    expect(status[0]!.textContent?.trim()).toBe("Loading the privacy policy…");
  });

  // The two attributes must sit on DIFFERENT elements. `aria-busy` on a live region tells assistive
  // tech to hold that region's announcements until it stops being busy — and this one never stops
  // being busy, it is simply removed. On one element they cancel each other out, which is exactly
  // what the earlier version did.
  it("marks the CONTENT busy, never the status sentence itself", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).toBeTruthy();
    expect(busy!.getAttribute("role")).not.toBe("status");
    // The busy element is the one holding the cards that are still loading.
    expect(busy!.textContent).toMatch(/Published policy/i);
    expect(busy!.textContent).toMatch(/Draft/i);
    // And the sentence stays free to be announced.
    expect(document.querySelector('[role="status"]')!.hasAttribute("aria-busy")).toBe(false);
  });

  // The rule the previous version got wrong. `aria-busy` marks an element AND ITS SUBTREE as
  // mid-update, and screen readers that honour it hold back announcements anywhere inside. Putting
  // the status sentence on a different element was not enough while that element was still a
  // CHILD of the busy one — it has to be a sibling, outside the subtree entirely.
  it("keeps the status sentence OUTSIDE the busy subtree", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    const busy = document.querySelector('[aria-busy="true"]')!;
    const status = document.querySelector('[role="status"]')!;
    expect(busy.contains(status)).toBe(false);
    expect(status.closest('[aria-busy="true"]')).toBeNull();
  });

  it("stops saying it is busy once the data is there", async () => {
    await render(<LegalSection />);
    await wait();

    expect(document.querySelector('[role="status"]')).toBeFalsy();
    expect(document.querySelector('[aria-busy="true"]')).toBeFalsy();
  });

  // `canEdit` comes from the permission hook, not the request — it is known before the first paint.
  // Leaving the notice out of the skeleton meant a read-only viewer watched a bordered banner appear
  // and shove the whole draft card down, which is precisely the jump a skeleton exists to prevent.
  it("includes the read-only banner while loading, for someone who cannot edit", async () => {
    h.perms = new Set(["policy.view"]);
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    expect(text()).toMatch(/Read-only/i);
  });

  it("omits it for someone who can edit", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPolicyForAdmin.mockReturnValue(d.promise);

    await render(<LegalSection />);

    expect(text()).not.toMatch(/Read-only/i);
  });
});

// The permissions come from the auth hook, not the request, so every part of the draft card that
// depends on them is knowable before the first paint — exactly like the read-only banner. Drawing a
// fixed two buttons for everyone meant a view-only user watched one placeholder vanish, and an
// edit-only user watched an extra hint line appear and push the page down.
describe("the skeleton follows the viewer's permissions", () => {
  /** Button-shaped placeholders vs every other bar. */
  const bars = () => {
    const all = Array.from(document.querySelectorAll(".skeleton"));
    const buttons = all.filter((el) => el.classList.contains("h-9"));
    return { buttons: buttons.length, others: all.length - buttons.length };
  };
  const skeletonFor = async (perms: string[]) => {
    h.perms = new Set(perms);
    h.getPolicyForAdmin.mockReturnValue(deferred<ReturnType<typeof policy>>().promise);
    await render(<LegalSection />);
    return bars();
  };

  it("draws only Preview for someone who can only view", async () => {
    expect((await skeletonFor(["policy.view"])).buttons).toBe(1);
  });

  it("draws Preview and Save for someone who can edit", async () => {
    expect((await skeletonFor(["policy.view", "policy.edit"])).buttons).toBe(2);
  });

  it("draws Preview, Save and Publish for someone who can do both", async () => {
    expect((await skeletonFor(["policy.view", "policy.edit", "policy.publish"])).buttons).toBe(3);
  });

  it("reserves the extra hint line an editor who cannot publish is shown", async () => {
    const editOnly = await skeletonFor(["policy.view", "policy.edit"]);
    await cleanup();
    const editAndPublish = await skeletonFor(["policy.view", "policy.edit", "policy.publish"]);

    expect(editOnly.others).toBe(editAndPublish.others + 1);
  });
});

describe("once it has loaded", () => {
  it("replaces every skeleton with the real content", async () => {
    await render(<LegalSection />);
    await wait();

    expect(skeletons()).toBe(0);
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Privacy policy draft"]')?.value).toBe(
      "# Privacy\n\nWe keep very little.",
    );
  });

  it("shows the published version when there is one", async () => {
    h.getPolicyForAdmin.mockResolvedValue(
      policy({
        published: { id: "v2", version: 2, publishedAt: "2026-08-01T09:00:00.000Z", publishedBy: "shahul", body: "x" },
        history: [{ id: "v2", version: 2, publishedAt: "2026-08-01T09:00:00.000Z", publishedBy: "shahul" }],
      }),
    );

    await render(<LegalSection />);
    await wait();

    expect(text()).toMatch(/Version 2/);
  });

  it("says plainly when nothing has been published", async () => {
    await render(<LegalSection />);
    await wait();

    expect(text()).toMatch(/No policy published yet/i);
  });
});

// A failed load must not leave the skeleton running for ever — that reads as "still working" when
// nothing is working, and the section would sit there pulsing indefinitely.
describe("when the load fails", () => {
  it("stops the skeleton and says what went wrong", async () => {
    h.getPolicyForAdmin.mockRejectedValue(new Error("Network unreachable"));

    await render(<LegalSection />);
    await wait();

    expect(skeletons()).toBe(0);
    expect(text()).toMatch(/network unreachable/i);
    // Still a usable screen, not a blank one.
    expect(text()).toMatch(/Published policy/i);
  });
});

describe("permissions", () => {
  it("is read-only for someone who may view but not edit", async () => {
    h.perms = new Set(["policy.view"]);
    await render(<LegalSection />);
    await wait();

    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Privacy policy draft"]')?.disabled).toBe(
      true,
    );
  });
});

// ── The three dialogs ─────────────────────────────────────────────────────────────────────────
//
// Discard, Publish and the version viewer were hand-built overlays: a fixed <div> with a panel in
// it. They LOOKED like dialogs and were not ones —
//
//   • no role="dialog", so a screen reader was never told a dialog had opened;
//   • no Escape, so the keyboard's universal "get me out of here" did nothing;
//   • no focus management, so focus stayed on the page button behind the overlay, and Tab walked
//     straight out of the dialog through controls the user could not even see.
//
// Publish is the one that makes this matter: it mints a PERMANENT version that can never be edited
// or deleted. The app already has ConfirmDialog and Modal, which handle all of the above, and these
// tests pin that this screen now uses them.

/** The published version, with a superseded one behind it — so every dialog can be reached. */
const withHistory = () =>
  policy({
    hasUnpublishedChanges: true,
    published: { id: "v2", version: 2, publishedAt: "2026-08-01T09:00:00.000Z", publishedBy: "shahul", body: "live" },
    history: [
      { id: "v2", version: 2, publishedAt: "2026-08-01T09:00:00.000Z", publishedBy: "shahul" },
      { id: "v1", version: 1, publishedAt: "2026-07-01T09:00:00.000Z", publishedBy: "shahul" },
    ],
  });

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
/** A button INSIDE the dialog — the page has buttons with the same labels behind it. */
const dialogBtn = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
    (b) => b.textContent?.trim() === label,
  );
/** A button on the PAGE, never one inside a dialog. */
const pageBtn = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === label && !b.closest('[role="dialog"]'),
  );
const pressEscape = async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait();
};
/** The dialog's accessible name, resolved the way assistive tech resolves it. */
const dialogName = () => {
  const id = dialog()?.getAttribute("aria-labelledby");
  return id ? document.getElementById(id)?.textContent?.trim() : undefined;
};

const mountLoaded = async (p: ReturnType<typeof policy> = withHistory()) => {
  h.getPolicyForAdmin.mockResolvedValue(p);
  await render(<LegalSection />);
  await wait();
};

describe("the Publish dialog", () => {
  it("is a real, labelled, modal dialog", async () => {
    await mountLoaded();
    await click(pageBtn("Publish"));

    expect(dialog()).toBeTruthy();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialogName()).toBe("Publish this policy?");
  });

  it("moves focus INTO the dialog, off the page behind it", async () => {
    await mountLoaded();
    await click(pageBtn("Publish"));

    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("names the permanent version it is about to create", async () => {
    await mountLoaded();
    await click(pageBtn("Publish"));

    expect(dialog()!.textContent).toMatch(/permanent version 3/i);
    expect(dialog()!.textContent).toMatch(/cannot be edited or deleted/i);
  });

  it("closes on Escape without publishing anything", async () => {
    await mountLoaded();
    await click(pageBtn("Publish"));
    // Precondition, not decoration: without it this passes against an overlay that is not a dialog
    // at all — "no dialog after Escape" is trivially true when there was never one to close.
    expect(dialog()).toBeTruthy();
    await pressEscape();

    expect(dialog()).toBeFalsy();
    expect(h.publishPolicy).not.toHaveBeenCalled();
  });

  it("closes on Cancel without publishing anything", async () => {
    await mountLoaded();
    await click(pageBtn("Publish"));
    await click(dialogBtn("Cancel"));

    expect(dialog()).toBeFalsy();
    expect(h.publishPolicy).not.toHaveBeenCalled();
  });

  it("publishes the saved revision on confirm", async () => {
    await mountLoaded();
    await click(pageBtn("Publish"));
    await click(dialogBtn("Publish"));

    expect(h.publishPolicy).toHaveBeenCalledTimes(1);
    expect(h.publishPolicy).toHaveBeenCalledWith(3);
  });

  // Once a permanent version is being minted there is nothing left to cancel. Letting Escape close
  // the dialog would only hide the outcome, and invite a second click on the page's Publish.
  it("cannot be dismissed while the publish is in flight", async () => {
    let finish!: (v: unknown) => void;
    h.publishPolicy.mockReturnValue(new Promise((r) => (finish = r)));
    await mountLoaded();
    await click(pageBtn("Publish"));
    await click(dialogBtn("Publish"));

    await pressEscape();
    expect(dialog()).toBeTruthy();
    expect(dialogBtn("Cancel")!.disabled).toBe(true);

    finish(withHistory());
    await wait();
  });
});

describe("the Discard dialog", () => {
  it("is a real, labelled, modal dialog", async () => {
    await mountLoaded();
    await click(pageBtn("Discard draft"));

    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialogName()).toBe("Discard draft changes?");
  });

  it("says what is lost and what is not", async () => {
    await mountLoaded();
    await click(pageBtn("Discard draft"));

    expect(dialog()!.textContent).toMatch(/Anything written since then is lost/i);
    expect(dialog()!.textContent).toMatch(/published policy does not change/i);
  });

  it("closes on Escape without discarding anything", async () => {
    await mountLoaded();
    await click(pageBtn("Discard draft"));
    expect(dialog()).toBeTruthy();
    await pressEscape();

    expect(dialog()).toBeFalsy();
    expect(h.discardDraft).not.toHaveBeenCalled();
  });

  it("discards against the current revision on confirm", async () => {
    await mountLoaded();
    await click(pageBtn("Discard draft"));
    await click(dialogBtn("Discard draft"));

    expect(h.discardDraft).toHaveBeenCalledWith(3);
  });
});

describe("the version viewer", () => {
  const detail = {
    id: "v1",
    version: 1,
    publishedAt: "2026-07-01T09:00:00.000Z",
    publishedBy: "shahul",
    body: "# Old\n\nThe old words.",
    blocks: [{ type: "heading" as const, text: "Old" }, { type: "paragraph" as const, text: "The old words." }],
    isCurrent: false,
  };

  it("is a real, labelled, modal dialog", async () => {
    h.getPublishedVersion.mockResolvedValue(detail);
    await mountLoaded();
    await click(pageBtn("View"));

    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialogName()).toBe("Version 1");
  });

  it("still says it is read only", async () => {
    h.getPublishedVersion.mockResolvedValue(detail);
    await mountLoaded();
    await click(pageBtn("View"));

    expect(dialog()!.textContent).toMatch(/Read only/i);
    expect(dialog()!.textContent).toMatch(/superseded/i);
    expect(dialog()!.textContent).toMatch(/The old words/);
  });

  it("closes on Escape", async () => {
    h.getPublishedVersion.mockResolvedValue(detail);
    await mountLoaded();
    await click(pageBtn("View"));
    expect(dialog()).toBeTruthy();
    await pressEscape();

    expect(dialog()).toBeFalsy();
  });

  it("offers Copy to draft to someone who can edit", async () => {
    h.getPublishedVersion.mockResolvedValue(detail);
    await mountLoaded();
    await click(pageBtn("View"));

    expect(dialogBtn("Copy to draft")).toBeTruthy();
  });

  it("does not offer it to someone who can only view", async () => {
    h.perms = new Set(["policy.view"]);
    h.getPublishedVersion.mockResolvedValue(detail);
    await mountLoaded();
    await click(pageBtn("View"));

    expect(dialog()).toBeTruthy();
    expect(dialogBtn("Copy to draft")).toBeFalsy();
  });
});

// ── What happens AROUND the dialogs ───────────────────────────────────────────────────────────

/** Three versions: v3 is live, v2 and v1 are superseded — so there are two View buttons. */
const withTwoSuperseded = () =>
  policy({
    hasUnpublishedChanges: true,
    published: { id: "v3", version: 3, publishedAt: "2026-09-01T09:00:00.000Z", publishedBy: "shahul", body: "live" },
    history: [
      { id: "v3", version: 3, publishedAt: "2026-09-01T09:00:00.000Z", publishedBy: "shahul" },
      { id: "v2", version: 2, publishedAt: "2026-08-01T09:00:00.000Z", publishedBy: "shahul" },
      { id: "v1", version: 1, publishedAt: "2026-07-01T09:00:00.000Z", publishedBy: "shahul" },
    ],
  });

const versionDetail = (version: number) => ({
  id: `v${version}`,
  version,
  publishedAt: "2026-07-01T09:00:00.000Z",
  publishedBy: "shahul",
  body: `# Version ${version}`,
  blocks: [{ type: "paragraph" as const, text: `The words of version ${version}.` }],
  isCurrent: false,
});

const viewButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (b) => b.textContent?.trim() === "View" && !b.closest('[role="dialog"]'),
  );

// A fetch that returns after the user has moved on must not drag them back. The viewer used to set
// whatever arrived, whenever it arrived — so closing it during loading reopened it the moment the
// response landed, and pulled focus back in with it. Escape and a backdrop click closing it made
// that easy to hit rather than rare.
describe("a version that arrives late", () => {
  it("does not reopen a viewer that was closed while it loaded", async () => {
    const d = deferred<ReturnType<typeof versionDetail>>();
    h.getPublishedVersion.mockReturnValue(d.promise);
    await mountLoaded();

    await click(pageBtn("View"));
    expect(dialog()).toBeTruthy();
    await pressEscape();
    expect(dialog()).toBeFalsy();

    d.resolve(versionDetail(1));
    await wait();

    expect(dialog()).toBeFalsy();
  });

  it("never replaces the version that was asked for LAST", async () => {
    const slow = deferred<ReturnType<typeof versionDetail>>();
    const fast = deferred<ReturnType<typeof versionDetail>>();
    h.getPublishedVersion.mockImplementation((id: string) => (id === "v2" ? slow.promise : fast.promise));
    await mountLoaded(withTwoSuperseded());

    await click(viewButtons()[0]); // v2 — slow
    await pressEscape();
    await click(viewButtons()[1]); // v1 — fast
    fast.resolve(versionDetail(1));
    await wait();
    expect(dialogName()).toBe("Version 1");

    slow.resolve(versionDetail(2));
    await wait();

    expect(dialogName()).toBe("Version 1");
    expect(dialog()!.textContent).toMatch(/The words of version 1/);
  });
});

// The error used to go to the page notice BEHIND the open viewer, under a backdrop, on a page whose
// scroll is locked — so a failed copy looked like nothing at all: the button re-enabled and that was
// it. The likeliest cause is the one the revision guard exists for: somebody else saved the draft.
describe("a Copy to draft that fails", () => {
  it("says so inside the viewer, where the user is looking", async () => {
    h.getPublishedVersion.mockResolvedValue(versionDetail(1));
    h.saveDraft.mockRejectedValue(new Error("Someone else saved the draft first. Reload and try again."));
    await mountLoaded();

    await click(pageBtn("View"));
    await click(dialogBtn("Copy to draft"));

    expect(dialog()).toBeTruthy();
    const alert = dialog()!.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Someone else saved the draft first/);
  });

  it("does not carry that error into the next viewing", async () => {
    h.getPublishedVersion.mockResolvedValue(versionDetail(1));
    h.saveDraft.mockRejectedValue(new Error("Someone else saved the draft first."));
    await mountLoaded();
    await click(pageBtn("View"));
    await click(dialogBtn("Copy to draft"));
    // Precondition: the error really was in the viewer. Without this the test passes against code
    // that never shows it there at all — there is nothing to carry over.
    expect(dialog()!.querySelector('[role="alert"]')).toBeTruthy();
    await pressEscape();

    await click(pageBtn("View"));

    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
  });

  // Every way out is locked while the copy runs — including the header's X, which used to stay
  // clickable and silently do nothing next to a footer Close that was visibly disabled.
  it("locks every close control while the copy is running", async () => {
    const d = deferred<ReturnType<typeof policy>>();
    h.getPublishedVersion.mockResolvedValue(versionDetail(1));
    h.saveDraft.mockReturnValue(d.promise);
    await mountLoaded();
    await click(pageBtn("View"));
    await click(dialogBtn("Copy to draft"));

    const headerClose = dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(headerClose?.disabled).toBe(true);
    expect(dialogBtn("Close")!.disabled).toBe(true);
    await pressEscape();
    expect(dialog()).toBeTruthy();

    d.resolve(withHistory());
    await wait();
  });
});

// A dialog hands focus back to whatever opened it. After a successful Discard that button no longer
// exists, and after a successful Publish it is disabled — so focus fell to the top of the document
// and a keyboard or screen-reader user lost their place entirely. It now goes to the thing the
// action just changed.
describe("where focus lands afterwards", () => {
  it("lands on the newly published version after Publish", async () => {
    h.publishPolicy.mockResolvedValue(
      policy({
        hasUnpublishedChanges: false,
        published: { id: "v3", version: 3, publishedAt: "2026-09-25T09:00:00.000Z", publishedBy: "shahul", body: "x" },
        history: [
          { id: "v3", version: 3, publishedAt: "2026-09-25T09:00:00.000Z", publishedBy: "shahul" },
          { id: "v2", version: 2, publishedAt: "2026-08-01T09:00:00.000Z", publishedBy: "shahul" },
        ],
      }),
    );
    await mountLoaded();
    await click(pageBtn("Publish"));
    await click(dialogBtn("Publish"));

    expect(dialog()).toBeFalsy();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toMatch(/Version 3/);
  });

  it("lands in the draft after Discard", async () => {
    h.discardDraft.mockResolvedValue({ ...withHistory(), hasUnpublishedChanges: false });
    await mountLoaded();
    await click(pageBtn("Discard draft"));
    await click(dialogBtn("Discard draft"));

    expect(dialog()).toBeFalsy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Privacy policy draft");
  });
});
