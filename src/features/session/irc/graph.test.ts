import { describe, expect, test } from "bun:test";
import type { AgentChatMessage, Subagent } from "@/core/gen";
import { agentNamer, USER } from "./chat";
import {
  activeAt,
  buildGraph,
  type ChatGraph,
  countNear,
  edgeKey,
  keepNodes,
  type LayoutItem,
  layoutGraph,
  pickHub,
  presentAt,
  sessionTree,
  spanText,
  STEP_MS,
  statusAt,
  stepDelay,
  summarize,
  summaryText,
  trackAt,
  trackPositions,
} from "./graph";

const msg = (id: string, at: number, m: Partial<AgentChatMessage> = {}): AgentChatMessage => ({
  id,
  from: "A",
  to: ["B"],
  broadcast: false,
  text: id,
  at,
  wakeRelay: false,
  progress: false,
  receipts: [],
  rev: 1,
  ...m,
});
const sub = (id: string, extra: Partial<Subagent> = {}): Subagent => ({ id, name: id, status: "running", ...extra });
const counts = (g: ChatGraph) => Object.fromEntries(g.edges.map((e) => [edgeKey(e), e.ids.length]));
const ids = (g: ChatGraph) => g.nodes.map((n) => n.id);

describe("who wrote to whom", () => {
  test("posts add up per direction: a question and its reply are two edges; nodes count what they sent and got", () => {
    const g = buildGraph([
      msg("m1", 1, { from: "Main", to: ["Sweep"] }),
      msg("m2", 2, { from: "Main", to: ["Sweep"] }),
      msg("m3", 3, { from: "Sweep", to: ["Main"], replyTo: "m2", wakeRelay: true }),
      msg("m4", 4, { from: "Sweep", to: ["Size16", "Size32", "Size16"] }),
    ]);
    expect(counts(g)).toEqual({ "Main\nSweep": 2, "Sweep\nMain": 1, "Sweep\nSize16": 1, "Sweep\nSize32": 1 });
    expect(g.nodes.map((n) => [n.id, n.sent, n.got, n.last])).toEqual([
      ["Main", 2, 1, "m3"],
      ["Sweep", 2, 2, "m4"],
      ["Size16", 0, 1, "m4"],
      ["Size32", 0, 1, "m4"],
    ]);
    expect(g.edges.find((e) => e.from === "Main")?.ids).toEqual(["m1", "m2"]);
    expect(g.spawns).toEqual([]);
  });

  test("a broadcast counts for its sender's @all and goes on edges of its own to each recipient it lists", () => {
    const g = buildGraph([
      msg("m1", 1, { from: "Bench", to: ["Main"] }),
      msg("m2", 2, { from: "Bench", to: ["Main", "Scout"], broadcast: true }),
      msg("m3", 3, { from: "Bench", to: ["Main", "Scout"], broadcast: true }),
      msg("m4", 4, { from: "Scout", to: ["Bench"], replyTo: "m3" }),
    ]);
    expect(counts(g)).toEqual({ "Bench\nMain": 1, "*Bench\nMain": 2, "*Bench\nScout": 2, "Scout\nBench": 1 });
    expect(g.edges.filter((e) => e.viaAll).every((e) => e.from === "Bench")).toBe(true);
    expect(g.nodes.find((n) => n.id === "Bench")).toMatchObject({ sent: 3, got: 1, broadcasts: 2, unaddressed: false });
    expect(g.nodes.find((n) => n.id === "Scout")).toMatchObject({ sent: 1, got: 2, broadcasts: 0 });
  });

  test("a post naming no recipient (a broadcast whose recipients aren't known, or one to itself) marks its sender and draws no edge", () => {
    const g = buildGraph([msg("m1", 1, { from: "Stale", to: [], broadcast: true }), msg("m2", 2, { from: "Echo", to: ["Echo"] }), msg("m3", 3, { from: "Main", to: ["Echo"] })]);
    expect(g.edges.map(edgeKey)).toEqual(["Main\nEcho"]);
    expect(g.nodes.map((n) => [n.id, n.unaddressed, n.broadcasts])).toEqual([
      ["Stale", true, 1],
      ["Echo", true, 0],
      ["Main", false, 0],
    ]);
  });

  test("the hub: the main agent when it is on the graph, else the agent in the most posts", () => {
    expect(pickHub(buildGraph([msg("m1", 1, { from: "A", to: ["B"] }), msg("m2", 2, { from: "C", to: ["B"] }), msg("m3", 3, { from: "Main", to: ["A"] })]))).toBe("Main");
    expect(pickHub(buildGraph([msg("m1", 1, { from: "A", to: ["B"] }), msg("m2", 2, { from: "C", to: ["B"] })]))).toBe("B");
    expect(pickHub(buildGraph([msg("m1", 1, { from: "A", to: ["B"] })]))).toBe("A");
    expect(pickHub(buildGraph([]))).toBeUndefined();
  });
});

