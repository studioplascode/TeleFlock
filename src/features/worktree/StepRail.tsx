import { motion } from "motion/react";
import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import { cn, spring } from "@/design";

export interface StepRailProps {
  steps: readonly string[];
  current: number;
  /** Highest step the user may jump to. */
  reachable: number;
  onJump: (index: number) => void;
}

/** Wizard progress: numbered nodes on a track that fills with the omp gradient as you advance. */
export function StepRail({ steps, current, reachable, onJump }: StepRailProps) {
  const frac = steps.length > 1 ? current / (steps.length - 1) : 0;
  const reach = steps.length > 1 ? Math.max(current, reachable) / (steps.length - 1) : 0;
  return (
    <nav aria-label="Steps" className="relative md:pt-1.5">
      <div className="absolute top-[13px] right-[calc(100%/var(--n)/2)] left-[calc(100%/var(--n)/2)] h-0.5 rounded-full bg-white/8 md:top-[19px]" style={{ "--n": steps.length } as CSSProperties}>
        {/* how far you could jump right now: a faint lead ahead of the solid progress */}
        <motion.div className="absolute inset-y-0 left-0 rounded-full bg-accent/30" initial={false} animate={{ width: `${reach * 100}%` }} transition={spring.smooth} />
        <motion.div className="relative h-full rounded-full bg-omp shadow-glow-accent" initial={false} animate={{ width: `${frac * 100}%` }} transition={spring.smooth} />
      </div>
      <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((label, i) => {
          const done = i < current;
          const on = i === current;
          const can = i <= reachable && !on;
          return (
            <li key={label} className="flex justify-center">
              <button
                type="button"
                onClick={() => can && onJump(i)}
                disabled={!can && !on}
                tabIndex={on ? -1 : undefined}
                aria-current={on ? "step" : undefined}
                aria-label={`${label}, step ${i + 1} of ${steps.length}${done ? ", done" : ""}`}
                className={cn("group flex flex-col items-center gap-1.5 rounded-sm px-1 focus-ring", can ? "cursor-pointer" : "cursor-default")}
              >
                <motion.span
                  className={cn(
                    "relative grid size-7 place-items-center rounded-full text-xs font-extrabold transition-colors duration-300",
                    on && "bg-omp text-white shadow-glow-accent",
                    done && "bg-accent/25 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.6)]",
                    !on && !done && can && "bg-tile-3 text-ink-2 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)] group-hover:text-ink",
                    !on && !done && !can && "bg-tile-3 text-mute-2 shadow-hairline",
                  )}
                  animate={{ scale: on ? 1.08 : 1 }}
                  transition={spring.bouncy}
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                  {on && <span className="tf-loop absolute -inset-1 animate-ping-soft rounded-full shadow-[0_0_0_2px_rgb(163_92_240/0.5)]" aria-hidden />}
                </motion.span>
                <span className={cn("text-2xs font-bold transition-colors", on ? "text-ink" : done || can ? "text-ink-2 group-hover:text-ink" : "text-mute-2")}>{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
