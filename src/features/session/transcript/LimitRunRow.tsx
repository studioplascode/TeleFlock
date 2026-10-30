import { ChevronDown, CircleAlert } from "lucide-react";
import { useState } from "react";
import { useSessionItem } from "@/core";
import { cn } from "@/design";
import { type LimitRun, LIMIT_WORDS } from "./limitRuns";
import { Row } from "./rows";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** The label of a folded run: "Rate limited ×4 · 16:54–16:59" (one time when the run fits in a minute). */
export function runLabel(run: LimitRun): string {
  const a = timeFmt.format(run.from);
  const b = timeFmt.format(run.to);
  return `${LIMIT_WORDS[run.kind]} ×${run.errors} · ${a === b ? a : `${a}–${b}`}`;
}

/**
 * Consecutive provider-limit errors (omp's wait on a rate or usage limit makes every background
 * delivery fail the same way) as one row; tap it to read each failure and the system turns between
 * them. Presentation only: the rows stay in the transcript.
 */
export function LimitRunRow({ agentKey, run }: { agentKey: string; run: LimitRun }) {
  const [open, setOpen] = useState(false);
  const last = useSessionItem(agentKey, run.members.at(-1) ?? run.leader);
  const lastError = last?.kind === "assistant" ? last.error : undefined;
  return (
    <div className="pl-[var(--tf-gutter,38px)]" data-testid="limit-run">
      <button
        type="button"
        data-find-skip
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring flex w-full min-w-0 items-start gap-2 rounded-md bg-error/10 px-3 py-2 text-left text-xs text-[#ff9aab] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.3)] hover:bg-error/15"
      >
        <CircleAlert className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-bold">
            {runLabel(run)}
            <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
          </span>
          {!open && lastError && <span className="mt-0.5 block truncate font-mono text-[10.5px] opacity-80">{lastError}</span>}
        </span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 border-l border-error/25 pl-3">
          {run.members.map((id) => (
            <Row key={id} agentKey={agentKey} itemId={id} />
          ))}
        </div>
      )}
    </div>
  );
}
