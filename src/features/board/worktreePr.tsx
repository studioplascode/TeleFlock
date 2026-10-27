import { useEffect, useRef } from "react";
import { create } from "zustand";
import { type CoreState, core, toApiError, useCore, useHosts } from "@/core";
import type { ApiError, PrStatusResult } from "@/core/gen";
import { useInView } from "@/design";
import { useShipMemo } from "./shipMemo";

/*
 * Whether a Review/Done card's linked worktree has a merged or closed pull request, so the card can offer
 * "Delete worktree". Review's memo (`useShipMemo`) only knows worktrees Review has shown, so visible cards
 * ask `gh.prStatus` themselves: lazily (after a moment on screen), queued per host, cached per worktree and
 * branch, re-asked only when an answer expires. Never toasts: a host whose gh is missing or signed out just
 * gets no button (and is left alone for a while).
 */

const MIN = 60_000;

/** How long an answer holds before a card that is still on screen asks again. */
export const PR_TTL = {
  /** Merged or closed: as good as final. */
  shipped: 30 * MIN,
  /** Open: it may be merged on GitHub any time. */
  open: 5 * MIN,
  /** No pull request yet. */
  none: 10 * MIN,
  /** Timeouts, a host still connecting. */
  retry: MIN,
  /** No GitHub remote, gh missing or signed out, …: nothing to offer for a while. */
  never: 60 * MIN,
} as const;

/** On screen this long before a card asks: scrolling past cards asks nothing. */
const DWELL_MS = 600;
/** `gh` runs in flight per host. */
const PER_HOST = 2;
/** `gh.prStatus` answers this stage of Review's memo: merged (see `shipState`). */
const MERGED_STAGE = 4;

/** What `gh.prStatus` last said about a linked worktree's branch. */
export interface WorktreePr {
  /** `OPEN` | `MERGED` | `CLOSED`; null = no pull request, or gh can't tell. */
  state: string | null;
  number?: number;
  /** Ask again after this (epoch ms). */
  until: number;
}

export interface ShippedPr {
  state: "MERGED" | "CLOSED";
  number?: number;
}

export function prFromResult(r: PrStatusResult, now: number): WorktreePr {
  if (!r.pr) return { state: null, until: now + PR_TTL.none };
  return { state: r.pr.state, number: r.pr.number, until: now + (r.pr.state === "OPEN" ? PR_TTL.open : PR_TTL.shipped) };
}

/** gh is missing or signed out on the host (or the host predates `gh.prStatus`): don't ask it again for a while. */
export function ghUnavailable(e: ApiError): boolean {
  if (e.code === "unknown_method") return true;
  return e.code === "gh_error" && /not installed|not authenticated|gh auth login/i.test(`${e.message} ${e.hint ?? ""}`);
}

/** A failed check: transient failures keep what was known and retry soon; anything else hides the button for a while. */
export function prFromError(e: ApiError, prev: WorktreePr | undefined, now: number): WorktreePr {
  if (e.retryable || e.code === "timeout" || e.code === "not_connected") return { state: prev?.state ?? null, number: prev?.number, until: now + PR_TTL.retry };
  return { state: null, until: now + PR_TTL.never };
}

export function isShipped(pr: WorktreePr | undefined): pr is WorktreePr & { state: ShippedPr["state"] } {
  return pr?.state === "MERGED" || pr?.state === "CLOSED";
}

/** "PR #96 is merged", "PR #12 was closed". */
export function shippedWords(pr: ShippedPr): string {
  return `${pr.number !== undefined ? `PR #${pr.number}` : "Its pull request"} ${pr.state === "MERGED" ? "is merged" : "was closed"}`;
}

const usePrCache = create<{ byKey: Record<string, WorktreePr> }>()(() => ({ byKey: {} }));

const SEP = "\u0000";

interface Target {
  hostId: string;
  workspaceId: string;
  /** Worktree root (`gh.prStatus` cwd). */
  path: string;
  /** Cache key: host, path and branch (a checkout of another branch asks again). */
  key: string;
}

/**
 * The agent's linked worktree as one primitive (a stable selector result), or null: its live workspace's,
 * else the checkout a parked agent's card remembers (Mark done closed its workspace; hosts ≥ 0.5.2).
 */
function selectTarget(s: CoreState, agentKey: string): string | null {
  const a = s.agents[agentKey];
  if (!a) return null;
  const ws = s.hosts[a.hostId]?.state.workspaces.find((w) => w.id === a.workspaceId);
  if (ws?.worktree) return [a.hostId, ws.id, ws.worktree.path, ws.worktree.branch ?? ws.repo?.branch ?? ""].join(SEP);
  const parked = a.parked?.worktree;
  return parked ? [a.hostId, "", parked.path, a.branch ?? ""].join(SEP) : null;
}

