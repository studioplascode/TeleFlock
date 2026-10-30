import { Bot, Braces, ChevronRight, Cpu, Octagon, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { core, parseAgentKey, toApiError, useAgent } from "@/core";
import type { Job, JobsView } from "@/core/gen";
import { cn, Elapsed, EmptyState, formatElapsed, Spinner, Tooltip, useWindowActive } from "@/design";
import { hostCall, usePending } from "../api";
import { glanceText, inspectIds, jobTitle, jobsPollMs, KIND_LABEL, keepExpanded, STATUS_WORD, summaryKey, waitingText } from "./jobsModel";

const KIND_ICON: Record<string, typeof Bot> = { bash: SquareTerminal, eval: Braces, task: Bot };
const STATUS_CLASS: Record<Job["status"], string> = {
  running: "bg-accent/14 text-accent-ink",
  completed: "bg-done/14 text-done",
  failed: "bg-error/14 text-error",
  cancelled: "bg-white/8 text-mute",
};

/**
 * The agent's background jobs (bash/eval commands and subagent tasks of the session and its
 * subagents): status, run time, omp's widget glance, the output tail of expanded (or the first
 * running) job, and Kill. Reads `jobs.list` every second while a job runs; the card summary
 * (`omp.jobs`) says when to look again otherwise. `always`: show the empty state (mobile tab).
 */
export function JobsPanel({ agentKey, always = false }: { agentKey: string; always?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const summary = agent?.omp?.jobs;
  const active = useWindowActive();
  const [view, setView] = useState<JobsView>();
  const [error, setError] = useState<{ title: string; hint?: string }>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const viewRef = useRef(view);
  viewRef.current = view;
  const wanted = always || summary !== undefined;
  const key = summaryKey(summary);

  const load = async () => {
    try {
      const v = await core.host(hostId).call("jobs.list", { agentId, inspect: inspectIds(expandedRef.current, viewRef.current) });
      setView(v);
      setError(undefined);
      setExpanded((e) => keepExpanded(e, v));
    } catch (e) {
      const err = toApiError(e);
      setError({ title: err.message, hint: err.hint });
    }
  };

  useEffect(() => {
    if (wanted) void load();
  }, [wanted, key, hostId, agentId, expanded.size]);

  const poll = jobsPollMs(summary, wanted && active);
  useEffect(() => {
    if (poll === null) return;
    const t = window.setInterval(() => void load(), poll);
    return () => clearInterval(t);
  }, [poll, hostId, agentId]);

  if (!wanted || (!always && view !== undefined && view.jobs.length === 0 && !view.waiting)) return null;
  const running = view?.jobs.filter((j) => j.status === "running").length ?? summary?.running ?? 0;
  return (
    <section data-panel="jobs" aria-label="Background jobs" className="rounded-[22px] glass px-4 py-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="kicker">Background jobs</div>
        <span className="text-[11px] font-bold text-mute">{running > 0 ? <span className="text-accent-hi">{running} running</span> : view ? `${view.jobs.length} recent` : null}</span>
      </div>
      {summary?.waiting && (
        <p className="mb-2 flex items-center gap-2 rounded-md bg-accent/10 px-2.5 py-1.5 text-xs font-semibold text-accent-ink" role="status">
          <Spinner size={12} /> {waitingText(summary)}: the agent resumes when a result arrives.
        </p>
      )}
      {error ? (
        <EmptyState compact title={error.title} description={error.hint} />
      ) : !view ? (
        <div className="flex items-center gap-2 py-2 text-xs text-mute">
          <Spinner size={12} /> Reading jobs…
        </div>
      ) : view.jobs.length === 0 ? (
        <EmptyState compact icon={<Cpu />} title="No background jobs" description="Commands and subagents the agent runs in the background show up here, with their output and a Kill button." />
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="Jobs">
          {view.jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              hostId={hostId}
              agentId={agentId}
              open={expanded.has(job.id) || (expanded.size === 0 && inspectIds(expanded, view)[0] === job.id)}
              onToggle={() => setExpanded((e) => (e.has(job.id) ? new Set([...e].filter((id) => id !== job.id)) : new Set([...e, job.id])))}
              onView={setView}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({ job, hostId, agentId, open, onToggle, onView }: { job: Job; hostId: string; agentId: string; open: boolean; onToggle(): void; onView(v: JobsView): void }) {
  const Icon = KIND_ICON[job.kind] ?? SquareTerminal;
  const [busy, run] = usePending();
  const [armed, setArmed] = useState(false);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open && out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [open, job.output]);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(t);
  }, [armed]);
  const kill = async () => {
    if (!armed) return setArmed(true);
    const r = await run(hostCall(hostId, "jobs.cancel", { agentId, jobId: job.id }, { success: `Stopped ${job.kind === "task" ? "subagent" : "job"} ${job.id}`, failure: "Couldn't stop the job" }));
    if (r.ok) onView(r.value);
  };
  const glance = glanceText(job.widget?.glance);
  const title = jobTitle(job);
  return (
    <li className="rounded-lg bg-[rgb(10_10_16/0.45)] px-2.5 py-2 shadow-hairline" data-job={job.id}>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} output of ${title}`} className="focus-ring grid size-5 shrink-0 place-items-center rounded-sm text-mute hover:text-ink">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <Tooltip content={KIND_LABEL[job.kind] ?? job.kind}>
          <Icon className={cn("size-3.5 shrink-0", job.status === "running" ? "text-accent-hi" : "text-mute-2")} aria-hidden />
        </Tooltip>
        <span className={cn("min-w-0 flex-1 truncate text-[11.5px] text-ink-2", job.kind !== "task" && "font-mono")} title={job.command ?? job.label}>
          {title}
        </span>
        <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase", STATUS_CLASS[job.status])}>{STATUS_WORD[job.status]}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-mute tabular">
          {job.status === "running" ? <Elapsed since={job.startedAt} /> : formatElapsed(Math.max(0, (job.endedAt ?? job.startedAt) - job.startedAt))}
        </span>
        {job.cancellable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void kill()}
            className={cn("focus-ring flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10.5px] font-bold", armed ? "bg-error text-white" : "text-mute hover:bg-error/15 hover:text-error")}
            aria-label={armed ? `Confirm: kill ${title}` : `Kill ${title}`}
          >
            <Octagon className="size-3" aria-hidden /> {armed ? "Kill?" : "Kill"}
          </button>
        )}
      </div>
      {(glance || job.ownerName || job.widget?.stage) && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-7 text-[10.5px] text-mute">
          {glance && <span className="rounded-full bg-white/6 px-1.5 font-mono font-bold text-ink-2">{glance}</span>}
          {job.widget?.glance?.trend && <span className={job.widget.glance.trendTone === "error" ? "text-error" : job.widget.glance.trendTone === "success" ? "text-done" : undefined}>{job.widget.glance.trend}</span>}
          {job.ownerName && <span>by {job.ownerName}</span>}
          {job.widget?.stage && <span className="min-w-0 truncate">{job.widget.stage}</span>}
        </div>
      )}
      {job.widget?.progress != null && (
        <div className="mt-1.5 ml-7 h-1 overflow-hidden rounded-full bg-white/8" role="progressbar" aria-valuenow={Math.round(job.widget.progress * 100)} aria-label={job.widget.progressText ?? "Progress"}>
          <span className="block h-full rounded-full bg-accent tf-glide-width" style={{ width: `${Math.round(job.widget.progress * 100)}%` }} />
        </div>
      )}
      {open && (
        <div className="mt-2 pl-7">
          {job.output !== undefined ? (
            <pre ref={out} className="max-h-48 overflow-auto rounded-sm well px-2 py-1.5 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-ink-2" aria-label="Output">
              {job.outputCut && <span className="text-mute-2">…{"\n"}</span>}
              {job.output || <span className="text-mute-2">(no output yet)</span>}
            </pre>
          ) : (
            <p className="text-[10.5px] text-mute">Reading output…</p>
          )}
          <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-mute-2">
            {job.cwd && <span title="Folder">{job.cwd}</span>}
            {job.pids && job.pids.length > 0 && <span>pid {job.pids.join(", ")}</span>}
            {job.exitCode !== undefined && <span className={job.exitCode === 0 ? undefined : "text-error"}>exit {job.exitCode}</span>}
            {job.artifactId && <span title="Full output in the session">artifact://{job.artifactId}</span>}
          </div>
        </div>
      )}
    </li>
  );
}
