"use client";

import { ExternalLink, MapPin, X } from "lucide-react";

import type { JobKitWarehouse } from "@/types/job";
import { ghostBtn, primaryBtn } from "@/components/ui/styles";

// "Where do I collect this?" for an engineer, who has no warehouse-module access and so cannot look a
// warehouse up for themselves. Shared by the job kit list and van stock requests: both hand the
// engineer a line and expect them to drive somewhere, so both open the same panel.
//
// The address is passed in LIVE from the server (not snapshotted with the line) — an engineer sent to
// a stale address is sent to the wrong place.
export function WarehousePickupModal({ wh, onClose }: { wh: JobKitWarehouse; onClose: () => void }) {
  const addressParts = [wh.addressLine1, wh.addressLine2, wh.city, wh.county, wh.postcode, wh.country].filter(Boolean) as string[];
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([wh.name, ...addressParts].join(", "))}`;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-[var(--ink)]">
              <MapPin className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              <span className="truncate">{wh.name}</span>
            </h3>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--faint)]">{wh.code}</p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Pickup address</p>
            {addressParts.length > 0 ? (
              <address className="mt-1 not-italic leading-relaxed text-[var(--ink)]">
                {addressParts.map((p, i) => (
                  <span key={i} className="block">{p}</span>
                ))}
              </address>
            ) : (
              <p className="mt-1 text-[var(--muted)]">No address on file for this warehouse.</p>
            )}
          </div>
          {wh.contactPhone && (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Contact</p>
              <a href={`tel:${wh.contactPhone}`} className="mt-1 block font-semibold text-[var(--accent)] hover:underline">{wh.contactPhone}</a>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>Close</button>
          {addressParts.length > 0 && (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={primaryBtn}>
              <ExternalLink className="h-4 w-4" /> Open in Maps
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
