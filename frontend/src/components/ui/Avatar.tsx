import { optimizeCloudinaryUrl } from "@/lib/utils";

function initials(firstName: string, lastName: string): string {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase() || "?";
}

// User avatar — the uploaded image (Cloudinary, auto-optimised) or initials.
export function Avatar({
  url,
  firstName,
  lastName,
  size = 40,
}: {
  url?: string | null;
  firstName: string;
  lastName: string;
  size?: number;
}) {
  const style = { width: size, height: size };
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={optimizeCloudinaryUrl(url)}
        alt={`${firstName} ${lastName}`}
        style={style}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      style={style}
      className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-[#5b8def] to-[var(--accent)] text-xs font-extrabold text-white"
    >
      {initials(firstName, lastName)}
    </span>
  );
}
