import { describe, expect, test } from "bun:test";
import type { AppEvent, SessionSnapshot } from "../gen";
import { agentKey } from "../keys";
import { resolveSuccessor } from "../store/lifecycle";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { PARK_GRACE_MS, PRUNE_AFTER_MS } from "./parking";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  const events: AppEvent[] = [];
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    events.push(e);
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const call = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
  clock.advance(3000);
  return { clock, call, events, get state() { return state; } };
}

const key = (id: string) => agentKey("forge", id);

describe("demo parking", () => {
  test("a seeded parked agent: read-only transcript, controls refused, resume under a new id", async () => {
    const r = rig();
    const a = r.state.agents[key("tokens")];
    expect(a?.parked?.sessionFile).toContain("tokens.jsonl");
    expect([a?.paneId, a?.workspaceId, a?.column]).toEqual(["", "", "done"]);
    const snap = await r.call<SessionSnapshot>("session.open", { agentId: "tokens" });
    expect(snap.items.length).toBeGreaterThan(0);
    expect(Object.entries(snap.meta.caps).filter(([, on]) => on).map(([k]) => k)).toEqual(["prompt"]);
    await expect(r.call("agent.abort", { agentId: "tokens" })).rejects.toMatchObject({ code: "parked" });
    await expect(r.call("term.open", { target: { kind: "agent", agentId: "tokens" }, cols: 80, rows: 24, mode: "control" })).rejects.toMatchObject({ code: "parked" });

    const started = await r.call<{ agentId: string; paneId: string }>("agent.resume", { agentId: "tokens" });
    expect(started.agentId).not.toBe("tokens");
    expect(r.state.agents[key("tokens")]).toBeUndefined();
    const next = r.state.agents[key(started.agentId)];
    expect(next?.omp?.sessionId).toBe(a?.omp?.sessionId);
    expect([next?.parked, next?.archived, next?.column, next?.paneId]).toEqual([undefined, false, "review", started.paneId]);
    expect(resolveSuccessor(r.state.successors, key("tokens"))).toBe(key(started.agentId));
  });

  test("Mark done with close parks after the undo window; undo inside it cancels; a prompt resumes it", async () => {
    const r = rig();
    await r.call("agent.archive", { agentId: "docs", archived: true, close: true });
    r.clock.advance(PARK_GRACE_MS / 2);
    await r.call("agent.archive", { agentId: "docs", archived: false });
    r.clock.advance(PARK_GRACE_MS);
    expect(r.state.agents[key("docs")]?.parked).toBeUndefined();

    await r.call("agent.archive", { agentId: "hero", archived: true, close: true });
    const sessionId = r.state.agents[key("hero")]?.omp?.sessionId;
    r.clock.advance(PARK_GRACE_MS + 400);
    const parked = r.state.agents[key("hero")];
    expect(parked?.parked).toBeDefined();
    // its worktree workspace had nothing else in it
    expect(r.state.hosts.forge?.state.workspaces.some((w) => w.id === "w9")).toBe(false);

    await r.call("agent.prompt", { agentId: "hero", text: "One more tweak" });
    r.clock.advance(2000);
    const heir = resolveSuccessor(r.state.successors, key("hero"));
    expect(heir).toBeDefined();
    const back = r.state.agents[heir ?? ""];
    expect(back?.omp?.sessionId).toBe(sessionId);
    expect(back?.column).toBe("running");
    expect(r.state.hosts.forge?.state.workspaces.find((w) => w.id === back?.workspaceId)?.cwd).toBe(parked?.cwd);
  });

  test("the seeded parked agent whose session is deleted is pruned with its notification", () => {
    const r = rig();
    r.clock.advance(5000);
    expect(r.state.notifications.some((n) => n.agentId === "spike")).toBe(true);
    r.clock.advance(PRUNE_AFTER_MS);
    expect(r.state.agents[key("spike")]).toBeUndefined();
    expect(r.state.hosts.forge?.state.info.pruned?.map((p) => p.agentId)).toEqual(["spike"]);
    expect(r.state.notifications.some((n) => n.agentId === "spike")).toBe(false);
  });
});
