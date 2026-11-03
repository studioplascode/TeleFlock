import { afterEach, describe, expect, test } from "bun:test";
import type { AppEvent, BrowserConfig, BrowserStatus, SessionSnapshot, ToolItem } from "../gen";
import { agentKey } from "../keys";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import type { DemoBrowserKnob } from "./browser";
import { type DemoBrowserTab, demoAgentTabs, resetDemoAgentTabs } from "./browserTabs";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

/** Engine + manual clock + a store fed through the real reducer; calls get 2 s (a browser start takes 1.2). `browser` plays `?demo&browser=…`. */
function rig(browser: DemoBrowserKnob = null) {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock, browser });
  const events: AppEvent[] = [];
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    events.push(e);
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const call = async <T = BrowserStatus>(hostId: string | null, method: string, params: unknown = {}): Promise<T> => {
    const p = hostId === null ? engine.callApp(method, params) : engine.callHost(hostId, method, params);
    clock.advance(2000);
    return (await p) as T;
  };
  clock.advance(2000);
  const status = () => call(null, "browser.status");
  const agent = (id: string) => state.agents[agentKey("forge", id)];
  return { clock, engine, events, call, status, agent, get state() { return state; } };
}

const ownerOf = (s: BrowserStatus, targetId: string) => s.tabs.find((t) => t.targetId === targetId);

afterEach(() => resetDemoAgentTabs());

