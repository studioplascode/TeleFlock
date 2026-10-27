import { useEffect, useState } from "react";
import { core, useAgent } from "@/core";
import type { ActiveTool, Liveness } from "@/core/gen";
import {
  Elapsed,
  Heartbeat,
  ProgressRing,
  Shimmer,
  Sparkline,
  StatusOrb,
  StreamText,
  type Status,
  Tooltip,
  cn,
  formatAge,
  useActivity,
  useLivelyMotion,
  useNow,
} from "@/design";
import { reportError } from "./agentActions";
import { QUIET_AFTER_MS } from "./lanes";
import { useBeat } from "./useBeat";

/** Context meter `ctx 61%`: neutral fill, warn from 80 %. `barClassName` lets a tight line drop the bar (the % stays). */
export function ContextMeter({ pct, barClassName }: { pct: number; barClassName?: string }) {
  const hot = pct >= 80;
  return (
    <Tooltip content={`Context window ${Math.round(pct)}% used`}>
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <span className={cn("font-mono text-2xs tabular", hot ? "text-warn" : "text-mute")}>
          ctx <b className={cn("font-bold", hot ? "text-warn" : "text-ink-2")}>{Math.round(pct)}%</b>
        </span>
        <span className={cn("h-1 w-8 overflow-hidden rounded-full bg-white/8", barClassName)} aria-hidden>
          <span className={cn("block h-full rounded-full transition-[width] duration-700", hot ? "bg-warn" : "bg-white/35")} style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      </span>
    </Tooltip>
  );
}

/** Running subagents' own completion estimate `subs 59%` (mean when several): the % omp's terminal shows on their rows. */
export function SubagentsDone({ pct, live }: { pct: number; live: number }) {
  const label = live > 1 ? `${live} subagents about ${Math.round(pct)}% done` : `Subagent about ${Math.round(pct)}% done`;
  return (
    <Tooltip content={<span className="block max-w-64">{`${label}: ${live > 1 ? "the average of the running subagents' own estimates" : "its own estimate"} of how far along the task is. omp asks every few minutes.`}</span>}>
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-2xs text-mute tabular">
        <ProgressRing done={pct} total={100} size={12} stroke={2} status="idle" label={null} ariaLabel={label} />
        subs <b className="font-bold text-ink-2">{Math.round(pct)}%</b>
      </span>
    </Tooltip>
  );
}

/** "Connect" pill for an omp session that isn't shared with TeleFlock yet (injects /collab while idle). */
export function ConnectLinkButton({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  // a parked agent has no running omp to connect (it resumes instead)
  if (agent?.omp?.link !== "notShared" || agent.parked) return null;
  return (
    <Tooltip content="This omp session isn't shared with TeleFlock yet. Connect injects /collab while idle.">
      <button
        type="button"
        className="shrink-0 rounded-full bg-accent/14 px-2 py-px text-2xs font-bold text-accent-ink pressable focus-ring hover:bg-accent/25"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void core.host(agent.hostId).call("agent.connect", { agentId: agent.id }).catch((err) => reportError(`Couldn't connect ${agent.name}`, err));
        }}
      >
        Connect
      </button>
    </Tooltip>
  );
}

/**
 * Status orb whose breath follows the agent's measured pulse rate (Lively motion; Calm holds it still),
 * wrapped in a conic ring while a tool runs (spec §4 "tool running"; it turns in Lively, Calm gives it
 * three turns and then lets it stand — the tool chip's timer keeps ticking).
 */
export function AgentOrb({
  agentKey,
  status,
  tool,
  size = 10,
  quiet = false,
}: {
  agentKey: string;
  status: Status;
  tool?: ActiveTool;
  size?: number;
  quiet?: boolean;
}) {
  const { beat } = useBeat(status === "running" || status === "needs-you" ? agentKey : null);
  const { tier } = useActivity(beat);
  const ring = size + 8;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: ring, height: ring }}>
      {tool && !quiet && (
        <span
          aria-hidden
          data-status={status}
          className="tf-loop absolute inset-0 animate-spin rounded-full [animation-duration:1.4s]"
          style={{
            background: "conic-gradient(from 0deg, transparent 0 55%, var(--st-1) 80%, var(--st-2) 100%)",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))",
          }}
        />
      )}
      <StatusOrb status={quiet ? "idle" : status} activity={quiet ? "silent" : tier} size={size} label={quiet ? "Quiet" : undefined} />
    </span>
  );
}

/** ECG heartbeat bound to the agent's pulses, labelled "last event 4s ago". Flatlines after 90 s of silence while working. */
export function AgentHeartbeat({
  agentKey,
  status,
  lastEventAt,
  height = 22,
  showAge = true,
  className,
}: {
  agentKey: string;
  status: Status;
  lastEventAt?: number;
  height?: number;
  showAge?: boolean;
  className?: string;
}) {
  const live = status === "running" || status === "needs-you";
  const { beat } = useBeat(live ? agentKey : null);
  return (
    <Heartbeat
      beat={beat}
      lastEventAt={lastEventAt}
      status={status}
      height={height}
      showAge={showAge}
      agePrefix="last event"
      staleAfterMs={QUIET_AFTER_MS}
      flatAfterMs={QUIET_AFTER_MS}
      className={className}
    />
  );
}

