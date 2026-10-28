import { describe, expect, test } from "bun:test";
import type { AccountLimits, AccountsSnapshot, Agent, AuthFlow, TunnelInfo } from "../gen";
import { DemoAccounts } from "./accounts";
import { DemoAuthFlows } from "./auth";
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

  test("re-linking an expired login stores a fresh credential that reports its windows", async () => {
    const r = rig();
    const before = (await r.call<AccountsSnapshot>("forge", "accounts.list", {})).accounts.find((a) => a.label === "old@flock.dev");
    expect(before?.disabled).toBe(true);
    const started = await r.call<AuthFlow>("forge", "accounts.link", { provider: "anthropic" });
    const waiting = await r.until(started.flowId, (f) => f.state === "waiting");
    expect(new URL(waiting.url ?? "").host).toBe("claude.ai");
    await r.call(null, "tunnel.open", { hostId: "forge", port: 54545, localPort: 54545 });
    await r.call(null, "app.openExternal", { url: waiting.url });
    expect((await r.until(started.flowId, (f) => f.state === "done")).account).toBe("old@flock.dev");
    const s = await r.call<AccountsSnapshot>("forge", "accounts.list", {});
    const old = s.accounts.filter((a) => a.label === "old@flock.dev");
    expect(old).toHaveLength(1);
    expect(old[0]?.disabled).toBe(false);
    expect(old[0]?.credentialId).not.toBe(before?.credentialId);
    expect(r.clock.now() - (old[0]?.linkedAt ?? 0)).toBeLessThan(60_000);
    expect(old[0]?.windows.length).toBeGreaterThan(0);
    expect(old[0]?.windowsError).toBeUndefined();
    const limits = await r.call<AccountLimits>("forge", "host.limits", {});
    const report = limits.accounts.filter((a) => a.label === "old@flock.dev");
    expect(report.map((a) => [a.disabled, a.windows.length > 0])).toEqual([[false, true]]);
  });

  test("sign-in pages are the providers' own", async () => {
    const r = rig();
    const host = async (provider: string) => {
      const f = await r.call<AuthFlow>("forge", "accounts.link", { provider });
      const w = await r.until(f.flowId, (x) => x.state === "waiting");
      await r.call("forge", "auth.cancel", { flowId: f.flowId });
      return w.url ? `${new URL(w.url).host}${new URL(w.url).pathname}` : undefined;
    };
    expect(await host("openai-codex")).toBe("auth.openai.com/oauth/authorize");
    expect(await host("google-gemini-cli")).toBe("accounts.google.com/o/oauth2/v2/auth");
    expect(await host("openai-codex-device")).toBe("auth.openai.com/codex/device");
    expect(await host("github-copilot")).toBe("github.com/login/device");
    expect(await host("deepseek")).toBe("platform.deepseek.com/api_keys");
    // A key prompt without a known key page asks for the key alone.
    expect(await host("litellm")).toBeUndefined();
  });

  test("a browser link counts down omp's 5-minute callback wait, then fails like omp; other links keep the host's limit", async () => {
    const r = rig();
    const started = await r.call<AuthFlow>("forge", "accounts.link", { provider: "anthropic" });
    const waiting = await r.until(started.flowId, (f) => f.state === "waiting");
    const left = (waiting.expiresAt ?? 0) - r.clock.now();
    expect(left).toBeGreaterThan(4 * 60_000 + 50_000);
    expect(left).toBeLessThanOrEqual(5 * 60_000);
    r.clock.advance(left);
    const over = await r.call<AuthFlow>("forge", "auth.wait", { flowId: started.flowId });
    expect(over.state).toBe("failed");
    expect(over.message).toContain("OAuth callback");

    const dev = await r.call<AuthFlow>("forge", "accounts.link", { provider: "github-copilot" });
    const code = await r.until(dev.flowId, (f) => f.state === "waiting");
    expect((code.expiresAt ?? 0) - code.startedAt).toBe(10 * 60_000);
    await r.call("forge", "auth.cancel", { flowId: dev.flowId });
  });
});

describe("demo accounts: live sessions", () => {
  /** DemoAccounts on a manual clock with a settable list of Claude sessions. */
  function sessions() {
    const clock = new ManualClock();
    let agents: Agent[] = [];
    const accounts = new DemoAccounts({ id: "forge", now: () => clock.now(), agents: () => agents, auth: new DemoAuthFlows(clock, () => false) });
    const run = (...ids: string[]) => {
      agents = ids.map((id) => ({ omp: { sessionId: id, model: { provider: "anthropic", id: "claude-opus-5" } } }) as unknown as Agent);
    };
    const on = () => Object.fromEntries(accounts.limits(true).sessions.map((s) => [s.sessionId, s.accountKey?.split("|email:")[1]]));
    const list = () => accounts.call("accounts.list", {}) as AccountsSnapshot;
    return { accounts, run, on, list };
  }

  test("omp spreads the sessions it finds; preferring an account moves none of them", () => {
    const t = sessions();
    t.run("s1", "s2", "s3", "s4");
    const spread = t.on();
    expect(new Set(Object.values(spread))).toEqual(new Set(["you@flock.dev", "team@acme.io|org:acme"]));
    const team = t.list().accounts.find((a) => a.label === "team@acme.io");
    const after = t.accounts.call("accounts.prefer", { key: team?.key, preferred: true }) as AccountsSnapshot;
    expect(t.on()).toEqual(spread);
    expect(after.accounts.find((a) => a.label === "team@acme.io")?.sessions).toBe(Object.values(spread).filter((k) => k === "team@acme.io|org:acme").length);
  });

  test("sessions that start later go to the preferred account; an unlinked account's move on", () => {
    const t = sessions();
    t.run("s1", "s2");
    const spread = t.on();
    const team = t.list().accounts.find((a) => a.label === "team@acme.io");
    t.accounts.call("accounts.prefer", { key: team?.key, preferred: true });
    t.run("s1", "s2", "s3");
    expect(t.on()).toEqual({ ...spread, s3: "team@acme.io|org:acme" });
    t.accounts.call("accounts.unlink", { provider: "anthropic", credentialId: team?.credentialId });
    expect(Object.values(t.on())).toEqual(["you@flock.dev", "you@flock.dev", "you@flock.dev"]);
  });
});