describe("demo browser", () => {
  test("runs on the fake browser with quota and ci attached to their tabs, and expenses asking", async () => {
    const r = rig();
    const s = await r.status();
    expect(s).toMatchObject({ state: "running", wsUrl: "demo:browser", downloadDir: "/home/demo/Downloads", cap: 4 });
    expect(s.attachments.map((a) => [a.agentId, a.scope, a.connections])).toEqual([
      ["quota", "session", 1],
      ["ci", "session", 1],
    ]);
    expect(s.tabs.map((t) => [t.targetId, t.agentId, t.detached])).toEqual([
      ["demo-tab-ci", "ci", false],
      ["demo-tab-quota", "quota", false],
    ]);
    expect(s.requests).toHaveLength(1);
    const req = s.requests[0];
    expect(req).toMatchObject({ hostId: "forge", agentId: "expenses", waiting: false });
    // On the board: a needs-you with the browser's options, the request on the card, and who drives whose browser.
    expect(r.agent("expenses")).toMatchObject({ column: "needs", browser: { request: { id: req?.id, reason: req?.reason } } });
    expect(r.agent("expenses")?.needs).toMatchObject({ kind: "confirm", browser: true, requestId: req?.id, question: req?.reason });
    expect(r.agent("expenses")?.needs?.options.map((o) => o.id)).toEqual(["session", "turn", "deny"]);
    expect(r.agent("quota")?.browser?.attached).toMatchObject({ device: "Demo browser", scope: "session" });
    // While they work, attached agents drive their tabs: the status says when they last did.
    r.clock.advance(30_000);
    const later = await r.status();
    expect(later.attachments.some((a) => a.activeAt != null && later.tabs.some((t) => t.agentId === a.agentId && t.activeAt === a.activeAt))).toBe(true);
  });

  test("Allow once through agent.answer: the agent attaches, opens its own tab, goes on, and its turn's end detaches it", async () => {
    const r = rig();
    const requestId = (await r.status()).requests[0]?.id as string;
    const opened: DemoBrowserTab[] = [];
    demoAgentTabs((t) => opened.push(t));
    await r.call("forge", "agent.answer", { agentId: "expenses", requestId, answer: { choices: ["turn"], cancel: false, chat: false } });
    let s = await r.status();
    expect(s.requests).toEqual([]);
    expect(s.attachments.find((a) => a.agentId === "expenses")).toMatchObject({ scope: "turn", agentName: "expenses" });
    expect(r.agent("expenses")).toMatchObject({ column: "running", browser: { attached: { scope: "turn", device: "Demo browser" } } });
    expect(r.agent("expenses")?.needs).toBeUndefined();
    // Its first tab, in a window of its own, is the agent's.
    r.clock.advance(1000);
    expect(opened).toEqual([{ targetId: "demo-tab-expenses-1", url: "https://mail.example.com/inbox", window: 10, owner: { hostId: "forge", agentId: "expenses" } }]);
    s = await r.status();
    expect(ownerOf(s, "demo-tab-expenses-1")).toMatchObject({ agentId: "expenses", lent: false, detached: false });
    // The tool call returned what the bridge says on Allow once.
    const snap = await r.call<SessionSnapshot>("forge", "session.open", { agentId: "expenses" });
    const tool = snap.items.find((i): i is ToolItem & { kind: "tool" } => i.kind === "tool" && i.tool === "use_user_browser");
    expect(tool).toMatchObject({ status: "ok", output: "The user allowed you to use their TeleFlock Browser until this turn ends." });
    // The turn ends: "Allow once" ends with it, the tab stays (detached).
    r.clock.advance(90_000);
    expect(r.agent("expenses")?.column).toBe("review");
    expect(r.agent("expenses")?.browser).toBeUndefined();
    s = await r.status();
    expect(s.attachments.map((a) => a.agentId)).toEqual(["quota", "ci"]);
    expect(ownerOf(s, "demo-tab-expenses-1")?.detached).toBe(true);
  });

  test("Deny tells the agent no; answering again is stale", async () => {
    const r = rig();
    const requestId = (await r.status()).requests[0]?.id as string;
    const s = await r.call(null, "browser.answer", { requestId, allow: false });
    expect(s.requests).toEqual([]);
    expect(s.attachments.map((a) => a.agentId)).toEqual(["quota", "ci"]);
    expect(r.agent("expenses")?.needs).toBeUndefined();
    expect(r.agent("expenses")?.browser).toBeUndefined();
    const snap = await r.call<SessionSnapshot>("forge", "session.open", { agentId: "expenses" });
    const tool = snap.items.find((i): i is ToolItem & { kind: "tool" } => i.kind === "tool" && i.tool === "use_user_browser");
    expect(tool?.output?.startsWith("The user declined")).toBe(true);
    await expect(r.call(null, "browser.answer", { requestId, allow: true })).rejects.toMatchObject({ code: "stale" });
  });

  test("at the cap an allowed request waits; detaching an agent lets it in, and the detached agent's tabs stay", async () => {
    const r = rig();
    const config = await r.call<BrowserConfig>(null, "browser.configSet", { headed: false, cap: 2 });
    expect(config.cap).toBe(2);
    const requestId = (await r.status()).requests[0]?.id as string;
    let s = await r.call(null, "browser.answer", { requestId, allow: true, scope: "session" });
    expect(s.requests[0]).toMatchObject({ id: requestId, waiting: true, scope: "session" });
    expect(r.agent("expenses")?.column).toBe("needs");
    // Attaching another agent at the cap is refused with what to do.
    await expect(r.call(null, "browser.attach", { hostId: "forge", agentId: "kanban" })).rejects.toMatchObject({ code: "browser_busy", message: "2 agents use the browser" });
    await r.call(null, "browser.detach", { hostId: "forge", agentId: "ci" });
    // The oldest waiting request takes the free slot.
    s = await r.status();
    expect(s.attachments.map((a) => a.agentId)).toEqual(["quota", "expenses"]);
    expect(s.requests).toEqual([]);
    expect(r.agent("ci")?.browser).toBeUndefined();
    expect(ownerOf(s, "demo-tab-ci")).toMatchObject({ agentName: "ci", detached: true });
    expect(r.agent("expenses")?.column).toBe("running");
  });

  test("Allow anyway attaches over the cap", async () => {
    const r = rig();
    await r.call<BrowserConfig>(null, "browser.configSet", { cap: 2 });
    const requestId = (await r.status()).requests[0]?.id as string;
    await r.call(null, "browser.answer", { requestId, allow: true });
    const s = await r.call(null, "browser.answer", { requestId, allow: true, scope: "session", overCap: true });
    expect(s.attachments.map((a) => a.agentId)).toEqual(["quota", "ci", "expenses"]);
    expect(s.requests).toEqual([]);
  });

  test("take over and hand back an agent's tab; lend one of the user's and take it back; detaching ends a loan", async () => {
    const r = rig();
    let s = await r.call(null, "browser.takeOver", { targetId: "demo-tab-quota" });
    expect(ownerOf(s, "demo-tab-quota")).toMatchObject({ takenOver: true, lent: false });
    s = await r.call(null, "browser.handBack", { targetId: "demo-tab-quota" });
    expect(ownerOf(s, "demo-tab-quota")?.takenOver).toBe(false);
    s = await r.call(null, "browser.lendTab", { targetId: "demo-tab-mail", hostId: "forge", agentId: "ci" });
    expect(ownerOf(s, "demo-tab-mail")).toMatchObject({ agentId: "ci", lent: true });
    await expect(r.call(null, "browser.lendTab", { targetId: "demo-tab-quota", hostId: "forge", agentId: "ci" })).rejects.toMatchObject({ code: "invalid_params" });
    s = await r.call(null, "browser.takeOver", { targetId: "demo-tab-mail" });
    expect(ownerOf(s, "demo-tab-mail")).toBeUndefined();
    await r.call(null, "browser.lendTab", { targetId: "demo-tab-start", hostId: "forge", agentId: "ci" });
    s = await r.call(null, "browser.detach", { hostId: "forge", agentId: "ci" });
    expect(ownerOf(s, "demo-tab-start")).toBeUndefined();
    await expect(r.call(null, "browser.takeOver", { targetId: "demo-tab-start" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("Let an agent use it from its menu, then stop: its host knows, and a claude agent can't", async () => {
    const r = rig();
    let s = await r.call(null, "browser.attach", { hostId: "forge", agentId: "kanban" });
    expect(s.attachments.find((a) => a.agentId === "kanban")).toMatchObject({ scope: "session", agentName: "kanban" });
    r.clock.advance(300);
    expect(r.agent("kanban")?.browser?.attached).toMatchObject({ device: "Demo browser", scope: "session" });
    s = await r.call(null, "browser.detach", { hostId: "forge", agentId: "kanban" });
    expect(s.attachments.some((a) => a.agentId === "kanban")).toBe(false);
    expect(r.agent("kanban")?.browser).toBeUndefined();
    await expect(r.call(null, "browser.attach", { hostId: "forge", agentId: "copy" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(r.call(null, "browser.attach", { hostId: "nowhere", agentId: "kanban" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("stop detaches every agent; start brings it back without them", async () => {
    const r = rig();
    let s = await r.call(null, "browser.stop");
    expect(s).toMatchObject({ state: "off", attachments: [] });
    expect(s.wsUrl).toBeUndefined();
    expect(r.agent("quota")?.browser).toBeUndefined();
    s = await r.call(null, "browser.start", { headed: true });
    expect(s).toMatchObject({ state: "running", headed: true, wsUrl: "demo:browser", attachments: [] });
  });

  test("settings: the config is replaced as a whole and checked; Chrome for Testing downloads with progress and joins the engines", async () => {
    const r = rig();
    await expect(r.call(null, "browser.configSet", { enginePath: "chrome", cap: 4 })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call(null, "browser.configSet", { cap: 0 })).rejects.toMatchObject({ code: "invalid_params" });
    let config = await r.call<BrowserConfig>(null, "browser.configSet", { enginePath: "/opt/brave.com/brave/brave", headed: true, cap: 6 });
    expect(config).toMatchObject({ enginePath: "/opt/brave.com/brave/brave", headed: true, cap: 6 });
    config = await r.call<BrowserConfig>(null, "browser.configSet", { cap: 3 });
    expect(config).toMatchObject({ headed: false, cap: 3 });
    expect(config.enginePath).toBeUndefined();
    expect(config.download).toEqual({ version: "156.0.7531.40", available: true, installed: false, size: 201_329_937 });
    const p = r.engine.callApp("browser.installEngine", {}) as Promise<BrowserStatus>;
    expect((await p).install).toEqual({ version: "156.0.7531.40" });
    r.clock.advance(1200);
    const progress = (await r.status()).install?.progress ?? 0;
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(100);
    r.clock.advance(6000);
    expect((await r.status()).install).toBeUndefined();
    config = await r.call<BrowserConfig>(null, "browser.config");
    expect(config.download.installed).toBe(true);
    expect(config.engines.map((e) => e.name)).toEqual(["Google Chrome", "Chromium", "Chrome for Testing"]);
  });

  test("browser=blocked: the policy blocks its browsers; Use TeleFlock's browser downloads it (Cancel stops that), chooses it and starts it; a blocked engine chosen again makes way for it", async () => {
    const r = rig("blocked");
    let s = await r.status();
    expect(s).toMatchObject({ state: "error", attachments: [], blocked: { fallback: "offer", engine: { name: "Google Chrome", blocked: true }, download: { installed: false, size: 201_329_937 } } });
    expect(s.wsUrl).toBeUndefined();
    // expenses still asks; allowing it starts the browser, which the policy blocks too.
    const requestId = s.requests[0]?.id as string;
    await expect(r.call(null, "browser.answer", { requestId, allow: true })).rejects.toMatchObject({ code: "browser_blocked" });
    s = await r.status();
    expect(s).toMatchObject({ state: "error", blocked: { fallback: "offer", engine: { name: "Chromium" } } });
    expect(s.requests.map((q) => q.id)).toEqual([requestId]);

    s = await r.call(null, "browser.installEngine", { start: true });
    expect(s.install).toEqual({ version: "156.0.7531.40" });
    r.clock.advance(1200);
    expect((await r.status()).install?.progress).toBeGreaterThan(0);
    s = await r.call(null, "browser.cancelInstall");
    expect(s).toMatchObject({ state: "error", blocked: { fallback: "offer" } });
    expect(s.install).toBeUndefined();

    await r.call(null, "browser.installEngine", { start: true });
    r.clock.advance(8000);
    // The start the download ended in goes on once the clock's timers ran.
    await Promise.resolve();
    s = await r.status();
    expect(s).toMatchObject({ state: "running", wsUrl: "demo:browser", engine: { name: "Chrome for Testing", builtin: true } });
    expect(s.blocked).toBeUndefined();
    let config = await r.call<BrowserConfig>(null, "browser.config");
    expect(config.enginePath).toBe(s.engine?.path);
    expect(config.engines.map((e) => [e.name, e.blocked ?? false])).toEqual([
      ["Google Chrome", true],
      ["Chromium", true],
      ["Chrome for Testing", false],
    ]);
    // Now the request can be allowed.
    s = await r.call(null, "browser.answer", { requestId, allow: true });
    expect(s.attachments.map((a) => a.agentId)).toEqual(["expenses"]);

    await r.call(null, "browser.stop");
    await r.call<BrowserConfig>(null, "browser.configSet", { enginePath: "/usr/bin/google-chrome-stable" });
    s = await r.call(null, "browser.start");
    expect(s).toMatchObject({ state: "running", engine: { builtin: true }, blocked: { fallback: "switched", engine: { name: "Google Chrome" } } });
    expect(s.message).toBeDefined();
    config = await r.call<BrowserConfig>(null, "browser.config");
    expect(config.enginePath).toBe(s.engine?.path);
  });
});
