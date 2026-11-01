import { describe, expect, test } from "bun:test";
import { ManualClock } from "./demo/clock";
import { DemoEngine } from "./demo/engine";
import type { Agent, AppEvent, ConnPhase, OmpInfo, SessionSnapshot, ToolStatus, TranscriptItem } from "./gen";
import { agentKey } from "./keys";
import { decideHeals, HEAL_CHECK_MS, type HealEntry, healWait, transcriptStale } from "./sessionHeal";
import { reduceEvents } from "./store/reduce";
import { type CoreState, emptySession, initialCoreState, type SessionEntry } from "./store/state";

const KEY = "h::a";
const omp: OmpInfo = { link: "live", bridge: true, fast: false, mode: "normal", queue: { steering: [], followUp: [] } };
const user = (id: string): TranscriptItem => ({ kind: "user", id, at: 1, text: "go", images: [], steering: false, synthetic: false });
const thought = (id: string, streaming = false): TranscriptItem => ({ kind: "thinking", id, at: 2, text: "", streaming, redacted: true });
const said = (id: string, streaming = false): TranscriptItem => ({ kind: "assistant", id, at: 3, text: "Done.", streaming });
/** The row that ended its run (`stopReason` stop, length, aborted or error). */
const ended = (id: string, stopReason: string): TranscriptItem => ({ kind: "assistant", id, at: 5, text: "Done.", streaming: false, stopReason });
const tool = (id: string, status: ToolStatus): TranscriptItem => ({ kind: "tool", id, at: 4, callId: id, tool: "bash", title: "bun test", args: {}, status, truncated: false });

/** The incident: a redacted thought, then two tool calls still shown pending. */
const STUCK = [user("u1"), thought("th1"), tool("t1", "pending"), tool("t2", "pending")];
const SETTLED = [user("u1"), thought("th1"), tool("t1", "ok"), tool("t2", "error"), said("s1")];