describe("the session's agent tree", () => {
  test("a parent and three workers before anyone posted: four agents, three spawn lines, and the summary says 0 posts", () => {
    const g = buildGraph([], sessionTree([sub("Api"), sub("Ui"), sub("Db")]));
    expect(ids(g)).toEqual(["Main", "Api", "Ui", "Db"]);
    expect(g.spawns).toEqual([
      { parent: "Main", child: "Api" },
      { parent: "Main", child: "Ui" },
      { parent: "Main", child: "Db" },
    ]);
    expect(g.edges).toEqual([]);
    expect(g.nodes.every((n) => n.sent + n.got === 0 && n.last === undefined)).toBe(true);
    expect(pickHub(g)).toBe("Main");
    expect(summaryText(summarize([], 0))).toBe("0 posts");
  });

  test("no subagents: no tree", () => {
    expect(sessionTree([])).toEqual([]);
  });

  test("subagents at any depth hang under their parent, by omp's id; whoever else posts joins after, under the agent its dotted id names", () => {
    const subs = [
      sub("pool-sub-1", { name: "Bench" }),
      sub("pool-sub-2", { name: "Bench.Sweep", parentId: "pool-sub-1" }),
      sub("pool-sub-3", { name: "Bench.Sweep.Size64", parentId: "pool-sub-2" }),
      sub("Scout"),
      // Its parent isn't on the roster (an older host's gap): it still belongs to the session, under the main agent.
      sub("Lab.Ui.Shots"),
    ];
    const tree = sessionTree(subs);
    expect(tree).toEqual([
      { id: "Main" },
      { id: "Bench", parent: "Main" },
      { id: "Bench.Sweep", parent: "Bench" },
      { id: "Bench.Sweep.Size64", parent: "Bench.Sweep" },
      { id: "Scout", parent: "Main" },
      { id: "Lab.Ui.Shots", parent: "Lab.Ui" },
    ]);
    const g = buildGraph([msg("m1", 1, { from: "Bench.Sweep.Size64", to: ["Bench.Sweep"] }), msg("m2", 2, { from: USER, to: ["Scout"] }), msg("m3", 3, { from: "Scout.Probe", to: ["Scout"] })], tree);
    expect(ids(g)).toEqual(["Main", "Bench", "Bench.Sweep", "Bench.Sweep.Size64", "Scout", "Lab.Ui.Shots", USER, "Scout.Probe"]);
    expect(g.spawns).toEqual([
      { parent: "Main", child: "Bench" },
      { parent: "Bench", child: "Bench.Sweep" },
      { parent: "Bench.Sweep", child: "Bench.Sweep.Size64" },
      { parent: "Main", child: "Scout" },
      { parent: "Main", child: "Lab.Ui.Shots" },
      { parent: "Scout", child: "Scout.Probe" },
    ]);
    expect(counts(g)).toEqual({ "Bench.Sweep.Size64\nBench.Sweep": 1, "user\nScout": 1, "Scout.Probe\nScout": 1 });
    // Bench never posted nor was addressed: silent, with no newest post.
    expect(g.nodes.find((n) => n.id === "Bench")).toMatchObject({ sent: 0, got: 0 });
    expect(g.nodes.find((n) => n.id === "Bench")?.last).toBeUndefined();
  });

  test("two roster rows with one omp id stand as one agent (the log can't tell them apart)", () => {
    const tree = sessionTree([sub("a", { name: "Scout" }), sub("b", { name: "Scout" })]);
    expect(tree).toEqual([{ id: "Main" }, { id: "Scout", parent: "Main" }]);
  });
});

