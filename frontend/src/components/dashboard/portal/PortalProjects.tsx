"use client";

import * as React from "react";
import { FolderKanban } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import type { CustomerProject } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

import {
  EmptyState,
  fmtDate,
  HeaderCardSkeleton,
  PortalHeader,
  StatusChip,
  TableCard,
  TableCardSkeleton,
} from "./portalUi";

const HEADERS = ["Code", "Project", "Type", "Start", "End", "Status"];
const SKELETON_CELLS = ["h-3 w-16", "h-3 w-40", "h-3 w-20", "h-3 w-20", "h-3 w-20", "h-5 w-20 rounded-full"];

// Customer portal — Projects (read-only). The customer's projects exactly as their
// account team set them up; the portal user can view but never edit them.
export function PortalProjects() {
  const [projects, setProjects] = React.useState<CustomerProject[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await customerService.getOwnProjects();
        if (active) setProjects(list);
      } catch (err) {
        if (active) {
          setMsg({
            type: "error",
            text: err instanceof Error ? err.message : "Could not load your projects.",
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
      <PortalHeader title="Projects" subtitle="The projects your account team is running for you." />

      {msg && <Notice msg={msg} />}

      {msg?.type === "error" ? null : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          hint="When your account team sets up a project, it'll appear here."
        />
      ) : (
        <TableCard headers={HEADERS} minWidth={680}>
          {projects.map((p) => (
            <tr key={p.id} className="border-b border-[var(--border)] align-top last:border-0">
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{p.code ?? "—"}</td>
              <td className="px-4 py-3">
                <div className="font-semibold text-[var(--ink)]">{p.name}</div>
                {p.description && (
                  <div className="mt-0.5 max-w-md text-[11px] text-[var(--muted)]">
                    {p.description}
                  </div>
                )}
              </td>
              <td className="px-4 py-3 text-[var(--muted)]">{p.type ?? "—"}</td>
              <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(p.startDate)}</td>
              <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(p.endDate)}</td>
              <td className="px-4 py-3">
                <StatusChip value={p.status} />
              </td>
            </tr>
          ))}
        </TableCard>
      )}
    </div>
  );
}
