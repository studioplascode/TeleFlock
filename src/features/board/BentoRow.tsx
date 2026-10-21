import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { parseAgentKey, useAgent, useColumnKeys, useCore, useHostIds, useHostStale, useHostState, useHosts, useInbox } from "@/core";
import type { Column } from "@/core/gen";
import { TerminalPane } from "@/features/terminal/TerminalPane";
import {
  AgentGlyph,
  Elapsed,
  IconButton,
  NumberTicker,
  Sparkline,
  StatusOrb,
  Tile,
  TiltCard,
  cn,
  formatCompact,
  formatUsd,
  spring,
} from "@/design";
import { openAgent, openTerminal } from "./agentActions";
import { useHealthHistory, useRecordHealth } from "./healthHistory";
import { LANES } from "./lanes";
import { QuickAnswer } from "./QuickAnswer";
import { useMostActive } from "./useMostActive";

/** Today's cost/tokens over the hosts in view. */
export function useTodayUsage(hostFilter: string): { cost: number; tokens: number } {
  const cost = useCore((s) => {
    let sum = 0;
    for (const [id, h] of Object.entries(s.hosts)) if (hostFilter === "all" || hostFilter === id) sum += h.state.usage.costUsd;
    return sum;
  });
  const tokens = useCore((s) => {
    let sum = 0;
    for (const [id, h] of Object.entries(s.hosts)) if (hostFilter === "all" || hostFilter === id) sum += h.state.usage.tokens;
    return sum;
  });
  return { cost, tokens };
}

/** Lane counts over the hosts in view, as "r,n,v,d" so the selector stays primitive. */
export function useLaneCounts(hostFilter: string): Record<Column, number> {
  const packed = useCore((s) => {
    const c = { running: 0, needs: 0, review: 0, done: 0 };
    for (const a of Object.values(s.agents)) if (hostFilter === "all" || a.hostId === hostFilter) c[a.column]++;
    return `${c.running},${c.needs},${c.review},${c.done}`;
  });
  const [running = 0, needs = 0, review = 0, done = 0] = packed.split(",").map(Number);
  return { running, needs, review, done };
}

/* ───────────────────────────── Needs-you hero ───────────────────────────── */

export function NeedsHeroTile({ className }: { className?: string }) {
  const inbox = useInbox();
  const [pick, setPick] = useState<string | null>(null);
  const idx = Math.max(0, pick ? inbox.indexOf(pick) : 0);
  const key = inbox[idx] ?? null;
  const cycle = (d: number) => {
    if (inbox.length === 0) return;
    setPick(inbox[(idx + d + inbox.length) % inbox.length] ?? null);
  };

  if (!key) {
    return (
      <Tile className={cn("flex h-(--bento-h) flex-col justify-between overflow-hidden p-5 short:p-4", className)}>
        <div className="flex items-center gap-2">
          <span data-status="done" className="inline-flex items-center gap-1.5 rounded-full st-soft py-1 pr-2.5 pl-2 font-display text-2xs font-bold tracking-[0.12em] uppercase">
            <StatusOrb status="done" size={6} label={null} />
            All clear
          </span>
        </div>
        <div>
          <h3 className="max-w-md font-display text-2xl leading-tight font-bold text-ink">Nobody is waiting on you.</h3>
          <p className="mt-1.5 text-sm text-mute">Questions and approvals show up here the moment an agent asks — answer them right on this tile.</p>
        </div>
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -top-20 -right-20 size-64 rounded-full border-[36px] border-done/6"
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      </Tile>
    );
  }

  return (
    <TiltCard className={cn("rounded-tile", className)} maxTilt={3}>
      <Tile variant="sunset" className="sun-pulse flex h-(--bento-h) flex-col overflow-hidden p-5 short:p-4">
        <div aria-hidden className="pointer-events-none absolute -top-16 -right-16 size-60 rounded-full border-[38px] border-white/8" />
        <div className="relative flex items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[rgb(40_0_20/0.28)] py-1 pr-2.5 pl-2 font-display text-2xs font-bold tracking-[0.12em] whitespace-nowrap uppercase">
            <span className="relative size-[7px] rounded-full bg-white">
              <span className="tf-loop absolute inset-0 animate-ping-soft rounded-full bg-white" />
            </span>
            Needs you ·{" "}
            <span className="inline-flex tabular">
              <NumberTicker value={idx + 1} />
              &nbsp;of&nbsp;
              <NumberTicker value={inbox.length} />
            </span>
          </span>
          {inbox.length > 1 && (
            <span className="flex">
              <IconButton label="Previous question" size="sm" className="text-white hover:bg-white/15" onClick={() => cycle(-1)}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="m10 3-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </IconButton>
              <IconButton label="Next question" size="sm" className="text-white hover:bg-white/15" onClick={() => cycle(1)}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="m6 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </IconButton>
            </span>
          )}
          <HeroWaiting agentKey={key} />
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={key}
            className="relative flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0, x: 40, filter: "blur(6px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: -40, filter: "blur(6px)" }}
            transition={spring.smooth}
          >
            <HeroBody agentKey={key} />
          </motion.div>
        </AnimatePresence>
      </Tile>
    </TiltCard>
  );
}

