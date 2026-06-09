"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Search, Users2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { primaryBtn } from "@/components/ui/styles";
import { CustomerFormModal } from "./CustomerFormModal";
import type { CustomerSummary } from "@/types/customer";
import type { UserStatus } from "@/types/user";

const PAGE_SIZE = 20;

export function CustomersView() {
  const router = useRouter();
  const { can } = useAuth();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(() =>
    customerService.getCachedCustomers({ pageSize: PAGE_SIZE }),
  );
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Debounce the search box so each keystroke doesn't fire a request.
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch whenever the page, the debounced query, or a refresh trigger changes.
  // All setState lives inside the async IIFE (not the effect body) so it isn't a
  // synchronous setState-in-effect.
  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { search: debounced || undefined, page, pageSize: PAGE_SIZE };
      const cached = customerService.getCachedCustomers(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await customerService.listCustomers(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load customers.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [debounced, page, refreshKey]);

  // Search changes reset to page 1 (in the handler, not an effect).
  const onSearchChange = (v: string) => {
    setSearch(v);
    setPage(1);
  };
  const reload = () => setRefreshKey((k) => k + 1);

  const customers = data?.customers ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Customers</h1>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Customer companies and their read-only portal access.
          </p>
        </div>
        {can("customers.create") && (
          <button onClick={() => setShowCreate(true)} className={primaryBtn}>
            <Plus className="h-4 w-4" />
            Add customer
          </button>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by name, code, email or contact…"
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2.5 pl-10 pr-3.5 text-sm text-[var(--ink)] outline-none transition-all placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" />
          </div>
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Users2 className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">
              {debounced ? "No customers match your search" : "No customers yet"}
            </p>
            {!debounced && can("customers.create") && (
              <button
                onClick={() => setShowCreate(true)}
                className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80"
              >
                Add your first customer
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c: CustomerSummary) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/dashboard/customers/${c.customerCode}`)}
                  className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                >
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{c.customerCode}</td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{c.name}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{c.contactPerson ?? "—"}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{c.email}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status as UserStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.total > 0 && (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          label="customers"
          onPage={setPage}
        />
      )}

      {showCreate && (
        <CustomerFormModal
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
