import { describe, expect, test } from "bun:test";
import type { AppEvent, RetryResult, SessionSnapshot } from "../gen";
import { agentKey } from "../keys";
import { resolveSuccessor } from "../store/lifecycle";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { BACK_AFTER_MS, HERDR_BACK_MS, PARK_GRACE_MS, PRUNE_AFTER_MS } from "./parking";

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

  test("seeded ended cards wait in Review: herdr stopped (no ticket), a countdown that brings one back by itself, a manual one", () => {
    const r = rig();
    const soak = r.state.agents[key("soak")];
    expect([soak?.column, soak?.archived, soak?.paneId, soak?.autoResume]).toEqual(["review", false, "", undefined]);
    expect(soak?.parked?.ended).toMatchObject({ cause: "herdrStopped", reason: "herdr stopped", turn: "working", lastAction: "bash: sleep 30; echo done >> /tmp/c.out" });
    const a11y = r.state.agents[key("a11y")];
    expect(a11y?.parked?.ended).toMatchObject({ cause: "herdrCrashed", reason: "herdr crashed", turn: "idle" });
    expect(a11y?.autoResume).toMatchObject({ status: "waiting", kind: "restart", reason: "herdr crashed", since: a11y?.parked?.ended?.at });
    const invoices = r.state.agents[key("invoices")];
    expect(invoices?.parked?.ended).toMatchObject({ cause: "reboot", reason: "the host restarted", turn: "replying" });
    expect(invoices?.autoResume).toMatchObject({ status: "manual", kind: "restart", reason: "Auto-resume is off on this host" });

    // a11y's countdown runs out: back by itself under a new id, live, its ticket gone (it was idle: nothing more)
    r.clock.advance(BACK_AFTER_MS);
    const heir = resolveSuccessor(r.state.successors, key("a11y"));
    expect(heir).toBeDefined();
    r.clock.advance(2500);
    const back = r.state.agents[heir ?? ""];
    expect([back?.parked, back?.autoResume, back?.omp?.link, back?.column]).toEqual([undefined, undefined, "live", "review"]);
  });

  test("Continue brings an ended card back and it goes on; Don't, then Dismiss, files one in Done; Mark done too", async () => {
    const r = rig();
    // a cut-off reply: omp's retry once it is back
    expect(await r.call<RetryResult>("agent.autoResumeNow", { agentId: "invoices" })).toEqual({ started: true, via: "restore" });
    const heir = resolveSuccessor(r.state.successors, key("invoices"));
    expect(r.state.agents[heir ?? ""]?.autoResume?.status).toBe("resuming");
    r.clock.advance(2000);
    const back = r.state.agents[heir ?? ""];
    expect([back?.parked, back?.autoResume, back?.column]).toEqual([undefined, undefined, "running"]);

    // Don't: a11y's countdown stops and waits for Continue; Dismiss then files it in Done
    expect(await r.call("agent.autoResumeCancel", { agentId: "a11y" })).toEqual({});
    expect(r.state.agents[key("a11y")]?.autoResume).toMatchObject({ status: "manual", reason: "You asked not to continue it by itself" });
    r.clock.advance(BACK_AFTER_MS);
    expect(r.state.agents[key("a11y")]?.parked?.ended).toBeDefined();
    await r.call("agent.autoResumeCancel", { agentId: "a11y" });
    const filed = r.state.agents[key("a11y")];
    expect([filed?.column, filed?.archived, filed?.parked?.ended, filed?.autoResume]).toEqual(["done", true, undefined, undefined]);

    // soak has no ticket (herdr was down): nothing to continue yet; Mark done files it in Done
    await expect(r.call("agent.autoResumeNow", { agentId: "soak" })).rejects.toMatchObject({ code: "not_found" });
    await r.call("agent.archive", { agentId: "soak", archived: true });
    expect([r.state.agents[key("soak")]?.column, r.state.agents[key("soak")]?.parked?.ended]).toEqual(["done", undefined]);
  });

  test("once herdr runs again an ended card gets its ticket and comes back mid-turn with hostd's note; Continue waits for herdr", async () => {
    const r = rig();
    await r.call("host.herdrRestart", { force: true });
    expect(r.state.agents[key("soak")]?.autoResume).toBeUndefined();
    await expect(r.call("agent.autoResumeNow", { agentId: "invoices" })).rejects.toMatchObject({ code: "rescheduled" });
    expect(r.state.agents[key("invoices")]?.autoResume?.status).toBe("waiting");
    r.clock.advance(6000);
    expect(r.state.agents[key("soak")]?.autoResume).toMatchObject({ status: "waiting", kind: "restart", reason: "herdr stopped" });
    r.clock.advance(HERDR_BACK_MS + 600);
    const heir = resolveSuccessor(r.state.successors, key("soak"));
    expect(heir).toBeDefined();
    r.clock.advance(2000);
    const back = r.state.agents[heir ?? ""];
    expect(back?.column).toBe("running");
    const snap = await r.call<SessionSnapshot>("session.open", { agentId: back?.id });
    const note = snap.items.filter((i) => i.kind === "user").at(-1);
    expect(note).toMatchObject({ author: "TeleFlock" });
    expect(note?.kind === "user" ? note.text : "").toMatch(/^Your previous process ended unexpectedly at \d\d:\d\d \(herdr stopped\)\. /);
    expect(note?.kind === "user" ? note.text : "").toContain("(herdr stopped). Its last action (bash: sleep 30; echo done >> /tmp/c.out) may or may not have run, and handles of background jobs");
    // the waiting ticket Continue left behind brought invoices back too, once herdr ran
    r.clock.advance(15_000);
    expect(resolveSuccessor(r.state.successors, key("invoices"))).toBeDefined();
  });

  test("auto-resume off: once herdr runs again an ended card waits for Continue", async () => {
    const r = rig();
    await r.call("host.autoResumeSet", { enabled: false });
    await r.call("host.herdrRestart", { force: true });
    r.clock.advance(6000);
    expect(r.state.agents[key("soak")]?.autoResume).toMatchObject({ status: "manual", kind: "restart", reason: "Auto-resume is off on this host" });
  });
});
