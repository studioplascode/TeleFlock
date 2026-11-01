import type { TranscriptItem } from "@/core/gen";
import { failureReporter } from "./failures";
import type { CoreState, SessionEntry } from "./store/state";

/*
 * Transcript self-heal. The UI keeps an open session's transcript from `session` events, and the
 * app core only sends a whole transcript again on a new `session.open`: a transcript that missed an
 * event (wherever it was lost) stays wrong for good. A transcript that disagrees with its host's
 * state (the turn is over, the card sits in Review or Done, nothing runs, yet a step still shows
 * running) and hears nothing for a while is re-opened: the core answers from its mirror and the
 * reset replaces the stale rows.
 */

/** How often open transcripts are checked; no timer while no session is open. */
export const HEAL_CHECK_MS = 5_000;
/** A transcript is re-opened once it has disagreed with host state this long… */
export const HEAL_STALE_MS = 30_000;
/** …and heard no `session` event this long. */
export const HEAL_QUIET_MS = 30_000;
/** After the n-th heal in a row the next waits 30 s × 2^(n−1)… */
const HEAL_BACKOFF_MS = 30_000;
/** …at most 15 min; 15 min without a heal also ends the streak. */
export const HEAL_MAX_WAIT_MS = 15 * 60_000;
/** Newest transcript rows looked at. */
const HEAL_TAIL_ROWS = 64;

/** Per-key bookkeeping between checks. */
export interface HealEntry {
  /** The first check that saw this disagreement (it lasts while every later check sees it too). */
  staleSince: number;
  /** Heals in a row. */
  heals: number;
  /** When the last of them ran. */
  lastHealAt?: number;
}

export interface HealDecision {
  /** Keys to re-open now. */
  heal: string[];
  /** Bookkeeping for the next check: only keys that are stale now. */
  book: Map<string, HealEntry>;
}

/** A row still in flight: a tool call not finished, or text or thinking still streaming. */
function inFlight(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "tool":
      return item.status === "pending" || item.status === "running";
    case "assistant":
    case "thinking":
      return item.streaming;
    default:
      return false;
  }
}

/** An assistant row that ended its run (`stopReason` stop, length, aborted or error). */
function endsRun(item: TranscriptItem): boolean {
  return item.kind === "assistant" && !item.streaming && (item.stopReason === "stop" || item.stopReason === "length" || item.stopReason === "aborted" || item.stopReason === "error");
}

/**
 * A row in flight among the newest 64, after the last row that ended a run. What a run left in
 * flight before it ended never finishes: the call of an attempt that failed mid-reply and was
 * retried has no result in omp's file, so a transcript rebuilt from it keeps it queued for good,
 * and re-opening it only shows the same.
 */
function tailInFlight(sess: SessionEntry): boolean {
  const ids = sess.itemIds;
  for (let i = ids.length - 1; i >= 0 && i >= ids.length - HEAL_TAIL_ROWS; i--) {
    const id = ids[i];
    const item = id === undefined ? undefined : sess.items[id];
    if (!item) continue;
    if (inFlight(item)) return true;
    if (endsRun(item)) return false;
  }
  return false;
}

/**
 * The open transcript of `key` disagrees with host state: its host is online, the agent's link is
 * live, its card sits in Review or Done with nothing live (no tool, streaming, thinking or pending
 * question), yet one of the newest 64 rows, after the last one that ended a run, is a tool call
 * still pending or running, or text or thinking still streaming.
 */
export function transcriptStale(state: CoreState, key: string): boolean {
  const sess = state.sessions[key];
  const agent = state.agents[key];
  if (sess?.status !== "live" || !agent) return false;
  if (state.status[agent.hostId]?.phase !== "online" || agent.omp?.link !== "live") return false;
  if ((agent.column !== "review" && agent.column !== "done") || agent.needs) return false;
  const { live } = agent;
  if (live.tool || live.streaming || live.thinking) return false;
  return tailInFlight(sess);
}

