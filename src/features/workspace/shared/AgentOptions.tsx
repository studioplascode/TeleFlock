import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useId, useState } from "react";
import { cn, spring } from "@/design";

export interface AgentOptionsProps {
  /** What is set: one chip per section that has something (null / false entries are skipped). */
  summary?: readonly ReactNode[];
  /** Start expanded (default: collapsed). */
  defaultOpen?: boolean;
  className?: string;
  /** `AgentOptionsSection`s. */
  children: ReactNode;
}

/**
 * "Agent options": the optional per-agent settings of a launch (New agent, New worktree, Fan out
 * variants, Dispatch, Automations), collapsed by default. The header shows each section's summary
 * chip, so what is set stays visible while collapsed; the body stacks the sections.
 */
export function AgentOptions({ summary = [], defaultOpen = false, className, children }: AgentOptionsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const chips = summary.filter((c) => c !== null && c !== undefined && c !== false && c !== "");
  return (
    <div className={cn("flex min-w-0 flex-col rounded-lg well", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3.5 py-2 text-left focus-ring"
      >
        <SlidersHorizontal className="size-4 shrink-0 text-mute" />
        <span className="text-sm font-bold text-ink">Agent options</span>
        {chips.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {chips.map((c, i) => (
              <span key={i} className="contents">
                {c}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-2xs font-semibold text-mute-2">optional</span>
        )}
        <ChevronDown className={cn("ml-auto size-4 shrink-0 text-mute transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={bodyId}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.smooth}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-5 border-t border-line px-3.5 pt-3 pb-3.5 max-md:px-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** One section of `AgentOptions`: a small heading, an optional note, its controls. */
export function AgentOptionsSection({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div>
        <h4 className="kicker">{title}</h4>
        {note && <p className="mt-0.5 text-xs text-mute">{note}</p>}
      </div>
      {children}
    </section>
  );
}
