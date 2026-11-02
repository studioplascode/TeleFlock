import { describe, expect, test } from "bun:test";
import type { ChangedFile, Subagent, TodoPhase } from "@/core/gen";

// The store persists to localStorage, which bun doesn't provide: an in-memory stand-in, installed
// before the store module loads (it hydrates at load).
const mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
  clear: () => {},
  key: () => null,
  length: 0,
} as Storage;
const { MAX_MARK_IDS, MAX_MARK_SESSIONS, markBtw, marksOf, markSub, sessionScope, subMarksOf, useInspectorCards, visibleBtw } = await import("./cards");
const { btwSummary, filesSummary, overviewSummary, subagentsSummary, todosSummary, treeSummary } = await import("./summaries");

describe("btw marks", () => {
  test("a session is told by its omp session id, so a reopened pane keeps its dismissals", () => {
    expect(sessionScope("h", "agent-1", "s-9")).toBe(sessionScope("h", "agent-2", "s-9"));
    expect(sessionScope("h", "agent-1", "s-9")).not.toBe(sessionScope("h2", "agent-1", "s-9"));
    expect(sessionScope("h", "agent-1", undefined)).not.toBe(sessionScope("h", "agent-1", "s-9"));
  });

  test("dismissing hides a row for good and clears its collapse; marks are per session", () => {
    let st = markBtw({}, "s1", "collapsed", ["a", "b"], true);
    st = markBtw(st, "s1", "dismissed", ["a"], true);
    expect(marksOf(st, "s1")).toEqual({ dismissed: ["a"], collapsed: ["b"] });
    expect(marksOf(st, "s2")).toEqual({ dismissed: [], collapsed: [] });
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(visibleBtw(rows, marksOf(st, "s1")).map((r) => r.id)).toEqual(["b", "c"]);
    expect(visibleBtw(rows, marksOf(st, "s2"))).toEqual(rows);
    // marking the same row again is a no-op on the list, un-collapsing removes it
    st = markBtw(st, "s1", "dismissed", ["a"], true);
    expect(marksOf(st, "s1").dismissed).toEqual(["a"]);
    st = markBtw(st, "s1", "collapsed", ["b"], false);
    expect(marksOf(st, "s1").collapsed).toEqual([]);
  });

  test("empty marks leave no entry; old ids and sessions fall out at the caps", () => {
    const st = markBtw(markBtw({}, "s1", "collapsed", ["a"], true), "s1", "collapsed", ["a"], false);
    expect(st).toEqual({});
    const ids = Array.from({ length: MAX_MARK_IDS + 5 }, (_, i) => `b${i}`);
    const big = markBtw({}, "s", "dismissed", ids, true);
    expect(marksOf(big, "s").dismissed).toHaveLength(MAX_MARK_IDS);
    expect(marksOf(big, "s").dismissed[0]).toBe("b5");
    let many = {};
    for (let i = 0; i < MAX_MARK_SESSIONS + 3; i++) many = markBtw(many, `s${i}`, "dismissed", ["x"], true);
    expect(Object.keys(many)).toHaveLength(MAX_MARK_SESSIONS);
    expect(Object.keys(many)).not.toContain("s0");
    expect(Object.keys(many)).toContain(`s${MAX_MARK_SESSIONS + 2}`);
  });
});

describe("subagent branch marks", () => {
  test("opening and closing a branch is remembered per session, the latest choice winning", () => {
    let st = markSub({}, "s1", "Lab", false);
    st = markSub(st, "s1", "Lab.Ui", true);
    expect(subMarksOf(st, "s1")).toEqual({ open: ["Lab.Ui"], closed: ["Lab"] });
    st = markSub(st, "s1", "Lab", true);
    expect(subMarksOf(st, "s1")).toEqual({ open: ["Lab.Ui", "Lab"], closed: [] });
    expect(subMarksOf(st, "s2")).toEqual({ open: [], closed: [] });
  });

  test("old branches and sessions fall out at the caps", () => {
    let big = {};
    for (let i = 0; i < MAX_MARK_IDS + 5; i++) big = markSub(big, "s", `a${i}`, false);
    expect(subMarksOf(big, "s").closed).toHaveLength(MAX_MARK_IDS);
    expect(subMarksOf(big, "s").closed[0]).toBe("a5");
    let many = {};
    for (let i = 0; i < MAX_MARK_SESSIONS + 3; i++) many = markSub(many, `s${i}`, "a", true);
    expect(Object.keys(many)).toHaveLength(MAX_MARK_SESSIONS);
    expect(Object.keys(many)).not.toContain("s0");
  });
});