/** The wait before the next heal after `heals` heals in a row: none before the first, then 30 s × 2^(n−1), at most 15 min. */
export function healWait(heals: number): number {
  return heals === 0 ? 0 : Math.min(HEAL_BACKOFF_MS * 2 ** (heals - 1), HEAL_MAX_WAIT_MS);
}

/**
 * Which open transcripts (`keys`) to re-open at `now`: each one that has been stale (see
 * `transcriptStale`) for ≥ 30 s and heard no `session` event for ≥ 30 s (`heardAt`), once the
 * backoff after its previous heals has passed (`healWait`). A key that is not stale drops out of
 * the bookkeeping, so its streak starts over; 15 min without a heal (events kept coming) also
 * ends the streak. Pure: `book` is not changed.
 */
export function decideHeals(
  state: CoreState,
  keys: Iterable<string>,
  heardAt: ReadonlyMap<string, number>,
  book: ReadonlyMap<string, HealEntry>,
  now: number,
): HealDecision {
  const heal: string[] = [];
  const next = new Map<string, HealEntry>();
  for (const key of keys) {
    if (!transcriptStale(state, key)) continue;
    const prev = book.get(key);
    const entry: HealEntry = prev ? { ...prev } : { staleSince: now, heals: 0 };
    const heard = heardAt.get(key);
    const quiet = heard === undefined || now - heard >= HEAL_QUIET_MS;
    const waited = entry.lastHealAt === undefined || now - entry.lastHealAt >= healWait(entry.heals);
    if (now - entry.staleSince >= HEAL_STALE_MS && quiet && waited) {
      heal.push(key);
      entry.heals++;
      entry.lastHealAt = now;
    } else if (entry.lastHealAt !== undefined && now - entry.lastHealAt >= HEAL_MAX_WAIT_MS) {
      entry.heals = 0;
      entry.lastHealAt = undefined;
    }
    next.set(key, entry);
  }
  return { heal, book: next };
}

export interface SessionHealDeps {
  /** Open sessions: key → views holding it (0 while its close lingers). */
  refs: ReadonlyMap<string, number>;
  /** When the last `session` event of each open key arrived. */
  heardAt: ReadonlyMap<string, number>;
  state(): CoreState;
  /** `session.open` again; its reset replaces the transcript. */
  reopen(key: string): void;
}

const checkFailed = failureReporter("transcript self-heal check");

/** The 5 s scheduler around `decideHeals` for the client runtime. */
export class SessionHealer {
  private book: ReadonlyMap<string, HealEntry> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SessionHealDeps) {}

  /** Checks every 5 s while any session is open, and runs no timer otherwise. Call after every change of `refs`. */
  sync(): void {
    let open = false;
    for (const n of this.deps.refs.values()) {
      if (n > 0) {
        open = true;
        break;
      }
    }
    if (!open) this.stop();
    else if (this.timer === null) this.timer = setInterval(() => this.check(), HEAL_CHECK_MS);
  }

  /** Stops checking and forgets every streak. */
  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    this.book = new Map();
  }

  /** One check: re-opens the transcripts that are due and returns their keys. */
  check(now = Date.now()): string[] {
    const open: string[] = [];
    for (const [key, n] of this.deps.refs) if (n > 0) open.push(key);
    let decision: HealDecision;
    try {
      decision = decideHeals(this.deps.state(), open, this.deps.heardAt, this.book, now);
    } catch (err) {
      checkFailed(err);
      return [];
    }
    this.book = decision.book;
    for (const key of decision.heal) {
      const heard = this.deps.heardAt.get(key);
      const quiet = heard === undefined ? "since it opened" : `for ${Math.round((now - heard) / 1000)} s`;
      console.warn(`[core] transcript ${key} still shows a step running after its turn ended and heard nothing ${quiet}: re-opening it (heal ${decision.book.get(key)?.heals ?? 1} in a row)`);
      this.deps.reopen(key);
    }
    return decision.heal;
  }
}
