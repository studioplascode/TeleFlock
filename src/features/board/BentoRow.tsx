import { ArrowRight, Check, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useMemo } from "react";
import { LIMITS_EVERY_MS, navigate, parseAgentKey, USAGE_BOARD_EVERY_MS, useAccountLimits, useAgent, useColumnKeys, useCore, useHostIds, useHosts, useTodaySpend, useUi } from "@/core";
import type { Column } from "@/core/gen";
import { TerminalPane } from "@/features/terminal/TerminalPane";
import { AgentGlyph, IconButton, NumberTicker, StatusOrb, Tile, TiltCard, cn, formatAge, formatCompact, formatUsd, spring, useNow, useWindowActive, useWindowVisible } from "@/design";
import { hostAccent } from "@/features/hosts/kinds";
import { useHealthHistory } from "@/features/shell/healthHistory";
import { herdrDown } from "@/features/hosts/herdrHealth";
import { PHASE_STATUS, connSummary } from "@/features/shell/status";
import { openAgent, openTerminal } from "./agentActions";
import { type FirstStepsView, useDemoAnswerTicks, useRealAnswerTicks } from "./firstSteps";
import { LANES } from "./lanes";
import { type LimitHeadline, limitHeadline } from "./limitHeadline";
import { LiveLine } from "./LiveBits";
import { useMostActive } from "./useMostActive";

/**
 * Today's cost/tokens over the hosts in view: the Usage page's Today figure (`useTodaySpend`: each
 * host's indexed hours since local midnight + what it saw live since its last sync).
 */
export function useTodayUsage(hostFilter: string): { cost: number; tokens: number } {
  const ids = useHostIds();
  const hostIds = hostFilter === "all" ? ids : ids.filter((id) => id === hostFilter);
  const t = useTodaySpend(hostIds, useWindowActive() ? USAGE_BOARD_EVERY_MS : null, useNow(60_000));
  return { cost: t.cost, tokens: t.tokens };
}

/** Lane counts over the hosts in view, as "r,n,v,d" so the selector stays primitive. */
function useLaneCounts(hostFilter: string): Record<Column, number> {
  const packed = useCore((s) => {
    const c = { running: 0, needs: 0, review: 0, done: 0 };
    for (const a of Object.values(s.agents)) {
      if (hostFilter !== "all" && a.hostId !== hostFilter) continue;
      // nothing runs while its host's herdr is down: those agents are not counted as running
      if (a.column === "running" && herdrDown(s.hosts[a.hostId]?.state.info.herdrHealth)) continue;
      c[a.column]++;
    }
    return `${c.running},${c.needs},${c.review},${c.done}`;
  });
  const [running = 0, needs = 0, review = 0, done = 0] = packed.split(",").map(Number);
  return { running, needs, review, done };
}

/** Host ids in view (the title-bar host filter). */
function useHostsInView(): string[] {
  const filter = useHosts((s) => s.filter);
  const ids = useHostIds();
  return filter === "all" ? ids : ids.filter((id) => id === filter);
}

/** The subscription window that binds first across the accounts of the hosts in view (re-asked every 5 min while the window is active). */
function useLimitHeadline(): LimitHeadline | null {
  const ids = useHostsInView();
  const online = useHosts((s) => ids.filter((id) => s.status[id]?.phase === "online").join("|"));
  const byHost = useAccountLimits(online ? online.split("|") : [], useWindowActive() ? LIMITS_EVERY_MS : null);
  return limitHeadline(byHost, useNow(30_000));
}

const TONE = { error: "text-error", warn: "text-warn", mute: "text-mute" } as const;

/** Proportional lane bar (the counts live in the lane headers right below). Glides in Lively only (`tf-glide-grow`). */
function LaneBar({ counts, className }: { counts: Record<Column, number>; className?: string }) {
  const total = counts.running + counts.needs + counts.review + counts.done;
  return (
    <div
      className={cn("flex h-2 gap-[3px]", className)}
      role="img"
      aria-label={LANES.map((l) => `${counts[l.column]} ${l.title}`).join(", ")}
    >
      {LANES.map((l) => (
        <i
          key={l.column}
          data-status={l.status}
          className={cn("tf-glide-grow min-w-[3px] rounded-full st-bg", l.column === "running" && "live-gradient")}
          style={{ flexBasis: 0, flexGrow: Math.max(counts[l.column], total === 0 ? 1 : 0.0001) }}
        />
      ))}
    </div>
  );
}