describe("inactive agents", () => {
  const subs = [sub("Sweep", { status: "done", startedAt: 0, endedAt: 50 }), sub("Size64", { status: "failed", startedAt: 0, endedAt: 20 }), sub("Size16"), sub("Old", { status: "aborted" })];
  const who = agentNamer(subs, "pool");

  test("a subagent counts as running until it ended: earlier on the timeline it was still at work", () => {
    expect(statusAt(subs[0] as Subagent, 10)).toBe("running");
    expect(statusAt(subs[0] as Subagent, 50)).toBe("done");
    expect(statusAt(subs[0] as Subagent, Number.POSITIVE_INFINITY)).toBe("done");
    expect(statusAt(subs[3] as Subagent, 10)).toBe("aborted"); // no end time: as it is now
    expect([10, 30, Number.POSITIVE_INFINITY].map((t) => activeAt(who("Size64"), t))).toEqual([true, false, false]);
    expect(activeAt(who("Size16"), Number.POSITIVE_INFINITY)).toBe(true);
  });

  test("the main agent, You and agents the roster lacks never count as finished", () => {
    for (const id of ["Main", USER, "Stranger.Worker"]) expect(activeAt(who(id), Number.POSITIVE_INFINITY)).toBe(true);
  });

  test("hiding inactive agents drops them and every edge to or from them, broadcast legs included", () => {
    const g = buildGraph([
      msg("m1", 1, { from: "Sweep", to: ["Size64"] }),
      msg("m2", 2, { from: "Size64", to: ["Sweep"] }),
      msg("m3", 3, { from: "Main", to: ["Sweep", "Size64", "Size16"], broadcast: true }),
      msg("m4", 4, { from: "Size16", to: ["Sweep"] }),
    ]);
    const kept = keepNodes(g, (n) => activeAt(who(n.id), 30));
    expect(ids(kept)).toEqual(["Sweep", "Main", "Size16"]);
    expect(kept.edges.map(edgeKey)).toEqual(["*Main\nSweep", "*Main\nSize16", "Size16\nSweep"]);
    expect(keepNodes(g, () => true)).toBe(g);
  });

  test("hiding them leaves silent agents of the tree out too, each kept one under the nearest kept agent it runs under", () => {
    const tree = [sub("Bench", { status: "done", endedAt: 10 }), sub("Bench.Sweep", { parentId: "Bench" }), sub("Scout", { status: "failed", endedAt: 5 }), sub("Idle")];
    const named = agentNamer(tree, "pool");
    const kept = keepNodes(buildGraph([], sessionTree(tree)), (n) => activeAt(named(n.id), Number.POSITIVE_INFINITY));
    expect(ids(kept)).toEqual(["Main", "Bench.Sweep", "Idle"]);
    expect(kept.spawns).toEqual([
      { parent: "Main", child: "Bench.Sweep" },
      { parent: "Main", child: "Idle" },
    ]);
  });
});

