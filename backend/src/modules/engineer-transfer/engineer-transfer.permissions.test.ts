import { beforeEach, describe, expect, it, vi } from "vitest";

// Who may decline / cancel a pending transfer, and what everyone else is told.
//
// The rule is unchanged: decline = the stock holder, cancel = the engineer who raised the request, and
// either one for an office user holding `engineer_stock.transfer`. What these pin is the case that
// exposed it — a transfer the OFFICE arranged (a kit-request approval, or the board's "New transfer")
// records the office user as requester, so the receiving engineer may not cancel it even though it
// sits in their "My requests" — and the refusal wording, which used to send people to "an admin" when
// Warehouse Managers hold the same power.
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "office:jobs" }));
vi.mock("#modules/notification/notification.service.js", () => ({ notify: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCompanyTimezone: vi.fn(async () => "Europe/London") }));
vi.mock("./engineer-transfer.repository.js", () => ({ findById: vi.fn(), declineTx: vi.fn(), cancelTx: vi.fn() }));

import type { AuditActor } from "#modules/audit/audit.service.js";
import * as transferRepo from "./engineer-transfer.repository.js";
import type { TransferWithLines } from "./engineer-transfer.repository.js";
import { cancel, decline } from "./engineer-transfer.service.js";

const HOLDER = "eng-holder";
const RECIPIENT = "eng-recipient";
const OFFICE = "office-user";

const transfer = (over: Partial<TransferWithLines> = {}) =>
  ({
    id: "t1",
    code: "ENG-0001",
    status: "pending",
    fromEngineerId: HOLDER,
    fromEngineerName: "Holder",
    fromEngineerEmail: null,
    fromEngineerPhone: null,
    toEngineerId: RECIPIENT,
    toEngineerName: "Recipient",
    toEngineerEmail: null,
    requestedById: RECIPIENT,
    requestedByEmail: null,
    requestedByKind: "engineer",
    reason: "Needed on site",
    notes: null,
    jobId: null,
    customerId: null,
    attachments: [],
    approvedBy: null,
    approvedAt: null,
    overrideByAdmin: false,
    declinedBy: null,
    declinedAt: null,
    declineReason: null,
    cancelledAt: null,
    completedAt: null,
    requireSignature: false,
    receiverSignatureUrl: null,
    acknowledgedAt: null,
    createdBy: null,
    createdAt: new Date("2026-09-01T09:00:00Z"),
    updatedAt: new Date("2026-09-01T09:00:00Z"),
    lines: [],
    ...over,
  }) as unknown as TransferWithLines;

// An office-arranged transfer: the office user is the requester, the engineer only receives it.
const officeArranged = () => transfer({ requestedById: OFFICE, requestedByKind: "admin" });

const fieldEngineer = (id: string) =>
  ({ type: "user", id, email: `${id}@example.test`, permissions: ["engineer.transfer"] }) as AuditActor;
// e.g. a Warehouse Manager — transfer oversight, and no "admin" anywhere in the role.
const oversight = { type: "user", id: "wm-1", email: "wm@example.test", permissions: ["engineer_stock.view", "engineer_stock.transfer"] } as AuditActor;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(transferRepo.cancelTx).mockImplementation(async () => transfer({ status: "cancelled" }));
  vi.mocked(transferRepo.declineTx).mockImplementation(async () => transfer({ status: "declined" }));
});

describe("cancel", () => {
  it("lets an engineer cancel a request they raised themselves", async () => {
    vi.mocked(transferRepo.findById).mockResolvedValue(transfer());

    const result = await cancel("t1", fieldEngineer(RECIPIENT));

    expect(transferRepo.cancelTx).toHaveBeenCalledWith("t1");
    expect(result.status).toBe("cancelled");
  });

  it("refuses the engineer an office-arranged request, even though it sits in their My requests", async () => {
    vi.mocked(transferRepo.findById).mockResolvedValue(officeArranged());

    await expect(cancel("t1", fieldEngineer(RECIPIENT))).rejects.toThrow(
      /^You do not have permission to cancel this transfer\.$/,
    );
    expect(transferRepo.cancelTx).not.toHaveBeenCalled();
  });

  it("still lets an office user with transfer oversight cancel it — authorisation is unchanged", async () => {
    vi.mocked(transferRepo.findById).mockResolvedValue(officeArranged());

    await cancel("t1", oversight);

    expect(transferRepo.cancelTx).toHaveBeenCalledWith("t1");
  });
});

describe("decline", () => {
  it("lets the stock holder decline", async () => {
    vi.mocked(transferRepo.findById).mockResolvedValue(transfer());

    const result = await decline("t1", "Van is empty", fieldEngineer(HOLDER));

    expect(transferRepo.declineTx).toHaveBeenCalledWith("t1", `${HOLDER}@example.test`, "Van is empty");
    expect(result.status).toBe("declined");
  });

  it("refuses anyone who is neither the holder nor oversight, with the neutral wording", async () => {
    vi.mocked(transferRepo.findById).mockResolvedValue(transfer());

    await expect(decline("t1", undefined, fieldEngineer(RECIPIENT))).rejects.toThrow(
      /^You do not have permission to decline this transfer\.$/,
    );
    expect(transferRepo.declineTx).not.toHaveBeenCalled();
  });

  it("still lets an office user with transfer oversight decline — authorisation is unchanged", async () => {
    vi.mocked(transferRepo.findById).mockResolvedValue(transfer());

    await decline("t1", undefined, oversight);

    expect(transferRepo.declineTx).toHaveBeenCalled();
  });
});
