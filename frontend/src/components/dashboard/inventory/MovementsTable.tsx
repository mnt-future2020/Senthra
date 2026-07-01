"use client";

import * as React from "react";

import * as svc from "@/services/stockPosition.service";
import { MovementFeed, type MovementFetcher } from "./MovementFeed";

// The Inventory Hub "Movements" tab — the company-wide Stock Movement History (every stock-affecting
// ledger leg across all pools), cursor-paginated. Reads the unified ledger via /inventory/movements.
const adminFetcher: MovementFetcher = (params) => svc.listMovements(params);

export function MovementsTable() {
  return (
    <div className="flex h-full flex-col gap-3">
      <p className="shrink-0 text-xs text-[var(--muted)]">
        Every stock movement across all pools — warehouse, engineer van, customer consignment and damaged. Newest first.
      </p>
      <div className="min-h-0 flex-1">
        <MovementFeed fetcher={adminFetcher} scope="admin" />
      </div>
    </div>
  );
}
