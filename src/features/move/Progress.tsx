import { Check, CircleCheck, Minus, TriangleAlert, Undo2, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn, Shimmer, Spinner } from "@/design";
import type { MoveFailure, MoveProgress, MoveStepView } from "@/core/move";
import { formatBytes } from "@/core/upload";
import type { MoveEntry } from "./store";

/* The running move: its steps, the copy's bytes, then the result. */

function StepIcon({ state }: { state: MoveStepView["state"] }): ReactNode {
  switch (state) {
    case "running":
      return <Spinner size={14} label="Running" />;
    case "done":
      return <Check className="size-3.5 text-done" aria-label="Done" />;
    case "failed":
      return <X className="size-3.5 text-error" aria-label="Failed" />;
    case "undone":
      return <Undo2 className="size-3.5 text-mute" aria-label="Undone" />;
    case "skipped":
      return <Minus className="size-3.5 text-mute-2" aria-label="Skipped" />;
    default:
      return <span className="size-1.5 rounded-full bg-white/20" role="img" aria-label="Waiting" />;
  }
}

function CopyBar({ sent, total }: { sent: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  return (
    <div className="mt-1.5 flex items-center gap-2.5">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={sent}>
        <div className="h-full rounded-full bg-omp transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-2xs text-mute tabular-nums">
        {formatBytes(sent)} / {formatBytes(total)}
      </span>
    </div>
  );
}

/** Every step in order (the source's, the copy, the target's, the final mark). */
export function StepList({ progress }: { progress: MoveProgress | null }) {
  if (!progress || progress.steps.length === 0) {
    return (
      <p className="flex items-center gap-2.5 text-sm text-mute">
        <Spinner size={14} label="Starting" />
        <Shimmer>Starting…</Shimmer>
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-0.5" aria-label="Move steps">
      {progress.steps.map((s) => (
        <li key={s.key} data-state={s.state} className="flex items-start gap-3 py-1.5">
          <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
            <StepIcon state={s.state} />
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm font-bold", s.state === "pending" || s.state === "skipped" ? "text-mute" : s.state === "undone" ? "text-mute line-through decoration-white/20" : s.state === "failed" ? "text-error" : "text-ink")}>{s.label}</p>
            {s.detail && <p className="text-xs text-mute [overflow-wrap:anywhere]">{s.detail}</p>}
            {s.side === "copy" && (s.state === "running" || progress.total > 0) && <CopyBar sent={progress.sent} total={progress.total} />}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** What the stage line says while the move runs. */
export function stageLine(p: MoveProgress | null, dstLabel: string): string {
  switch (p?.stage) {
    case "copying":
      return `Copying to ${dstLabel}…`;
    case "receiving":
      return `${dstLabel} is setting the agent up…`;
    case "confirming":
      return `Confirming the agent started on ${dstLabel}… It stays parked here until then; nothing is rolled back.`;
    case "finishing":
      return "Finishing up…";
    case "cancelling":
      return "Cancelling: stopping and putting everything back…";
    case "rollingBack":
      return "Something went wrong: putting everything back…";
    default:
      return "Preparing the agent…";
  }
}

export function Running({ entry }: { entry: MoveEntry }) {
  const stage = entry.progress?.stage;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-bold" aria-live="polite">
        {stage === "cancelling" || stage === "rollingBack" ? <Shimmer>{stageLine(entry.progress, entry.dstLabel)}</Shimmer> : stageLine(entry.progress, entry.dstLabel)}
      </p>
      <StepList progress={entry.progress} />
      <p className="text-xs text-mute">You can close this: the move keeps going and tells you when it is done.</p>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 rounded-lg bg-warn/10 p-3 text-xs shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)]">
      {notes.map((n) => (
        <li key={n} className="flex gap-2">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
          <span className="[overflow-wrap:anywhere]">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function whereItStands(f: MoveFailure, entry: MoveEntry): string {
  if (f.rolledBack) return `${entry.name} is back on ${entry.srcLabel}, as it was.`;
  if (f.confirming) return `${entry.dstLabel} could not tell yet whether ${entry.name} started there. It stays parked on ${entry.srcLabel} and nothing was rolled back; TeleFlock settles it as soon as ${entry.dstLabel} knows.`;
  if (f.unsettled) return `A host stopped answering, so nothing was rolled back yet. TeleFlock finishes it as soon as both hosts are connected again.`;
  return `The move could not be rolled back automatically. Check ${entry.name} on ${entry.srcLabel}.`;
}

function blame(f: MoveFailure, entry: MoveEntry): string | null {
  if (f.cancelled) return null;
  if (f.side === "source") return `${entry.srcLabel} reported:`;
  if (f.side === "target") return `${entry.dstLabel} reported:`;
  return null;
}

/** The finished move: success, or what failed and where the agent is now. */
export function Result({ entry }: { entry: MoveEntry }) {
  const o = entry.outcome;
  if (!o) return null;
  if (o.ok) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <CircleCheck className="size-6 shrink-0 text-done" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-bold">
              {entry.name} now runs on {entry.dstLabel}
            </p>
            {o.cwd && <p className="font-mono text-xs [overflow-wrap:anywhere] text-mute">{o.cwd}</p>}
          </div>
        </div>
        <Notes notes={o.notes} />
        <StepList progress={entry.progress} />
      </div>
    );
  }
  const f = o.failure;
  const failedStep = entry.progress?.steps.find((s) => s.state === "failed");
  const who = blame(f, entry);
  return (
    <div className="flex flex-col gap-3">
      <div role="alert" className="flex gap-3 rounded-lg bg-error/10 p-3.5 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-error" aria-hidden />
        <div className="min-w-0 flex-1 text-xs">
          <p className="text-sm font-bold">{f.cancelled ? "Move cancelled" : `Couldn't move ${entry.name}`}</p>
          {failedStep && !f.cancelled && <p className="mt-0.5 text-mute">At: {failedStep.label}</p>}
          {!f.cancelled && (
            <p className="mt-1 text-ink-2 [overflow-wrap:anywhere]">
              {who && <span className="text-mute">{who} </span>}
              {f.error.message}
            </p>
          )}
          {f.error.hint && !f.cancelled && <p className="mt-1 text-mute">{f.error.hint}</p>}
          <p className={cn("mt-1.5 font-bold", f.rolledBack ? "text-done" : "text-warn")}>{whereItStands(f, entry)}</p>
        </div>
      </div>
      <Notes notes={f.notes} />
      <StepList progress={entry.progress} />
    </div>
  );
}