function parseTarget(t: string): Target {
  const [hostId = "", workspaceId = "", path = "", branch = ""] = t.split(SEP);
  return { hostId, workspaceId, path, key: [hostId, path, branch].join(SEP) };
}

/* ───────────── the queue: a few `gh` runs per host at a time, none while the window is hidden ───────────── */

interface Job {
  hostId: string;
  key: string;
  cwd: string;
}

const queue: Job[] = [];
const queued = new Set<string>();
const running = new Map<string, number>();
/** Hosts not asked again before the time (gh missing or signed out there). */
const quietUntil = new Map<string, number>();
let waitingForVisible = false;

function pump(): void {
  if (typeof document !== "undefined" && document.hidden) {
    if (!waitingForVisible) {
      waitingForVisible = true;
      const onVisible = () => {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", onVisible);
        waitingForVisible = false;
        pump();
      };
      document.addEventListener("visibilitychange", onVisible);
    }
    return;
  }
  for (let i = 0; i < queue.length; ) {
    const job = queue[i] as Job;
    const n = running.get(job.hostId) ?? 0;
    if (n >= PER_HOST) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    running.set(job.hostId, n + 1);
    void ask(job).finally(() => {
      running.set(job.hostId, (running.get(job.hostId) ?? 1) - 1);
      queued.delete(job.key);
      pump();
    });
  }
}

async function ask(job: Job): Promise<void> {
  let next: WorktreePr;
  try {
    next = prFromResult(await core.host(job.hostId).call("gh.prStatus", { cwd: job.cwd }), Date.now());
  } catch (err) {
    const e = toApiError(err);
    if (ghUnavailable(e)) quietUntil.set(job.hostId, Date.now() + PR_TTL.never);
    next = prFromError(e, usePrCache.getState().byKey[job.key], Date.now());
  }
  usePrCache.setState((s) => ({ byKey: { ...s.byKey, [job.key]: next } }));
}

function request(t: Target): void {
  if (queued.has(t.key) || (quietUntil.get(t.hostId) ?? 0) > Date.now()) return;
  queued.add(t.key);
  queue.push({ hostId: t.hostId, key: t.key, cwd: t.path });
  pump();
}

/* ───────────── hooks ───────────── */

/**
 * The merged or closed pull request of the agent's linked worktree, once known (the board's own check or
 * Review's memo). Null without a linked worktree, while its host isn't online, or while nothing says shipped;
 * `enabled: false` (cards outside Review/Done) skips the lookup.
 */
export function useShippedPr(agentKey: string, enabled = true): ShippedPr | null {
  const raw = useCore((s) => (enabled ? selectTarget(s, agentKey) : null));
  const t = raw ? parseTarget(raw) : null;
  const online = useHosts((h) => !!t && h.status[t.hostId]?.phase === "online");
  const memo = useShipMemo((s) => (t ? s.byWorkspace[`${t.hostId}/${t.workspaceId}`] : undefined));
  const pr = usePrCache((s) => (t ? s.byKey[t.key] : undefined));
  if (!t || !online) return null;
  if (isShipped(pr)) return { state: pr.state, number: pr.number };
  if (memo?.stage === MERGED_STAGE) return { state: "MERGED", number: memo.pr };
  return null;
}

/**
 * Invisible probe for a Review/Done card (mount inside its positioned surface): once the card has been
 * on screen for a moment, asks whether its linked worktree's PR is merged or closed. Renders nothing
 * without a linked worktree, while the host isn't online, or once Review already saw the PR merged.
 */
export function PrProbe({ agentKey }: { agentKey: string }) {
  const raw = useCore((s) => selectTarget(s, agentKey));
  const hostId = raw ? parseTarget(raw).hostId : "";
  const online = useHosts((h) => !!hostId && h.status[hostId]?.phase === "online");
  const merged = useShipMemo((s) => {
    const t = raw ? parseTarget(raw) : null;
    return !!t && s.byWorkspace[`${t.hostId}/${t.workspaceId}`]?.stage === MERGED_STAGE;
  });
  if (!raw || !online || merged) return null;
  // keyed: a new worktree (or branch) gets a fresh observer
  return <Probe key={raw} target={raw} />;
}

function Probe({ target }: { target: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, "0px");
  const until = usePrCache((s) => s.byKey[parseTarget(target).key]?.until ?? 0);
  useEffect(() => {
    if (!inView) return;
    // first ask after a short dwell; afterwards when the answer expires, if the card is still on screen
    const timer = window.setTimeout(() => request(parseTarget(target)), Math.max(DWELL_MS, until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [inView, until, target]);
  return <span ref={ref} aria-hidden className="pointer-events-none absolute inset-0" />;
}
