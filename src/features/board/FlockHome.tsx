import { BellOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { navigate, parseAgentKey, useAgent, useColumnKeys, useHostIds, useHostStale, useHosts } from "@/core";
import type { Column } from "@/core/gen";
import { WhileAwayToast } from "@/features/activity/WhileAwayToast";
import {
  AgentGlyph,
  CardFlight,
  Elapsed,
  EmptyState,
  Heartbeat,
  LayoutGroup,
  NumberTicker,
  ProgressRing,
  StatusOrb,
  Tile,
  cn,
  formatAge,
  formatCompact,
  formatUsd,
  spring,
  useNow,
} from "@/design";
import { DiffStat } from "./AgentCard";
import { archiveWithUndo, canReview, openAgent, openAnswerHud, openTerminal, promptAgent, setArchived, useMuted } from "./agentActions";
import { ArchiveConfirmDialog } from "./CardMenu";
import { FilterChip } from "./FilterChip";
import { SelectionBar } from "./SelectionBar";
import { useTodayUsage } from "./BentoRow";
import { useBoard } from "./boardStore";
import { LANE_BY_COLUMN, NEEDS_LABEL } from "./lanes";
import { AgentHeartbeat, AgentOrb, LiveLine, QuietChip, useQuiet } from "./LiveBits";
import { QuickAnswer } from "./QuickAnswer";
import { type SwipeAction, SwipeRow } from "./SwipeRow";
import { useBeat } from "./useBeat";
import { StaleHosts } from "./StaleHosts";

const ICON = {
  answer: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5V13a2.5 2.5 0 0 1-1-2z" strokeLinejoin="round" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="m6 8 2.5 2.5L6 13M10.5 13H14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  archive: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <rect x="2.5" y="3.5" width="15" height="4" rx="1.2" />
      <path d="M4 7.5v7a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-7M8 11h4" strokeLinecap="round" />
    </svg>
  ),
  reopen: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 10a6 6 0 1 0 2-4.5M4 3.5v3h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

function swipeActions(key: string, column: Column): SwipeAction[] {
  const out: SwipeAction[] = [];
  if (column === "needs") out.push({ id: "answer", label: "Answer", icon: ICON.answer, tone: "bg-sun text-white", run: () => openAnswerHud(key) });
  out.push({ id: "terminal", label: "Terminal", icon: ICON.terminal, tone: "bg-tile-5 text-ink", run: () => openTerminal(key, true) });
  if (column === "review") out.push({ id: "archive", label: "Archive", icon: ICON.archive, tone: "bg-done text-[#1a2e05]", run: () => void archiveWithUndo([key]) });
  if (column === "done") out.push({ id: "reopen", label: "Reopen", icon: ICON.reopen, tone: "bg-review text-[#04262c]", run: () => void setArchived(key, false).catch(() => {}) });
  return out;
}

/* ───────────────────────── widgets ───────────────────────── */

function Widgets() {
  const hostId = useHosts((s) => s.filter);
  const needs = useColumnKeys("needs", { hostId });
  const running = useColumnKeys("running", { hostId });
  const { cost, tokens } = useTodayUsage(hostId);
  const { beat, lastAt } = useBeat(running);
  return (
    <div className="grid grid-cols-[1fr_1fr_1.35fr] gap-2.5">
      <button
        type="button"
        onClick={() => (needs[0] ? openAnswerHud(needs[0]) : navigate({ name: "inbox" }))}
        className="text-left pressable focus-ring rounded-tile"
        aria-label={`${needs.length} need you`}
      >
        <Tile variant={needs.length > 0 ? "sunset" : "default"} className={cn("flex h-28 flex-col justify-between rounded-[22px] p-3.5", needs.length > 0 && "sun-pulse")}>
          <NumberTicker value={needs.length} className="font-display text-hero leading-none font-bold" />
          <span className={cn("text-xs font-bold", needs.length > 0 ? "text-white/90" : "text-mute")}>need you</span>
        </Tile>
      </button>
      <Tile className="flex h-28 flex-col justify-between overflow-hidden rounded-[22px] p-3.5">
        <div className="flex items-start justify-between">
          <NumberTicker value={running.length} className="font-display text-hero leading-none font-bold text-ink" />
          <StatusOrb status="running" size={8} activity={running.length > 0 ? "busy" : "silent"} label={null} />
        </div>
        <div>
          <Heartbeat beat={beat} lastEventAt={lastAt} status="running" height={18} showAge={false} />
          <span className="text-xs font-bold text-mute">running</span>
        </div>
      </Tile>
      <Tile className="flex h-28 flex-col justify-between rounded-[22px] p-3.5">
        <NumberTicker value={cost} format={formatUsd} className="font-display text-3xl leading-none font-bold text-ink" />
        <span className="text-xs font-bold text-mute">
          today · <NumberTicker value={tokens} format={formatCompact} className="text-ink" /> tok
        </span>
      </Tile>
    </div>
  );
}

/* ───────────────────────── rows ───────────────────────── */

function NeedsCard({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  const stale = useHostStale(agent?.hostId ?? "");
  const muted = useMuted(agentKey);
  if (!agent?.needs) return null;
  const n = agent.needs;
  return (
    <SwipeRow id={agentKey} actions={swipeActions(agentKey, "needs")} onOpen={() => openAgent(agentKey)}>
      <div data-status="needs-you" data-morph="surface" data-morph-key={agentKey} className={cn("card-surface st-border-grad rounded-xl p-4", stale && "opacity-70 grayscale-[0.6]")}>
        <div className="flex items-center gap-2">
          <span data-status="needs-you" className="rounded-full st-bg px-2 py-0.5 font-display text-[10px] font-bold tracking-[0.12em] uppercase">
            {agent.name} · {NEEDS_LABEL[n.kind]}
          </span>
          {muted && <BellOff className="size-3.5 shrink-0 text-mute-2" aria-label="Notifications muted" />}
          <span className="ml-auto text-xs font-bold text-[#ffb08a]">
            waiting <Elapsed since={n.since} />
          </span>
        </div>
        <p className="mt-2.5 font-display text-xl leading-tight font-bold text-ink">{n.question || n.title}</p>
        <p className="mt-1 truncate font-mono text-2xs text-mute-2">
          {agent.repo}
          {agent.branch && ` · ${agent.branch}`}
        </p>
        {n.command && <pre className="mt-2.5 overflow-x-auto rounded-md well px-3 py-2 font-mono text-xs text-ink-2">{n.command}</pre>}
        <QuickAnswer agentKey={agentKey} appearance="big" mobile className="mt-3.5" />
      </div>
    </SwipeRow>
  );
}

function AgentRow({ agentKey, column }: { agentKey: string; column: Column }) {
  const agent = useAgent(agentKey);
  const stale = useHostStale(agent?.hostId ?? "");
  const muted = useMuted(agentKey);
  const silent = useQuiet(column === "running" && !stale, agent?.live.lastEventAt);
  const now = useNow(30_000);
  if (!agent) return null;
  const status = column === "review" && agent.turns === 0 ? "idle" : LANE_BY_COLUMN[column].status;
  const todos = agent.omp?.todos;
  const quiet = silent !== null;
  return (
    <SwipeRow id={agentKey} actions={swipeActions(agentKey, column)} onOpen={() => openAgent(agentKey)}>
      <div data-status={status} data-morph="surface" data-morph-key={agentKey} className={cn("card-surface flex gap-3 rounded-xl p-3.5", stale && "opacity-70 grayscale-[0.6]", quiet && "shadow-[var(--shadow-d1),inset_0_0_0_1px_rgb(251_191_36/0.3)]")}>
        {todos && todos.total > 0 ? (
          <ProgressRing done={todos.done} total={todos.total} status={quiet ? "idle" : status} size={40} stroke={3.5} />
        ) : (
          <AgentGlyph name={agent.name} size={40} status={column === "running" ? status : undefined} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {column === "running" && <AgentOrb agentKey={agentKey} status={status} tool={agent.live.tool} quiet={quiet} size={7} />}
            <span data-morph="name" data-morph-key={agentKey} className="truncate text-sm font-extrabold text-ink">{agent.name}</span>
            {muted && <BellOff className="size-3 shrink-0 text-mute-2" aria-label="Notifications muted" />}
            <span className="min-w-0 truncate font-mono text-2xs text-mute-2">{agent.repo}</span>
            <span className="ml-auto shrink-0 font-mono text-2xs text-mute tabular">
              {column === "running" ? <Elapsed since={agent.omp?.turnStartedAt ?? agent.stateSince} /> : formatAge(now - agent.stateSince)}
            </span>
          </div>
          <p className={cn("mt-0.5 font-semibold text-ink-2", column === "done" ? "truncate text-xs" : "line-clamp-2 text-sm leading-snug")}>{agent.title || agent.name}</p>
          {column === "running" && (
            <>
              <LiveLine live={agent.live} running={!stale} turnStartedAt={agent.omp?.turnStartedAt ?? agent.stateSince} className="mt-1.5" />
              <div className="mt-1.5 flex items-center gap-2">
                <AgentHeartbeat agentKey={agentKey} status={quiet ? "idle" : status} lastEventAt={agent.live.lastEventAt} height={18} className="min-w-0 flex-1" />
                {quiet && <QuietChip silentMs={silent} />}
              </div>
            </>
          )}
          {column === "review" && agent.turns === 0 && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="rounded-full bg-white/6 px-2 py-px text-[10px] font-bold text-mute uppercase">Ready · waiting for a prompt</span>
              <button
                type="button"
                className="ml-auto min-h-9 rounded-sm bg-accent px-3 py-1 text-2xs font-extrabold text-white shadow-glow-accent pressable focus-ring"
                onClick={(e) => {
                  e.stopPropagation();
                  promptAgent(agentKey);
                }}
              >
                Prompt…
              </button>
            </div>
          )}
          {column === "review" && agent.turns > 0 && (
            <div className="mt-1.5 flex items-center gap-2">
              <span data-status="review" className="rounded-full st-soft px-2 py-px text-[10px] font-bold uppercase">
                Review
              </span>
              {agent.diff && <DiffStat {...agent.diff} />}
              {canReview(agent) && (
                <button
                  type="button"
                  data-status="review"
                  className="ml-auto rounded-sm st-bg px-2.5 py-1 text-2xs font-extrabold pressable focus-ring"
                  onClick={(e) => {
                    e.stopPropagation();
                    const { hostId } = parseAgentKey(agentKey);
                    navigate({ name: "review", hostId, workspaceId: agent.workspaceId });
                  }}
                >
                  Review diff
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </SwipeRow>
  );
}

function Section({ title, column, count, children, action }: { title: string; column: Column; count: number; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5" aria-label={title}>
      <header className="flex items-center gap-2 px-1">
        <StatusOrb status={LANE_BY_COLUMN[column].status} size={7} label={null} />
        <h2 className="font-display text-md font-bold text-ink">{title}</h2>
        <span className="rounded-full bg-white/6 px-1.5 text-2xs font-bold text-mute tabular">{count}</span>
        <span className="ml-auto">{action}</span>
      </header>
      {children}
    </section>
  );
}

function HostPill() {
  const ids = useHostIds();
  const filter = useHosts((s) => s.filter);
  const hostId = filter !== "all" ? filter : ids[0];
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const latency = useHosts((s) => (hostId ? s.status[hostId]?.latencyMs : undefined));
  const stale = useHostStale(hostId ?? "");
  if (!hostId) return null;
  return (
    <button type="button" onClick={() => navigate({ name: "hosts" })} className="flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-xs font-bold text-ink pressable focus-ring">
      <StatusOrb status={stale ? "idle" : "done"} size={7} label={null} />
      {name}
      {ids.length > 1 && filter === "all" && <span className="text-mute">+{ids.length - 1}</span>}
      <span className="text-mute">{stale ? "offline" : latency !== undefined ? `${latency} ms` : ""}</span>
    </button>
  );
}

/** Mobile home (spec §3 "Flock home"). */
export function FlockHome() {
  const hostId = useHosts((s) => s.filter);
  const q = useBoard((s) => s.q.trim()) || undefined;
  const needs = useColumnKeys("needs", { hostId, q });
  const running = useColumnKeys("running", { hostId, q });
  const review = useColumnKeys("review", { hostId, q });
  const done = useColumnKeys("done", { hostId, q });
  const doneOpen = useBoard((s) => s.doneOpen);
  const toggleDone = useBoard((s) => s.toggleDone);
  const empty = needs.length + running.length + review.length + done.length === 0;
  useEffect(() => () => useBoard.getState().clearPicked(), []);

  return (
    <div className="flex min-h-full flex-col gap-5 px-4 pt-[max(14px,env(safe-area-inset-top))] pb-6">
      <WhileAwayToast />
      <div className="contents">
        <header className="flex items-end justify-between">
          <div>
            <span className="kicker">Your agents, herded</span>
            <h1 className="font-display text-display font-bold text-ink">Flock</h1>
          </div>
          <HostPill />
        </header>
        <StaleHosts />
        <FilterChip className="self-start" />
        <Widgets />
        <LayoutGroup id="flock">
          {empty && q && <EmptyState title="No matches" description={`No agent matches “${q}”.`} />}
          {empty && !q && (
            <EmptyState
              title="No agents yet"
              description="Start one from a worktree — it appears here with a live heartbeat."
              action={
                <button type="button" className="rounded-md bg-accent px-4 py-2.5 text-sm font-bold text-white pressable" onClick={() => navigate({ name: "hosts" })}>
                  Hosts
                </button>
              }
            />
          )}
          {needs.length > 0 && (
            <Section title="Needs you" column="needs" count={needs.length}>
              {needs.map((k) => (
                <CardFlight key={k} flightId={k}>
                  <NeedsCard agentKey={k} />
                </CardFlight>
              ))}
            </Section>
          )}
          {running.length > 0 && (
            <Section title="Running" column="running" count={running.length}>
              {running.map((k) => (
                <CardFlight key={k} flightId={k}>
                  <AgentRow agentKey={k} column="running" />
                </CardFlight>
              ))}
            </Section>
          )}
          {review.length > 0 && (
            <Section title="In review" column="review" count={review.length}>
              {review.map((k) => (
                <CardFlight key={k} flightId={k}>
                  <AgentRow agentKey={k} column="review" />
                </CardFlight>
              ))}
            </Section>
          )}
          {done.length > 0 && (
            <Section
              title="Done"
              column="done"
              count={done.length}
              action={
                <button type="button" onClick={toggleDone} aria-expanded={doneOpen} className="rounded-full px-2.5 py-1 text-xs font-bold text-mute pressable focus-ring">
                  {doneOpen ? "Hide" : "Show"}
                </button>
              }
            >
              <AnimatePresence initial={false}>
                {doneOpen && (
                  <motion.div
                    key="done"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={spring.smooth}
                    className="flex flex-col gap-2.5 overflow-hidden"
                  >
                    {done.map((k) => (
                      <CardFlight key={k} flightId={k}>
                        <AgentRow agentKey={k} column="done" />
                      </CardFlight>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </Section>
          )}
        </LayoutGroup>
      </div>
      <SelectionBar mobile />
      <ArchiveConfirmDialog />
    </div>
  );
}
