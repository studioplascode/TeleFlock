import { describe, expect, test } from "bun:test";
import { ManualClock } from "@/core/demo/clock";
import { DemoEngine } from "@/core/demo/engine";
import type { AccountsSnapshot, AuthFlow, TunnelInfo, TunnelListResult } from "@/core/gen";
import { RemoteAuthController, type RemoteAuthDeps, type RemoteAuthHandlers, type RemoteAuthSnapshot, type RemoteAuthStage } from "./remoteAuth";

/** The demo host `forge` online on a manual clock, and a controller wired to it like the app's. */
function rig(over: Partial<RemoteAuthDeps> = {}) {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  clock.advance(5000);
  const calls: { method: string; params: unknown }[] = [];
  const opened: string[] = [];
  const deps: RemoteAuthDeps = {
    hostId: "forge",
    host: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve(engine.callHost("forge", method, params));
    },
    app: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve(engine.callApp(method, params));
    },
    externalOpen: () => true,
    windowOpen: (url) => opened.push(url),
    reach: () => "tunnel",
    autoOpen: false,
    copy: () => Promise.resolve(),
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    sleep: (ms) => new Promise((resolve) => clock.after(ms, resolve)),
    ...over,
  };
  const link = (provider: string) => () => engine.callHost("forge", "accounts.link", { provider }) as Promise<AuthFlow>;
  const make = (handlers: RemoteAuthHandlers) => {
    const ctl = new RemoteAuthController(deps, handlers);
    const stages: RemoteAuthStage[] = [];
    ctl.subscribe(() => {
      const s = ctl.getSnapshot().stage;
      if (stages[stages.length - 1] !== s) stages.push(s);
    });
    return { ctl, stages };
  };
  /** Lets promise chains settle (no real time passes), then moves the demo clock in small steps
   * until `pred` holds. */
  const until = async (ctl: RemoteAuthController, pred: (s: RemoteAuthSnapshot) => boolean, budgetMs = 30_000): Promise<RemoteAuthSnapshot> => {
    for (let spent = 0; ; spent += 100) {
      for (let i = 0; i < 40; i++) await Promise.resolve();
      if (pred(ctl.getSnapshot()) || spent >= budgetMs) return ctl.getSnapshot();
      clock.advance(100);
    }
  };
  /** Awaits `p` while moving the demo clock (host calls answer after a simulated latency). */
  const drive = async <T>(p: Promise<T>): Promise<T> => {
    let settled = false;
    const watched = p.finally(() => (settled = true));
    for (let i = 0; i < 600 && !settled; i++) {
      for (let j = 0; j < 40; j++) await Promise.resolve();
      if (!settled) clock.advance(50);
    }
    return watched;
  };
  const tunnels = async () => ((await drive(engine.callApp("tunnel.list", {}))) as TunnelListResult).tunnels;
  const flowOnHost = async (flowId: string) => (await drive(engine.callHost("forge", "auth.wait", { flowId }))) as AuthFlow;
  return { clock, engine, deps, calls, opened, link, make, until, drive, tunnels, flowOnHost };
}

