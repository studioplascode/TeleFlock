import { describe, expect, test } from "bun:test";
import type { ActivityPage, AppEvent, AutoAnswer, Started } from "../gen";
import { agentKey } from "../keys";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

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
  return { clock, events, call, get state() { return state; } };
}

const key = (id: string) => agentKey("forge", id);
const MIN = 60_000;

describe("demo decide for me", () => {
  test("seeded: forge's default is on, push counts down from its ★ pick, flags waits for no app", () => {
    const r = rig();
    expect(r.state.hosts.forge?.state.info.autoAnswer).toEqual({ enabled: true, afterSecs: 1200, onlyWhenNoApp: false });
    expect(r.state.hosts["studio-pc"]?.state.info.autoAnswer).toMatchObject({ enabled: false });
    const push = r.state.agents[key("push")];
    expect(push?.autoAnswer).toMatchObject({ source: "host", policy: { enabled: true, afterSecs: 1200 } });
    const cd = push?.autoAnswer?.countdown;
    expect(cd).toMatchObject({ status: "counting", requestId: push?.needs?.requestId, picks: ["ntfy on your tailnet"] });
    // 12:40 left when the demo started (3.4 s ago)
    expect((cd?.deadline ?? 0) - r.clock.now()).toBe(760_000 - 3000);
    const flags = r.state.agents[key("flags")];
    expect(flags?.column).toBe("needs");
    expect(flags?.autoAnswer).toMatchObject({ source: "agent", policy: { enabled: true, afterSecs: 1800, onlyWhenNoApp: true } });
    expect(flags?.autoAnswer?.countdown).toMatchObject({ status: "waitingForNoApp", remainingMs: 25 * MIN, picks: ["Config file in the repo"], requestId: flags?.needs?.requestId });
    // approvals never count down; non-omp agents have no policy
    expect(r.state.agents[key("limits")]?.autoAnswer?.countdown).toBeUndefined();
    expect(Object.values(r.state.agents).filter((a) => a.kind !== "omp" && a.autoAnswer)).toEqual([]);
  });

  test("the deadline picks the ★ option like tf-hostd: Activity and an info notification", async () => {
    const r = rig();
    // a shorter host default applies to the running countdown at once (time already waited counts)
    expect(await r.call<AutoAnswer>("host.autoAnswerSet", { enabled: true, afterSecs: 600, onlyWhenNoApp: false })).toEqual({ enabled: true, afterSecs: 600, onlyWhenNoApp: false });
    expect(r.state.hosts.forge?.state.info.autoAnswer?.afterSecs).toBe(600);
    const deadline = r.state.agents[key("push")]?.autoAnswer?.countdown?.deadline ?? 0;
    expect(deadline - r.clock.now()).toBeLessThan(3 * MIN);
    r.clock.advance(deadline - r.clock.now() + 300);
    const push = r.state.agents[key("push")];
    expect(push?.column).toBe("running");
    expect(push?.needs).toBeUndefined();
    expect(push?.autoAnswer?.countdown).toBeUndefined();
    const page = await r.call<ActivityPage>("host.activity", { agentId: "push", limit: 5 });
    expect(page.events[0]).toMatchObject({ kind: "answered", title: "Auto-answered ★ ntfy on your tailnet" });
    expect(page.events[0]?.detail).toContain("nobody answered within 10 min");
    const notes = r.events.flatMap((e) => (e.type === "notify" && e.notification.agentId === "push" ? [e.notification] : []));
    expect(notes.at(-1)).toMatchObject({ kind: "info", title: "push · decided for you" });
    expect(notes.at(-1)?.body?.startsWith("★ ntfy on your tailnet — ")).toBe(true);
  });

  test("cancel, restart, postpone; errors as the host words them", async () => {
    const r = rig();
    const requestId = r.state.agents[key("push")]?.needs?.requestId as string;
    const cd = () => r.state.agents[key("push")]?.autoAnswer?.countdown;
    await expect(r.call("agent.autoAnswerCancel", { agentId: "push", requestId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await r.call("agent.autoAnswerCancel", { agentId: "push", requestId });
    expect(cd()).toMatchObject({ status: "cancelled", requestId });
    // a cancelled one restarts with what was asked for (each call returns 400 ms later)
    await r.call("agent.autoAnswerPostpone", { agentId: "push", requestId, secs: 600 });
    expect(cd()?.status).toBe("counting");
    expect((cd()?.deadline ?? 0) - r.clock.now()).toBe(600_000 - 400);
    // a running one gets more time, capped at 24 h
    await r.call("agent.autoAnswerPostpone", { agentId: "push", requestId, secs: 3600 });
    expect((cd()?.deadline ?? 0) - r.clock.now()).toBe(600_000 + 3_600_000 - 800);
    await r.call("agent.autoAnswerPostpone", { agentId: "push", requestId, secs: 86_400 });
    expect((cd()?.deadline ?? 0) - r.clock.now()).toBe(86_400_000 - 400);
    await expect(r.call("agent.autoAnswerPostpone", { agentId: "push", requestId, secs: 0 })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("agent.autoAnswerPostpone", { agentId: "push", requestId, secs: 86_401 })).rejects.toMatchObject({ code: "invalid_params" });
    // waiting for no app: the standing clock gets the time too
    const flagsReq = r.state.agents[key("flags")]?.needs?.requestId as string;
    await r.call("agent.autoAnswerPostpone", { agentId: "flags", requestId: flagsReq, secs: 600 });
    expect(r.state.agents[key("flags")]?.autoAnswer?.countdown).toMatchObject({ status: "waitingForNoApp", remainingMs: 35 * MIN });
    // the director leaves questions you cancelled or postponed to you (push's is 24 h away now)
    r.clock.advance(5 * MIN);
    expect(r.state.agents[key("push")]?.needs?.requestId).toBe(requestId);
    expect(r.state.agents[key("flags")]?.needs?.requestId).toBe(flagsReq);
  });

  test("an agent's own policy: off, back to the host default; validation", async () => {
    const r = rig();
    const aa = () => r.state.agents[key("push")]?.autoAnswer;
    await r.call("agent.setAutoAnswer", { agentId: "push", policy: { enabled: false, afterSecs: 1200, onlyWhenNoApp: false } });
    expect(aa()).toEqual({ source: "agent", policy: { enabled: false, afterSecs: 1200, onlyWhenNoApp: false } });
    await r.call("agent.setAutoAnswer", { agentId: "push" });
    expect(aa()).toMatchObject({ source: "host", countdown: { status: "counting" } });
    await r.call("agent.setAutoAnswer", { agentId: "push", policy: { enabled: true, afterSecs: 1200, onlyWhenNoApp: true } });
    expect(aa()).toMatchObject({ source: "agent", countdown: { status: "waitingForNoApp" } });
    await expect(r.call("agent.setAutoAnswer", { agentId: "push", policy: { enabled: true, afterSecs: 30, onlyWhenNoApp: false } })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("agent.setAutoAnswer", { agentId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(r.call("agent.setAutoAnswer", { agentId: "copy" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(r.call("host.autoAnswerSet", { enabled: true, afterSecs: 86_401, onlyWhenNoApp: false })).rejects.toMatchObject({ code: "invalid_params" });
    // host default off: an agent without its own policy has none
    await r.call("host.autoAnswerSet", { enabled: false, afterSecs: 1200, onlyWhenNoApp: false });
    expect(r.state.agents[key("limits")]?.autoAnswer).toBeUndefined();
    expect(r.state.agents[key("flags")]?.autoAnswer?.source).toBe("agent");
  });

  test("a launch spec gives the new agent its own policy; a bad one launches nothing", async () => {
    const r = rig();
    const policy = { enabled: true, afterSecs: 300, onlyWhenNoApp: true };
    const started = await r.call<Started>("agent.start", { target: { kind: "workspace", workspaceId: "w1" }, spec: { kind: "omp", name: "decider", plan: false, autoAnswer: policy } });
    expect(r.state.agents[key(started.agentId as string)]?.autoAnswer).toEqual({ source: "agent", policy });
    await expect(r.call("agent.start", { target: { kind: "workspace", workspaceId: "w1" }, spec: { kind: "omp", name: "nodecider", plan: false, autoAnswer: { enabled: true, afterSecs: 5, onlyWhenNoApp: false } } })).rejects.toMatchObject({ code: "invalid_params" });
    expect(r.state.agents[key("nodecider")]).toBeUndefined();
  });
});
