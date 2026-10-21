import { AnimatePresence, motion, useAnimate } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { core, navigate, useAgent, useHostStale, useHosts } from "@/core";
import type { Column } from "@/core/gen";
import {
  AgentGlyph,
  Card,
  Elapsed,
  GlowBorder,
  IconButton,
  ProgressRing,
  Swarm,
  TiltCard,
  Tooltip,
  cn,
  formatAge,
  useCalmMotion,
  spring,
  useNow,
} from "@/design";
import { BellOff } from "lucide-react";
import { openAgent, openTerminal, reportError, stopAgent, useMuted } from "./agentActions";
import { ArchiveButton } from "./ArchiveConfirm";
import { CardContextMenu, CardMenuButton } from "./CardMenu";
import { LANE_BY_COLUMN, NEEDS_LABEL } from "./lanes";
import { AgentHeartbeat, AgentOrb, LiveLine, QuietChip, TpsSparkline, useQuiet } from "./LiveBits";
import { QuickAnswer } from "./QuickAnswer";

const NUDGE_EVERY_MS = 20_000;

/** Sunset nudge every 20 s while an agent waits on you (spec §4). */
function useNudge(on: boolean) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const tick = useNow(NUDGE_EVERY_MS);
  const calm = useCalmMotion();
  useEffect(() => {
    if (!on || calm || !scope.current) return;
    void animate(scope.current, { rotate: [0, -1.4, 1.2, -0.7, 0.3, 0], y: [0, -3, 0] }, { duration: 0.7, ease: "easeInOut" });
  }, [tick, on, calm, animate, scope]);
  return scope;
}

/** Lane each agent was last rendered in (survives the remount a lane change causes). */
const LAST_LANE = new Map<string, Column>();

/**
 * Lane-change moment for the burst ring: finishing (→ review) and getting back to work after an
 * answer (needs → running) both deserve a visible "it happened".
 */
function useArrival(key: string, lane: Column, floating: boolean): Column | null {
  const [burst, setBurst] = useState<Column | null>(null);
  useEffect(() => {
    if (floating) return;
    const prev = LAST_LANE.get(key);
    LAST_LANE.set(key, lane);
    if (prev && prev !== lane && (lane === "review" || (lane === "running" && prev === "needs") || lane === "done")) setBurst(lane);
  }, [key, lane, floating]);
  useEffect(() => {
    if (!burst) return;
    const t = window.setTimeout(() => setBurst(null), 1400);
    return () => clearTimeout(t);
  }, [burst]);
  return burst;
}

const BURST_STATUS = { running: "running", needs: "needs-you", review: "review", done: "done" } as const;

function ArrivalBurst({ lane }: { lane: Column }) {
  return (
    <span data-status={BURST_STATUS[lane]} aria-hidden className="pointer-events-none absolute inset-0 z-20">
      <motion.span
        className="absolute inset-0 rounded-xl shadow-[0_0_0_2px_var(--st-solid),0_0_30px_4px_rgb(var(--st-rgb)/0.6)]"
        initial={{ opacity: 1, scale: 0.96 }}
        animate={{ opacity: 0, scale: 1.08 }}
        transition={{ duration: 1.1, ease: "easeOut" }}
      />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <motion.span
            key={i}
            className="absolute top-1/2 left-1/2 size-1.5 rounded-full st-fill"
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: Math.cos(a) * 150, y: Math.sin(a) * 90, opacity: 0, scale: 0.3 }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          />
        );
      })}
    </span>
  );
}

/** `+412 −38 · 9f` */
export function DiffStat({ added, removed, files, className }: { added: number; removed: number; files?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-2xs tabular", className)}>
      <span className="text-add">+{added}</span>
      <span className="text-del">−{removed}</span>
      {files !== undefined && <span className="text-mute-2">{files}f</span>}
    </span>
  );
}

/** Host colour tag for compact rows (name in the tooltip). */
function HostDot({ hostId }: { hostId: string }) {
  const profile = useHosts((s) => s.profiles.find((p) => p.id === hostId));
  const color = profile?.color ?? "var(--color-accent)";
  return (
    <span
      role="img"
      aria-label={`Host ${profile?.name ?? hostId}`}
      title={profile?.name ?? hostId}
      className="h-3 w-[3px] shrink-0 rounded-full"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}

/** Host colour dot + name (multi-host boards). */
export function HostTag({ hostId, className }: { hostId: string; className?: string }) {
  const profile = useHosts((s) => s.profiles.find((p) => p.id === hostId));
  const color = profile?.color ?? "var(--color-accent)";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-2xs font-bold text-mute", className)} title={`Host ${profile?.name ?? hostId}`}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      <span className="truncate">{profile?.name ?? hostId}</span>
    </span>
  );
}

