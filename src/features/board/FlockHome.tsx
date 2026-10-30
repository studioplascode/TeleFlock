import { BellOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { navigate, useAgent, useColumnKeys, useCore, useHostIds, useHosts, useHostStale, useHostStates, useUi } from "@/core";
import type { Column } from "@/core/gen";
import { useHerdrDown } from "@/features/hosts/HerdrControls";
import { herdrAgentWord, herdrCardTime, herdrOrbStatus } from "@/features/hosts/herdrHealth";
import { WhileAwayToast } from "@/features/activity/WhileAwayToast";
import { CountdownChip } from "@/features/autoAnswer/CountdownChip";
import { askText } from "@/features/inbox/askText";
import { resumeNow } from "@/features/session/resume/actions";
import { ticketActions } from "@/features/session/resume/words";
import { ACTIONS, isFresh, LANE_TITLE, NEEDS_WORD, STATE_WORD, stateTime } from "@/features/shell/vocab";
import {
  AgentGlyph,
  Button,
  CardFlight,
  Elapsed,
  EmptyState,
  FlightGroup,
  Heartbeat,
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
import { FlockFab, HostChip, RepoChip } from "./FlockActions";
import { LANE_BY_COLUMN, QUIET_AFTER_MS } from "./lanes";
import { AutoResumeBadge } from "./AutoResumeBadge";
import { JobsMeter, WaitingForJobs } from "./JobsMeter";
import { RetryLine } from "./RetryLine";
import { retryOf } from "./retry";
import { AgentHeartbeat, AgentOrb, ConnectLinkButton, ContextMeter, LiveLine, QuietChip, SubagentsDone, TpsSparkline, useQuiet } from "./LiveBits";
import { ParkedChip } from "./ParkedChip";
import { RecapLine } from "./RecapLine";
import { PhoneNotices } from "./Notices";
import { QuickAnswer } from "./QuickAnswer";
import { RepoTag } from "./RepoTag";
import { type SwipeAction, SwipeRow } from "./SwipeRow";
import { boardSetupGap } from "./setupGap";
import { useBeat } from "./useBeat";
import { PrProbe } from "./worktreePr";

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
      return online && at !== undefined && !retryOf(a) && now - at > QUIET_AFTER_MS ? n + 1 : n;
    }, 0),
  );
  const tile = "flex h-24 flex-col justify-between rounded-[20px] p-3";
  return (
    // minmax(0, …): no tile's content widens its column; labels wrap or truncate, the spend figure shrinks to its tile
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)] gap-2">
      <button
        type="button"
        onClick={() => (needs[0] ? openAnswerHud(needs[0]) : navigate({ name: "inbox" }))}
        className="text-left pressable focus-ring rounded-tile"
        aria-label={needs.length > 0 ? `${needs.length} need you: answer` : "Nothing needs you: open Inbox"}
      >
        {/* Keyed by the count: Calm's bounded sunset pulse plays again for each new arrival (the button keeps focus). */}
        <Tile key={needs.length} variant={needs.length > 0 ? "sunset" : "default"} className={cn(tile, needs.length > 0 && "sun-pulse")}>
          <NumberTicker value={needs.length} className="font-display text-display leading-none font-bold" />
          <span className={cn("text-xs leading-tight font-bold", needs.length > 0 ? "text-white/90" : "text-mute")}>
            need you{needs.length > 0 && <span className="text-white"> · Answer&nbsp;→</span>}
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
            <span className="block truncate text-xs font-bold text-mute">running{running.length > 0 && " ↓"}</span>
          </div>
        </Tile>
      </button>
      <button type="button" onClick={() => navigate({ name: "usage" })} className="min-w-0 text-left pressable focus-ring rounded-tile" aria-label={`${formatUsd(cost)} today: open Usage`}>
        {/* @container: the cost figure shrinks to the tile (up to text-2xl) instead of clipping */}
        <Tile className={cn(tile, "min-w-0 @container")}>
          <NumberTicker value={cost} format={formatUsd} className="font-display text-hero-fit leading-none font-bold text-ink [--fit-max:var(--text-2xl)]" />
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
          <AutoResumeBadge agentKey={agentKey} />
          <span className="ml-auto shrink-0 text-xs font-bold whitespace-nowrap text-[#ffb08a]">
            waiting <Elapsed since={n.since} />
          </span>
          <span className="-mr-1.5 shrink-0">
            <CardMenuButton agentKey={agentKey} lane="needs" mobile />
          </span>
        </div>
        <RepoTag hostId={agent.hostId} repo={agent.repo} branch={agent.branch} cwd={agent.cwd} className="mt-1 flex" />
        <p className="mt-1.5 font-display text-lg leading-snug font-bold text-ink">{headline}</p>
        {body && <p className="mt-1 line-clamp-3 text-sm whitespace-pre-line text-mute">{body}</p>}
        {n.command && <pre className="mt-2 overflow-x-auto rounded-md well px-3 py-2 font-mono text-xs text-ink-2">{n.command}</pre>}
        <CountdownChip agentKey={agentKey} className="mt-2.5" />
        <QuickAnswer agentKey={agentKey} appearance="big" mobile className="mt-3" />
      </div>
    </SwipeRow>
  );
}

