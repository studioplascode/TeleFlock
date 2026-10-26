import { BellOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { navigate, useAgent, useColumnKeys, useCore, useHostIds, useHosts, useHostStale, useHostStates, useUi } from "@/core";
import type { Column } from "@/core/gen";
import { WhileAwayToast } from "@/features/activity/WhileAwayToast";
import { connAction } from "@/features/hosts/ConnStatusCard";
import { askText } from "@/features/inbox/askText";
import { phaseBusy } from "@/features/shell/status";
import { ACTIONS, isFresh, LANE_TITLE, NEEDS_WORD, STATE_WORD, stateTime } from "@/features/shell/vocab";
import {
  AgentGlyph,
  Button,
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
  formatCompact,
  formatUsd,
  spring,
  useCalmMotion,
  useNow,
} from "@/design";
import { DiffStat } from "./AgentCard";
import { archiveWithUndo, canReview, openAgent, openAnswerHud, openTerminal, promptAgent, setArchived, stopAgent, useMuted } from "./agentActions";
import { CardMenuButton } from "./CardMenu";
import { FilterChip } from "./FilterChip";
import { SelectionBar } from "./SelectionBar";
import { useTodayUsage } from "./BentoRow";
import { useBoard } from "./boardStore";
import { connWords, FlockFab, HostChip } from "./FlockActions";
import { LANE_BY_COLUMN, QUIET_AFTER_MS } from "./lanes";
import { AgentHeartbeat, AgentOrb, ConnectLinkButton, ContextMeter, LiveLine, QuietChip, SubagentsDone, TpsSparkline, useQuiet } from "./LiveBits";
import { ParkedChip } from "./ParkedChip";
import { SetupGaps } from "./StaleHosts";
import { QuickAnswer } from "./QuickAnswer";
import { type SwipeAction, SwipeRow } from "./SwipeRow";
import { useBeat } from "./useBeat";

const RUNNING_ID = "flock-running";

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
  stop: (
    <svg viewBox="0 0 20 20" aria-hidden>
      <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  ),
  markDone: (
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

/** Swipe-left accelerators; every one also has a visible twin (row buttons or the ⋯ menu). */
function swipeActions(key: string, column: Column): SwipeAction[] {
  const out: SwipeAction[] = [];
  if (column === "needs") out.push({ id: "answer", label: ACTIONS.answer.label, icon: ICON.answer, tone: "bg-sun text-white", run: () => openAnswerHud(key) });
  out.push({ id: "terminal", label: ACTIONS.terminal.label, icon: ICON.terminal, tone: "bg-tile-5 text-ink", run: () => openTerminal(key, true) });
  if (column === "running") out.push({ id: "stop", label: ACTIONS.stopTurn.label, icon: ICON.stop, tone: "bg-error text-white", run: () => void stopAgent(key) });
  if (column === "review") out.push({ id: "markDone", label: ACTIONS.markDone.label, icon: ICON.markDone, tone: "bg-done text-[#1a2e05]", run: () => void archiveWithUndo([key]) });
  if (column === "done") out.push({ id: "reopen", label: ACTIONS.reopen.label, icon: ICON.reopen, tone: "bg-review text-[#04262c]", run: () => void setArchived(key, false).catch(() => {}) });
  return out;
}

/** Row buttons must not start a swipe, a long-press or open the session. */
const stopRow = {
  onClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
  onPointerDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
};

/* ───────────────────────── host strips ───────────────────────── */

/** One line per disconnected host in view: `● studio-pc offline · 3h ago · Retry` (cards below are its snapshot). */
function StaleStrip({ hostId }: { hostId: string }) {
  const stale = useHostStale(hostId);
  const st = useHosts((s) => s.status[hostId]);
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const now = useNow(1000);
  if (!stale || !st) return null;
  const action = connAction(st, hostId);
  const bad = st.phase === "authRequired" || st.phase === "hostKey" || st.phase === "error";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={spring.smooth}
      role="status"
      aria-label={`${name} ${connWords(st, now)}; its cards show the last snapshot`}
      className="flex min-h-10 items-center gap-2 rounded-lg bg-warn/8 py-1 pr-1 pl-3 text-xs shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]"
    >
      <StatusOrb status={bad ? "error" : "idle"} size={8} label={null} className="shrink-0" />
      <p className="min-w-0 flex-1 truncate text-mute">
        <b className="text-ink">{name}</b> <span className={cn(phaseBusy(st.phase) && "tf-shimmer-text")}>{connWords(st, now)}</span>
        {st.error && <span className="text-[#ff9fb2]"> · {st.error.message}</span>}
      </p>
      {action && (
        <Button size="sm" variant="secondary" className="shrink-0" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </motion.div>
  );
}

/* ───────────────────────── widgets ───────────────────────── */

/** The three tiles act and say so: answer what waits, jump to Running, open Usage. */
function Widgets() {
  const hostId = useHosts((s) => s.filter);
  const needs = useColumnKeys("needs", { hostId });
  const running = useColumnKeys("running", { hostId });
  const { cost, tokens } = useTodayUsage(hostId);
  const { beat, lastAt } = useBeat(running);
  const calm = useCalmMotion();
  // Board quiet heuristic: working, host online, no events for QUIET_AFTER_MS (possibly stuck).
  const now = useNow(5000);
  const quiet = useCore((s) =>
    running.reduce((n, k) => {
      const a = s.agents[k];
      const at = a?.live.lastEventAt;
      const online = a !== undefined && (s.hosts[a.hostId] === undefined || s.status[a.hostId]?.phase === "online");
      return online && at !== undefined && now - at > QUIET_AFTER_MS ? n + 1 : n;
    }, 0),
  );
  const tile = "flex h-24 flex-col justify-between rounded-[20px] p-3";
  return (
    <div className="grid grid-cols-[1fr_1fr_1.35fr] gap-2">
      <button
        type="button"
        onClick={() => (needs[0] ? openAnswerHud(needs[0]) : navigate({ name: "inbox" }))}
        className="text-left pressable focus-ring rounded-tile"
        aria-label={needs.length > 0 ? `${needs.length} need you: answer` : "Nothing needs you: open Inbox"}
      >
        {/* Keyed by the count: Calm's bounded sunset pulse plays again for each new arrival (the button keeps focus). */}
        <Tile key={needs.length} variant={needs.length > 0 ? "sunset" : "default"} className={cn(tile, needs.length > 0 && "sun-pulse")}>
          <NumberTicker value={needs.length} className="font-display text-display leading-none font-bold" />
          <span className={cn("text-xs font-bold whitespace-nowrap", needs.length > 0 ? "text-white/90" : "text-mute")}>
            need you{needs.length > 0 && <span className="text-white"> · Answer →</span>}
          </span>
        </Tile>
      </button>
      <button
        type="button"
        disabled={running.length === 0}
        onClick={() => document.getElementById(RUNNING_ID)?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" })}
        className="min-w-0 text-left pressable focus-ring rounded-tile disabled:pointer-events-none"
        aria-label={`${running.length} running${quiet > 0 ? `, ${quiet} quiet (no events for over 90 seconds)` : ""}: jump to Running`}
      >
        <Tile className={cn(tile, "overflow-hidden")}>
          <div className="flex items-start justify-between">
            <NumberTicker value={running.length} className="font-display text-display leading-none font-bold text-ink" />
            <StatusOrb status="running" size={8} activity={running.length > quiet ? "busy" : "silent"} label={null} />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <Heartbeat beat={beat} lastEventAt={lastAt} status="running" height={16} showAge={false} className="min-w-0 flex-1" />
              {quiet > 0 && (
                <span className="flex shrink-0 items-center gap-1 text-2xs font-extrabold whitespace-nowrap text-warn" title="No events for over 90 s while working: possibly stuck">
                  <span className="size-1.5 rounded-full bg-warn shadow-[0_0_6px_rgb(251_191_36/0.7)]" aria-hidden />
                  {quiet} quiet
                </span>
              )}
            </div>
            <span className="text-xs font-bold text-mute">running{running.length > 0 && " ↓"}</span>
          </div>
        </Tile>
      </button>
      <button type="button" onClick={() => navigate({ name: "usage" })} className="min-w-0 text-left pressable focus-ring rounded-tile" aria-label={`${formatUsd(cost)} today: open Usage`}>
        <Tile className={cn(tile, "min-w-0")}>
          <NumberTicker value={cost} format={formatUsd} className="font-display text-2xl leading-none font-bold text-ink" />
          <span className="flex min-w-0 flex-col text-xs font-bold text-mute">
            <span className="truncate">
              <NumberTicker value={tokens} format={formatCompact} className="text-ink" /> tok
            </span>
            <span className="truncate">today ›</span>
          </span>
        </Tile>
      </button>
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
  // each fact once: generic titles and an approval's command lines give way (same rule as Inbox, HUD, session)
  const { headline, body } = askText({ title: n.title, message: n.question, command: n.command, approval: n.kind === "approval" });
  return (
    <SwipeRow id={agentKey} actions={swipeActions(agentKey, "needs")} onOpen={() => openAgent(agentKey)}>
      <div data-status="needs-you" data-morph="surface" data-morph-key={agentKey} className={cn("card-surface st-border-grad rounded-xl p-3.5 pt-2.5", stale && "opacity-70 grayscale-[0.6]")}>
        <div className="flex items-center gap-2">
          <span data-status="needs-you" className="min-w-0 truncate rounded-full st-bg px-2 py-0.5 font-display text-[10px] font-bold tracking-[0.12em] uppercase">
            {agent.name} · {NEEDS_WORD[n.kind]}
          </span>
          {muted && <BellOff className="size-3.5 shrink-0 text-mute-2" aria-label="Notifications muted" />}
          <span className="ml-auto shrink-0 text-xs font-bold whitespace-nowrap text-[#ffb08a]">
            waiting <Elapsed since={n.since} />
          </span>
          <span className="-mr-1.5 shrink-0">
            <CardMenuButton agentKey={agentKey} lane="needs" mobile />
          </span>
        </div>
        <p className="mt-1.5 font-display text-lg leading-snug font-bold text-ink">{headline}</p>
        {body && <p className="mt-1 line-clamp-3 text-sm whitespace-pre-line text-mute">{body}</p>}
        <p className="mt-1 truncate font-mono text-2xs text-mute-2">
          {agent.repo}
          {agent.branch && ` · ${agent.branch}`}
        </p>
        {n.command && <pre className="mt-2 overflow-x-auto rounded-md well px-3 py-2 font-mono text-xs text-ink-2">{n.command}</pre>}
        <QuickAnswer agentKey={agentKey} appearance="big" mobile className="mt-3" />
      </div>
    </SwipeRow>
  );
}

/** Live facts under a row, same set as the desktop card footer: ctx · subagents · diff · not shared · model. */
function RowMeta({ agentKey, diff = true }: { agentKey: string; diff?: boolean }) {
  const agent = useAgent(agentKey);
  const omp = agent?.omp;
  if (!agent) return null;
  const subs = omp?.subagents?.live ?? 0;
  const subPct = subs > 0 ? omp?.subagents?.completionPct : undefined;
  const model = omp?.model ? `${omp.model.label ?? omp.model.id}${omp.thinking && omp.thinking !== "off" ? ` · ${omp.thinking}` : ""}` : null;
  if (!omp?.context && subPct == null && !(diff && agent.diff) && omp?.link !== "notShared" && !model) return null;
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-2.5">
      {omp?.context && <ContextMeter pct={omp.context.pct} />}
      {subPct != null && <SubagentsDone pct={subPct} live={subs} />}
      {diff && agent.diff && <DiffStat {...agent.diff} />}
      <span className="contents" {...stopRow}>
        <ConnectLinkButton agentKey={agentKey} />
      </span>
      {model && <span className="ml-auto min-w-0 truncate font-mono text-2xs text-mute">{model}</span>}
    </div>
  );
}

function AgentRow({ agentKey, column }: { agentKey: string; column: Column }) {
  const agent = useAgent(agentKey);
  const stale = useHostStale(agent?.hostId ?? "");
  const muted = useMuted(agentKey);
  const quiet = useQuiet(column === "running" && !stale, agent?.live.lastEventAt);
  const now = useNow(30_000);
  if (!agent) return null;
  // the lane the row is drawn in leads the host state during an optimistic move
  const fresh = column === "review" && isFresh(agent);
  const state = fresh ? "fresh" : column;
  // a fresh agent that never ran sits calmly (idle), not in review cyan
  const status = fresh ? "idle" : LANE_BY_COLUMN[column].status;
  const todos = agent.omp?.todos;
  return (
    <SwipeRow id={agentKey} actions={swipeActions(agentKey, column)} onOpen={() => openAgent(agentKey)}>
      <div data-status={status} data-morph="surface" data-morph-key={agentKey} className={cn("card-surface flex gap-2.5 rounded-xl py-2.5 pr-1.5 pl-3", stale && "opacity-70 grayscale-[0.6]", quiet && "shadow-[var(--shadow-d1),inset_0_0_0_1px_rgb(251_191_36/0.3)]")}>
        <span className="pt-0.5">
          {todos && todos.total > 0 ? (
            <ProgressRing done={todos.done} total={todos.total} status={quiet ? "idle" : status} size={36} stroke={3.5} />
          ) : (
            <AgentGlyph name={agent.name} size={36} status={column === "running" ? status : undefined} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-8 items-center gap-1.5">
            {column === "running" && <AgentOrb agentKey={agentKey} status={status} tool={agent.live.tool} quiet={quiet} size={7} />}
            <span data-morph="name" data-morph-key={agentKey} className="min-w-[4ch] truncate text-sm font-extrabold text-ink">
              {agent.name}
            </span>
            {muted && <BellOff className="size-3 shrink-0 text-mute-2" aria-label="Notifications muted" />}
            {agent.parked && <ParkedChip agentKey={agentKey} />}
            <span className="min-w-0 flex-[1_1_0] truncate font-mono text-2xs text-mute-2">{agent.repo}</span>
            <span className="shrink-0 font-mono text-2xs text-mute tabular">
              {column === "running" ? (
                <>
                  turn <Elapsed since={agent.omp?.turnStartedAt ?? agent.stateSince} />
                </>
              ) : (
                stateTime(state, agent.stateSince, now)
              )}
            </span>
            <span className="shrink-0">
              <CardMenuButton agentKey={agentKey} lane={column} mobile />
            </span>
          </div>
          <p className={cn("pr-1.5 font-semibold text-ink-2", column === "done" ? "truncate text-xs" : "line-clamp-2 text-sm leading-snug")}>{agent.title || agent.name}</p>
          <div className="pr-1.5">
            {column === "running" && (
              <>
                <LiveLine live={agent.live} running={!stale} turnStartedAt={agent.omp?.turnStartedAt ?? agent.stateSince} className="mt-1" />
                <div className="mt-1 flex items-center gap-2">
                  {/* one signal per fact: while quiet, the quiet chip stands in for the heartbeat's age (and the flat tok/s) */}
                  <AgentHeartbeat
                    agentKey={agentKey}
                    status={quiet ? "idle" : status}
                    lastEventAt={agent.live.lastEventAt}
                    showAge={!quiet}
                    height={16}
                    className="min-w-0 flex-1"
                  />
                  {quiet ? <QuietChip since={agent.live.lastEventAt ?? 0} className="shrink-0" /> : <TpsSparkline tps={agent.live.tps} status={status} />}
                </div>
                <RowMeta agentKey={agentKey} />
              </>
            )}
            {fresh && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="rounded-full bg-white/6 px-2 py-px text-[10px] font-bold text-mute uppercase">{STATE_WORD.fresh}</span>
                <button
                  type="button"
                  className="ml-auto min-h-9 rounded-sm bg-accent px-3 py-1 text-2xs font-extrabold text-white shadow-glow-accent pressable focus-ring"
                  {...stopRow}
                  onClick={(e) => {
                    e.stopPropagation();
                    promptAgent(agentKey);
                  }}
                >
                  Prompt…
                </button>
              </div>
            )}
            {column === "review" && !fresh && (
              <>
                <RowMeta agentKey={agentKey} />
                <div className="mt-1.5 flex items-center justify-end gap-1.5" {...stopRow}>
                  <button
                    type="button"
                    className="min-h-9 rounded-sm bg-tile-4 px-3 py-1 text-2xs font-bold text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] pressable focus-ring"
                    title={ACTIONS.markDone.description}
                    onClick={() => void archiveWithUndo([agentKey])}
                  >
                    {ACTIONS.markDone.label}
                  </button>
                  {canReview(agent) && (
                    <button
                      type="button"
                      data-status="review"
                      className="min-h-9 rounded-sm st-bg px-3 py-1 text-2xs font-extrabold pressable focus-ring"
                      title={ACTIONS.review.description}
                      onClick={() => navigate({ name: "review", hostId: agent.hostId, workspaceId: agent.workspaceId })}
                    >
                      {ACTIONS.review.label}
                    </button>
                  )}
                </div>
              </>
            )}
            {column === "done" && agent.diff && (
              <div className="mt-0.5">
                <DiffStat {...agent.diff} />
              </div>
            )}
          </div>
        </div>
      </div>
    </SwipeRow>
  );
}

function Section({ column, count, children, action, id }: { column: Column; count: number; children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <section id={id} className="flex scroll-mt-3 flex-col gap-2" aria-label={LANE_TITLE[column]}>
      <header className="flex items-center gap-2 px-1">
        <StatusOrb status={LANE_BY_COLUMN[column].status} size={7} label={null} />
        <h2 className="font-display text-md font-bold text-ink">{LANE_TITLE[column]}</h2>
        <span className="rounded-full bg-white/6 px-1.5 text-2xs font-bold text-mute tabular">{count}</span>
        <span className="ml-auto">{action}</span>
      </header>
      {children}
    </section>
  );
}

/**
 * The host to send a newcomer to while setup is unfinished: no host yet ("" = add one), none online,
 * or an online host whose setup hides agents. null when every host is ready.
 */
function useSetupTarget(): string | null {
  const ids = useHostIds();
  const status = useHosts((s) => s.status);
  const states = useHostStates();
  if (ids.length === 0) return "";
  const gap = ids.find((id) => {
    const setup = states[id]?.info.setup;
    return status[id]?.phase === "online" && setup !== undefined && !(setup.globalSharing && setup.herdrIntegration);
  });
  if (gap) return gap;
  return ids.some((id) => status[id]?.phase === "online") ? null : (ids[0] ?? "");
}

function EmptyFlock() {
  const { openDialog } = useUi();
  const filter = useHosts((s) => s.filter);
  const firstOnline = useHosts((s) => s.profiles.find((p) => s.status[p.id]?.phase === "online")?.id);
  const setup = useSetupTarget();
  return (
    <EmptyState
      title="No agents yet"
      description="Type a task and an agent starts on it in its own worktree. It shows up here with a live heartbeat."
      action={
        <div className="flex flex-col items-center gap-2">
          <Button variant="primary" onClick={() => navigate({ name: "dispatch" })}>
            Dispatch a task
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => openDialog({ kind: "newWorktree", hostId: filter !== "all" ? filter : firstOnline })}>
              {ACTIONS.newWorktree.label}
            </Button>
            {setup !== null && (
              <Button variant="ghost" onClick={() => (setup ? (window.location.hash = `#/hosts?setup=${encodeURIComponent(setup)}`) : navigate({ name: "hosts" }))}>
                Hosts
              </Button>
            )}
          </div>
        </div>
      }
    />
  );
}

/** Mobile home (spec §3 "Flock home"). */
export function FlockHome() {
  const hostId = useHosts((s) => s.filter);
  const ids = useHostIds();
  const q = useBoard((s) => s.q.trim()) || undefined;
  const needs = useColumnKeys("needs", { hostId, q });
  const running = useColumnKeys("running", { hostId, q });
  const review = useColumnKeys("review", { hostId, q });
  const done = useColumnKeys("done", { hostId, q });
  const doneOpen = useBoard((s) => s.doneOpen);
  const toggleDone = useBoard((s) => s.toggleDone);
  const empty = needs.length + running.length + review.length + done.length === 0;
  const shownHosts = hostId === "all" ? ids : ids.filter((id) => id === hostId);
  useEffect(() => () => useBoard.getState().clearPicked(), []);

  return (
    <div className="flex min-h-full flex-col gap-3 px-3.5 pt-2.5 pb-22">
      <WhileAwayToast />
      <header className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-bold text-ink">Flock</h1>
        <HostChip />
      </header>
      <AnimatePresence initial={false}>
        {shownHosts.map((id) => (
          <StaleStrip key={id} hostId={id} />
        ))}
      </AnimatePresence>
      <SetupGaps />
      <FilterChip className="self-start" />
      <Widgets />
      <LayoutGroup id="flock">
        {empty && q && <EmptyState title="No matches" description={`No agent matches “${q}”.`} />}
        {empty && !q && <EmptyFlock />}
        {needs.length > 0 && (
          <Section column="needs" count={needs.length}>
            {needs.map((k) => (
              <CardFlight key={k} flightId={k}>
                <NeedsCard agentKey={k} />
              </CardFlight>
            ))}
          </Section>
        )}
        {running.length > 0 && (
          <Section column="running" count={running.length} id={RUNNING_ID}>
            {running.map((k) => (
              <CardFlight key={k} flightId={k}>
                <AgentRow agentKey={k} column="running" />
              </CardFlight>
            ))}
          </Section>
        )}
        {review.length > 0 && (
          <Section column="review" count={review.length}>
            {review.map((k) => (
              <CardFlight key={k} flightId={k}>
                <AgentRow agentKey={k} column="review" />
              </CardFlight>
            ))}
          </Section>
        )}
        {done.length > 0 && (
          <Section
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
                  initial={{ height: 0, opacity: 0, overflow: "hidden" }}
                  // Clip only while sizing: settled, the cards' shadows and selection rings must not be cut.
                  animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
                  exit={{ height: 0, opacity: 0, overflow: "hidden" }}
                  transition={spring.smooth}
                  className="flex flex-col gap-2"
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
      <SelectionBar mobile />
      <FlockFab />
    </div>
  );
}
