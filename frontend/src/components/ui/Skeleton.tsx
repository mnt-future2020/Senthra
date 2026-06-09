import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

// Loading placeholder. Compose several blocks (sized with utility classes) to
// mirror the real content's layout so the page doesn't shift when data arrives.
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-md", className)} {...props} />;
}