/* ───────────────────────────── Stats (links to Usage) ───────────────────────────── */

export function StatsTile({ className }: { className?: string }) {
  const filter = useHosts((s) => s.filter);
  const { cost, tokens } = useTodayUsage(filter);
  const counts = useLaneCounts(filter);
  const total = counts.running + counts.needs + counts.review + counts.done;
  const limit = useLimitHeadline();
  return (
    <TiltCard className={cn("rounded-tile", className)}>
      {/* @container: the cost figure shrinks to the tile */}
      <Tile asChild>
        <button type="button" onClick={() => navigate({ name: "usage" })} className="group flex h-(--bento-h) w-full flex-col p-5 text-left @container focus-ring">
          <span className="flex w-full items-center gap-2">
            <span className="kicker min-w-0 truncate">
              Today · {total} agent{total === 1 ? "" : "s"}
            </span>
            <ArrowRight className="ml-auto size-3.5 shrink-0 text-mute-2 transition-transform group-hover:translate-x-0.5 group-hover:text-ink" aria-label="Open Usage" />
          </span>
          <NumberTicker value={cost} format={formatUsd} className="mt-2.5 font-display text-hero-fit font-bold text-ink" />
          <span className="mt-1 truncate text-sm font-semibold text-mute">
            <NumberTicker value={tokens} format={formatCompact} className="font-bold text-ink" /> tokens
          </span>
          <span className="mt-auto flex w-full flex-col gap-1.5 pt-3">
            <LaneBar counts={counts} />
            {limit ? (
              <span className="flex min-w-0 flex-col" title={limit.pace}>
                <span className={cn("truncate text-2xs font-bold", limit.tone === "mute" ? "text-ink-2" : TONE[limit.tone])}>{limit.text}</span>
                <span className="truncate text-2xs text-mute-2">{limit.pace}</span>
              </span>
            ) : (
              <span className="truncate text-2xs text-mute-2">Subscription limits show here when omp reports them</span>
            )}
          </span>
        </button>
      </Tile>
    </TiltCard>
  );
}

/* ───────────────────────────── Hosts (links to Hosts) ───────────────────────────── */

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/**
 * One host: orb, name with its identity swatch, latency or phase; CPU %, RAM bar with used/total GB and
 * load when online. The tile row wraps instead of hiding; the dense strip row (one line) shows RAM as a
 * percentage and drops the load only when its container is too narrow (both stay in the tooltip).
 */
function HostRow({ hostId, dense = false }: { hostId: string; dense?: boolean }) {
  const profile = useHosts((s) => s.profiles.find((p) => p.id === hostId));
  const status = useHosts((s) => s.status[hostId]);
  const { health } = useHealthHistory(hostId);
  const now = useNow(30_000);
  const phase = status?.phase ?? "idle";
  const online = phase === "online";
  const memPct = health && health.memTotal > 0 ? (health.memUsed / health.memTotal) * 100 : 0;
  const name = profile?.name ?? hostId;
  const facts =
    online && health ? (
      <span className={cn("flex min-w-0 items-center gap-x-2 gap-y-0.5 text-2xs font-semibold whitespace-nowrap text-mute tabular", !dense && "flex-wrap")}>
        <span>
          cpu <b className="text-ink-2">{Math.round(health.cpuPct)}%</b>
        </span>
        <span className="inline-flex items-center gap-1">
          ram
          <span className="h-1 w-10 overflow-hidden rounded-full bg-white/8" aria-hidden>
            <span className={cn("tf-glide-width block h-full rounded-full", memPct >= 90 ? "bg-warn" : "bg-white/35")} style={{ width: `${memPct}%` }} />
          </span>
          <b className={cn("text-ink-2", dense && "hidden @min-[22rem]:inline")}>
            {gb(health.memUsed)}/{gb(health.memTotal)} GB
          </b>
          {dense && <b className="text-ink-2 @min-[22rem]:hidden">{Math.round(memPct)}%</b>}
        </span>
        <span className={cn(dense && "hidden @min-[18rem]:inline")}>
          load <b className="text-ink-2">{health.load1.toFixed(2)}</b>
        </span>
      </span>
    ) : !online && status?.lastOnlineAt ? (
      <span className="truncate text-2xs text-mute-2">last seen {formatAge(now - status.lastOnlineAt)}</span>
    ) : null;
  return (
    <span className={cn("flex min-w-0", dense ? "items-center gap-2" : "flex-col gap-1")} title={health && online ? `${name}: load ${health.load1.toFixed(2)} · ${gb(health.memUsed)} / ${gb(health.memTotal)} GB RAM` : undefined}>
      <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", dense && "shrink-0")}>
        <StatusOrb status={PHASE_STATUS[phase]} size={7} label={null} />
        <span className="h-3 w-1 shrink-0 rounded-full" style={{ background: hostAccent(profile?.color) }} aria-hidden />
        <span className="min-w-0 truncate font-bold text-ink">{name}</span>
        <span className={cn("shrink-0 text-2xs font-semibold text-mute", !dense && "ml-auto")}>{connSummary(status)}</span>
      </span>
      {facts}
    </span>
  );
}

