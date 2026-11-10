import type { QuickCommand } from "@/core/quickCommand";
import { cn } from "@/design";
import { quickWhat } from "./quick";

/**
 * The draft is one of omp's quick commands: what Enter does with it, as omp's own composer shows
 * by recolouring its editor. `blocked`: why this session can't run it.
 */
export function QuickCue({ quick, blocked, className }: { quick: QuickCommand; blocked: string | null; className?: string }) {
  const { kind, output } = quickWhat(quick);
  return (
    <div data-quick-cue={quick.prefix} aria-live="polite" className={cn("flex min-w-0 items-center gap-2 text-[11.5px] font-semibold", className)}>
      <span
        className={cn(
          "grid h-5 min-w-5 shrink-0 place-items-center rounded-[7px] px-1 font-mono text-[11px] font-extrabold",
          quick.python ? "bg-omp-blue/15 text-omp-blue" : "bg-accent/15 text-accent-hi",
        )}
      >
        {quick.prefix}
      </span>
      <span className="shrink-0 text-ink-2">{kind}</span>
      <span className={cn("min-w-0 truncate", blocked ? "text-warn" : "text-mute")}>· {blocked ?? output}</span>
    </div>
  );
}
