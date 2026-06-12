"use client";

import * as React from "react";
import { MapPin } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import type { CustomerSite } from "@/types/customer";
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

// Customer portal — Sites (read-only). The customer's physical sites as set up by
// their account team; view-only from the portal.
export function PortalSites() {
  const [sites, setSites] = React.useState<CustomerSite[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await customerService.getOwnSites();
        if (active) setSites(list);
      } catch (err) {
        if (active) {
          setMsg({
            type: "error",
            text: err instanceof Error ? err.message : "Could not load your sites.",
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
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

      {msg?.type === "error" ? null : sites.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No sites yet"
          hint="When your account team adds a site, it'll appear here."
        />
      ) : (
        <TableCard headers={HEADERS} minWidth={680}>
          {sites.map((s) => (
            <tr key={s.id} className="border-b border-[var(--border)] align-top last:border-0">
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{s.code ?? "—"}</td>
              <td className="px-4 py-3 font-semibold text-[var(--ink)]">{s.name}</td>
              <td className="px-4 py-3 text-[var(--muted)]">{s.addressLine ?? "—"}</td>
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
      )}
    </div>
  );
}
