import { BellOff } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useAgent, useHostStale, useHosts, useIsMuted } from "@/core";
import type { Column } from "@/core/gen";
import { cn, formatAge, type Status, Swarm, useCalmMotion, useLivelyMotion, useNow } from "@/design";
import { openAgent, openAnswerHud } from "@/features/board/agentActions";
import { useQuiet } from "@/features/board/LiveBits";
import { retryOf } from "@/features/board/retry";
import { COLUMN_STATUS } from "@/features/shell/status";
import { type AgentStateId, agentStateId, agentStateWord } from "@/features/shell/vocab";
import { ambientTime } from "./layout";

/** The 20 s needs-you nudge (spec §4): the attention layers play again while it keeps waiting. */
const NUDGE_EVERY_MS = 20_000;

/** Lane each orb was last drawn in (survives remounts), for the one-shot burst when it changes. */
const LAST_COLUMN = new Map<string, Column>();

/** A ring that bursts once when the agent enters a lane worth noticing (finished, needs you, back to work). */
function useArrival(key: string, column: Column | undefined): number {
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (!column) return;
    const prev = LAST_COLUMN.get(key);
    LAST_COLUMN.set(key, column);
    if (prev && prev !== column && column !== "done") setBurst((n) => n + 1);
  }, [key, column]);
  return burst;
}

/** Time words, redrawn every 15 s (minutes are enough across the room). */
function OrbTime({ hostId, state, since, stale }: { hostId: string; state: AgentStateId | "quiet"; since: number | undefined; stale: boolean }) {
  const lastOnlineAt = useHosts((s) => s.status[hostId]?.lastOnlineAt);
  const now = useNow(15_000);
  return stale ? `last seen ${lastOnlineAt ? formatAge(now - lastOnlineAt) : "—"}` : ambientTime(state, since, now);
}

export interface AmbientOrbProps {
  agentKey: string;
  /** Orb diameter (px). */
  size: number;
}

/**
 * One agent in ambient mode: an orb in its state's colours with the board's liveness encodings at
 * room scale (needs-you sunset glow and ping, tool ring, subagent swarm, quiet ring, a burst when
 * it changes lane), its name, state and time. Tap: answer when it waits on you, else open it.
 * Motion follows the budget: Calm plays attention three times (again on the 20 s nudge), Lively
 * loops, Reduced holds still, and loops pause while the window is inactive (motion.css).
 */