function ContextMeter({ pct }: { pct: number }) {
  const hot = pct >= 80;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Context ${Math.round(pct)}% used`}>
      <span className="h-1 w-8 overflow-hidden rounded-full bg-white/8">
        <span className={cn("block h-full rounded-full transition-[width] duration-700", hot ? "bg-warn" : "bg-run")} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className={cn("font-mono text-2xs tabular", hot ? "text-warn" : "text-mute")}>{Math.round(pct)}%</span>
    </span>
  );
}

export interface AgentCardProps {
  agentKey: string;
  /** Lane the card is rendered in (may lead the host state during an optimistic drop). */
  lane: Column;
  selected?: boolean;
  /** Part of the multi-selection (accent ring + lift). */
  picked?: boolean;
  /** Rendered inside the dnd-kit DragOverlay. */
  floating?: boolean;
}

/** The kanban card: every liveness signal for one agent, plus lane-specific actions. */
export function AgentCard({ agentKey, lane, selected = false, picked = false, floating = false }: AgentCardProps) {
  const agent = useAgent(agentKey);
  const stale = useHostStale(agent?.hostId ?? "");
  const lastOnlineAt = useHosts((s) => (agent ? s.status[agent.hostId]?.lastOnlineAt : undefined));
  const reconnecting = useHosts((s) => (agent ? s.status[agent.hostId]?.phase === "reconnecting" || s.status[agent.hostId]?.phase === "connecting" : false));
  const multiHost = useHosts((s) => s.profiles.length > 1);
  const muted = useMuted(agentKey);
  const silentMs = useQuiet(lane === "running" && !stale, agent?.live.lastEventAt);
  // a muted agent still waits visibly, it just stops tugging at your sleeve
  const nudge = useNudge(lane === "needs" && !stale && !muted);
  const burst = useArrival(agentKey, lane, floating);
  // Live lanes render their clocks with <Elapsed>; the card itself only needs `now` for ages.
  const now = useNow(stale ? 1000 : lane === "done" || lane === "review" ? 30_000 : 60_000);
  if (!agent) return null;

  const meta = LANE_BY_COLUMN[lane];
  const status = meta.status;
  const quiet = silentMs !== null;
  const omp = agent.omp;
  const todos = omp?.todos;
  const subs = omp?.subagents?.live ?? 0;
  const live = lane === "running" || lane === "needs";
  const ready = lane === "review" && agent.turns === 0;

  const avatar =
    todos && todos.total > 0 ? (
      <ProgressRing done={todos.done} total={todos.total} status={quiet ? "idle" : status} size={36} stroke={3.5} />
    ) : (
      <AgentGlyph name={agent.name} size={36} status={live ? status : undefined} />
    );

  let body: ReactNode;
  if (lane === "needs" && agent.needs) {
    const n = agent.needs;
    body = (
      <>
        <p className="mt-2 text-sm leading-snug font-bold text-ink">“{n.question || n.title}”</p>
        {n.detail && <p className="mt-1 line-clamp-2 text-xs text-mute">{n.detail}</p>}
        {n.command && !n.question.includes(n.command) && (
          <pre className="mt-2 max-h-20 overflow-hidden rounded-sm well px-2.5 py-1.5 font-mono text-2xs whitespace-pre-wrap text-ink-2">{n.command}</pre>
        )}
        <QuickAnswer agentKey={agentKey} className="mt-2.5" max={4} chat={false} />
      </>
    );
  } else if (lane === "review") {
    body = (
      <>
        <LiveLine live={agent.live} running={false} className="mt-2" />
        <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            data-status="review"
            className="h-7 rounded-sm st-bg px-2.5 text-2xs font-extrabold pressable focus-ring hover:brightness-110"
            onClick={() => navigate({ name: "review", hostId: agent.hostId, workspaceId: agent.workspaceId })}
          >
            Review diff
          </button>
          <ArchiveButton
            agentKey={agentKey}
            className="h-7 rounded-sm bg-tile-4 px-2.5 text-2xs font-bold text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] pressable focus-ring hover:bg-tile-5"
          >
            Archive
          </ArchiveButton>
          <button
            type="button"
            className="h-7 rounded-sm px-2.5 text-2xs font-bold text-mute pressable focus-ring hover:bg-white/6 hover:text-ink"
            onClick={() => openAgent(agentKey)}
          >
            Open
          </button>
        </div>
      </>
    );
  } else if (lane === "running") {
    body = (
      <>
        <LiveLine live={agent.live} running={!stale} turnStartedAt={omp?.turnStartedAt ?? agent.stateSince} className="mt-2" />
        <div className="mt-2 flex items-center gap-2">
          <AgentHeartbeat agentKey={agentKey} status={quiet ? "idle" : status} lastEventAt={agent.live.lastEventAt} height={20} className="min-w-0 flex-1" />
          {quiet ? <QuietChip silentMs={silentMs} /> : <TpsSparkline tps={agent.live.tps} status={status} />}
        </div>
      </>
    );
  }

  const card = (
    <Card
      data-status={status}
      data-morph={floating ? undefined : "surface"}
      data-morph-key={floating ? undefined : agentKey}
      selected={selected || picked}
      className={cn(
        "group/card relative flex flex-col rounded-xl p-3.5 outline-none",
        lane === "needs" && "st-border-grad",
        lane === "done" && "py-3",
        stale && "opacity-70 grayscale-[0.65]",
        quiet && "shadow-[var(--shadow-d1),inset_0_0_0_1px_rgb(251_191_36/0.3)]",
        floating && "shadow-[var(--shadow-d3)]",
      )}
    >
      {/* header: lane badge (needs / review only) */}
      {(lane === "needs" || lane === "review") && (
        <div className="mb-2.5 flex items-center gap-2 whitespace-nowrap">
          {lane === "needs" && agent.needs ? (
            <span data-status="needs-you" className="rounded-full st-bg px-2 py-0.5 font-display text-[9.5px] font-bold tracking-[0.12em] uppercase">
              {NEEDS_LABEL[agent.needs.kind]}
            </span>
          ) : (
            <span data-status="review" className="rounded-full st-soft px-2 py-0.5 font-display text-[9.5px] font-bold tracking-[0.12em] uppercase">
              {ready ? "Ready" : "Ready to review"}
            </span>
          )}
          {todos && todos.total > 0 && (
            <span className="min-w-0 truncate text-2xs font-semibold text-mute">
              {todos.done}/{todos.total} todos
            </span>
          )}
          <span className="ml-auto shrink-0 text-2xs font-bold text-mute tabular">
            {stale ? (
              <span className={cn(reconnecting && "tf-shimmer-text")}>last seen {lastOnlineAt ? formatAge(now - lastOnlineAt) : "—"}</span>
            ) : lane === "needs" && agent.needs ? (
              <span className="text-[#ffb08a]">
                waiting <Elapsed since={agent.needs.since} />
              </span>
            ) : (
              formatAge(now - agent.stateSince)
            )}
          </span>
        </div>
      )}

      {/* identity + title */}
      <div className="flex items-start gap-3">
        {lane === "done" ? (
          <span data-status="done" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full st-soft">
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
              <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        ) : (
          <span data-morph={floating ? undefined : "glyph"} data-morph-key={floating ? undefined : agentKey} className="shrink-0">
            {subs > 0 ? (
              <Swarm count={subs} size={36} status={status}>
                {avatar}
              </Swarm>
            ) : (
              avatar
            )}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            {lane === "running" && <AgentOrb agentKey={agentKey} status={status} tool={agent.live.tool} quiet={quiet} size={7} />}
            {multiHost && <HostDot hostId={agent.hostId} />}
            <span data-morph={floating ? undefined : "name"} data-morph-key={floating ? undefined : agentKey} className="shrink-0 font-extrabold text-ink">
              {agent.name}
            </span>
            {agent.kind !== "omp" && <span className="shrink-0 rounded-xs bg-white/6 px-1 text-[9.5px] font-bold text-mute uppercase">{agent.kind}</span>}
            {muted && (
              <span role="img" aria-label="Notifications muted" title="Notifications muted" className="shrink-0 text-mute-2">
                <BellOff className="size-3" aria-hidden />
              </span>
            )}
            {(agent.repo || agent.branch) && (
              <span className="min-w-0 truncate font-mono text-2xs text-mute-2">
                {agent.repo}
                {agent.branch && ` · ${agent.branch}`}
              </span>
            )}
            {(lane === "running" || lane === "done") && (
              <span className="ml-auto shrink-0 pl-1 text-2xs font-bold text-mute tabular">
                {stale ? (
                  <span className={cn(reconnecting && "tf-shimmer-text")}>seen {lastOnlineAt ? formatAge(now - lastOnlineAt) : "—"}</span>
                ) : lane === "running" ? (
                  <Elapsed since={omp?.turnStartedAt ?? agent.stateSince} />
                ) : (
                  formatAge(now - agent.stateSince)
                )}
              </span>
            )}
          </div>
          <h4 className={cn("font-sans leading-snug font-bold text-ink", lane === "done" ? "line-clamp-1 text-xs" : "line-clamp-2 text-sm")}>{agent.title || agent.name}</h4>
        </div>
      </div>

      {body}

      {/* footer */}
      {lane !== "done" ? (
        <div className="mt-2.5 flex min-w-0 items-center gap-2.5 border-t border-line pt-2">
          {omp?.context && <ContextMeter pct={omp.context.pct} />}
          {agent.diff && <DiffStat {...agent.diff} />}
          {omp?.link === "notShared" && (
            <button
              type="button"
              className="rounded-full bg-accent/14 px-2 py-px text-2xs font-bold text-accent-ink pressable focus-ring hover:bg-accent/25"
              title="This omp session isn't shared with TeleFlock yet. Connect injects /collab while idle."
              onClick={(e) => {
                e.stopPropagation();
                void core.host(agent.hostId).call("agent.connect", { agentId: agent.id }).catch((err) => reportError(`Couldn't connect ${agent.name}`, err));
              }}
            >
              Connect
            </button>
          )}
          {omp?.model && (
            <span className="ml-auto min-w-0 truncate font-mono text-2xs text-mute">
              {omp.model.label ?? omp.model.id}
              {omp.thinking && omp.thinking !== "off" && ` · ${omp.thinking}`}
            </span>
          )}
        </div>
      ) : (
        agent.diff && (
          <div className="mt-1 flex items-center gap-2 pl-8">
            <DiffStat {...agent.diff} />
          </div>
        )
      )}

      {/* hover actions: quick tools for running cards, the ⋯ menu everywhere */}
      {!floating && (
        <div
          className="absolute top-2 right-2 flex gap-0.5 rounded-md glass p-0.5 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[data-state=open]]:opacity-100"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {lane === "running" && (
            <>
              <Tooltip content="Open session" shortcut="Enter">
                <IconButton label="Open session" size="sm" onClick={() => openAgent(agentKey)}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7.5 8.5" />
                  </svg>
                </IconButton>
              </Tooltip>
              <Tooltip content="Terminal (split)" shortcut="T">
                <IconButton label="Open terminal" size="sm" onClick={() => openTerminal(agentKey, false)}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="m3 4.5 3 3-3 3M8 11.5h5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </IconButton>
              </Tooltip>
              <Tooltip content="Stop the current turn">
                <IconButton label="Stop" size="sm" variant="danger" onClick={() => void stopAgent(agentKey)}>
                  <svg viewBox="0 0 16 16" aria-hidden>
                    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                  </svg>
                </IconButton>
              </Tooltip>
            </>
          )}
          <CardMenuButton agentKey={agentKey} lane={lane} />
        </div>
      )}

      {/* multi-select check */}
      <AnimatePresence>
        {picked && (
          <motion.span
            aria-hidden
            initial={{ scale: 0, rotate: -60 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0 }}
            transition={spring.bouncy}
            className="absolute -top-1.5 -left-1.5 z-10 grid size-5 place-items-center rounded-full bg-accent text-white shadow-glow-accent"
          >
            <svg viewBox="0 0 12 12" className="size-3">
              <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
    </Card>
  );

  const glowing = live && !stale && !quiet && !floating;
  const body2 = (
    <div ref={nudge} className="relative">
      <motion.div animate={{ y: picked ? -3 : 0, scale: picked ? 1.01 : 1 }} transition={spring.snappy}>
        <TiltCard maxTilt={floating ? 0 : 4} disabled={floating} className="rounded-xl">
          {glowing ? (
            <GlowBorder status={status} radius={22} className="rounded-xl">
              {card}
            </GlowBorder>
          ) : (
            card
          )}
        </TiltCard>
      </motion.div>
      <AnimatePresence>{burst && <ArrivalBurst key={burst} lane={burst} />}</AnimatePresence>
    </div>
  );
  return floating ? (
    body2
  ) : (
    <CardContextMenu agentKey={agentKey} lane={lane}>
      {body2}
    </CardContextMenu>
  );
}