/**
 * Live facts under a row, same set as the desktop card footer: ctx · subagents · diff · not shared · model.
 * Fixed order, wrapping onto another line instead of running past the card; a narrow row drops the context
 * bar first (its % stays), and the model takes the rest of a line, truncated.
 */
function RowMeta({ agentKey, diff = true }: { agentKey: string; diff?: boolean }) {
  const agent = useAgent(agentKey);
  const omp = agent?.omp;
  if (!agent) return null;
  const subs = omp?.subagents?.live ?? 0;
  const subPct = subs > 0 ? omp?.subagents?.completionPct : undefined;
  const model = omp?.model ? `${omp.model.label ?? omp.model.id}${omp.thinking && omp.thinking !== "off" ? ` · ${omp.thinking}` : ""}` : null;
  if (!omp?.context && subPct == null && !omp?.jobs?.running && !(diff && agent.diff) && omp?.link !== "notShared" && !model) return null;
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 @container">
      {omp?.context && <ContextMeter pct={omp.context.pct} barClassName="@max-[300px]:hidden" />}
      {subPct != null && <SubagentsDone pct={subPct} live={subs} />}
      {omp?.jobs && <JobsMeter jobs={omp.jobs} />}
      {diff && agent.diff && <DiffStat {...agent.diff} />}
      <span className="contents" {...stopRow}>
        <ConnectLinkButton agentKey={agentKey} />
      </span>
      {model && <span className="min-w-0 flex-[1_1_6rem] truncate text-right font-mono text-2xs text-mute">{model}</span>}
    </div>
  );
}