/**
 * True once a working agent has emitted nothing for QUIET_AFTER_MS. A single timer at the threshold,
 * not a clock subscription: the card using it re-renders when quiet flips, not every second.
 */
export function useQuiet(working: boolean, lastEventAt: number | undefined): boolean {
  const due = working && lastEventAt !== undefined ? lastEventAt + QUIET_AFTER_MS : null;
  const [passed, setPassed] = useState<number | null>(() => (due !== null && Date.now() >= due ? due : null));
  useEffect(() => {
    if (due === null) return;
    const t = window.setTimeout(() => setPassed(due), Math.max(0, due - Date.now()));
    return () => clearTimeout(t);
  }, [due]);
  return due !== null && passed === due;
}

/** Amber "quiet 2m" chip: the agent says it's working but nothing has happened since `since` (ms epoch). */
export function QuietChip({ since, className }: { since: number; className?: string }) {
  const silentMs = useNow(1000) - since;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-warn/12 px-2 py-0.5 text-2xs font-bold text-warn shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)]",
        className,
      )}
      title="No events while working — it may be stuck. Open the terminal to check."
    >
      <svg viewBox="0 0 16 8" className="h-2 w-4" aria-hidden>
        <path d="M0 4h16" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      quiet {formatAge(silentMs).replace(/ ago$/, "")}
    </span>
  );
}

/** Mono tool chip with a ticking timer: `bash  bun test src/board · 0:12`. The spinner only turns in Lively motion: the timer already ticks. */
export function ToolChip({ tool, className }: { tool: ActiveTool; className?: string }) {
  const lively = useLivelyMotion();
  return (
    <span className={cn("flex min-w-0 items-center gap-2 rounded-sm well px-2 py-1 font-mono text-2xs", className)}>
      <span data-status="running" className="shrink-0 rounded-xs st-soft px-1.5 py-px font-bold">
        {tool.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{tool.label}</span>
      <Elapsed since={tool.startedAt} className="shrink-0 text-mute tabular" />
      {lively && <span className="tf-loop size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-tool/25 border-t-tool" aria-hidden />}
    </span>
  );
}

/**
 * The agent's live line: tool chip > streaming text with caret > "thinking…" shimmer with timer >
 * last line at rest.
 */
export function LiveLine({
  live,
  turnStartedAt,
  running,
  className,
}: {
  live: Liveness;
  turnStartedAt?: number;
  running: boolean;
  className?: string;
}) {
  if (running && live.tool) return <ToolChip tool={live.tool} className={className} />;
  if (running && live.streaming && live.line)
    return (
      <p className={cn("line-clamp-2 min-h-[1.45em] text-xs text-ink-2", className)}>
        <StreamText text={live.line} streaming />
      </p>
    );
  if (running && (live.thinking || !live.line))
    return (
      <p className={cn("flex items-center gap-2 text-xs", className)}>
        <Shimmer>{live.thinking ? "Thinking…" : "Waiting on the model…"}</Shimmer>
        {turnStartedAt !== undefined && <Elapsed since={turnStartedAt} className="font-mono text-2xs text-mute tabular" />}
      </p>
    );
  if (!live.line) return null;
  return <p className={cn("line-clamp-2 text-xs text-mute", className)}>{live.line}</p>;
}

const TPS_SAMPLES = 24;

/**
 * Rolling tok/s sparkline, sampled once a second from the agent's `live.tps` on the shared clock
 * (which holds still while the window is inactive, so sampling pauses too). A flat zero line has
 * nothing to scroll: it stops sampling (and re-rendering) until tokens flow again.
 */
export function TpsSparkline({ tps, status, className }: { tps: number | undefined; status: Status; className?: string }) {
  // starts as a flat line (two points draw it), which is also all a never-busy agent ever shows
  const [samples, setSamples] = useState<{ at: number; values: number[] }>(() => ({ at: 0, values: [0, 0] }));
  const values = samples.values;
  const latest = tps ?? 0;
  const flat = latest === 0 && values.every((v) => v === 0);
  const now = useNow(flat ? null : 1000);
  // one sample per clock tick (not per tps patch), using the latest rendered value
  useEffect(() => {
    if (flat) return;
    setSamples((s) => (s.at === now ? s : { at: now, values: s.values.length >= TPS_SAMPLES ? [...s.values.slice(s.values.length - TPS_SAMPLES + 1), latest] : [...s.values, latest] }));
  }, [now, flat, latest]);
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Sparkline values={values} status={status} height={18} className="w-14" aria-label="Tokens per second" />
      <span className="shrink-0 font-mono text-2xs whitespace-nowrap text-mute tabular">{Math.round(latest)} tok/s</span>
    </div>
  );
}
