import { BellOff, Brain, Sparkles, Trash2 } from "lucide-react";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { navigate, useAgent, useCore, useHostStale, useHosts } from "@/core";
import type { Agent, Column, HerdrHealth } from "@/core/gen";
import {
  AgentGlyph,
  Card,
  GlowBorder,
  IconButton,
  ProgressRing,
  Swarm,
  TiltCard,
  Tooltip,
  cn,
  formatAge,
  spring,
  useCalmMotion,
  useLivelyMotion,
  useNow,
} from "@/design";
import { CountdownChip } from "@/features/autoAnswer/CountdownChip";
import { useHerdrDown } from "@/features/hosts/HerdrControls";
import { herdrAgentWord, herdrCardTime, herdrOrbStatus } from "@/features/hosts/herdrHealth";
import { hostAccent } from "@/features/hosts/kinds";
import { ShipStepper } from "@/features/review/ShipPanel";
import { ACTIONS, type AgentStateId, agentStateId, agentStateWord, stateTime } from "@/features/shell/vocab";
import { archiveWithUndo, canReview, deleteWorktree, openAgent, openTerminal, promptAgent, stopAgent, useMuted } from "./agentActions";
import { resumeNow } from "@/features/session/resume/actions";
import { ticketActions } from "@/features/session/resume/words";
import { CardContextMenu, CardMenuButton } from "./CardMenu";
import { LANE_BY_COLUMN } from "./lanes";
import { AutoResumeBadge } from "./AutoResumeBadge";
import { AgentHeartbeat, AgentOrb, ConnectLinkButton, ContextMeter, LiveLine, QuietChip, SubagentsDone, TpsSparkline, useQuiet } from "./LiveBits";
import { ParkedChip } from "./ParkedChip";
import { RetryLine } from "./RetryLine";
import { retryOf } from "./retry";
import { RestingLine } from "./RecapLine";
import { QuickAnswer } from "./QuickAnswer";
import { RepoTag } from "./RepoTag";
import { useShipMemo } from "./shipMemo";
import { PrProbe, shippedWords, useShippedPr } from "./worktreePr";
import { JobsMeter, WaitingForJobs } from "./JobsMeter";

const NUDGE_EVERY_MS = 20_000;

/** Sunset nudge every 20 s while an agent waits on you (spec §4). */
function useNudge(on: boolean) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const tick = useNow(on ? NUDGE_EVERY_MS : null);
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
    <span data-status={BURST_STATUS[lane]} aria-hidden className="pointer-events-none absolute inset-0 z-raised">
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