function AgentRow({ agentKey, column }: { agentKey: string; column: Column }) {
  const agent = useAgent(agentKey);
  // herdr is down on its host: nothing runs, whatever the cached lane says (Review and Done rows were idle already)
  const herdrHealth = useHerdrDown(agent?.hostId ?? "");
  const herdr = column === "running" || column === "needs" ? herdrHealth : undefined;
  const stale = useHostStale(agent?.hostId ?? "") || herdr !== undefined;
  const muted = useMuted(agentKey);
  const retry = retryOf(agent);
  const quiet = useQuiet(column === "running" && !stale && !retry && !agent?.omp?.jobs?.waiting, agent?.live.lastEventAt);
  const now = useNow(30_000);
  if (!agent) return null;
  // the lane the row is drawn in leads the host state during an optimistic move
  const fresh = column === "review" && isFresh(agent);
  const state = fresh ? "fresh" : column;
  // an ended card (its omp ended without anyone closing it): its time counts from then; its ticket's Continue leads
  const ended = column === "review" ? agent.parked?.ended : undefined;
  const ticket = ended && agent.autoResume ? ticketActions(agent.autoResume, { ended }) : null;
  // a fresh agent that never ran sits calmly (idle), not in review cyan; so does an ended one until it is back
  const status = herdr ? herdrOrbStatus(herdr) : fresh || ended ? "idle" : LANE_BY_COLUMN[column].status;
  const todos = agent.omp?.todos;
  return (
    <SwipeRow id={agentKey} actions={swipeActions(agentKey, column)} onOpen={() => openAgent(agentKey)}>
      <div data-status={status} data-morph="surface" data-morph-key={agentKey} className={cn("card-surface flex gap-2.5 rounded-xl py-2.5 pr-1.5 pl-3", stale && "opacity-70 grayscale-[0.6]", quiet && "shadow-[var(--shadow-d1),inset_0_0_0_1px_rgb(251_191_36/0.3)]")}>
        <span className="pt-0.5">
          {todos && todos.total > 0 ? (
            <ProgressRing done={todos.done} total={todos.total} status={quiet ? "idle" : status} size={36} stroke={3.5} />
          ) : (
            <AgentGlyph name={agent.name} size={36} status={column === "running" && !herdr ? status : undefined} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-8 items-center gap-1.5">
            {column === "running" && !herdr && <AgentOrb agentKey={agentKey} status={status} tool={agent.live.tool} quiet={quiet} size={7} />}
            <span data-morph="name" data-morph-key={agentKey} className="min-w-[4ch] truncate text-sm font-extrabold text-ink">
              {agent.name}
            </span>
            {muted && <BellOff className="size-3 shrink-0 text-mute-2" aria-label="Notifications muted" />}
            {agent.parked && <ParkedChip agentKey={agentKey} />}
            <AutoResumeBadge agentKey={agentKey} />
            {/* takes only the room the name, time and ⋯ leave: the branch gives way first, then the repo name (the chip keeps its icon) */}
            <RepoTag hostId={agent.hostId} repo={agent.repo} branch={agent.branch} cwd={agent.cwd} className="min-w-6 flex-[1_1_0]" />
            <span className="ml-auto shrink-0 font-mono text-2xs text-mute tabular">
              {herdr ? (
                herdrCardTime(herdr)
              ) : column === "running" ? (
                <>
                  turn <Elapsed since={agent.omp?.turnStartedAt ?? agent.stateSince} />
                </>
              ) : (
                ended ? stateTime("ended", ended.at, now) : stateTime(state, agent.stateSince, now)
              )}
            </span>
            <span className="shrink-0">
              <CardMenuButton agentKey={agentKey} lane={column} mobile />
            </span>
          </div>
          <p className={cn("pr-1.5 font-semibold text-ink-2", column === "done" ? "truncate text-xs" : "line-clamp-2 text-sm leading-snug")}>{agent.title || agent.name}</p>
          <div className="pr-1.5">
            {herdr && <p className="mt-1 text-xs font-semibold text-mute">{herdrAgentWord(herdr)}</p>}
            {column === "running" && !herdr && (
              <>
                {retry ? (
                  <RetryLine wait={retry} className="mt-1" />
                ) : agent.omp?.jobs?.waiting ? (
                  <WaitingForJobs jobs={agent.omp.jobs} className="mt-1" />
                ) : (
                  <LiveLine live={agent.live} running={!stale} turnStartedAt={agent.omp?.turnStartedAt ?? agent.stateSince} className="mt-1" />
                )}
                <div className="mt-1 flex items-center gap-2">
                  {/* one signal per fact: while quiet, the quiet chip stands in for the heartbeat's age (and the flat tok/s); a retry wait is said in its line */}
                  <AgentHeartbeat
                    agentKey={agentKey}
                    status={quiet || retry ? "idle" : status}
                    lastEventAt={agent.live.lastEventAt}
                    showAge={!quiet && !retry}
                    height={16}
                    className="min-w-0 flex-1"
                  />
                  {quiet ? <QuietChip since={agent.live.lastEventAt ?? 0} className="shrink-0" /> : !retry && <TpsSparkline tps={agent.live.tps} status={status} />}
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
                <RecapLine agent={agent} lines={2} className="mt-1" />
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
                  {ticket && (
                    <button
                      type="button"
                      className="min-h-9 rounded-sm bg-accent px-3 py-1 text-2xs font-extrabold text-white shadow-glow-accent pressable focus-ring"
                      title={ticket.resumeHint}
                      onClick={() => void resumeNow(agentKey)}
                    >
                      {ticket.resume}
                    </button>
                  )}
                  {canReview(agent) && !agent.parked && (
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
            {column === "done" && <RecapLine agent={agent} className="mt-0.5" />}
            {column === "done" && agent.diff && (
              <div className="mt-0.5">
                <DiffStat {...agent.diff} />
              </div>
            )}
          </div>
        </div>
        {/* Review/Done in a linked worktree: merged or closed PR → "Delete worktree…" in the ⋯ menu */}
        {(column === "review" || column === "done") && !fresh && <PrProbe agentKey={agentKey} />}
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
 * or an online host whose setup hides agents (the board's notices name the same gaps). null when
 * every host is ready.
 */
function useSetupTarget(): string | null {
  const profiles = useHosts((s) => s.profiles);
  const ids = useHostIds();
  const status = useHosts((s) => s.status);
  const states = useHostStates();
  if (ids.length === 0) return "";
  const gap = ids.find((id) => status[id]?.phase === "online" && boardSetupGap(profiles.find((p) => p.id === id)?.kind, states[id]?.info.setup) !== null);
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
  const q = useBoard((s) => s.q.trim()) || undefined;
  // shared with the desktop toolbar's repo select
  const repo = useBoard((s) => s.repo) ?? undefined;
  const needs = useColumnKeys("needs", { hostId, repo, q });
  const running = useColumnKeys("running", { hostId, repo, q });
  const review = useColumnKeys("review", { hostId, repo, q });
  const done = useColumnKeys("done", { hostId, repo, q });
  const doneOpen = useBoard((s) => s.doneOpen);
  const toggleDone = useBoard((s) => s.toggleDone);
  const empty = needs.length + running.length + review.length + done.length === 0;
  useEffect(() => () => useBoard.getState().clearPicked(), []);

  return (
    <div className="flex min-h-full flex-col gap-3 px-3.5 pt-2.5 pb-22">
      <WhileAwayToast />
      <header className="flex items-center justify-between gap-2">
        <h1 className="shrink-0 font-display text-2xl font-bold text-ink">Flock</h1>
        <div className="flex min-w-0 items-center gap-1.5">
          <RepoChip />
          <HostChip />
        </div>
      </header>
      <PhoneNotices />
      <FilterChip className="self-start" />
      <Widgets />
      <FlightGroup id="flock" arrangement={[needs, running, review, done].map((keys) => keys.join(" ")).join("|")}>
        {empty && (q || repo) && (
          <EmptyState
            title="No matches"
            description={q ? `No agent${repo ? ` in ${repo}` : ""} matches “${q}”.` : `No agents in ${repo}.`}
            action={
              repo && (
                <Button variant="secondary" size="sm" onClick={() => useBoard.getState().setRepo(null)}>
                  All repos
                </Button>
              )
            }
          />
        )}
        {empty && !q && !repo && <EmptyFlock />}
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
      </FlightGroup>
      <SelectionBar mobile />
      <FlockFab />
    </div>
  );
}