describe("remote auth", () => {
  test("a browser sign-in forwards its callback port for the flow's lifetime and finishes through it", async () => {
    const r = rig();
    const done: AuthFlow[] = [];
    const { ctl, stages } = r.make({ start: r.link("openai-codex"), onDone: (f) => done.push(f) });
    ctl.retain();
    const ready = await r.until(ctl, (s) => s.tunnel.state === "open");
    expect(ready.stage).toBe("browser");
    expect(ready.paste).toBe("fallback");
    expect(ready.tunnel.port).toBe(1455);
    const [t] = await r.tunnels();
    expect(t).toMatchObject({ hostId: "forge", remotePort: 1455, localPort: 1455 });

    ctl.openUrl();
    expect(r.calls.some((c) => c.method === "app.openExternal")).toBe(true);
    const end = await r.until(ctl, (s) => s.stage === "done");
    expect(end.flow?.account).toBe("you@flock.dev");
    expect(done.length).toBe(1);
    expect(stages).toEqual(["starting", "browser", "done"]);
    // Final: the tunnel it opened is gone.
    await r.until(ctl, () => false, 300);
    expect(await r.tunnels()).toEqual([]);
  });

  test("a busy callback port makes the pasted address primary; a wrong paste is refused where it was made", async () => {
    const r = rig();
    const { ctl } = r.make({ start: r.link("google-gemini-cli") });
    ctl.retain();
    const busy = await r.until(ctl, (s) => s.tunnel.state === "busy");
    expect(busy.tunnel.port).toBe(8085);
    expect(busy.tunnel.message).toContain("8085");
    expect(busy.paste).toBe("primary");
    expect(busy.stage).toBe("paste");

    expect(await r.drive(ctl.submit("http://localhost:1455/auth/callback?code=x"))).toBe(false);
    expect(ctl.getSnapshot().submitError?.code).toBe("invalid_params");
    expect(ctl.getSnapshot().stage).toBe("paste");
    ctl.clearSubmitError();
    expect(ctl.getSnapshot().submitError).toBeNull();

    expect(await r.drive(ctl.submit("http://localhost:8085/oauth2callback?code=abc123&state=s"))).toBe(true);
    expect(ctl.getSnapshot().stage).toBe("working");
    expect((await r.until(ctl, (s) => s.stage === "done")).stage).toBe("done");
  });

  test("closing while the host is still starting cancels the flow it was about to follow", async () => {
    const r = rig();
    let resolveStart: (f: AuthFlow) => void = () => {};
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const pending = new Promise<AuthFlow>((resolve) => (resolveStart = resolve));
    const { ctl } = r.make({ start: () => pending });
    ctl.retain();
    ctl.dispose();
    const flow = (await r.drive(r.engine.callHost("forge", "accounts.link", { provider: "anthropic" }))) as AuthFlow;
    resolveStart(flow);
    await r.until(ctl, () => false, 300);
    expect((await r.flowOnHost(flow.flowId)).state).toBe("cancelled");
  });

  test("cancel closes the tunnel it opened and cancels the flow on the host, reported once the host has it", async () => {
    const r = rig();
    const finals: AuthFlow[] = [];
    const { ctl } = r.make({ start: r.link("anthropic"), onFinal: (f) => finals.push(f) });
    ctl.retain();
    const open = await r.until(ctl, (s) => s.tunnel.state === "open");
    expect(open.tunnel.port).toBe(54545);
    const flowId = open.flow?.flowId ?? "";
    ctl.cancel();
    expect(ctl.getSnapshot().stage).toBe("cancelled");
    expect(finals).toEqual([]);
    await r.until(ctl, () => false, 300);
    expect(finals.map((f) => f.state)).toEqual(["cancelled"]);
    expect(await r.tunnels()).toEqual([]);
    expect((await r.flowOnHost(flowId)).state).toBe("cancelled");
  });

  test("closing mid sign-in reports the cancelled flow once the host has it: a list read then is current", async () => {
    const r = rig();
    let listed: Promise<unknown> | undefined;
    const { ctl } = r.make({ start: r.link("openai-codex"), onFinal: () => (listed = r.engine.callHost("forge", "accounts.list", {})) });
    ctl.retain();
    const open = await r.until(ctl, (s) => s.tunnel.state === "open");
    ctl.dispose();
    expect(listed).toBeUndefined();
    await r.until(ctl, () => false, 300);
    expect(listed).toBeDefined();
    const list = (await r.drive(listed ?? Promise.reject())) as AccountsSnapshot;
    expect(list.flows.find((f) => f.flowId === open.flow?.flowId)?.state).toBe("cancelled");
    expect(await r.tunnels()).toEqual([]);
  });

  test("a same-port tunnel left open by an earlier sign-in is taken over and closed at the end; a preview of the port is left alone", async () => {
    const r = rig();
    const preview = (await r.drive(r.engine.callApp("tunnel.open", { hostId: "forge", port: 1455 }))) as TunnelInfo;
    // A page that reloaded mid sign-in never closed its tunnel.
    const left = (await r.drive(r.engine.callApp("tunnel.open", { hostId: "forge", port: 1455, localPort: 1455 }))) as TunnelInfo;
    expect(preview.localPort).not.toBe(1455);
    const { ctl } = r.make({ start: r.link("openai-codex") });
    ctl.retain();
    await r.until(ctl, (s) => s.tunnel.state === "open");
    expect(r.calls.filter((c) => c.method === "tunnel.open").length).toBe(1);
    expect((await r.tunnels()).map((t) => t.tunnelId)).toEqual([preview.tunnelId, left.tunnelId]);
    ctl.openUrl();
    await r.until(ctl, (s) => s.stage === "done");
    await r.until(ctl, () => false, 300);
    expect(await r.tunnels()).toEqual([preview]);
  });

  test("only an http(s) sign-in page is opened", async () => {
    // The host relays an MCP server's authorization endpoint as is; followed here, the poll never answers.
    const r = rig({ externalOpen: () => false, host: (method) => (method === "auth.wait" ? new Promise(() => {}) : Promise.resolve({})) });
    const page: AuthFlow = { flowId: "auth_x", kind: "mcp", title: "evil", state: "waiting", rev: 2, url: "vscode://evil/run?cmd=x", paste: "none", startedAt: 1, updatedAt: 1 };
    const { ctl } = r.make({ start: () => Promise.resolve(page) });
    ctl.retain();
    await r.until(ctl, (s) => s.stage === "browser");
    ctl.openUrl();
    expect(r.opened).toEqual([]);
    expect(ctl.getSnapshot()).toMatchObject({ opened: false, openError: "its address isn't http or https" });
    expect(r.calls.some((c) => c.method === "app.openExternal")).toBe(false);
    // An https page opens in the browser (inside the click).
    const { ctl: ok } = r.make({ start: () => Promise.resolve({ ...page, flowId: "auth_y", url: "https://auth.example/authorize?x=1" }) });
    ok.retain();
    await r.until(ok, (s) => s.stage === "browser");
    ok.openUrl();
    expect(r.opened).toEqual(["https://auth.example/authorize?x=1"]);
  });

  test("a host on this machine needs no tunnel; a browser elsewhere pastes", async () => {
    const local = rig({ reach: () => "local" });
    const a = local.make({ start: local.link("openai-codex") });
    a.ctl.retain();
    const s = await local.until(a.ctl, (x) => x.stage === "browser");
    expect(s.tunnel).toEqual({ state: "local", port: 1455 });
    expect(s.paste).toBe("fallback");
    expect(local.calls.some((c) => c.method === "tunnel.open")).toBe(false);

    const away = rig({ reach: () => "unreachable" });
    const b = away.make({ start: away.link("openai-codex") });
    b.ctl.retain();
    const p = await away.until(b.ctl, (x) => x.stage !== "starting");
    expect(p.stage).toBe("paste");
    expect(p.tunnel.state).toBe("failed");
    expect(away.calls.some((c) => c.method === "tunnel.open")).toBe(false);
  });

  test("a question that follows the page right away is shown without flashing the browser step", async () => {
    const r = rig();
    const { ctl, stages } = r.make({ start: r.link("deepseek") });
    ctl.retain();
    const asked = await r.until(ctl, (s) => s.stage === "prompt");
    expect(asked.flow?.prompt?.secret).toBe(true);
    expect(stages).toEqual(["starting", "prompt"]);
    expect(await r.drive(ctl.submit("sk-1"))).toBe(false);
    expect(ctl.getSnapshot().submitError?.message).toContain("too short");
    expect(await r.drive(ctl.submit("sk-demo-123456"))).toBe(true);
    expect((await r.until(ctl, (s) => s.stage === "done")).stage).toBe("done");
  });

  test("device codes: the page opens, the host finishes on its own", async () => {
    const r = rig();
    const { ctl } = r.make({ start: r.link("github-copilot") });
    ctl.retain();
    const code = await r.until(ctl, (s) => s.stage === "device");
    expect(code.flow?.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(code.tunnel.state).toBe("none");
    expect(await ctl.copyCode()).toBe(true);
    ctl.openUrl();
    expect((await r.until(ctl, (s) => s.stage === "done")).stage).toBe("done");
  });

  test("auto-open waits for the tunnel, opens once, never for device codes", async () => {
    const r = rig({ autoOpen: true });
    const { ctl } = r.make({ start: r.link("openai-codex") });
    ctl.retain();
    const s = await r.until(ctl, (x) => x.opened);
    expect(s.tunnel.state).toBe("open");
    expect(r.calls.filter((c) => c.method === "app.openExternal").length).toBe(1);
    await r.until(ctl, (x) => x.stage === "done");
    expect(r.calls.filter((c) => c.method === "app.openExternal").length).toBe(1);

    const d = rig({ autoOpen: true });
    const dev = d.make({ start: d.link("github-copilot") });
    dev.ctl.retain();
    await d.until(dev.ctl, (x) => x.stage === "device");
    await d.until(dev.ctl, () => false, 2000);
    expect(dev.ctl.getSnapshot().opened).toBe(false);
  });

  test("a host that drops off is followed again; a flow the host forgot fails with its reason", async () => {
    const r = rig();
    let drop = 0;
    const flaky = rig({
      host: (method, params) => {
        if (method === "auth.wait" && drop > 0) {
          drop -= 1;
          return Promise.reject({ code: "not_connected", message: "forge is offline", retryable: true });
        }
        return Promise.resolve(r.engine.callHost("forge", method, params));
      },
      app: (method, params) => Promise.resolve(r.engine.callApp(method, params)),
      sleep: (ms) => new Promise((resolve) => r.clock.after(ms, resolve)),
    });
    const { ctl } = flaky.make({ start: () => r.engine.callHost("forge", "accounts.link", { provider: "github-copilot" }) as Promise<AuthFlow> });
    drop = 2;
    ctl.retain();
    const back = await r.until(ctl, (s) => s.stage === "device");
    expect(back.reconnecting).toBe(false);

    const gone = rig({ host: (method, params) => (method === "auth.wait" ? Promise.reject({ code: "auth_flow_gone", message: "sign-in `x` is not running on this host", retryable: false }) : Promise.resolve(r.engine.callHost("forge", method, params))) });
    const g = gone.make({ flowId: "x" });
    g.ctl.retain();
    const failed = await gone.until(g.ctl, (s) => s.stage === "failed");
    expect(failed.error?.code).toBe("auth_flow_gone");
    expect(failed.canRetry).toBe(false);
  });

  test("retry starts a new attempt after a cancel", async () => {
    const r = rig();
    const { ctl } = r.make({ start: r.link("github-copilot") });
    ctl.retain();
    const first = await r.until(ctl, (s) => s.stage === "device");
    ctl.cancel();
    ctl.retry();
    const second = await r.until(ctl, (s) => s.stage === "device");
    expect(second.flow?.flowId).not.toBe(first.flow?.flowId);
    expect((await r.flowOnHost(first.flow?.flowId ?? "")).state).toBe("cancelled");
  });
});
