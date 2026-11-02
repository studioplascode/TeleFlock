import { describe, expect, test } from "bun:test";
import type { RefusalFallback, RetryResult, SessionSnapshot } from "../gen";
import { agentKey } from "../keys";
import { lastRefusalRowId } from "../refusal";
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
  const call = async <T = unknown>(method: string, params: unknown = {}, host = "forge"): Promise<T> => {
    const p = engine.callHost(host, method, params);
    clock.advance(400);
    return (await p) as T;
  };
  /** The transcript rows of authbug, the agent Opus refused. */
  const open = async () => (await call<SessionSnapshot>("session.open", { agentId: "authbug" })).items;
  clock.advance(3000);
  return { clock, engine, call, open, get state() { return state; } };
}

const key = (id: string) => agentKey("forge", id);
const rule = (over: Record<string, unknown> = {}) => ({ category: "cyber", from: "anthropic/claude-opus-5", to: "anthropic/claude-sonnet-5", after: "stay", ...over });

describe("demo refusal fallback rules", () => {
  test("none at first; a save is answered as tf-hostd keeps it, and read back", async () => {
    const r = rig();
    expect(await r.call<RefusalFallback>("host.refusalFallback")).toEqual({ rules: [] });
    const saved = await r.call<RefusalFallback>("host.refusalFallbackSet", { rules: [rule({ category: " Cyber ", from: "anthropic/claude-opus-5:high", to: "anthropic/claude-sonnet-5:low" })] });
    expect(saved.rules).toEqual([{ category: "cyber", from: "anthropic/claude-opus-5", to: "anthropic/claude-sonnet-5", thinking: "low", after: "stay" }]);
    expect(await r.call<RefusalFallback>("host.refusalFallback")).toEqual(saved);
  });

  test("a bad list is refused whole, in the host's words, and the old rules stay", async () => {
    const r = rig();
    await r.call("host.refusalFallbackSet", { rules: [rule()] });
    await expect(r.call("host.refusalFallbackSet", { rules: [rule(), rule({ from: "anthropic/claude-sonnet-5" })] })).rejects.toMatchObject({ code: "invalid_params", message: "rule 2: a model cannot fall back to itself" });
    await expect(r.call("host.refusalFallbackSet", { rules: [rule({ to: "claude-sonnet-5" })] })).rejects.toMatchObject({ code: "invalid_params", message: 'rule 1: "to" is a model as provider/id' });
    expect((await r.call<RefusalFallback>("host.refusalFallback")).rules).toEqual([rule()]);
  });

  test("studio-pc plays a tf-hostd before 0.9.0", async () => {
    const r = rig();
    // studio-pc starts offline: trust its key, as the app does on first connect
    let fingerprint: string | undefined;
    for (let i = 0; i < 400 && !fingerprint; i++) {
      r.clock.advance(100);
      fingerprint = r.state.status["studio-pc"]?.hostKey?.fingerprint;
    }
    await r.engine.callApp("hosts.trustKey", { hostId: "studio-pc", fingerprint });
    r.clock.advance(2000);
    await expect(r.call("host.refusalFallback", {}, "studio-pc")).rejects.toMatchObject({ code: "unknown_method" });
    await expect(r.call("agent.refusalRetry", { agentId: "render", model: "anthropic/claude-sonnet-5" }, "studio-pc")).rejects.toMatchObject({ code: "unknown_method" });
  });
});

describe("demo refusal retry", () => {
  test("authbug ended on Opus's cyber refusal, which omp's own retry cannot run again", async () => {
    const r = rig();
    const items = await r.open();
    const refused = items.find((i) => i.id === lastRefusalRowId(items.length, (n) => items[n]));
    expect(refused).toMatchObject({ kind: "assistant", model: "opus-5", refusal: { kind: "refusal", category: "cyber" } });
    expect(r.state.agents[key("authbug")]).toMatchObject({ column: "review" });
    expect(await r.call<RetryResult>("agent.retry", { agentId: "authbug" })).toEqual({ started: false, via: "retry" });
  });

  test("Retry with Sonnet goes on with the same turn on it, behind a notice row, once", async () => {
    const r = rig();
    const before = (await r.open()).length;
    expect(await r.call<RetryResult>("agent.refusalRetry", { agentId: "authbug", model: "anthropic/claude-sonnet-5" })).toEqual({ started: true, via: "retry" });
    // the turn takes ~16 s; the demo's "other device" only prompts an agent that has been idle for 20 s
    r.clock.advance(30_000);
    const items = await r.open();
    // no new prompt: the model row and the notice come right after the refusal, then the turn's own rows
    const added = items.slice(before);
    expect(added.map((i) => i.kind).slice(0, 2)).toEqual(["mode", "notice"]);
    expect(added[1]).toMatchObject({ kind: "notice", level: "warn", source: "refusal", text: "Opus 5 refused (cyber); switched to Sonnet 5 and continued" });
    expect(added.some((i) => i.kind === "user")).toBe(false);
    expect(added.at(-1)).toMatchObject({ kind: "assistant", model: "sonnet-5" });
    expect(r.state.agents[key("authbug")]?.omp?.model).toMatchObject({ id: "claude-sonnet-5" });
    expect(r.state.agents[key("authbug")]).toMatchObject({ column: "review" });
    // it is not the refused turn any more: a second retry has nothing to run
    expect(lastRefusalRowId(items.length, (n) => items[n])).toBeUndefined();
    expect(await r.call<RetryResult>("agent.refusalRetry", { agentId: "authbug", model: "anthropic/claude-opus-5" })).toEqual({ started: false, via: "retry" });
  });

  test("the thinking level asked for is the one it goes on with; the refused turn's is kept otherwise", async () => {
    const r = rig();
    await r.call("agent.refusalRetry", { agentId: "authbug", model: "anthropic/claude-sonnet-5", thinking: "low" });
    expect(r.state.agents[key("authbug")]?.omp?.thinking).toBe("low");
    const kept = rig();
    await kept.call("agent.refusalRetry", { agentId: "authbug", model: "anthropic/claude-sonnet-5" });
    expect(kept.state.agents[key("authbug")]?.omp?.thinking).toBe("high");
  });

  test("a model that is no provider/id, or no model of the host, is refused; a session that wasn't refused has nothing to retry", async () => {
    const r = rig();
    await expect(r.call("agent.refusalRetry", { agentId: "authbug", model: "claude-sonnet-5" })).rejects.toMatchObject({ code: "invalid_params", message: "model must be `provider/id`, got `claude-sonnet-5`" });
    await expect(r.call("agent.refusalRetry", { agentId: "authbug", model: "acme/model-x" })).rejects.toMatchObject({ code: "invalid_params" });
    expect(await r.call<RetryResult>("agent.refusalRetry", { agentId: "hero", model: "anthropic/claude-opus-5" })).toEqual({ started: false, via: "retry" });
    // refused calls changed nothing: authbug is still on Opus and still refused
    expect(r.state.agents[key("authbug")]?.omp?.model).toMatchObject({ id: "claude-opus-5" });
  });
});
