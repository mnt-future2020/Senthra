import Link from "next/link";

import { Avatar } from "@/components/ui/Avatar";

// A staff user referenced from another record — a warehouse's manager, a supplier's internal
// owner, an IRM item's owner. Every such reference carries at least id/name/email/jobTitle; the
// name parts + image are optional because only some endpoints send them (initials are derived
// from `name` when they're absent).
export interface StaffRef {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  firstName?: string;
  lastName?: string;
  profileImageUrl?: string | null;
}

// Split a display name into the two parts Avatar needs for initials. "Gokul Rajan" → G + R;
// a single-word name yields one initial rather than a "?" placeholder.
function nameParts(staff: StaffRef): { first: string; last: string } {
  if (staff.firstName || staff.lastName) {
    return { first: staff.firstName ?? "", last: staff.lastName ?? "" };
  }
  const [first = "", ...rest] = staff.name.trim().split(/\s+/);
  return { first, last: rest.at(-1) ?? "" };
}

// THE staff presentation for detail pages — avatar, name · job title, email. Used everywhere a
// record points at a person so the Management cards across Warehouses / Suppliers / IRM read
// identically. Pass `href` to link the name through to that user's page; omit it when the viewer
// can't open the target, so nobody is handed a link that 403s.
export function StaffChip({ staff, href, size = 36 }: { staff: StaffRef; href?: string; size?: number }) {
  const { first, last } = nameParts(staff);
  const name = (
    <span className="font-semibold text-[var(--ink)]">
      {staff.name}
      {staff.jobTitle && (
        <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">· {staff.jobTitle}</span>
      )}
    </span>
  );
  return (
    <div className="flex items-center gap-3">
      <Avatar url={staff.profileImageUrl} firstName={first} lastName={last} size={size} />
      <div className="min-w-0">
        {href ? (
          <Link href={href} className="hover:text-[var(--accent)] hover:underline">
            {name}
          </Link>
        ) : (
          name
        )}
        <a
          className="block truncate text-xs text-[var(--accent)] hover:underline"
          href={`mailto:${staff.email}`}
        >
          {staff.email}
        </a>
      </div>
    </div>
  );
}

// The shared empty state, so "nobody assigned" reads the same on every detail page.
export function NoStaffAssigned({ label }: { label: string }) {
  return <span className="text-[var(--faint)]">{label}</span>;
}