describe("the timeline", () => {
  const log = [msg("m1", 1_000, { from: "Main", to: ["Sweep"] }), msg("m2", 3_000, { from: "Sweep", to: ["Main"] }), msg("m3", 3_000, { from: "Sweep", to: ["Size64"] }), msg("m4", 11_000, { from: "Size64", to: ["Sweep"] })];
  const ats = log.map((m) => m.at);

  test("the graph at a point shows the posts up to it, who was running then, and who had been spawned", () => {
    const subs = [sub("Sweep", { status: "done", startedAt: 500, endedAt: 20_000 }), sub("Size64", { status: "failed", startedAt: 2_000, endedAt: 12_000 }), sub("Late", { status: "done", startedAt: 15_000, endedAt: 16_000 })];
    const who = agentNamer(subs, "pool");
    const tree = sessionTree(subs);
    const at = (shown: number) => {
      // The start: just before the first post, as the Graph tab tells it.
      const t = shown > 0 ? (log[shown - 1] as AgentChatMessage).at : (log[0] as AgentChatMessage).at - 1;
      const g = keepNodes(buildGraph(log.slice(0, shown), tree), (n) => presentAt(n, who(n.id), t));
      return { nodes: ids(g), edges: counts(g), inactive: g.nodes.filter((n) => !activeAt(who(n.id), t)).map((n) => n.id) };
    };
    // Sweep was spawned before the first post; Size64 and Late weren't yet.
    expect(at(0)).toEqual({ nodes: ["Main", "Sweep"], edges: {}, inactive: [] });
    expect(at(1)).toEqual({ nodes: ["Main", "Sweep"], edges: { "Main\nSweep": 1 }, inactive: [] });
    expect(at(3)).toEqual({ nodes: ["Main", "Sweep", "Size64"], edges: { "Main\nSweep": 1, "Sweep\nMain": 1, "Sweep\nSize64": 1 }, inactive: [] });
    expect(at(4)).toEqual({ nodes: ["Main", "Sweep", "Size64"], edges: { "Main\nSweep": 1, "Sweep\nMain": 1, "Sweep\nSize64": 1, "Size64\nSweep": 1 }, inactive: [] });
    // Live (now): Late is there, silent, and finished like Size64 and Sweep.
    const now = keepNodes(buildGraph(log, tree), (n) => presentAt(n, who(n.id), Number.POSITIVE_INFINITY));
    expect(ids(now)).toEqual(["Main", "Sweep", "Size64", "Late"]);
    expect(now.nodes.filter((n) => !activeAt(who(n.id), Number.POSITIVE_INFINITY)).map((n) => n.id)).toEqual(["Sweep", "Size64", "Late"]);
  });

  test("an agent that posted or was addressed is on the graph even before the roster says it started", () => {
    const early = sub("Early", { startedAt: 5_000 });
    const g = buildGraph([msg("m1", 1_000, { from: "Main", to: ["Early"] })]);
    const n = g.nodes.find((x) => x.id === "Early");
    expect(n && presentAt(n, agentNamer([early], "pool")("Early"), 1_000)).toBe(true);
  });

  test("even pacing: one equal step per post, a second each at 1×", () => {
    const even = trackPositions(ats, "even");
    expect(even).toEqual([0.25, 0.5, 0.75, 1]);
    expect([0, 1, 2, 3].map((k) => stepDelay(even, k, 1))).toEqual([STEP_MS, STEP_MS, STEP_MS, STEP_MS]);
    expect(stepDelay(even, 2, 4)).toBe(STEP_MS / 4);
    expect(stepDelay(even, 4, 1)).toBe(0);
  });

  test("real-time pacing: steps in proportion to the time between posts, the log taking as long as at even pacing", () => {
    const real = trackPositions(ats, "real");
    // 10 s from first to last, the first an average gap (2.5 s) in.
    expect(real).toEqual([2_500 / 12_500, 4_500 / 12_500, 4_500 / 12_500, 1]);
    const delays = [0, 1, 2, 3].map((k) => stepDelay(real, k, 1));
    expect(delays.map((d) => Math.round(d))).toEqual([800, 640, 0, 2560]);
    expect(Math.round(delays.reduce((a, b) => a + b))).toBe(4 * STEP_MS);
    expect(Math.round(stepDelay(real, 3, 2))).toBe(1280);
    // All sent at once: nothing to be in proportion to.
    expect(trackPositions([5, 5], "real")).toEqual([0.5, 1]);
    expect(trackPositions([], "real")).toEqual([]);
  });

  test("dragging snaps to the nearest post; posts sent at the same moment show together", () => {
    const real = trackPositions(ats, "real");
    expect(countNear(real, 0)).toBe(0);
    expect(countNear(real, 0.05)).toBe(0);
    expect(countNear(real, 0.19)).toBe(1);
    expect(countNear(real, 0.36)).toBe(3);
    expect(countNear(real, 0.9)).toBe(4);
    expect(trackAt(real, 0)).toBe(0);
    expect(trackAt(real, 2)).toBe(trackAt(real, 3));
    expect(trackAt(real, 9)).toBe(1);
  });

  test("the summary counts the posts shown and the time they span", () => {
    expect(summarize(ats, 4)).toEqual({ shown: 4, total: 4, span: 10_000, totalSpan: 10_000 });
    expect(summarize(ats, 2)).toEqual({ shown: 2, total: 4, span: 2_000, totalSpan: 10_000 });
    expect(summarize(ats, 9).shown).toBe(4);
    expect(summaryText(summarize(ats, 4))).toBe("4 posts over 10s");
    expect(summaryText(summarize(ats, 2))).toBe("2 of 4 posts · 2s of 10s");
    expect(summaryText(summarize(ats, 0))).toBe("0 of 4 posts");
    expect(summaryText(summarize([7], 1))).toBe("1 post");
    expect(summaryText(summarize([7], 0))).toBe("0 of 1 post");
    expect(summaryText(summarize([], 0))).toBe("0 posts");
    expect([0, 45_000, 760_000, 11_100_000, 11_159_000, 187_200_000].map(spanText)).toEqual(["0s", "45s", "12m 40s", "3h 05m", "3h 05m", "2d 4h"]);
  });
});