export function HostsTile({ className }: { className?: string }) {
  const ids = useHostsInView();
  return (
    <TiltCard className={cn("rounded-tile", className)}>
      <Tile asChild>
        <button type="button" onClick={() => navigate({ name: "hosts" })} className="group flex h-(--bento-h) w-full flex-col p-5 text-left focus-ring">
          <span className="flex w-full items-center gap-2">
            <span className="kicker">Hosts</span>
            <ArrowRight className="ml-auto size-3.5 shrink-0 text-mute-2 transition-transform group-hover:translate-x-0.5 group-hover:text-ink" aria-label="Open Hosts" />
          </span>
          {ids.length === 0 ? (
            <span className="mt-auto text-sm text-mute">No hosts yet. Add one on Hosts.</span>
          ) : (
            <span className="no-scrollbar mt-3 flex min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto">
              {ids.map((id) => (
                <HostRow key={id} hostId={id} />
              ))}
            </span>
          )}
        </button>
      </Tile>
    </TiltCard>
  );
}

/* ───────────────────────────── First steps ───────────────────────────── */

function DemoTicks({ hostId }: { hostId: string }) {
  useDemoAnswerTicks(hostId);
  return null;
}

function RealTicks({ hostId }: { hostId: string }) {
  useRealAnswerTicks(hostId);
  return null;
}

/** Keeps the checklist's activity-based steps ticking (mounted wherever the checklist is drawn). */
function StepTicks({ view }: { view: FirstStepsView }) {
  return view.kind === "demo" ? <DemoTicks hostId={view.hostId} /> : <RealTicks hostId={view.hostId} />;
}

function addRealHost(view: FirstStepsView) {
  useUi.getState().openDialog({ kind: "hostEditor" });
  view.retire();
}

export function FirstStepsTile({ view, className }: { view: FirstStepsView; className?: string }) {
  return (
    <TiltCard className={cn("rounded-tile", className)} maxTilt={2}>
      <Tile className="flex h-(--bento-h) flex-col p-5 @container">
        <StepTicks view={view} />
        <div className="flex items-center gap-2">
          <span className="kicker">First steps</span>
          <span className="text-2xs font-bold text-mute tabular">
            {view.done}/{view.steps.length}
          </span>
          <IconButton label="Hide first steps" size="sm" className="-my-1 ml-auto" onClick={view.retire}>
            <X />
          </IconButton>
        </div>
        {view.complete && view.kind === "demo" ? (
          <div className="mt-auto flex flex-col items-start gap-3">
            <p className="text-sm text-mute">That's the whole loop: answer, steer, review, dispatch, find anything. Your own machines work the same way.</p>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-accent px-3 text-xs font-extrabold text-white shadow-glow-accent pressable focus-ring hover:bg-accent-hi"
              onClick={() => addRealHost(view)}
            >
              Add your real host <ArrowRight className="size-3.5" />
            </button>
          </div>
        ) : (
          <ol className="no-scrollbar mt-2.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {view.steps.map((s, i) => (
              <li key={s.id} className="flex min-w-0 items-center gap-2 text-xs" title={`${s.label}: ${s.how}`}>
                <span
                  data-status={s.done ? "done" : undefined}
                  className={cn("grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-extrabold", s.done ? "st-soft" : "bg-white/6 text-mute")}
                >
                  {s.done ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn("shrink-0 font-bold", s.done ? "text-mute line-through decoration-mute-2" : "text-ink")}>{s.label}</span>
                {!s.done && <span className="min-w-0 truncate text-mute-2">· {s.how}</span>}
              </li>
            ))}
          </ol>
        )}
      </Tile>
    </TiltCard>
  );
}