/** `+412 −38 · 9 files`. `muted` (Done cards) dims the counts so the green `+` doesn't read as the done check. */
export function DiffStat({ added, removed, files, muted = false, className }: { added: number; removed: number; files?: number; muted?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 font-mono text-2xs whitespace-nowrap tabular", className)}>
      <span className={cn("inline-flex gap-1", muted && "opacity-70")}>
        <span className="text-add">+{added}</span>
        <span className="text-del">−{removed}</span>
      </span>
      {files !== undefined && (
        <span className="text-mute">
          · {files} file{files === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}

/** Host name chip with the host's identity swatch (multi-host boards, Activity rows). */
export function HostTag({ hostId, className }: { hostId: string; className?: string }) {
  const profile = useHosts((s) => s.profiles.find((p) => p.id === hostId));
  const name = profile?.name ?? hostId;
  return (
    <span className={cn("inline-flex max-w-full min-w-0 shrink-0 items-center gap-1 rounded-xs bg-white/6 py-px pr-1.5 pl-1 text-2xs font-bold text-ink-2", className)} title={`Host ${name}`}>
      <span className="h-2.5 w-1 shrink-0 rounded-full" style={{ background: hostAccent(profile?.color) }} aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

const PILL: Record<AgentStateId, string> = {
  needs: "st-bg",
  running: "st-soft",
  fresh: "bg-white/6 text-mute",
  review: "st-soft",
  done: "st-soft",
};

/** Zone 1, right: the state's time with its verb ("turn 27:24", "waiting 6:13", "finished 25m ago"). Ticks on its own. */
function StateTime({ agent, state, stale, herdr, className }: { agent: Agent & { hostId: string }; state: AgentStateId; stale: boolean; herdr?: HerdrHealth; className?: string }) {
  const lastOnlineAt = useHosts((s) => s.status[agent.hostId]?.lastOnlineAt);
  const reconnecting = useHosts((s) => s.status[agent.hostId]?.phase === "reconnecting" || s.status[agent.hostId]?.phase === "connecting");
  const ticking = !stale && !herdr && (state === "running" || state === "needs");
  const now = useNow(ticking ? 1000 : 30_000);
  // herdr is down: the time stops where the outage began
  if (herdr && !stale) return <span className={className}>{herdrCardTime(herdr)}</span>;
  if (stale)
    return (
      <span className={cn(className, reconnecting && "tf-shimmer-text")} title="Last seen while the host was online">
        last seen {lastOnlineAt ? formatAge(now - lastOnlineAt) : "—"}
      </span>
    );
  // an ended card (its omp ended without anyone closing it): since then; its pill says "Ended"
  const ended = state === "review" || state === "fresh" ? agent.parked?.ended : undefined;
  if (ended) return <span className={className}>{stateTime("ended", ended.at, now)}</span>;
  const since = state === "needs" ? agent.needs?.since : state === "running" ? (agent.omp?.turnStartedAt ?? agent.stateSince) : agent.stateSince;
  return <span className={className}>{stateTime(state, since, now)}</span>;
}

/**
 * "Delete worktree…" for a Review/Done card whose linked worktree's pull request is merged or closed
 * (`useShippedPr`; the card's `PrProbe` asks gh). Renders nothing until then.
 */
function DeleteWorktreeButton({ agentKey, andDone }: { agentKey: string; andDone: boolean }) {
  const pr = useShippedPr(agentKey);
  if (!pr) return null;
  return (
    <Tooltip content={`${shippedWords(pr)}: delete the checkout folder${andDone ? " and mark it done" : ""} (asks first); the branch stays`}>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-sm bg-error/12 px-2.5 text-2xs font-bold text-[#ff8aa5] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)] pressable focus-ring hover:bg-error hover:text-white"
        onClick={() => void deleteWorktree(agentKey)}
      >
        <Trash2 className="size-3 shrink-0" aria-hidden />
        {ACTIONS.deleteWorktree.label}
      </button>
    </Tooltip>
  );
}

/**
 * Review card zone 4: the next ship step as the primary button (from host state, or what Review last saw), Mark done, Open,
 * Delete worktree once shipped. An ended card leads with its ticket's Continue instead (its workspace went with its pane).
 */
function ReviewBody({ agent, agentKey }: { agent: Agent & { hostId: string }; agentKey: string }) {
  const repo = useCore((s) => s.hosts[agent.hostId]?.state.workspaces.find((w) => w.id === agent.workspaceId)?.repo);
  const memo = useShipMemo((s) => s.byWorkspace[`${agent.hostId}/${agent.workspaceId}`]);
  const dirty = repo?.dirty ?? 0;
  const ahead = repo?.ahead ?? 0;
  // uncommitted / unpushed work always comes first; past that only Review's last reading knows the PR stage
  const next =
    dirty > 0 ? `Commit ${dirty} file${dirty === 1 ? "" : "s"}` : ahead > 0 ? `Push ${ahead} commit${ahead === 1 ? "" : "s"}` : memo?.pr !== undefined ? memo.next : ACTIONS.review.label;
  const stage = dirty > 0 ? 0 : ahead > 0 ? 1 : (memo?.stage ?? 0);
  const ticket = agent.parked?.ended && agent.autoResume ? ticketActions(agent.autoResume, { ended: agent.parked.ended }) : null;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <>
      <RestingLine agent={agent} className="mt-2" />
      {memo?.pr !== undefined && (
        <div className="mt-2 w-36" title={`Ship: ${memo.next}`}>
          <ShipStepper stage={stage} blocked={memo.blocked && stage === memo.stage} dots />
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={stop} onPointerDown={stop}>
        {ticket && (
          <Tooltip content={ticket.resumeHint}>
            <button
              type="button"
              className="h-7 rounded-sm bg-accent px-2.5 text-2xs font-extrabold text-white shadow-glow-accent pressable focus-ring hover:bg-accent-hi"
              onClick={() => void resumeNow(agentKey)}
            >
              {ticket.resume}
            </button>
          </Tooltip>
        )}
        {canReview(agent) && !agent.parked && (
          <Tooltip content={ACTIONS.review.description}>
            <button
              type="button"
              data-status="review"
              className="h-7 max-w-full truncate rounded-sm st-bg px-2.5 text-2xs font-extrabold pressable focus-ring hover:brightness-110"
              onClick={() => navigate({ name: "review", hostId: agent.hostId, workspaceId: agent.workspaceId })}
            >
              {next}
            </button>
          </Tooltip>
        )}
        <Tooltip content={ACTIONS.markDone.description}>
          <button
            type="button"
            className="h-7 rounded-sm bg-tile-4 px-2.5 text-2xs font-bold text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] pressable focus-ring hover:bg-tile-5"
            onClick={() => void archiveWithUndo([agentKey])}
          >
            {ACTIONS.markDone.label}
          </button>
        </Tooltip>
        <button type="button" className="h-7 rounded-sm px-2.5 text-2xs font-bold text-mute pressable focus-ring hover:bg-white/6 hover:text-ink" onClick={() => openAgent(agentKey)}>
          Open
        </button>
        <DeleteWorktreeButton agentKey={agentKey} andDone />
      </div>
    </>
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
  /** Top card of the Needs-you lane: the sunset treatment. */
  hero?: boolean;
}

/**
 * The kanban card. Five fixed zones on every lane (Density P1): (1) state strip with the timed verb,
 * (2) identity, (3) title, (4) lane body, (5) labelled meters in one fixed order that wrap instead of hiding.
 */
export function AgentCard({ agentKey, lane, selected = false, picked = false, floating = false, hero = false }: AgentCardProps) {
  const agent = useAgent(agentKey);
  const hostStale = useHostStale(agent?.hostId ?? "");
  // herdr is down on its host: nothing runs, whatever the cached lane says (no running visuals, no ticking timers).
  // Review and Done cards keep their state: those agents were idle already.
  const herdrHealth = useHerdrDown(agent?.hostId ?? "");
  const herdr = lane === "running" || lane === "needs" ? herdrHealth : undefined;
  const stale = hostStale || herdr !== undefined;
  const multiHost = useHosts((s) => s.profiles.length > 1);
  const muted = useMuted(agentKey);
  const lively = useLivelyMotion();
  // Waiting for background jobs is silent by design (omp's async wait), not quiet.
  const retry = retryOf(agent);
  const quiet = useQuiet(lane === "running" && !stale && !agent?.omp?.jobs?.waiting && !retry, agent?.live.lastEventAt);
  // a muted agent still waits visibly, it just stops tugging at your sleeve
  const nudge = useNudge(lane === "needs" && !stale && !muted);
  const burst = useArrival(agentKey, lane, floating);
  if (!agent) return null;

  // the lane leads the host state during an optimistic drop
  const state: AgentStateId = lane === "review" ? agentStateId({ ...agent, column: "review" }) : lane;
  const fresh = state === "fresh";
  // a fresh agent that never ran sits calmly (idle), not in review cyan; so does an ended one until it is back
  const status = herdr ? herdrOrbStatus(herdr) : fresh || (lane === "review" && agent.parked?.ended) ? "idle" : LANE_BY_COLUMN[lane].status;
  const omp = agent.omp;
  const todos = omp?.todos;
  const subs = omp?.subagents?.live ?? 0;
  const subPct = subs > 0 ? omp?.subagents?.completionPct : undefined;
  const live = (lane === "running" || lane === "needs") && !herdr;
  const isHero = hero && lane === "needs" && !stale && !floating;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  const ring = todos && todos.total > 0;
  const avatar = ring ? (
    <ProgressRing done={todos.done} total={todos.total} status={quiet ? "idle" : status} size={36} stroke={3.5} ariaLabel={`${todos.done} of ${todos.total} todos done`} />
  ) : (
    <AgentGlyph name={agent.name} size={36} status={live ? status : undefined} />
  );

  let body: ReactNode = null;
  if (lane === "needs" && agent.needs) {
    const n = agent.needs;
    body = (
      <>
        <p className="mt-2 text-sm leading-snug font-bold wrap-break-word text-ink">“{n.question || n.title}”</p>
        {n.detail && <p className="mt-1 line-clamp-2 text-xs text-mute">{n.detail}</p>}
        {n.command && !n.question.includes(n.command) && (
          <pre className="mt-2 max-h-20 overflow-hidden rounded-sm well px-2.5 py-1.5 font-mono text-2xs whitespace-pre-wrap text-ink-2">{n.command}</pre>
        )}
        <CountdownChip agentKey={agentKey} sunset={isHero} className="mt-2" />
        <QuickAnswer agentKey={agentKey} appearance={isHero ? "hero" : "card"} className="mt-2.5" max={4} chat={false} />
      </>
    );
  } else if (fresh) {
    body = (
      <>
        <p className="mt-2 text-xs text-mute">Nothing to review yet: it's waiting for its first prompt{agent.repo || !agent.cwd ? "." : ` in ${agent.cwd}.`}</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={stop} onPointerDown={stop}>
          <button
            type="button"
            className="h-7 rounded-sm bg-accent px-2.5 text-2xs font-extrabold text-white shadow-glow-accent pressable focus-ring hover:bg-accent-hi"
            onClick={() => promptAgent(agentKey)}
          >
            Prompt…
          </button>
          <Tooltip content={ACTIONS.terminal.description} shortcut={ACTIONS.terminal.shortcut}>
            <button
              type="button"
              className="h-7 rounded-sm px-2.5 text-2xs font-bold text-mute pressable focus-ring hover:bg-white/6 hover:text-ink"
              onClick={() => openTerminal(agentKey, false)}
            >
              {ACTIONS.terminal.label}
            </button>
          </Tooltip>
        </div>
      </>
    );
  } else if (lane === "review") {
    body = <ReviewBody agent={agent} agentKey={agentKey} />;
  } else if (lane === "running") {
    body = (
      <>
        {retry && !stale ? (
          <RetryLine wait={retry} className="mt-2" />
        ) : agent.omp?.jobs?.waiting && !stale ? (
          <WaitingForJobs jobs={agent.omp.jobs} className="mt-2" />
        ) : (
          <LiveLine live={agent.live} running={!stale} className="mt-2" />
        )}
        <div className="mt-2 flex min-w-0 items-center gap-2">
          {/* when quiet, the chip replaces the age label: one signal per fact; a retry wait says it all in its line above */}
          <AgentHeartbeat agentKey={agentKey} status={quiet || retry ? "idle" : status} lastEventAt={agent.live.lastEventAt} height={20} showAge={!quiet && !retry} className="min-w-0 flex-1" />
          {quiet ? <QuietChip since={agent.live.lastEventAt ?? 0} /> : !retry && <TpsSparkline tps={agent.live.tps} status={status} />}
        </div>
      </>
    );
  } else if (lane === "done") {
    body = (
      <>
        <RestingLine agent={agent} lines={1} className="mt-1.5" />
        {/* collapses while there's nothing to offer */}
        <div className="mt-2.5 flex empty:hidden" onClick={stop} onPointerDown={stop}>
          <DeleteWorktreeButton agentKey={agentKey} andDone={false} />
        </div>
      </>
    );
  }

  const model = omp?.model;
  const thinking = omp?.thinking && omp.thinking !== "off" ? omp.thinking : undefined;
  const meters =
    omp?.context || subPct != null || omp?.jobs?.running || agent.diff || omp?.link === "notShared" || model || thinking ? (
      // fixed order; wraps onto a second line on narrow cards instead of hiding anything
      <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line pt-2">
        {omp?.context && <ContextMeter pct={omp.context.pct} />}
        {subPct != null && <SubagentsDone pct={subPct} live={subs} />}
        {omp?.jobs && <JobsMeter jobs={omp.jobs} />}
        {agent.diff && <DiffStat {...agent.diff} muted={lane === "done"} />}
        <ConnectLinkButton agentKey={agentKey} />
        {model && (
          <Tooltip content="Model">
            <span className="inline-flex max-w-full min-w-0 items-center gap-1 font-mono text-2xs text-mute">
              <Sparkles className="size-3 shrink-0 text-mute-2" aria-hidden />
              <span className="truncate">{model.label ?? model.id}</span>
            </span>
          </Tooltip>
        )}
        {thinking && (
          <Tooltip content="Thinking level">
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-2xs text-mute">
              <Brain className="size-3 text-mute-2" aria-hidden />
              {thinking}
            </span>
          </Tooltip>
        )}
      </div>
    ) : null;

  const card = (
    <Card
      data-status={status}
      data-morph={floating ? undefined : "surface"}
      data-morph-key={floating ? undefined : agentKey}
      selected={selected || picked}
      className={cn(
        "group/card relative flex flex-col rounded-xl p-3.5 outline-none @container/card",
        lane === "needs" && "st-border-grad",
        isHero && "card-sunset sun-pulse",
        stale && "opacity-70 grayscale-[0.65]",
        quiet && "shadow-[var(--shadow-d1),inset_0_0_0_1px_rgb(251_191_36/0.3)]",
        floating && "shadow-[var(--shadow-d3)]",
      )}
    >
      {/* (1) state strip: state word (+ tool) left, timed verb right — the same place on every lane */}
      <div className="mb-2 flex min-w-0 items-center gap-2 pr-1 whitespace-nowrap">
        <span
          data-status={status}
          className={cn(
            "min-w-0 truncate rounded-full px-2 py-0.5 font-display text-[9.5px] font-bold tracking-[0.12em] uppercase",
            isHero ? "bg-[rgb(40_0_20/0.28)] text-white" : herdr ? "bg-white/6 text-mute" : PILL[state],
          )}
        >
          {herdr ? herdrAgentWord(herdr) : agentStateWord({ ...agent, column: lane })}
          {lane === "running" && agent.live.tool && !stale && <span className="normal-case tracking-normal"> · {agent.live.tool.name}</span>}
        </span>
        <StateTime agent={agent} state={state} stale={hostStale} herdr={herdr} className={cn("ml-auto shrink-0 text-2xs font-bold tabular", lane === "needs" && !isHero ? "text-[#ffb08a]" : "text-mute")} />
      </div>

      {/* (2) identity + (3) title */}
      <div className="flex items-start gap-3">
        <span data-morph={floating ? undefined : "glyph"} data-morph-key={floating ? undefined : agentKey} className="flex shrink-0 flex-col items-center gap-0.5">
          {subs > 0 ? (
            <Swarm count={subs} size={36} status={status}>
              {avatar}
            </Swarm>
          ) : (
            avatar
          )}
          {ring && <span className="text-[9px] font-bold text-mute-2">todos</span>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            {lane === "running" && <AgentOrb agentKey={agentKey} status={status} tool={stale ? undefined : agent.live.tool} quiet={quiet} size={7} />}
            <span
              data-morph={floating ? undefined : "name"}
              data-morph-key={floating ? undefined : agentKey}
              className="max-w-full min-w-[4ch] truncate font-extrabold text-ink"
              title={agent.name}
            >
              {agent.name}
            </span>
            {agent.kind !== "omp" && <span className="shrink-0 rounded-xs bg-white/6 px-1 text-[9.5px] font-bold text-mute uppercase">{agent.kind}</span>}
            {muted && (
              <span role="img" aria-label="Notifications muted" title="Notifications muted" className="shrink-0 text-mute-2">
                <BellOff className="size-3" aria-hidden />
              </span>
            )}
            {agent.parked && <ParkedChip agentKey={agentKey} />}
            <AutoResumeBadge agentKey={agentKey} />
            {multiHost && <HostTag hostId={agent.hostId} />}
            <RepoTag hostId={agent.hostId} repo={agent.repo} branch={agent.branch} cwd={agent.cwd} sunset={isHero} />
          </div>
          <h4 className={cn("mt-0.5 font-sans leading-snug font-bold wrap-break-word text-ink", lane === "done" ? "line-clamp-1 text-xs" : "line-clamp-2 text-sm")}>
            {agent.title || (fresh ? "New session" : agent.name)}
          </h4>
        </div>
      </div>

      {/* (4) lane body */}
      {body}

      {/* (5) meters */}
      {meters}

      {/* Review/Done in a linked worktree: is its PR merged or closed? (lazy, cached; feeds Delete worktree) */}
      {(lane === "review" || lane === "done") && !fresh && !floating && <PrProbe agentKey={agentKey} />}

      {/* hover actions: quick tools for running cards, the ⋯ menu everywhere */}
      {!floating && (
        <div
          className="absolute top-2 right-2 flex gap-0.5 rounded-md bg-[rgb(27_27_37/0.94)] p-0.5 opacity-0 shadow-[var(--shadow-d2),inset_0_0_0_1px_rgb(255_255_255/0.07)] transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[data-state=open]]:opacity-100"
          onClick={stop}
          onPointerDown={stop}
        >
          {lane === "running" && (
            <>
              <Tooltip content={ACTIONS.openSession.label} shortcut={ACTIONS.openSession.shortcut}>
                <IconButton label={ACTIONS.openSession.label} size="sm" onClick={() => openAgent(agentKey)}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7.5 8.5" />
                  </svg>
                </IconButton>
              </Tooltip>
              <Tooltip content={ACTIONS.terminal.description} shortcut={ACTIONS.terminal.shortcut}>
                <IconButton label={ACTIONS.terminal.label} size="sm" onClick={() => openTerminal(agentKey, false)}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="m3 4.5 3 3-3 3M8 11.5h5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </IconButton>
              </Tooltip>
              <Tooltip content={ACTIONS.stopTurn.description}>
                <IconButton label={ACTIONS.stopTurn.label} size="sm" onClick={() => void stopAgent(agentKey)}>
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
            className="absolute -top-1.5 -left-1.5 z-raised grid size-5 place-items-center rounded-full bg-accent text-white shadow-glow-accent"
          >
            <svg viewBox="0 0 12 12" className="size-3">
              <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
    </Card>
  );

  // Motion budget: needs-you always glows (the hero glows through its sunset pulse); running cards glow only in Lively.
  const glowing = !isHero && !stale && !quiet && !floating && (lane === "needs" || (lane === "running" && lively));
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
