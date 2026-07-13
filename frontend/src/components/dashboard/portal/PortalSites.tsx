"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MapPin, Search } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import type { PagedCustomerSites } from "@/services/customer.service";
import type { Msg } from "@/components/ui/types";

import {
  EmptyState,
  HeaderCardSkeleton,
  PortalHeader,
  StatusChip,
  TableCard,
  TableCardSkeleton,
} from "./portalUi";

const HEADERS = ["Code", "Site", "Address", "Postcode", "Contact", "Status"];
const SKELETON_CELLS = ["h-3 w-16", "h-3 w-36", "h-3 w-40", "h-3 w-16", "h-3 w-28", "h-5 w-20 rounded-full"];

// Customer portal — Sites (read-only). Sites can be bulk-imported in the THOUSANDS, so the list is
// server-paged with a search box; filters live in the URL (?q, ?sort, ?page) so they survive a
// refresh — the same pattern as every other list.
export function PortalSites() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const sortOldest = searchParams.get("sort") === "oldest"; // default: newest first
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedCustomerSites | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  const [searchInput, setSearchInput] = React.useState(search);
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/portal/sites?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patchParams({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patchParams]);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        const r = await customerService.getOwnSites({
          q: search || undefined,
          sort: sortOldest ? "oldest" : undefined,
          page,
          pageSize: 20,
        });
        if (active) {
          setPaged(r);
          setMsg(null);
        }
      } catch (err) {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your sites." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [search, sortOldest, page]);

  const sites = paged?.sites ?? [];
  const filtered = !!search;

  if (loading && paged === null) {
    return (
      <div className="space-y-6">
        <HeaderCardSkeleton />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={680} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortalHeader title="Sites" subtitle="Your sites and their on-site contacts." />

      {msg && <Notice msg={msg} />}

      {/* Toolbar — search + sort */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, code or postcode…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select
          size="sm"
          value={sortOldest ? "oldest" : "newest"}
          onChange={(v) => patchParams({ sort: v === "oldest" ? "oldest" : null }, true)}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
          ariaLabel="Sort order"
        />
      </div>

      {msg?.type === "error" ? null : loading ? (
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={680} />
      ) : sites.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title={filtered ? "No matching sites" : "No sites yet"}
          hint={filtered ? "Try a different search." : "When your account team adds a site, it'll appear here."}
        />
      ) : (
        <>
          <TableCard headers={HEADERS} minWidth={680}>
            {sites.map((s) => (
              <tr key={s.id} className="border-b border-[var(--border)] align-top last:border-0">
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{s.code ?? "—"}</td>
                <td className="px-4 py-3 font-semibold text-[var(--ink)]">{s.name}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{[s.addressLine1, s.addressLine2, s.city, s.county].filter(Boolean).join(", ") || "—"}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{s.postcode ?? "—"}</td>
                <td className="px-4 py-3 text-[var(--muted)]">
                  {s.contactPerson ? (
                    <div>
                      <div className="text-[var(--ink)]">{s.contactPerson}</div>
                      {s.contactNumber && (
                        <div className="text-[11px] text-[var(--faint)]">{s.contactNumber}</div>
                      )}
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusChip value={s.status} />
                </td>
              </tr>
            ))}
          </TableCard>
          <Pagination
            page={paged?.page ?? 1}
            totalPages={paged?.totalPages ?? 1}
            total={paged?.total ?? 0}
            label="sites"
            onPage={(p) => patchParams({ page: p > 1 ? String(p) : null })}
          />
        </>
      )}
    </div>
  );
}
