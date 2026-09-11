"use client";

import * as React from "react";

import { listCustomerOptions, listCustomerProjectOptions } from "@/services/customer.service";
import { listWarehouseOptions } from "@/services/warehouse.service";
import { listIrmItems } from "@/services/irm.service";
import { listEngineerOptions } from "@/services/stockPosition.service";
import { markInactive } from "@/lib/historicalOption";
import type { IrmItem } from "@/types/irm";

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
// Every list is COMPLETE — the lean options endpoints, never a page of a list read. The pickers used to
// load `pageSize: 200` from the list endpoints, which the server clamps to 100, so the 101st customer or
// warehouse simply had no row. Items are the exception: the catalogue is searched server-side by the
// item picker, and this only loads the first page it shows before anything is typed.
//
// Each options endpoint admits `reports.view`, so a report user can fill every picker. The one
// exception is the customer (and so project) list for a WAREHOUSE-SCOPED user, whose reports are scoped
// to their warehouses: the caller passes `customers: false` and hides those filters rather than
// fetching a list the server refuses (see lib/pickerAccess). A genuine failure still degrades to an
// empty list rather than failing the screen.

export interface Option {
  value: string;
  label: string;
}

export interface FilterOptions {
  customers: Option[];
  warehouses: Option[];
  /** Whole rows, not {value,label}: the item picker seeds from these and labels the selected one. */
  items: IrmItem[];
  engineers: Option[];
}

const EMPTY: FilterOptions = { customers: [], warehouses: [], items: [], engineers: [] };

/** The first page of the catalogue the item picker offers before anything is typed. */
const ITEM_SEED_PAGE = 100;

/**
 * The lookup lists, loaded once per mount.
 *
 * `customers: false` skips the customer list for a viewer who may not read it (see the header).
 */
export function useReportFilterOptions({ enabled = true, customers: loadCustomers = true }: { enabled?: boolean; customers?: boolean } = {}): FilterOptions {
  const [lists, setLists] = React.useState<FilterOptions>(EMPTY);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    void (async () => {
      const [customers, warehouses, items, engineers] = await Promise.all([
        // Deactivated customers too, labelled "(inactive)": a report reads history, and a retired
        // customer still owns its rows.
        loadCustomers
          ? listCustomerOptions({ includeInactive: true })
              .then((cs) => cs.map((c) => ({ value: c.id, label: markInactive(c.name, c.inactive) })))
              .catch(() => [])
          : Promise.resolve([] as Option[]),
        listWarehouseOptions()
          .then((ws) => ws.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` })))
          .catch(() => []),
        listIrmItems({ status: "active", pageSize: ITEM_SEED_PAGE })
          .then((r) => r.items)
          .catch(() => [] as IrmItem[]),
        listEngineerOptions()
          .then((r) => r.map((e) => ({ value: e.engineerId, label: e.name })))
          .catch(() => []),
      ]);
      if (active) setLists({ customers, warehouses, items, engineers });
    })();
    return () => {
      active = false;
    };
  }, [enabled, loadCustomers]);

  return lists;
}

/**
 * Projects for the selected customer — the complete set, via the lean project options.
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
      const rows = await listCustomerProjectOptions(customerId)
        .then((ps) => ps.map((p) => ({ value: p.id, label: p.name })))
        .catch(() => []);
      if (active) setLoaded({ customerId, projects: rows });
    })();
    return () => {
      active = false;
    };
  }, [customerId]);

  return loaded && loaded.customerId === customerId ? loaded.projects : [];
}