/** An idle omp agent in Review on an online host, its open transcript holding `items`. */
function world(over: { agent?: Partial<Agent>; phase?: ConnPhase; session?: Partial<SessionEntry>; items?: TranscriptItem[] } = {}): CoreState {
  const items = over.items ?? STUCK;
  const agent: Agent = { id: "a", name: "a", kind: "omp", paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", state: "idle", stateSince: 1, column: "review", archived: false, turns: 1, title: "a", live: { streaming: false, thinking: false }, omp, ...over.agent };
  return {
    ...initialCoreState("demo"),
    status: { h: { phase: over.phase ?? "online", since: 1, attempt: 0 } },
    agents: { [KEY]: { ...agent, hostId: "h", key: KEY } },
    sessions: { [KEY]: { ...emptySession("live"), itemIds: items.map((i) => i.id), items: Object.fromEntries(items.map((i) => [i.id, i])), ...over.session } },
  };
}

/** Checks at chosen times, carrying the bookkeeping from one to the next like the runtime does. */
function checker(state: CoreState = world()) {
  let book: ReadonlyMap<string, HealEntry> = new Map();
  const heard = new Map<string, number>();
  return {
    heard,
    get book() {
      return book;
    },
    /** Whether the check at `now` re-opens the transcript. */
    at(now: number, s: CoreState = state): boolean {
      const d = decideHeals(s, [KEY], heard, book, now);
      book = d.book;
      return d.heal.includes(KEY);
    },
  };
}

describe("transcriptStale", () => {
  test("only while every condition holds: one flipped alone keeps the transcript fresh", () => {
    expect(transcriptStale(world(), KEY)).toBe(true);
    expect(transcriptStale(world({ agent: { column: "done", archived: true } }), KEY)).toBe(true);
    expect(transcriptStale(world({ items: [user("u1"), tool("t1", "running")] }), KEY)).toBe(true);
    expect(transcriptStale(world({ items: [user("u1"), said("s1", true)] }), KEY)).toBe(true);
    expect(transcriptStale(world({ items: [user("u1"), thought("th1", true)] }), KEY)).toBe(true);
    expect(transcriptStale(world({ items: [tool("t0", "running"), ...Array.from({ length: 63 }, (_, i) => user(`u${i}`))] }), KEY)).toBe(true);
    // A turn stuck after an earlier one ended.
    expect(transcriptStale(world({ items: [user("u0"), ended("s0", "stop"), ...STUCK] }), KEY)).toBe(true);
    const fresh: Record<string, CoreState> = {
      "host not online": world({ phase: "reconnecting" }),
      "link not live": world({ agent: { omp: { ...omp, link: "connecting" } } }),
      "not an omp agent": world({ agent: { omp: undefined } }),
      "card running": world({ agent: { column: "running", state: "working" } }),
      "card needs you": world({ agent: { column: "needs", state: "blocked" } }),
      "a tool runs": world({ agent: { live: { streaming: false, thinking: false, tool: { name: "bash", label: "bun test", startedAt: 1 } } } }),
      "text streams": world({ agent: { live: { streaming: true, thinking: false } } }),
      "it thinks": world({ agent: { live: { streaming: false, thinking: true } } }),
      "a question waits": world({ agent: { needs: { kind: "ask", since: 1, title: "Question", question: "Which one?", options: [], multi: false, allowOther: true, allowChat: false, answerable: true } } }),
      "every row settled": world({ items: SETTLED }),
      // omp retried an attempt that failed after streaming a call: its file has no result for the
      // call, so a transcript rebuilt from it keeps it queued for good, and no re-open changes that.
      ...Object.fromEntries(
        ["stop", "length", "aborted", "error"].map((why) => [`a call left by a run that ended (${why})`, world({ items: [user("u1"), thought("th1"), tool("t1", "pending"), ended("s1", why)] })]),
      ),
      "the unsettled row is older than the newest 64": world({ items: [tool("t0", "running"), ...Array.from({ length: 64 }, (_, i) => user(`u${i}`))] }),
      "still loading": world({ session: { status: "loading" } }),
      "session ended": world({ session: { status: "ended" } }),
    };
    for (const [why, s] of Object.entries(fresh)) expect({ why, stale: transcriptStale(s, KEY) }).toEqual({ why, stale: false });
    expect(transcriptStale(world(), "h::unknown")).toBe(false);
  });
});

describe("decideHeals", () => {
  test("re-opens once the transcript has been stale for 30 s and heard nothing for 30 s", () => {
    const c = checker();
    expect(c.at(0)).toBe(false);
    expect(c.at(29_999)).toBe(false);
    c.heard.set(KEY, 10_000);
    expect(c.at(30_000)).toBe(false);
    expect(c.at(39_999)).toBe(false);
    expect(c.at(40_000)).toBe(true);
  });

  test("backs off 30 s, 60 s, 120 s … between heals in a row, at most 15 min apart", () => {
    const c = checker();
    const heals: number[] = [];
    for (let t = 0; t <= 3_000_000; t += HEAL_CHECK_MS) if (c.at(t)) heals.push(t / 1000);
    expect(heals).toEqual([30, 60, 120, 240, 480, 960, 1860, 2760]);
    expect([1, 2, 3, 6, 40].map(healWait)).toEqual([30_000, 60_000, 120_000, 900_000, 900_000]);
  });

  test("a transcript that agrees again starts over", () => {
    const c = checker();
    c.at(0);
    expect([c.at(30_000), c.at(60_000)]).toEqual([true, true]);
    expect(c.at(65_000, world({ items: SETTLED }))).toBe(false);
    expect(c.book.size).toBe(0);
    // Stale again: 30 s of it first, then the backoff begins at 30 s again.
    expect(c.at(70_000)).toBe(false);
    expect(c.at(99_999)).toBe(false);
    expect(c.at(100_000)).toBe(true);
    expect(c.at(129_999)).toBe(false);
    expect(c.at(130_000)).toBe(true);
  });

  test("15 min without a heal while events kept coming ends the streak", () => {
    const c = checker();
    for (const t of [0, 30_000, 60_000, 120_000]) c.at(t);
    expect(c.book.get(KEY)?.heals).toBe(3);
    let t = 120_000;
    for (; t <= 120_000 + 15 * 60_000; t += HEAL_CHECK_MS) {
      c.heard.set(KEY, t);
      expect(c.at(t)).toBe(false);
    }
    const last = t - HEAL_CHECK_MS;
    expect(c.at(last + 30_000)).toBe(true);
    expect(c.at(last + 59_999)).toBe(false);
    expect(c.at(last + 60_000)).toBe(true);
  });

  test("only open keys count, and the bookkeeping passed in stays as it was", () => {
    const book = new Map<string, HealEntry>([[KEY, { staleSince: 0, heals: 0 }]]);
    const open = decideHeals(world(), [KEY], new Map(), book, 30_000);
    expect(open.heal).toEqual([KEY]);
    expect(book.get(KEY)).toEqual({ staleSince: 0, heals: 0 });
    expect(decideHeals(world(), [], new Map(), book, 30_000)).toEqual({ heal: [], book: new Map() });
  });
});

describe("the demo host", () => {
  test("its transcripts always agree with its state: nothing to heal", async () => {
    const clock = new ManualClock();
    const engine = new DemoEngine({ mode: "backend", clock });
    let state = initialCoreState("demo");
    const heard = new Map<string, number>();
    /** Events of each session that arrived while its `session.open` was on its way (the demo's snapshot predates them). */
    const opening = new Map<string, AppEvent[]>();
    engine.subscribe((e) => {
      if (e.type === "session") {
        const key = agentKey(e.hostId, e.agentId);
        heard.set(key, clock.now());
        opening.get(key)?.push(e);
      }
      state = reduceEvents(state, [e]).state;
    });
    clock.advance(2000);
    const keys: string[] = [];
    for (const a of Object.values(state.agents)) {
      if (a.hostId !== "forge" || a.omp?.link !== "live") continue;
      opening.set(a.key, []);
      const answer = engine.callHost("forge", "session.open", { agentId: a.id, limit: 200 });
      clock.advance(100);
      const snapshot = (await answer) as SessionSnapshot;
      const reset: AppEvent = { type: "session", hostId: "forge", agentId: a.id, ev: { k: "reset", snapshot } };
      state = reduceEvents(state, [reset, ...(opening.get(a.key) ?? [])]).state;
      opening.delete(a.key);
      keys.push(a.key);
    }
    expect(keys.length).toBeGreaterThan(5);
    let book: ReadonlyMap<string, HealEntry> = new Map();
    const healed: string[] = [];
    for (let t = 0; t < 10 * 60_000; t += HEAL_CHECK_MS) {
      clock.advance(HEAL_CHECK_MS);
      const d = decideHeals(state, keys, heard, book, clock.now());
      healed.push(...d.heal);
      book = d.book;
    }
    expect(healed).toEqual([]);
    // It ran: turns ended while their transcripts were open.
    expect(keys.some((k) => state.agents[k]?.column === "review" && (state.sessions[k]?.itemIds.length ?? 0) > 0)).toBe(true);
    engine.dispose();
  }, 30_000);
});
