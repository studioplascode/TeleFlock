import { describe, expect, test } from "bun:test";
import type { Automation, AutomationList, SessionRoleModels, Started } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  engine.subscribe(() => {});
  clock.advance(5000);
  const call = async <T,>(hostId: string, method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost(hostId, method, params);
    clock.advance(400);
    return (await p) as T;
  };
  return { clock, call };
}

describe("demo agent roles", () => {
  test("get/set round trip: the agent's own maps over the host's; a new default switches the model", async () => {
    const r = rig();
    const before = await r.call<SessionRoleModels>("forge", "agent.getRoleModels", { agentId: "push" });
    expect(before.session).toEqual({});
    expect(before.sessionChains).toEqual({});
    expect(before.host).toMatchObject({ default: "anthropic/claude-opus-5:high", smol: "openai-codex/gpt-6-luna:low" });
    expect(before.hostChains).toMatchObject({ "openai-codex/*": ["openai/*"] });
    expect(before.active).toBe("anthropic/claude-opus-5");

    const roleModels = { smol: "openai/gpt-5.5:low", default: "google/gemini-3-pro:high" };
    const fallbackChains = { default: ["openai/gpt-5.5:high", "anthropic/*"], "openai-codex/*": [] };
    const set = await r.call<SessionRoleModels>("forge", "agent.setRoleModels", { agentId: "push", roleModels, fallbackChains });
    expect(set.session).toEqual(roleModels);
    expect(set.sessionChains).toEqual(fallbackChains);
    expect(set.active).toBe("google/gemini-3-pro");
    expect(set.warning).toBeUndefined();
    expect(await r.call<SessionRoleModels>("forge", "agent.getRoleModels", { agentId: "push" })).toEqual(set);

    // Nothing of its own: back on the host's default.
    const back = await r.call<SessionRoleModels>("forge", "agent.setRoleModels", { agentId: "push" });
    expect(back.session).toEqual({});
    expect(back.sessionChains).toEqual({});
    expect(back.active).toBe("anthropic/claude-opus-5");
  });

  test("bad maps are refused, an unknown default model warns, no bridge is unsupported", async () => {
    const r = rig();
    for (const bad of [{ roleModels: { smol: "no-provider" } }, { roleModels: { "9x": "a/b" } }, { fallbackChains: { default: ["a b/c"] } }, { fallbackChains: { "bad key": [] } }]) {
      await expect(r.call("forge", "agent.setRoleModels", { agentId: "push", ...bad })).rejects.toMatchObject({ code: "invalid_params" });
    }
    const warned = await r.call<SessionRoleModels>("forge", "agent.setRoleModels", { agentId: "push", roleModels: { default: "ollama/llama3:8b" } });
    expect(warned.session).toEqual({ default: "ollama/llama3:8b" });
    expect(warned.warning).toContain("ollama/llama3:8b");
    expect(warned.active).toBe("anthropic/claude-opus-5");
    await expect(r.call("forge", "agent.getRoleModels", { agentId: "deps" })).rejects.toMatchObject({ code: "unsupported" });
  });

  test("agent.start takes the agent's own maps; a default role is its main model", async () => {
    const r = rig();
    const spec = { kind: "omp", plan: false, model: "openai/gpt-5.5", roleModels: { default: "google/gemini-3-pro:high", smol: "openai/gpt-5.5:low" }, fallbackChains: { default: ["openai/*"] } };
    const started = await r.call<Started>("forge", "agent.start", { target: { kind: "cwd", cwd: "/home/demo/scratch" }, spec });
    r.clock.advance(2000);
    const got = await r.call<SessionRoleModels>("forge", "agent.getRoleModels", { agentId: started.agentId });
    expect(got.session).toEqual(spec.roleModels);
    expect(got.sessionChains).toEqual(spec.fallbackChains);
    expect(got.active).toBe("google/gemini-3-pro");
    await expect(r.call("forge", "agent.start", { target: { kind: "cwd", cwd: "/home/demo/scratch" }, spec: { kind: "omp", plan: false, roleModels: { smol: "nope" } } })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  test("automations keep the two maps", async () => {
    const r = rig();
    const draft = { name: "Roles", enabled: true, schedule: "0 9 * * 1-5", cwd: "/home/demo/scratch", worktree: false, prompt: "Tidy notes", plan: false, catchUp: false, roleModels: { smol: "openai/gpt-5.5:low" }, fallbackChains: { default: ["anthropic/*"] } };
    const saved = await r.call<Automation>("forge", "automation.save", draft);
    expect(saved).toMatchObject({ roleModels: draft.roleModels, fallbackChains: draft.fallbackChains });
    const list = await r.call<AutomationList>("forge", "automation.list");
    expect(list.automations.find((a) => a.id === saved.id)).toMatchObject({ roleModels: draft.roleModels, fallbackChains: draft.fallbackChains });
    const cleared = await r.call<Automation>("forge", "automation.save", { ...draft, id: saved.id, roleModels: {}, fallbackChains: undefined });
    expect(cleared.roleModels).toBeUndefined();
    expect(cleared.fallbackChains).toBeUndefined();
    await expect(r.call("forge", "automation.save", { ...draft, fallbackChains: { default: ["a b/c"] } })).rejects.toMatchObject({ code: "invalid_params" });
  });
});