/* ───────────────────────────── Live mini terminal ───────────────────────────── */

function OpenTerminalButton({ agentKey }: { agentKey: string }) {
  return (
    <IconButton label="Open terminal (T)" size="sm" onClick={() => openTerminal(agentKey, false)}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M9 2h5v5M14 2 8 8M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9" />
      </svg>
    </IconButton>
  );
}

/** The busiest running agent in view whose host is online (an offline host's terminal can't stream). */
function useLeader(): string | null {
  const filter = useHosts((s) => s.filter);
  const running = useColumnKeys("running", { hostId: filter });
  // herdr down: its agents are not running, so nothing of that host streams
  const online = useCore((s) => Object.keys(s.status).filter((id) => s.status[id]?.phase === "online" && !herdrDown(s.hosts[id]?.state.info.herdrHealth)).join("\n"));
  const live = useMemo(() => {
    const ok = new Set(online.split("\n"));
    return running.filter((key) => ok.has(parseAgentKey(key).hostId));
  }, [running, online]);
  return useMostActive(live);
}

/** The leader's terminal, observed. Detached while the window is hidden (no attach, no xterm work for a window nobody can see); an unfocused window keeps it, so a board on a second monitor stays live. */
export function LiveTerminalTile({ className }: { className?: string }) {
  const leader = useLeader();
  const agent = useAgent(leader ?? "");
  const shown = useWindowVisible();
  const target = leader ? parseAgentKey(leader) : null;

  return (
    <TiltCard className={cn("rounded-tile", className)} maxTilt={2}>
      <Tile variant="deep" className="flex h-(--bento-h) flex-col overflow-hidden p-0">
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-xs font-bold">
          {agent && leader ? (
            <>
              <AgentGlyph name={agent.name} size={20} />
              <button type="button" className="min-w-0 truncate rounded-xs text-ink focus-ring hover:underline" onClick={() => openAgent(leader)}>
                {agent.name}
              </button>
              <span className="shrink-0 font-mono text-2xs text-mute-2" title="herdr pane">
                pane {agent.paneId}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 font-display text-[10px] tracking-[0.12em] text-mute uppercase">
                <StatusOrb status="running" size={6} label={null} activity="busy" /> live
              </span>
              <OpenTerminalButton agentKey={leader} />
            </>
          ) : (
            <span className="kicker">Live terminal</span>
          )}
        </div>
        <div className="relative min-h-0 flex-1 px-1.5 pb-1.5">
          <AnimatePresence mode="wait" initial={false}>
            {target && shown ? (
              <motion.div
                key={leader}
                className="absolute inset-0 px-1.5 pb-1.5"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={spring.smooth}
              >
                <TerminalPane hostId={target.hostId} target={{ kind: "agent", agentId: target.agentId }} mode="observe" compact className="h-full w-full" />
              </motion.div>
            ) : (
              <p className="px-3 pt-6 text-sm text-mute">{target ? "Paused while TeleFlock is hidden." : "The busiest running agent streams here."}</p>
            )}
          </AnimatePresence>
        </div>
      </Tile>
    </TiltCard>
  );
}

/* ───────────────────────────── Short windows: the same facts in one strip ───────────────────────────── */

