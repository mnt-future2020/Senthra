import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Insert Cloudinary auto-format + auto-quality transforms into a delivery URL so
// Cloudinary serves an optimized image (webp/avif, right quality) straight from
// its CDN. No-op for non-Cloudinary URLs or if already transformed.
export function optimizeCloudinaryUrl(url: string): string {
  if (!url.includes("res.cloudinary.com/") || !url.includes("/upload/")) return url;
  if (url.includes("/upload/f_auto")) return url;
  return url.replace("/upload/", "/upload/f_auto,q_auto/");
}
