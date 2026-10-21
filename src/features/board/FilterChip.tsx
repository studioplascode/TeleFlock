import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn, spring } from "@/design";
import { useBoard } from "./boardStore";

/** "Filtered: <q> ✕" — visible whenever the board search is active (e.g. after a fan-out). */
export function FilterChip({ className }: { className?: string }) {
  const q = useBoard((s) => s.q.trim());
  const setQ = useBoard((s) => s.setQ);
  return (
    <AnimatePresence initial={false}>
      {q && (
        <motion.span
          key="filter"
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85 }}
          transition={spring.snappy}
          className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent/14 py-1 pr-1 pl-3 text-xs font-bold text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]", className)}
        >
          <span className="text-mute">Filtered:</span>
          <span className="min-w-0 truncate">{q}</span>
          <button type="button" aria-label="Clear filter" onClick={() => setQ("")} className="grid size-7 shrink-0 place-items-center rounded-full pressable focus-ring hover:bg-accent/25">
            <X className="size-3.5" aria-hidden />
          </button>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
