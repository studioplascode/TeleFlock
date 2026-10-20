import { useEffect, useState } from "react";
import type { ActiveTool, Liveness } from "@/core/gen";
import {
  Elapsed,
  Heartbeat,
  Shimmer,
  Sparkline,
  StatusOrb,
  StreamText,
  type Status,
  cn,
  formatAge,
  useActivity,
  useNow,
} from "@/design";
import { QUIET_AFTER_MS } from "./lanes";
import { useBeat } from "./useBeat";

/**
 * Status orb whose breath follows the agent's measured pulse rate, wrapped in a rotating conic
 * ring while a tool runs (spec §4 "tool running").
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

/** ECG heartbeat bound to the agent's pulses. Flatlines after 90 s of silence while working. */
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
      staleAfterMs={QUIET_AFTER_MS}
      flatAfterMs={QUIET_AFTER_MS}
      className={className}
    />
  );
}

/** True when a working agent has emitted nothing for QUIET_AFTER_MS (re-evaluated every second). */
export function useQuiet(working: boolean, lastEventAt: number | undefined): number | null {
  const now = useNow(1000);
  if (!working || lastEventAt === undefined) return null;
  const silent = now - lastEventAt;
  return silent > QUIET_AFTER_MS ? silent : null;
}

/** Amber "quiet 2m" chip: the agent says it's working but nothing has happened for a while. */
export function QuietChip({ silentMs, className }: { silentMs: number; className?: string }) {
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

/** Mono tool chip with a ticking timer: `bash  bun test src/board · 0:12`. */
export function ToolChip({ tool, className }: { tool: ActiveTool; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2 rounded-sm well px-2 py-1 font-mono text-2xs", className)}>
      <span data-status="running" className="shrink-0 rounded-xs st-soft px-1.5 py-px font-bold">
        {tool.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{tool.label}</span>
      <Elapsed since={tool.startedAt} className="shrink-0 text-mute tabular" />
      <span className="tf-loop size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-tool/25 border-t-tool" aria-hidden />
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

/** Rolling tok/s sparkline, sampled once a second from the agent's `live.tps`. */
export function TpsSparkline({ tps, status, className }: { tps: number | undefined; status: Status; className?: string }) {
  const now = useNow(1000);
  const [values, setValues] = useState<number[]>([]);
  const latest = tps ?? 0;
  // one sample per clock tick (not per tps patch), using the latest rendered value
  useEffect(() => {
    setValues((v) => (v.length >= TPS_SAMPLES ? [...v.slice(v.length - TPS_SAMPLES + 1), latest] : [...v, latest]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Sparkline values={values} status={status} height={18} className="w-14" aria-label="Tokens per second" />
      <span className="w-12 shrink-0 font-mono text-2xs text-mute tabular">{Math.round(latest)} t/s</span>
    </div>
  );
}
