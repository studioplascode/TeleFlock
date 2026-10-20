import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Shimmering placeholder block. Size it with className (e.g. "h-4 w-32 rounded-sm"). */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("tf-skeleton tf-loop rounded-sm", className)} aria-hidden {...rest} />;
}