export function AmbientOrb({ agentKey, size }: AmbientOrbProps) {
  const agent = useAgent(agentKey);
  const stale = useHostStale(agent?.hostId ?? "");
  const muted = useIsMuted(agentKey);
  const lively = useLivelyMotion();
  const reduced = useCalmMotion();
  const multiHost = useHosts((s) => s.profiles.length > 1);
  const hostName = useHosts((s) => s.profiles.find((p) => p.id === agent?.hostId)?.name);
  const quiet = useQuiet(agent?.column === "running" && !stale && !retryOf(agent), agent?.live.lastEventAt);
  const needs = agent?.column === "needs" && !stale;
  // a muted agent still glows, it just stops tugging at your sleeve
  const nudging = needs && !muted && !reduced;
  const nudge = useNow(nudging ? NUDGE_EVERY_MS : null);
  const burst = useArrival(agentKey, agent?.column);
  if (!agent) return null;

  const state = agentStateId(agent);
  const status: Status = stale || state === "fresh" ? "idle" : COLUMN_STATUS[agent.column];
  const tool = !stale && !quiet ? agent.live.tool : undefined;
  const subs = stale ? 0 : (agent.omp?.subagents?.live ?? 0);
  const running = agent.column === "running" && !stale;
  const since = state === "needs" ? agent.needs?.since : state === "running" ? (agent.omp?.turnStartedAt ?? agent.stateSince) : agent.stateSince;
  const word = agentStateWord(agent);
  const detail =
    state === "needs"
      ? agent.needs?.question || agent.needs?.title
      : running
        ? tool
          ? tool.name
          : agent.live.thinking && !agent.live.streaming
            ? "thinking…"
            : agent.live.line
        : state === "fresh"
          ? "waiting for its first prompt"
          : agent.title;
  const nameSize = Math.round(Math.max(13, Math.min(21, size * 0.15)));
  const dim = state === "done" || state === "fresh" || stale;

  const orb = (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      {needs && (
        <>
          {/* sunset glow: painted once; Calm breathes it three times (and again on each nudge), Lively keeps breathing */}
          <span
            key={`glow-${nudging ? nudge : 0}`}
            aria-hidden
            className="tf-loop pointer-events-none absolute -inset-[48%] animate-breathe rounded-full"
            style={{ background: "radial-gradient(circle, rgb(var(--st-rgb) / 0.5) 0%, rgb(255 122 24 / 0.16) 42%, transparent 68%)", "--tf-breath": "2.4s" } as CSSProperties}
          />
          <span key={`ping-${nudging ? nudge : 0}`} aria-hidden className="tf-loop pointer-events-none absolute inset-0 animate-ping-soft rounded-full shadow-[0_0_0_2px_rgb(var(--st-rgb)/0.9)]" />
        </>
      )}
      {tool && (
        <span
          aria-hidden
          className="tf-loop pointer-events-none absolute -inset-[9%] animate-spin rounded-full [animation-duration:1.6s]"
          style={{
            background: "conic-gradient(from 0deg, transparent 0 55%, var(--st-1) 80%, var(--st-2) 100%)",
            mask: `radial-gradient(farthest-side, transparent calc(100% - ${Math.max(2, size * 0.035)}px), #000 calc(100% - ${Math.max(1.5, size * 0.03)}px))`,
          }}
        />
      )}
      {quiet && <span aria-hidden className="pointer-events-none absolute -inset-[9%] rounded-full shadow-[0_0_0_2px_rgb(251_191_36/0.75)]" />}
      <span
        aria-hidden
        className={cn("absolute inset-0 rounded-full", dim && "opacity-55", stale && "grayscale")}
        style={{
          background: "radial-gradient(circle at 34% 28%, rgb(255 255 255 / 0.5), rgb(255 255 255 / 0) 34%), radial-gradient(circle at 50% 55%, var(--st-1) 0%, var(--st-2) 74%, rgb(var(--st-rgb) / 0.6) 100%)",
          boxShadow: dim
            ? `inset 0 ${-size * 0.06}px ${size * 0.18}px rgb(0 0 0 / 0.35)`
            : `0 0 ${size * 0.42}px rgb(var(--st-rgb) / ${needs ? 0.6 : 0.38}), inset 0 ${-size * 0.06}px ${size * 0.18}px rgb(0 0 0 / 0.35)`,
        }}
      />
      {/* Lively only: a sheen turns while it works, a slow deep pulse while it waits on the model */}
      {lively && running && !quiet && (
        <span
          aria-hidden
          className={cn("tf-loop pointer-events-none absolute inset-[6%] rounded-full", agent.live.thinking && !agent.live.streaming ? "animate-breathe" : "animate-spin-slow")}
          style={{ background: "conic-gradient(from 0deg, rgb(255 255 255 / 0) 0 60%, rgb(255 255 255 / 0.22) 80%, rgb(255 255 255 / 0) 100%)", "--tf-breath": "3.2s" } as CSSProperties}
        />
      )}
      {burst > 0 && !reduced && (
        <span
          key={`burst-${burst}`}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full opacity-0 shadow-[0_0_0_3px_rgb(var(--st-rgb)/0.9),0_0_24px_rgb(var(--st-rgb)/0.7)] animate-[tf-ping_1.3s_cubic-bezier(0,0,0.2,1)_1_both]"
        />
      )}
    </span>
  );

  return (
    <button
      type="button"
      data-status={status}
      onClick={() => (needs ? openAnswerHud(agentKey) : openAgent(agentKey))}
      aria-label={`${agent.name}: ${word}${needs ? ". Answer" : ""}`}
      className="group flex w-full min-w-0 flex-col items-center gap-2.5 rounded-xl px-2 py-2 text-center focus-ring pressable"
    >
      {subs > 0 ? (
        <Swarm count={subs} size={size} status={status}>
          {orb}
        </Swarm>
      ) : (
        orb
      )}
      <span className="flex w-full min-w-0 flex-col items-center gap-0.5">
        <span className="flex max-w-full min-w-0 items-center gap-1.5">
          <span className={cn("truncate font-display font-bold", dim ? "text-mute" : "text-ink")} style={{ fontSize: nameSize }}>
            {agent.name}
          </span>
          {muted && <BellOff className="size-3.5 shrink-0 text-mute-2" aria-label="Notifications muted" />}
        </span>
        <span className={cn("max-w-full truncate text-xs font-bold", stale ? "text-mute" : quiet ? "text-warn" : dim ? "text-mute" : "st-text")}>
          {word}
          {multiHost && hostName ? ` · ${hostName}` : ""}
          {" · "}
          <OrbTime hostId={agent.hostId} state={quiet ? "quiet" : state} since={quiet ? agent.live.lastEventAt : since} stale={stale} />
        </span>
        {detail && <span className="line-clamp-1 max-w-full text-2xs text-mute-2 group-hover:text-mute">{detail}</span>}
      </span>
    </button>
  );
}