describe("inspector card store", () => {
  test("collapsed cards, dismissed side questions and folded subagent branches survive a reload", async () => {
    useInspectorCards.getState().toggle("todos");
    useInspectorCards.getState().setCollapsed("spend", true);
    useInspectorCards.getState().markBtw("h/s:1", "dismissed", ["b1"], true);
    useInspectorCards.getState().markSub("h/s:1", "Lab", false);
    useInspectorCards.getState().toggle("todos"); // open again: only collapsed cards are stored
    const saved = JSON.parse(mem["tf.inspector"]!).state;
    expect(saved.collapsed).toEqual({ spend: true });
    expect(saved.btw["h/s:1"].dismissed).toEqual(["b1"]);
    expect(saved.subs["h/s:1"].closed).toEqual(["Lab"]);
    await useInspectorCards.persist.rehydrate();
    expect(useInspectorCards.getState().collapsed.spend).toBe(true);
    expect(marksOf(useInspectorCards.getState().btw, "h/s:1").dismissed).toEqual(["b1"]);
    expect(subMarksOf(useInspectorCards.getState().subs, "h/s:1").closed).toEqual(["Lab"]);
  });
});

describe("collapsed summaries", () => {
  const phase = (...tasks: TodoPhase["tasks"]): TodoPhase => ({ name: "p", tasks });
  const sub = (status: Subagent["status"]): Subagent => ({ id: status + Math.random(), name: "n", status });
  const file = (path: string, added: number, removed: number): ChangedFile => ({ path, added, removed, status: "modified" });

  test("Session: only what is known", () => {
    expect(overviewSummary({ ctxPct: 41.6, limitLeft: 0.58, usd: 1.234, tps: 33.4 })).toBe("ctx 42% · limit 58% left · $1.23 · 33 tok/s");
    expect(overviewSummary({ usd: 0, tps: 0 })).toBe("$0.00");
    expect(overviewSummary({})).toBe("");
  });

  test("Todos: done/total and the task in progress", () => {
    const todos = [phase({ content: "a", status: "completed" }, { content: "b", status: "inProgress" }, { content: "c", status: "blocked" }, { content: "d", status: "abandoned" })];
    expect(todosSummary(todos)).toBe("1/3 · 1 blocked · b");
    expect(todosSummary([phase({ content: "a", status: "completed" })])).toBe("1/1");
  });

  test("Subagents: running and failed, else how many finished and how many were stopped, as the rows say", () => {
    expect(subagentsSummary([sub("running"), sub("running"), sub("failed"), sub("done")])).toBe("2 running · 1 failed");
    expect(subagentsSummary([sub("parked"), sub("done")])).toBe("2 done");
    // a stopped one is no done one: its row says "Stopped", the finished group "N done · M stopped"
    expect(subagentsSummary([sub("parked"), sub("aborted")])).toBe("1 done · 1 stopped");
    expect(subagentsSummary([sub("aborted")])).toBe("1 stopped");
  });

  test("Changed files, tree and btw", () => {
    expect(filesSummary([file("a", 200, 10), file("b", 12, 7)])).toMatchObject({ count: 2, added: 212, removed: 17, text: "2 files +212 −17" });
    expect(filesSummary([file("a", 1, 0)]).text).toBe("1 file +1 −0");
    expect(treeSummary(412, 3)).toBe("412 nodes · 3 branches");
    expect(treeSummary(1, 0)).toBe("1 node");
    expect(btwSummary(0, false)).toBe("no side questions");
    expect(btwSummary(3, true)).toBe("3 questions · answering");
  });
});