describe("the layout", () => {
  const item = (id: string, parent?: string, w = 70 + (id.length % 5) * 12): LayoutItem => ({ id, parent, w, h: 28 });
  const overlaps = (items: LayoutItem[], pos: Map<string, { x: number; y: number }>) => {
    const hits: string[] = [];
    items.forEach((a, i) => {
      for (const b of items.slice(i + 1)) {
        const pa = pos.get(a.id) as { x: number; y: number };
        const pb = pos.get(b.id) as { x: number; y: number };
        if (Math.abs(pa.x - pb.x) < (a.w + b.w) / 2 + 4 && Math.abs(pa.y - pb.y) < (a.h + b.h) / 2 + 4) hits.push(`${a.id}/${b.id}`);
      }
    });
    return hits;
  };
  const flat = (n: number) => [item("Main"), ...Array.from({ length: n - 1 }, (_, i) => item(`worker_${i + 1}`))];
  const nested = (n: number) => [
    item("Main"),
    ...Array.from({ length: n - 1 }, (_, i) => {
      const parent = i < 3 ? undefined : `w${(i - 3) % 3}`;
      return item(`w${i}`, parent);
    }),
  ];

  test("the hub sits at the top centre, an agent's own below it", () => {
    const items = [item("Main"), item("Bench"), item("Sweep", "Bench"), item("Size16", "Sweep"), item("Size32", "Sweep"), item("Scout")];
    const { pos } = layoutGraph(items, "Main", 1000, 600);
    const at = (id: string) => pos.get(id) as { x: number; y: number };
    expect(at("Main").x).toBe(500);
    for (const it of items.slice(1)) expect(at(it.id).y).toBeGreaterThan(at("Main").y);
    expect(at("Sweep").y).toBeGreaterThan(at("Bench").y);
    expect(at("Size16").y).toBeGreaterThan(at("Sweep").y);
    expect(at("Sweep").x).toBeGreaterThan(at("Size16").x);
    expect(at("Sweep").x).toBeLessThan(at("Size32").x);
    expect(at("Bench").x).toBeLessThan(at("Scout").x);
  });

  test("a row whose agents fit side by side stays one lane and arcs, though their columns are narrower than they are", () => {
    const names = ["QueryScout", "PoolBench", "LockAudit", "StaleProbe"];
    const items = [item("Main"), ...names.map((id) => item(id, undefined, 116))];
    // 128 px columns for 116 px pills plus their gap: staggering would drop every other one a lane lower.
    const { pos } = layoutGraph(items, "Main", 540, 700);
    const y = (id: string) => pos.get(id)?.y ?? Number.NaN;
    for (const mid of ["PoolBench", "LockAudit"]) for (const end of ["QueryScout", "StaleProbe"]) expect(y(mid)).toBeGreaterThan(y(end));
    expect(overlaps(items, pos)).toEqual([]);
  });

  test("the same graph and canvas give the same places", () => {
    const items = nested(12);
    expect(layoutGraph(items, "Main", 720, 480)).toEqual(layoutGraph(items, "Main", 720, 480));
  });

  test("2 to 20 agents, flat or nested, on a desktop panel or a phone: no two pills overlap and all stay on the canvas", () => {
    for (const [width, height] of [
      [1000, 560],
      [380, 520],
    ] as const) {
      for (let n = 2; n <= 20; n++) {
        for (const items of [flat(n), nested(n)]) {
          const { pos, height: used } = layoutGraph(items, "Main", width, height);
          expect(overlaps(items, pos)).toEqual([]);
          for (const it of items) {
            const p = pos.get(it.id) as { x: number; y: number };
            expect(p.x - it.w / 2).toBeGreaterThanOrEqual(0);
            expect(p.x + it.w / 2).toBeLessThanOrEqual(width);
            expect(p.y + it.h / 2).toBeLessThanOrEqual(used);
          }
        }
      }
    }
  });

  test("a drawing taller than the canvas makes it taller; a short one sits in its middle", () => {
    const tall = layoutGraph(flat(20), "Main", 380, 200);
    expect(tall.height).toBeGreaterThan(200);
    const short = layoutGraph([item("Main"), item("Scout")], "Main", 600, 600);
    expect(short.height).toBe(600);
    const ys = [...short.pos.values()].map((p) => p.y);
    expect(Math.min(...ys)).toBeGreaterThan(100);
    expect(Math.max(...ys)).toBeLessThan(500);
  });
});