function HeroWaiting({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  if (!agent?.needs) return null;
  return (
    <span className="ml-auto min-w-0 truncate text-xs font-bold opacity-90">
      {agent.name} · waiting <Elapsed since={agent.needs.since} />
    </span>
  );
}

function HeroBody({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  if (!agent?.needs) return null;
  const n = agent.needs;
  const model = agent.omp?.model;
  return (
    <>
      <button type="button" className="mt-2.5 text-left focus-ring rounded-sm" onClick={() => openAgent(agentKey)}>
        <h3 className="line-clamp-2 max-w-xl font-display text-[21px] leading-tight font-bold wrap-break-word short:line-clamp-1 short:text-lg">{n.question || n.title}</h3>
      </button>
      <p className="mt-1 truncate text-xs font-semibold opacity-85 short:hidden">
        {agent.repo ?? agent.name}
        {agent.branch && (
          <>
            {" "}/ <code className="font-mono text-2xs">{agent.branch}</code>
          </>
        )}
        {model && ` · ${model.label ?? model.id}`}
        {agent.omp?.thinking && agent.omp.thinking !== "off" && ` · ${agent.omp.thinking}`}
      </p>
      {n.command && !n.question.includes(n.command) && <pre className="mt-2 truncate rounded-sm bg-[rgb(40_0_20/0.3)] px-2.5 py-1.5 font-mono text-2xs">{n.command}</pre>}
      <QuickAnswer agentKey={agentKey} appearance="hero" max={4} chat={false} className="mt-auto pt-2.5" />
    </>
  );
}

/* ───────────────────────────── Stats ───────────────────────────── */

export function StatsTile({ className }: { className?: string }) {
  const filter = useHosts((s) => s.filter);
  const { cost, tokens } = useTodayUsage(filter);
  const counts = useLaneCounts(filter);
  const total = counts.running + counts.needs + counts.review + counts.done;
  return (
    <TiltCard className={cn("rounded-tile", className)}>
      <Tile className="flex h-(--bento-h) flex-col p-5 short:p-4">
        <span className="kicker">
          Today · {total} agent{total === 1 ? "" : "s"}
        </span>
        <NumberTicker value={cost} format={formatUsd} className="mt-3 font-display text-hero font-bold text-ink" />
        <span className="mt-1.5 text-sm font-semibold text-mute">
          <NumberTicker value={tokens} format={formatCompact} className="font-bold text-ink" /> tokens
        </span>
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <div className="flex h-2 gap-[3px]" role="img" aria-label={`${counts.running} running, ${counts.needs} need you, ${counts.review} in review, ${counts.done} done`}>
            {LANES.map((l) => (
              <motion.i
                key={l.column}
                data-status={l.status}
                className={cn("min-w-[3px] rounded-full st-bg", l.column === "running" && "live-gradient")}
                animate={{ flexGrow: Math.max(counts[l.column], total === 0 ? 1 : 0.0001) }}
                transition={spring.gentle}
                style={{ flexBasis: 0 }}
              />
            ))}
          </div>
          <div className="flex justify-between text-2xs font-semibold text-mute">
            {LANES.map((l) => (
              <span key={l.column}>
                <b className="mr-1 text-ink tabular">{counts[l.column]}</b>
                {l.column === "running" ? "run" : l.column === "needs" ? "you" : l.column === "review" ? "rev" : "done"}
              </span>
            ))}
          </div>
        </div>
      </Tile>
    </TiltCard>
  );
}

/* ───────────────────────────── Host health ───────────────────────────── */

function fmtBytes(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)}`;
}

export function HealthTile({ className }: { className?: string }) {
  const filter = useHosts((s) => s.filter);
  const ids = useHostIds();
  const hostId = filter !== "all" ? filter : ids[0];
  const profile = useHosts((s) => s.profiles.find((p) => p.id === hostId));
  const status = useHosts((s) => (hostId ? s.status[hostId] : undefined));
  const state = useHostState(hostId ?? "");
  const stale = useHostStale(hostId ?? "");
  const health = state?.health;
  useRecordHealth(hostId, health);
  const history = useHealthHistory((s) => (hostId ? s.byHost[hostId] : undefined));
  const cpu = history?.map((h) => h.cpuPct) ?? [];
  const mem = history?.map((h) => h.memPct) ?? [];
  const memPct = health && health.memTotal > 0 ? (health.memUsed / health.memTotal) * 100 : 0;

  return (
    <TiltCard className={cn("rounded-tile", className)}>
      <Tile className={cn("flex h-(--bento-h) flex-col p-5 short:p-4", stale && "grayscale-[0.6]")}>
        <div className="flex items-center gap-2">
          <span className="kicker min-w-0 truncate">{profile?.name ?? state?.info.hostname ?? "No host"}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-bold text-mute">
            <StatusOrb status={stale ? "idle" : "done"} size={6} label={null} />
            {stale ? (status?.phase ?? "offline") : status?.latencyMs !== undefined ? `${status.latencyMs} ms` : "online"}
          </span>
        </div>
        {health ? (
          <>
            <div className="mt-3 flex items-baseline gap-1 font-display font-bold whitespace-nowrap text-ink short:mt-2">
              <NumberTicker value={Math.round(health.cpuPct)} className="text-hero" />
              <span className="text-md text-mute">% cpu</span>
              <span className="ml-auto text-2xs font-semibold text-mute tabular">load {health.load1.toFixed(2)}</span>
            </div>
            <Sparkline values={cpu} status="running" height={28} className="mt-2" aria-label="CPU history" />
            <div className="mt-auto flex flex-col gap-1.5 pt-3">
              <div className="flex justify-between text-2xs font-bold text-mute">
                <span>RAM</span>
                <span className="text-ink tabular">
                  {fmtBytes(health.memUsed)} / {fmtBytes(health.memTotal)} GB
                </span>
              </div>
              <div className="relative h-5 short:hidden">
                <Sparkline values={mem} status="review" height={20} fill live={false} aria-label="RAM history" />
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/6">
                <motion.div data-status="review" className="h-full rounded-full st-bg" animate={{ width: `${memPct}%` }} transition={spring.gentle} />
              </div>
            </div>
          </>
        ) : (
          <p className="mt-auto text-sm text-mute">{stale ? "Waiting for the host to come back…" : "Health readings arrive with the next update."}</p>
        )}
      </Tile>
    </TiltCard>
  );
}

/* ───────────────────────────── Live mini terminal ───────────────────────────── */

export function LiveTerminalTile({ className }: { className?: string }) {
  const filter = useHosts((s) => s.filter);
  const running = useColumnKeys("running", { hostId: filter });
  const leader = useMostActive(running);
  const agent = useAgent(leader ?? "");
  const target = leader ? parseAgentKey(leader) : null;

  return (
    <TiltCard className={cn("rounded-tile", className)} maxTilt={2}>
      <Tile variant="deep" className="flex h-(--bento-h) flex-col overflow-hidden p-0">
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-xs font-bold">
          {agent ? (
            <>
              <AgentGlyph name={agent.name} size={20} />
              <button type="button" className="min-w-0 truncate rounded-xs text-ink focus-ring hover:underline" onClick={() => leader && openAgent(leader)}>
                {agent.name}
              </button>
              <span className="shrink-0 font-mono text-2xs text-mute-2">{agent.paneId}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 font-display text-[10px] tracking-[0.12em] text-mute uppercase">
                <StatusOrb status="running" size={6} label={null} activity="busy" /> live
              </span>
              <IconButton label="Open terminal" size="sm" onClick={() => leader && openTerminal(leader, false)}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M9 2h5v5M14 2 8 8M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9" />
                </svg>
              </IconButton>
            </>
          ) : (
            <span className="kicker">Live terminal</span>
          )}
        </div>
        <div className="relative min-h-0 flex-1 px-1.5 pb-1.5">
          <AnimatePresence mode="wait" initial={false}>
            {target ? (
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
              <p className="px-3 pt-6 text-sm text-mute">The busiest running agent streams here.</p>
            )}
          </AnimatePresence>
        </div>
      </Tile>
    </TiltCard>
  );
}
