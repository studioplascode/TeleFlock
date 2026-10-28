import { describe, expect, test } from "bun:test";
import type { AccountsSnapshot, AuthFlow, TunnelInfo } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

/** Demo engine on a manual clock, `forge` online. */
function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  clock.advance(5000);
  const call = async <T = unknown>(hostId: string | null, method: string, params: unknown = {}): Promise<T> => {
    const p = hostId === null ? engine.callApp(method, params) : engine.callHost(hostId, method, params);
    clock.advance(400);
    return (await p) as T;
  };
  /** The flow once `pred` holds, polled the way the app does (`auth.wait` long-poll). */
  const until = async (flowId: string, pred: (f: AuthFlow) => boolean, budgetMs = 30_000): Promise<AuthFlow> => {
    let f = await call<AuthFlow>("forge", "auth.wait", { flowId });
    for (let spent = 0; !pred(f) && spent < budgetMs; spent += 1000) {
      const next = engine.callHost("forge", "auth.wait", { flowId, afterRev: f.rev, waitMs: 1000 });
      clock.advance(1000);
      f = (await next) as AuthFlow;
    }
    return f;
  };
  return { clock, engine, call, until };
}

describe("demo accounts", () => {
  test("lists omp's providers and the stored accounts", async () => {
    const r = rig();
    const s = await r.call<AccountsSnapshot>("forge", "accounts.list", {});
    expect(s.providers[0]?.id).toBe("openai-codex");
    expect(s.providers.some((p) => p.id === "anthropic")).toBe(true);
    const claude = s.accounts.filter((a) => a.provider === "anthropic");
    expect(claude[0]?.preferred).toBe(true);
    expect(claude.some((a) => a.disabled && a.disabledReason?.includes("invalid_grant"))).toBe(true);
    expect(s.accounts.some((a) => a.kind === "apiKey" && a.preferBlocked)).toBe(true);
    expect(claude[0]?.windows.length).toBeGreaterThan(0);
  });

  test("a browser link finishes through a same-port tunnel", async () => {
    const r = rig();
    const started = await r.call<AuthFlow>("forge", "accounts.link", { provider: "openai-codex" });
    expect(started.state).toBe("starting");
    const waiting = await r.until(started.flowId, (f) => f.state === "waiting");
    expect(waiting.callbackPort).toBe(1455);
    expect(waiting.paste).toBe("fallback");
    // The same provider again: the running flow.
    expect((await r.call<AuthFlow>("forge", "accounts.link", { provider: "openai-codex" })).flowId).toBe(started.flowId);
    const t = await r.call<TunnelInfo>(null, "tunnel.open", { hostId: "forge", port: 1455, localPort: 1455 });
    expect(t.localPort).toBe(1455);
    await r.call(null, "app.openExternal", { url: waiting.url });
    const done = await r.until(started.flowId, (f) => f.state === "done");
    expect(done.state).toBe("done");
    const s = await r.call<AccountsSnapshot>("forge", "accounts.list", {});
    expect(s.accounts.some((a) => a.provider === "openai-codex" && a.label === done.account)).toBe(true);
  });

  test("a busy device port falls back to the pasted address", async () => {
    const r = rig();
    const started = await r.call<AuthFlow>("forge", "accounts.link", { provider: "google-gemini-cli" });
    const waiting = await r.until(started.flowId, (f) => f.state === "waiting");
    expect(waiting.callbackPort).toBe(8085);
    await expect(r.call(null, "tunnel.open", { hostId: "forge", port: 8085, localPort: 8085 })).rejects.toMatchObject({ code: "port_in_use" });
    await r.call(null, "app.openExternal", { url: waiting.url });
    r.clock.advance(3000);
    expect((await r.call<AuthFlow>("forge", "auth.wait", { flowId: started.flowId })).state).toBe("waiting");
    await expect(r.call("forge", "auth.submit", { flowId: started.flowId, text: "http://localhost:1455/auth/callback?code=x" })).rejects.toMatchObject({ code: "invalid_params" });
    await r.call("forge", "auth.submit", { flowId: started.flowId, text: "http://localhost:8085/oauth2callback?code=abc123&state=s" });
    expect((await r.until(started.flowId, (f) => f.state === "done")).state).toBe("done");
  });

  test("device codes, API keys, cancel, unlink and prefer", async () => {
    const r = rig();
    const dev = await r.call<AuthFlow>("forge", "accounts.link", { provider: "github-copilot" });
    const code = await r.until(dev.flowId, (f) => f.state === "waiting");
    expect(code.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(code.paste).toBe("none");
    await r.call(null, "app.openExternal", { url: code.url });
    expect((await r.until(dev.flowId, (f) => f.state === "done")).state).toBe("done");

    const key = await r.call<AuthFlow>("forge", "accounts.link", { provider: "deepseek" });
    const asked = await r.until(key.flowId, (f) => f.prompt != null);
    expect(asked.prompt?.secret).toBe(true);
    await expect(r.call("forge", "auth.submit", { flowId: key.flowId, text: "sk-1" })).rejects.toMatchObject({ code: "invalid_params" });
    await r.call("forge", "auth.submit", { flowId: key.flowId, text: "sk-demo-123456" });
    expect((await r.until(key.flowId, (f) => f.state === "done")).state).toBe("done");

    const gone = await r.call<AuthFlow>("forge", "accounts.link", { provider: "anthropic" });
    await r.call("forge", "auth.cancel", { flowId: gone.flowId });
    expect((await r.call<AuthFlow>("forge", "auth.wait", { flowId: gone.flowId })).state).toBe("cancelled");

    let s = await r.call<AccountsSnapshot>("forge", "accounts.list", {});
    const team = s.accounts.find((a) => a.label === "team@acme.io");
    expect(team?.preferred).toBe(false);
    s = await r.call<AccountsSnapshot>("forge", "accounts.prefer", { key: team?.key, preferred: true });
    expect(s.accounts.filter((a) => a.provider === "anthropic" && a.preferred).map((a) => a.label)).toEqual(["team@acme.io"]);
    s = await r.call<AccountsSnapshot>("forge", "accounts.unlink", { provider: "anthropic", credentialId: team?.credentialId });
    expect(s.accounts.some((a) => a.label === "team@acme.io")).toBe(false);
    const limits = await r.call<{ accounts: { label: string }[] }>("forge", "host.limits", {});
    expect(limits.accounts.some((a) => a.label === "team@acme.io")).toBe(false);
  });
});
