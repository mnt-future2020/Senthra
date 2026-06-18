import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// The id of the first ACTIVE entry in a master-data list (type, category, …), or ""
// if there is none. Used to preselect a required dropdown on create AND to seed the
// dirty-check baseline with that same default — so an auto-applied default is never
// mistaken for a user edit (which would otherwise trip the unsaved-changes guard).
export function firstActiveId<T extends { id: string; status?: string | null }>(list: T[]): string {
  return list.find((x) => x.status === "active")?.id ?? "";
}

// Insert Cloudinary auto-format + auto-quality transforms into a delivery URL so
// Cloudinary serves an optimized image (webp/avif, right quality) straight from
// its CDN. No-op for non-Cloudinary URLs or if already transformed.
export function optimizeCloudinaryUrl(url: string): string {
  if (!url.includes("res.cloudinary.com/") || !url.includes("/upload/")) return url;
  if (url.includes("/upload/f_auto")) return url;
  return url.replace("/upload/", "/upload/f_auto,q_auto/");
}
