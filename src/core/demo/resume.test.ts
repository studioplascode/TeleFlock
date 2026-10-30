import { describe, expect, test } from "bun:test";
import type { AutoResumeConfig, RetryResult, SessionSnapshot } from "../gen";
import { agentKey } from "../keys";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const call = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
  clock.advance(3000);
  return { clock, call, get state() { return state; } };
}

const key = (id: string) => agentKey("forge", id);

describe("demo resume", () => {
  test("seeded: a failed turn with a failed subagent, a waiting ticket, a manual one", async () => {
    const r = rig();
    expect(r.state.agents[key("bench")]).toMatchObject({ column: "review" });
    expect(r.state.agents[key("bench")]?.autoResume).toBeUndefined();
    const waiting = r.state.agents[key("audit")]?.autoResume;
    expect(waiting).toMatchObject({ status: "waiting", kind: "usageLimit", basis: "window", root: true, attempts: 0 });
    expect(waiting?.subagentIds).toHaveLength(1);
    expect((waiting?.resumeAt ?? 0) - r.clock.now()).toBeGreaterThan(110 * 60_000);
    expect(r.state.agents[key("i18n")]?.autoResume).toMatchObject({ status: "manual", reason: "omp exited while waiting" });
    const snap = await r.call<SessionSnapshot>("session.open", { agentId: "bench" });
    expect(snap.meta.caps).toMatchObject({ retry: true, subagentRetry: true });
    expect(snap.items.at(-1)).toMatchObject({ kind: "assistant", text: "", stopReason: "error" });
    expect(snap.meta.subagents.filter((s) => s.status === "failed").map((s) => s.name)).toEqual(["LoadGen"]);
  });

  test("retry runs a failed turn again without a new user row; then there is nothing to retry", async () => {
    const r = rig();
    const before = await r.call<SessionSnapshot>("session.open", { agentId: "bench" });
    const users = before.items.filter((i) => i.kind === "user").length;
    expect(await r.call<RetryResult>("agent.retry", { agentId: "bench" })).toEqual({ started: true, via: "retry" });
    expect(r.state.agents[key("bench")]?.column).toBe("running");
    expect(await r.call<RetryResult>("agent.retry", { agentId: "bench" })).toEqual({ started: false, via: "retry" });
    r.clock.advance(10_000);
    const after = await r.call<SessionSnapshot>("session.open", { agentId: "bench" });
    expect(after.items.filter((i) => i.kind === "user").length).toBe(users);
    expect(r.state.agents[key("bench")]?.column).toBe("review");
    expect(await r.call<RetryResult>("agent.retry", { agentId: "bench" })).toEqual({ started: false, via: "retry" });
  });

  test("a failed subagent retries alone and finishes; a finished one has nothing to retry", async () => {
    const r = rig();
    const sub = (await r.call<SessionSnapshot>("session.open", { agentId: "bench" })).meta.subagents.find((s) => s.status === "failed");
    expect(await r.call<RetryResult>("agent.retry", { agentId: "bench", subagentId: sub?.id })).toEqual({ started: true, via: "retry" });
    const status = async () => (await r.call<SessionSnapshot>("session.open", { agentId: "bench" })).meta.subagents.find((s) => s.id === sub?.id)?.status;
    expect(await status()).toBe("running");
    r.clock.advance(9000);
    expect(await status()).toBe("done");
    expect(await r.call<RetryResult>("agent.retry", { agentId: "bench", subagentId: sub?.id })).toEqual({ started: false, via: "retry" });
    await expect(r.call("agent.retry", { agentId: "bench", subagentId: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("Resume now: resuming, the agent works again, the ticket clears; cancel drops a ticket", async () => {
    const r = rig();
    expect(await r.call<RetryResult>("agent.autoResumeNow", { agentId: "audit" })).toEqual({ started: true, via: "retry" });
    expect(r.state.agents[key("audit")]?.autoResume?.status).toBe("resuming");
    r.clock.advance(1500);
    expect(r.state.agents[key("audit")]?.column).toBe("running");
    r.clock.advance(4000);
    expect(r.state.agents[key("audit")]?.autoResume).toBeUndefined();
    expect(await r.call("agent.autoResumeCancel", { agentId: "i18n" })).toEqual({});
    expect(r.state.agents[key("i18n")]?.autoResume).toBeUndefined();
    expect(await r.call<RetryResult>("agent.autoResumeNow", { agentId: "i18n" })).toEqual({ started: false, via: "retry" });
  });

  test("plain retry on an agent with a ticket resumes the ticket, like hostd", async () => {
    const r = rig();
    expect(await r.call<RetryResult>("agent.retry", { agentId: "audit" })).toEqual({ started: true, via: "retry" });
    expect(r.state.agents[key("audit")]?.autoResume?.status).toBe("resuming");
  });

  test("host.autoResume is on by default and keeps what is set", async () => {
    const r = rig();
    expect(await r.call<AutoResumeConfig>("host.autoResume")).toEqual({ enabled: true, bringBack: true });
    expect(await r.call<AutoResumeConfig>("host.autoResumeSet", { enabled: false })).toEqual({ enabled: false, bringBack: true });
    expect(await r.call<AutoResumeConfig>("host.autoResumeSet", { bringBack: false })).toEqual({ enabled: false, bringBack: false });
    expect(await r.call<AutoResumeConfig>("host.autoResume")).toEqual({ enabled: false, bringBack: false });
    await expect(r.call("host.autoResumeSet", {})).rejects.toMatchObject({ code: "invalid_params" });
  });
});