function StripCell({ label, onClick, children, className }: { label: string; onClick?: () => void; children: ReactNode; className?: string }) {
  const cls = cn("flex h-full min-w-0 flex-col justify-center gap-1 px-4 text-left", className);
  return onClick ? (
    <button type="button" aria-label={label} onClick={onClick} className={cn(cls, "rounded-tile focus-ring hover:bg-white/[0.03]")}>
      {children}
    </button>
  ) : (
    <div aria-label={label} className={cls}>
      {children}
    </div>
  );
}

/** ≤ 820 px tall (`short:`): spend + limit, every host, first steps and the live agent in one ~72 px strip. */
export function BentoStrip({ firstSteps, live }: { firstSteps: FirstStepsView | null; live: boolean }) {
  const filter = useHosts((s) => s.filter);
  const { cost, tokens } = useTodayUsage(filter);
  const counts = useLaneCounts(filter);
  const limit = useLimitHeadline();
  const ids = useHostsInView();
  const leader = useLeader();
  const agent = useAgent(leader ?? "");
  const next = firstSteps?.steps.find((s) => !s.done);
  return (
    <Tile
      className={cn(
        // the hosts cell gets the extra room: cpu, ram GB and load per host on one line
        "grid h-[72px] shrink-0 divide-x divide-line overflow-hidden p-0",
        firstSteps && live
          ? "grid-cols-[1fr_1.4fr_1fr_1fr]"
          : firstSteps || live
            ? "grid-cols-[1fr_1.4fr_1fr]"
            : "grid-cols-[1fr_1.4fr]",
      )}
    >
      {firstSteps && <StepTicks view={firstSteps} />}
      <StripCell label="Open Usage" onClick={() => navigate({ name: "usage" })}>
        <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
          <NumberTicker value={cost} format={formatUsd} className="font-display text-md font-bold text-ink" />
          <span className="truncate text-2xs font-semibold text-mute">
            today · <NumberTicker value={tokens} format={formatCompact} className="font-bold text-ink-2" /> tok
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <LaneBar counts={counts} className="h-1.5 w-14 shrink-0" />
          {limit && (
            <span className={cn("min-w-0 truncate text-2xs font-bold", limit.tone === "mute" ? "text-mute" : TONE[limit.tone])} title={limit.pace}>
              {limit.text}
            </span>
          )}
        </span>
      </StripCell>
      <StripCell label="Open Hosts" onClick={() => navigate({ name: "hosts" })} className="@container">
        <span className="flex min-w-0 flex-col gap-1">
          {ids.slice(0, 2).map((id) => (
            <HostRow key={id} hostId={id} dense />
          ))}
          {ids.length > 2 && <span className="text-2xs text-mute-2">+{ids.length - 2} more</span>}
        </span>
      </StripCell>
      {firstSteps && (
        <StripCell label="First steps">
          <span className="flex min-w-0 items-center gap-2 text-xs">
            <span className="kicker">First steps</span>
            <span className="text-2xs font-bold text-mute tabular">
              {firstSteps.done}/{firstSteps.steps.length}
            </span>
            {firstSteps.complete && firstSteps.kind === "demo" && (
              <button type="button" className="ml-auto shrink-0 rounded-xs text-2xs font-extrabold text-accent-ink focus-ring hover:underline" onClick={() => addRealHost(firstSteps)}>
                Add your real host →
              </button>
            )}
          </span>
          {next && (
            <span className="min-w-0 truncate text-2xs" title={`${next.label}: ${next.how}`}>
              <b className="text-ink">{next.label}</b> <span className="text-mute-2">· {next.how}</span>
            </span>
          )}
        </StripCell>
      )}
      {live && (
        <StripCell label="Live agent" className="flex-row items-center gap-2">
          {agent && leader ? (
            <>
              <AgentGlyph name={agent.name} size={22} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <button type="button" className="min-w-0 truncate rounded-xs text-left text-xs font-bold text-ink focus-ring hover:underline" onClick={() => openAgent(leader)}>
                  {agent.name}
                </button>
                <LiveLine live={agent.live} running className="line-clamp-1 min-h-0 text-2xs" />
              </span>
              <OpenTerminalButton agentKey={leader} />
            </>
          ) : (
            <span className="text-xs text-mute">The busiest running agent shows here.</span>
          )}
        </StripCell>
      )}
    </Tile>
  );
}
