import { AnimatePresence, motion } from "motion/react";
import { cn, spring } from "@/design";
import { quickWhat, useRuns } from "./quick";

/**
 * The "Running" strip above the composer: quick commands (`!ls`, `$ code`) this client ran whose
 * row has not reached the transcript yet. omp records a run when it ends, so a chip stays as long
 * as the command runs (`useRuns`).
 */
export function RunStrip({ agentKey }: { agentKey: string }) {
  const runs = useRuns(agentKey);
  return (
    <AnimatePresence initial={false}>
      {runs.length > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="mb-2 flex flex-wrap items-center gap-1.5 overflow-hidden px-1"
          aria-label="Running commands"
        >
          <span className="mr-0.5 text-[10px] font-extrabold tracking-[0.1em] text-mute-2 uppercase">Running · {runs.length}</span>
          <AnimatePresence initial={false} mode="popLayout">
            {runs.map((r) => {
              const { kind, output } = quickWhat(r);
              return (
                <motion.span
                  layout
                  key={r.id}
                  initial={{ opacity: 0, scale: 0.8, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0, transition: spring.bouncy }}
                  exit={{ opacity: 0, scale: 0.85, y: -10, transition: { duration: 0.22 } }}
                  title={`${kind} · ${output}${r.sending ? "\nStarting…" : ""}\n${r.body}`}
                  className={cn(
                    "flex max-w-[300px] min-w-0 items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-[11.5px] font-semibold shadow-hairline",
                    r.python ? "bg-omp-blue/12 text-ink-2" : "bg-accent/14 text-accent-ink",
                    r.sending && "opacity-70",
                  )}
                >
                  <span className={cn("shrink-0 rounded-full px-1.5 py-px font-mono text-[10px] font-extrabold", r.python ? "bg-omp-blue/20 text-omp-blue" : "bg-accent/25 text-accent-hi")}>
                    {r.prefix}
                  </span>
                  <span className="truncate font-mono">{r.body.split("\n")[0]}</span>
                  <span className="tf-loop size-1.5 shrink-0 animate-breathe rounded-full bg-current opacity-70" aria-hidden />
                </motion.span>
              );
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
