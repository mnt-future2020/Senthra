"use client";

import * as React from "react";

import { listCustomers, listCustomerProjects } from "@/services/customer.service";
import { listWarehouses } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { listEngineerInventory } from "@/services/stockPosition.service";

// ── Option lists for the Custom Reports filter bar ────────────────────────────────────────────
//
// Every id-valued filter on a custom report is a PICKER, never a typed id.
//
// The filters shipped as free-text boxes labelled "ID", which asked a user to know and type a Mongo
// ObjectId — and there is nowhere in this app that shows one. Anything else typed in reached the
// server as an equality filter on an ObjectId column and came back as a malformed-ObjectID error, so
// the only two outcomes were "no rows" and "a crash". The same lists already back the Stock Movement
// feed's filters (MovementFeed), which is where this pattern comes from.
//
// Every fetch is permission-gated server-side and every one degrades to an EMPTY list rather than
// failing the screen: `reports.view` does not imply `customers.view`, so a legitimate report user may
// hold none of these. An empty list renders as "All customers" alone — that dimension simply cannot
// be narrowed, which is honest, and better than a control that 403s on use.

export interface Option {
  value: string;
  label: string;
}

export interface FilterOptions {
  customers: Option[];
  warehouses: Option[];
  items: Option[];
  engineers: Option[];
}

const EMPTY: FilterOptions = { customers: [], warehouses: [], items: [], engineers: [] };

/** How many of each bounded entity the pickers carry. Matches MovementFeed's own ceiling. */
const PICKER_PAGE = 200;

/**
 * The lookup lists, loaded once per mount.
 *
 * Not memo-cached across mounts on purpose: the underlying services already cache their list reads,
 * so a second visit is served from there rather than from a copy this module would have to invalidate.
 */
export function useReportFilterOptions(enabled = true): FilterOptions {
  const [lists, setLists] = React.useState<FilterOptions>(EMPTY);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    void (async () => {
      const [customers, warehouses, items, engineers] = await Promise.all([
        listCustomers({ pageSize: PICKER_PAGE })
          .then((r) => r.customers.map((c) => ({ value: c.id, label: c.name })))
          .catch(() => []),
        listWarehouses({ status: "active", pageSize: PICKER_PAGE })
          .then((r) => r.warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` })))
          .catch(() => []),
        listIrmItems({ status: "active", pageSize: PICKER_PAGE })
          .then((r) =>
            r.items
              .map((i) => ({ value: i.id, label: i.code ? `${i.code} — ${i.name}` : i.name }))
              .sort((a, b) => a.label.localeCompare(b.label)),
          )
          .catch(() => []),
        listEngineerInventory()
          .then((r) => r.map((e) => ({ value: e.engineerId, label: e.name })))
          .catch(() => []),
      ]);
      if (active) setLists({ customers, warehouses, items, engineers });
    })();
    return () => {
      active = false;
    };
  }, [enabled]);

  return lists;
}

/**
 * Projects for the selected customer.
 *
 * Deliberately DEPENDENT rather than a flat list of every project in the system. There is no
 * all-customers project endpoint, and there should not be one for this: a project is only meaningful
 * beside the customer it belongs to, and "Project Activity" — the one report that accepts this
 * filter — already offers `customerId`. So the control asks for the customer first, which is also how
 * a person describes the query they actually want.
 *
 * Returns an empty list with no customer selected; the caller renders that state as a disabled
 * picker saying so, rather than an enabled one with nothing in it.
 */
export function useProjectOptions(customerId: string | undefined): Option[] {
  // Keyed by the customer it was fetched FOR, and the answer is derived from that key rather than
  // cleared by the effect. Two things fall out of it: the previous customer's projects can never be
  // shown against a newly-picked one, and there is no synchronous setState in the effect body (which
  // is a cascading render, and what the React Compiler lint rule objects to). Same shape as
  // ScheduleForm's recipient lookup.
  const [loaded, setLoaded] = React.useState<{ customerId: string; projects: Option[] } | null>(null);

  React.useEffect(() => {
    if (!customerId) return;
    let active = true;
    void (async () => {
      const rows = await listCustomerProjects(customerId, { pageSize: PICKER_PAGE })
        .then((r) => r.projects.map((p) => ({ value: p.id, label: p.name })))
        .catch(() => []);
      if (active) setLoaded({ customerId, projects: rows });
    })();
    return () => {
      active = false;
    };
  }, [customerId]);

  return loaded && loaded.customerId === customerId ? loaded.projects : [];
}
