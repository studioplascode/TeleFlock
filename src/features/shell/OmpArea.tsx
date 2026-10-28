import { Blocks, KeyRound, type LucideIcon, SlidersHorizontal } from "lucide-react";
import { navigate } from "@/core";
import { cn } from "@/design";
import { haptic } from "./haptics";
import { VIEWS } from "./vocab";

/** omp's per-host pages, in nav order. */
export type OmpAreaPage = "omp" | "mcp" | "accounts";

const PAGES: readonly { name: OmpAreaPage; icon: LucideIcon; label: string }[] = [
  { name: "omp", icon: SlidersHorizontal, label: VIEWS.omp.label },
  { name: "mcp", icon: Blocks, label: VIEWS.mcp.label },
  { name: "accounts", icon: KeyRound, label: VIEWS.accounts.label },
];

/**
 * omp's per-host pages (settings, MCP servers) as one area: a strip at the top of each links to the
 * others for the same host, so finding one of them finds all of them.
 */
export function OmpAreaNav({ current, hostId, className }: { current: OmpAreaPage; hostId?: string; className?: string }) {
  return (
    <nav aria-label="omp on this host" className={cn("-mx-1 flex gap-1 overflow-x-auto px-1 no-scrollbar", className)}>
      {PAGES.map(({ name, icon: Icon, label }) => {
        const active = name === current;
        return (
          <button
            key={name}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (active) return;
              haptic("tick");
              navigate({ name, hostId });
            }}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold transition-colors focus-ring",
              active ? "bg-accent/16 text-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]" : "text-mute hover:bg-white/6 hover:text-ink",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
