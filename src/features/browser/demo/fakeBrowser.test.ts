import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_BROWSER_TABS, DEMO_BROWSER_WS, openDemoAgentTab, resetDemoAgentTabs } from "@/core/demo/browserTabs";
import { ManualClock } from "@/core/demo/clock";
import { CdpConnection } from "../cdp/connection";
import type { CdpEvent, CdpEvents, KeyEventParams, MouseButtonName } from "../cdp/protocol";
import { FAVICON_SCRIPT, SELECTION_SCRIPT, cursorScript, elementScript, measureScript } from "../cdp/scripts";
import type { ElementInfo, Measured } from "../observe";
import { configureDemoBrowser, demoAgentStep, demoSocket, resetDemoBrowser } from "./fakeBrowser";
import { type FrameRequest, type PageState, approxMeasure, defaultMemory, findHit, freshState, layoutPage, pageFor } from "./pages";

const EVENTS = [
  "Target.targetCreated",
  "Target.targetInfoChanged",
  "Target.targetDestroyed",
  "Target.detachedFromTarget",
  "Page.screencastFrame",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.loadEventFired",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.fileChooserOpened",
  "Browser.downloadWillBegin",
  "Browser.downloadProgress",
  "Runtime.consoleAPICalled",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Log.entryAdded",
] as const satisfies readonly CdpEvent[];

interface Seen {
  method: CdpEvent;
  params: unknown;
  sessionId?: string;
}

let clock: ManualClock;
let painted: FrameRequest[];

beforeEach(() => {
  resetDemoBrowser();
  clock = new ManualClock();
  painted = [];
  configureDemoBrowser({
    clock,
    measure: approxMeasure,
    paint: async (req) => {
      painted.push(req);
      return "AAAA";
    },
    icon: async (site) => `ICON-${site.host}`,
  });
});

afterEach(() => {
  resetDemoBrowser();
  resetDemoAgentTabs();
});

/**
 * Lets queued answers, events and paints through: the fake answers and paints in microtasks, and a
 * zero-delay task runs only after all of them (its own timers run on the manual clock). Executor
 * form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function client() {
  const conn = await CdpConnection.open(DEMO_BROWSER_WS, { socket: demoSocket });
  const events: Seen[] = [];
  for (const method of EVENTS) conn.on(method, (params, sessionId) => events.push({ method, params, sessionId }));
  return {
    conn,
    events,
    /** The params of every `method` event so far (of one session when given). */
    of<E extends CdpEvent>(method: E, sessionId?: string): CdpEvents[E][] {
      // The fake sends `CdpEvents[E]` for `method`: that is what is under test.
      return events.filter((e) => e.method === method && (sessionId === undefined || e.sessionId === sessionId)).map((e) => e.params as CdpEvents[E]);
    },
    async attach(targetId: string): Promise<string> {
      return (await conn.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    },
    async click(sessionId: string, at: { x: number; y: number }, o: { modifiers?: number; button?: MouseButtonName } = {}): Promise<void> {
      const base = { x: at.x, y: at.y, modifiers: o.modifiers ?? 0, button: o.button ?? "left", clickCount: 1 } as const;
      await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0, clickCount: 0 }, sessionId);
      await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 }, sessionId);
      await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 }, sessionId);
    },
    async key(sessionId: string, p: Partial<KeyEventParams> & { key: string }): Promise<void> {
      await conn.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 0, code: "", windowsVirtualKeyCode: 0, ...p }, sessionId);
    },
    /** What the page shows now (a screenshot through the stub painter). */
    async texts(sessionId: string): Promise<{ texts: string[]; scrollY: number }> {
      await conn.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const req = painted.at(-1);
      return { texts: (req?.scene.items ?? []).flatMap((i) => (i.k === "text" ? [i.text] : [])), scrollY: req?.scrollY ?? -1 };
    },
  };
}

/** The centre of an element in viewport px, laid out as the fake lays it out (scrolled to the top). */
function spot(url: string, id: string, viewport = { width: 1280, height: 800 }, patch: Partial<PageState> = {}): { x: number; y: number } {
  const page = pageFor(url, defaultMemory());
  const hit = findHit(layoutPage(page, { ...freshState(page), ...patch }, viewport, approxMeasure), id);
  if (!hit) throw new Error(`${url} has no ${id}`);
  return { x: hit.rect.x + hit.rect.width / 2, y: hit.rect.y + hit.rect.height / 2 };
}

const TALL = { width: 1280, height: 4000 };

describe("demo fake browser", () => {
  test("a socket opens on a microtask, answers after send returns and closes with 1000", async () => {
    const ws = demoSocket(DEMO_BROWSER_WS);
    const got: unknown[] = [];
    let opened = false;
    let closed: number | undefined;
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)) as unknown);
    ws.onclose = (ev) => {
      closed = ev.code;
    };
    expect(ws.readyState).toBe(0);
    await flush();
    expect(ws.readyState).toBe(1);
    expect(opened).toBe(true);
    ws.send(JSON.stringify({ id: 1, method: "Nope.nothing", params: {} }));
    ws.send(JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "nope", flatten: true } }));
    ws.send(JSON.stringify({ id: 3, method: "Browser.getVersion", params: {} }));
    ws.send(JSON.stringify({ id: 4, method: "Page.enable", params: {}, sessionId: "nope" }));
    expect(got).toHaveLength(0);
    await flush();
    expect(got[0]).toEqual({ id: 1, error: { code: -32601, message: "'Nope.nothing' wasn't found" } });
    expect(got[1]).toMatchObject({ id: 2, error: { code: -32000 } });
    expect(got[2]).toMatchObject({ id: 3, result: { product: "Chrome/156.0.0.0" } });
    expect(got[3]).toMatchObject({ id: 4, error: { code: -32000 }, sessionId: "nope" });
    ws.close();
    expect(ws.readyState).toBe(3);
    await flush();
    expect(closed).toBe(1000);
  });

  test("discovery announces the existing tabs, then the ones that open", async () => {
    const a = await client();
    await a.conn.send("Target.setDiscoverTargets", { discover: true });
    const created = a.of("Target.targetCreated").map((e) => e.targetInfo);
    expect(created.map((i) => [i.targetId, i.url])).toEqual(DEMO_BROWSER_TABS.map((t) => [t.targetId, t.url]));
    expect(created[0]).toMatchObject({ type: "page", title: "New Tab", attached: false, browserContextId: "demo-context" });
    expect(created[1]?.title).toBe("Inbox (3) – Example Mail");
    const { targetInfos } = await a.conn.send("Target.getTargets", {});
    expect(targetInfos.map((i) => i.targetId)).toEqual(DEMO_BROWSER_TABS.map((t) => t.targetId));
    const version = await a.conn.send("Browser.getVersion", {});
    expect(version.userAgent.endsWith("TeleFlockDemo")).toBe(true);
    const { targetId } = await a.conn.send("Target.createTarget", { url: "https://ci.example.com/runs", newWindow: true });
    expect(a.of("Target.targetCreated").at(-1)?.targetInfo).toMatchObject({ targetId, url: "https://ci.example.com/runs", title: "Runs · Example CI" });
  });

  test("tabs agents open (the demo backend) appear in their own windows, also the ones opened before the fake started", async () => {
    openDemoAgentTab({ targetId: "agent-early", url: "https://docs.example.com/guide", window: 10, owner: { hostId: "forge", agentId: "a" } });
    const a = await client();
    await a.conn.send("Target.setDiscoverTargets", { discover: true });
    expect(a.of("Target.targetCreated").map((e) => e.targetInfo.targetId)).toEqual([...DEMO_BROWSER_TABS.map((t) => t.targetId), "agent-early"]);
    openDemoAgentTab({ targetId: "agent-late", url: "https://mail.example.com/inbox", window: 11, owner: { hostId: "forge", agentId: "b" } });
    expect(a.of("Target.targetCreated").at(-1)?.targetInfo).toMatchObject({ targetId: "agent-late", title: "Inbox (3) – Example Mail" });
    // Each is the shown tab of its window: its screencast runs while the user's window shows another tab.
    const s = await a.attach("agent-late");
    await a.conn.send("Page.startScreencast", { format: "jpeg", quality: 70 }, s);
    await flush();
    expect(a.of("Page.screencastFrame", s)).toHaveLength(1);
  });

  test("a session's events go only to the client that attached it", async () => {
    const a = await client();
    const b = await client();
    await b.conn.send("Target.setDiscoverTargets", { discover: true });
    const sa = await a.attach("demo-tab-start");
    const sb = await b.attach("demo-tab-mail");
    expect(sa).not.toBe(sb);
    await expect(b.conn.send("Page.navigate", { url: "https://docs.example.com/guide" }, sa)).rejects.toMatchObject({ code: -32000 });
    await a.conn.send("Page.navigate", { url: "https://docs.example.com/guide" }, sa);
    clock.advance(400);
    expect(a.of("Page.frameNavigated", sa)).toHaveLength(1);
    expect(b.events.filter((e) => e.sessionId === sa || e.method.startsWith("Page."))).toEqual([]);
    // Discovery events go to every client that turned discovery on, and only to those.
    expect(b.of("Target.targetInfoChanged").map((e) => e.targetInfo.url)).toEqual(["https://docs.example.com/guide"]);
    expect(a.of("Target.targetInfoChanged")).toHaveLength(0);
  });

  test("navigate loads the page: frameNavigated, targetInfoChanged and history", async () => {
    const a = await client();
    await a.conn.send("Target.setDiscoverTargets", { discover: true });
    const s = await a.attach("demo-tab-start");
    const { frameId } = await a.conn.send("Page.navigate", { url: "https://docs.example.com/guide" }, s);
    expect(frameId).toBe("demo-tab-start");
    expect(a.of("Page.frameStartedLoading", s)).toEqual([{ frameId }]);
    clock.advance(300);
    expect(a.of("Page.frameNavigated", s)).toHaveLength(0);
    clock.advance(50);
    expect(a.events.filter((e) => e.method !== "Target.targetCreated").map((e) => e.method)).toEqual([
      "Page.frameStartedLoading",
      "Page.frameNavigated",
      "Target.targetInfoChanged",
      "Page.loadEventFired",
      "Page.frameStoppedLoading",
    ]);
    expect(a.of("Page.frameNavigated", s)[0]?.frame).toMatchObject({ id: frameId, url: "https://docs.example.com/guide" });
    expect(a.of("Target.targetInfoChanged")[0]?.targetInfo).toMatchObject({ targetId: frameId, url: "https://docs.example.com/guide", title: "Guide · Example Docs" });

    await a.conn.send("Page.navigate", { url: "https://docs.example.com/guide#deploy" }, s);
    expect(a.of("Page.navigatedWithinDocument", s)).toEqual([{ frameId, url: "https://docs.example.com/guide#deploy" }]);
    expect(a.of("Page.frameStartedLoading", s)).toHaveLength(1);
    expect((await a.texts(s)).scrollY).toBeGreaterThan(0);
    const h = await a.conn.send("Page.getNavigationHistory", {}, s);
    expect(h.currentIndex).toBe(2);
    expect(h.entries.map((e) => [e.url, e.transitionType])).toEqual([
      ["https://start.teleflock.demo/", "typed"],
      ["https://docs.example.com/guide", "typed"],
      ["https://docs.example.com/guide#deploy", "typed"],
    ]);

    await a.conn.send("Page.navigateToHistoryEntry", { entryId: h.entries[0]?.id ?? -1 }, s);
    clock.advance(350);
    expect((await a.conn.send("Page.getNavigationHistory", {}, s)).currentIndex).toBe(0);
    expect(a.of("Target.targetInfoChanged").at(-1)?.targetInfo).toMatchObject({ url: "https://start.teleflock.demo/", title: "New Tab" });

    await a.conn.send("Page.reload", {}, s);
    clock.advance(350);
    expect(a.of("Page.loadEventFired", s)).toHaveLength(3);
    expect((await a.conn.send("Page.getNavigationHistory", {}, s)).entries[0]?.transitionType).toBe("reload");

    await a.conn.send("Page.navigate", { url: "https://nowhere.invalid/" }, s);
    clock.advance(350);
    expect(a.of("Target.targetInfoChanged").at(-1)?.targetInfo).toMatchObject({ url: "https://nowhere.invalid/", title: "nowhere.invalid" });
    expect((await a.texts(s)).texts).toContain("This site can’t be reached");
  });

  test("a navigation is a Document request for sessions that watch the network: 200, the 404 of a missing page, Chrome's network error", async () => {
    const a = await client();
    const s = await a.attach("demo-tab-start");
    await a.conn.send("Network.enable", {}, s);
    await a.conn.send("Log.enable", {}, s);
    for (const url of ["https://docs.example.com/guide", "https://docs.example.com/nope", "http://localhost:3000/checkout", "https://nowhere.invalid/"]) {
      await a.conn.send("Page.navigate", { url }, s);
      clock.advance(350);
    }
    expect(a.of("Network.requestWillBeSent", s).map((e) => [e.request.method, e.request.url, e.type])).toEqual([
      ["GET", "https://docs.example.com/guide", "Document"],
      ["GET", "https://docs.example.com/nope", "Document"],
      ["GET", "http://localhost:3000/checkout", "Document"],
      ["GET", "https://nowhere.invalid/", "Document"],
    ]);
    const answered = a.of("Network.responseReceived", s);
    expect(answered.map((e) => [e.response.url, e.response.status, e.type])).toEqual([
      ["https://docs.example.com/guide", 200, "Document"],
      ["https://docs.example.com/nope", 404, "Document"],
    ]);
    expect(a.of("Network.loadingFinished", s)).toHaveLength(2);
    expect((await a.conn.send("Network.getResponseBody", { requestId: answered[1]?.requestId ?? "" }, s)).body).toContain("404");
    expect(a.of("Network.loadingFailed", s).map((e) => [e.errorText, e.type])).toEqual([
      ["net::ERR_CONNECTION_REFUSED", "Document"],
      ["net::ERR_NAME_NOT_RESOLVED", "Document"],
    ]);
    expect(a.of("Log.entryAdded", s).map((e) => [e.entry.level, e.entry.text, e.entry.url])).toEqual([
      ["error", "Failed to load resource: the server responded with a status of 404 (Not Found)", "https://docs.example.com/nope"],
      ["error", "Failed to load resource: net::ERR_CONNECTION_REFUSED", "http://localhost:3000/checkout"],
      ["error", "Failed to load resource: net::ERR_NAME_NOT_RESOLVED", "https://nowhere.invalid/"],
    ]);
    // A navigation within the document is no request.
    await a.conn.send("Page.navigate", { url: "https://nowhere.invalid/#top" }, s);
    expect(a.of("Network.requestWillBeSent", s)).toHaveLength(4);
  });

  test("screencast: no second frame before the ack, none while hidden, a fresh one when shown", async () => {
    const a = await client();
    const start = await a.attach("demo-tab-start");
    const mail = await a.attach("demo-tab-mail");
    const frames = (s: string) => a.of("Page.screencastFrame", s);
    const move = (s: string, at: { x: number; y: number }) => a.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, modifiers: 0, button: "none", buttons: 0, clickCount: 0 }, s);
    await a.conn.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1000, maxHeight: 1000 }, start);
    await a.conn.send("Page.startScreencast", { format: "jpeg", quality: 70 }, mail);
    await flush();
    expect(frames(start)).toHaveLength(1);
    expect(frames(mail)).toHaveLength(0);
    expect(frames(start)[0]).toMatchObject({ data: "AAAA", sessionId: 1, metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 800, scrollOffsetX: 0, scrollOffsetY: 0 } });
    expect(painted.at(-1)).toMatchObject({ pixelWidth: 1000, pixelHeight: 625, format: "jpeg", quality: 70 });

    await move(start, spot("https://start.teleflock.demo/", "tile-docs"));
    await flush();
    expect(frames(start)).toHaveLength(1);
    await a.conn.send("Page.screencastFrameAck", { sessionId: 1 }, start);
    await flush();
    expect(frames(start).map((f) => f.sessionId)).toEqual([1, 2]);
    await a.conn.send("Page.screencastFrameAck", { sessionId: 2 }, start);
    await flush();
    expect(frames(start)).toHaveLength(2);

    await a.conn.send("Target.activateTarget", { targetId: "demo-tab-mail" });
    await flush();
    expect(frames(mail)).toHaveLength(1);
    await move(start, { x: 4, y: 4 });
    await flush();
    expect(frames(start)).toHaveLength(2);
    await a.conn.send("Target.activateTarget", { targetId: "demo-tab-start" });
    await flush();
    expect(frames(start).map((f) => f.sessionId)).toEqual([1, 2, 3]);

    await a.conn.send("Page.screencastFrameAck", { sessionId: 3 }, start);
    await a.conn.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false }, start);
    await flush();
    expect(frames(start).at(-1)?.metadata).toMatchObject({ deviceWidth: 800, deviceHeight: 600 });
    expect(painted.at(-1)).toMatchObject({ pixelWidth: 1000, pixelHeight: 750 });
    await a.conn.send("Page.screencastFrameAck", { sessionId: 4 }, start);
    await a.conn.send("Emulation.clearDeviceMetricsOverride", {}, start);
    await flush();
    expect(frames(start).at(-1)?.metadata).toMatchObject({ deviceWidth: 1280, deviceHeight: 800 });
    await a.conn.send("Page.stopScreencast", {}, start);
    await a.conn.send("Page.screencastFrameAck", { sessionId: 5 }, start);
    await move(start, spot("https://start.teleflock.demo/", "tile-mail"));
    await flush();
    expect(frames(start)).toHaveLength(5);
  });

  test("Ctrl+click opens a background tab, a target=_blank link a foreground one, both with their opener", async () => {
    const a = await client();
    await a.conn.send("Target.setDiscoverTargets", { discover: true });
    const start = await a.attach("demo-tab-start");
    await a.click(start, spot("https://start.teleflock.demo/", "tile-docs"), { modifiers: 2 });
    const bg = a.of("Target.targetCreated").at(-1)?.targetInfo;
    expect(bg).toMatchObject({ url: "https://docs.example.com/guide", title: "Guide · Example Docs", openerId: "demo-tab-start" });
    expect(a.of("Page.frameStartedLoading", start)).toHaveLength(0);
    const guide = bg?.targetId ?? "";
    const gs = await a.attach(guide);
    await a.conn.send("Page.startScreencast", { format: "jpeg" }, gs);
    await flush();
    expect(a.of("Page.screencastFrame", gs)).toHaveLength(0);

    await a.click(start, spot("https://start.teleflock.demo/", "tile-ci"), { button: "middle" });
    expect(a.of("Target.targetCreated").at(-1)?.targetInfo).toMatchObject({ url: "https://ci.example.com/runs", openerId: "demo-tab-start" });

    await a.conn.send("Target.activateTarget", { targetId: guide });
    await flush();
    expect(a.of("Page.screencastFrame", gs)).toHaveLength(1);
    await a.conn.send("Emulation.setDeviceMetricsOverride", { ...TALL, deviceScaleFactor: 1, mobile: false }, gs);
    await a.click(gs, spot("https://docs.example.com/guide", "api-reference", TALL));
    const fg = a.of("Target.targetCreated").at(-1)?.targetInfo;
    expect(fg).toMatchObject({ url: "https://docs.example.com/api", openerId: guide });
    expect(a.of("Page.frameStartedLoading", gs)).toHaveLength(0);
    const fs = await a.attach(fg?.targetId ?? "");
    await a.conn.send("Page.startScreencast", { format: "jpeg" }, fs);
    await flush();
    expect(a.of("Page.screencastFrame", fs)).toHaveLength(1);
  });

  test("typing into a form (keyDown text, insertText, Backspace, select all) and Enter submit the values", async () => {
    const a = await client();
    await a.conn.send("Target.setDiscoverTargets", { discover: true });
    const { targetId } = await a.conn.send("Target.createTarget", { url: "https://mail.example.com/" });
    const s = await a.attach(targetId);
    const type = async (text: string) => {
      for (const ch of text) await a.key(s, { type: "keyDown", key: ch, text: ch });
    };
    const selectAll = () => a.key(s, { key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    const evaluate = async (expression: string) => (await a.conn.send("Runtime.evaluate", { expression, returnByValue: true }, s)).result.value;

    await a.click(s, spot("https://mail.example.com/", "email"));
    await type("grac");
    await a.conn.send("Input.insertText", { text: "e@example.org" }, s);
    for (let i = 0; i < 3; i++) await a.key(s, { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await a.conn.send("Input.insertText", { text: "com" }, s);
    expect(await evaluate(SELECTION_SCRIPT)).toBe("");
    await selectAll();
    expect(await evaluate(SELECTION_SCRIPT)).toBe("grace@example.com");
    await type("x");
    await selectAll();
    expect(await evaluate(SELECTION_SCRIPT)).toBe("x");
    await a.conn.send("Input.insertText", { text: "grace@example.com" }, s);

    await a.key(s, { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await a.conn.send("Input.insertText", { text: "hunter2" }, s);
    await selectAll();
    expect(await evaluate(SELECTION_SCRIPT)).toBe("");
    expect(await evaluate(elementScript())).toMatchObject({ tag: "input", type: "password", name: "password", sensitive: true });
    const shown = await a.texts(s);
    expect(shown.texts).toContain("•••••••");
    expect(shown.texts).not.toContain("hunter2");

    await a.key(s, { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    clock.advance(350);
    expect(a.of("Target.targetInfoChanged").at(-1)?.targetInfo).toMatchObject({ targetId, url: "https://mail.example.com/inbox", title: "Inbox (3) – Example Mail" });
    expect((await a.conn.send("Page.getNavigationHistory", {}, s)).entries.at(-1)).toMatchObject({ url: "https://mail.example.com/inbox", transitionType: "form_submit" });
    expect((await a.texts(s)).texts).toContain("3 unread · Signed in as grace@example.com");

    const start = await a.attach("demo-tab-start");
    await a.click(start, spot("https://start.teleflock.demo/", "q"));
    await a.conn.send("Input.insertText", { text: "flock " }, start);
    await a.conn.send("Input.imeSetComposition", { text: "de", selectionStart: 2, selectionEnd: 2 }, start);
    await a.conn.send("Input.imeSetComposition", { text: "dem", selectionStart: 3, selectionEnd: 3 }, start);
    expect((await a.texts(start)).texts).toContain("flock dem");
    await a.conn.send("Input.insertText", { text: "demo" }, start);
    await a.key(start, { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    clock.advance(350);
    expect(a.of("Target.targetInfoChanged").at(-1)?.targetInfo).toMatchObject({ targetId: "demo-tab-start", url: "https://search.teleflock.demo/?q=flock%20demo", title: "flock demo - TeleFlock Search" });
  });

  test("a dialog blocks the page until handled; handling without one fails", async () => {
    const a = await client();
    const s = await a.attach("demo-tab-quota");
    await expect(a.conn.send("Page.handleJavaScriptDialog", { accept: true }, s)).rejects.toMatchObject({ code: -32000 });
    await a.click(s, spot("https://dashboard.example.com/billing", "restart-gateway"));
    expect(a.of("Page.javascriptDialogOpening", s)).toEqual([{ url: "https://dashboard.example.com/billing", message: "Restart api-gateway now? Requests in flight will be retried.", type: "confirm" }]);
    await a.conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, modifiers: 0, button: "none", buttons: 0, clickCount: 0, deltaX: 0, deltaY: 400 }, s);
    expect((await a.texts(s)).scrollY).toBe(0);
    await a.conn.send("Page.handleJavaScriptDialog", { accept: true }, s);
    expect(a.of("Page.javascriptDialogClosed", s)).toEqual([{ result: true, userInput: "" }]);
    expect((await a.texts(s)).texts.some((t) => t.startsWith("api-gateway is restarting"))).toBe(true);
    await a.conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, modifiers: 0, button: "none", buttons: 0, clickCount: 0, deltaX: 0, deltaY: 400 }, s);
    expect((await a.texts(s)).scrollY).toBe(400);

    const { targetId } = await a.conn.send("Target.createTarget", { url: "https://docs.example.com/guide" });
    const g = await a.attach(targetId);
    await a.conn.send("Emulation.setDeviceMetricsOverride", { ...TALL, deviceScaleFactor: 1, mobile: false }, g);
    await a.click(g, spot("https://docs.example.com/guide", "ask", TALL));
    expect(a.of("Page.javascriptDialogOpening", g)).toEqual([{ url: "https://docs.example.com/guide", message: "Your question", type: "prompt", defaultPrompt: "" }]);
    await a.conn.send("Page.handleJavaScriptDialog", { accept: true, promptText: "How do I roll back?" }, g);
    expect(a.of("Page.javascriptDialogClosed", g)).toEqual([{ result: true, userInput: "How do I roll back?" }]);
    expect((await a.texts(g)).texts).toContain("Thanks, we got: How do I roll back?");
  });

  test("file chooser: reported only when intercepted; setFileInputFiles lists the base names; upload", async () => {
    const a = await client();
    const url = "https://shop.example.com/upload";
    const { targetId } = await a.conn.send("Target.createTarget", { url });
    const s = await a.attach(targetId);
    await a.conn.send("Network.enable", {}, s);
    await a.click(s, spot(url, "invoices"));
    expect(a.of("Page.fileChooserOpened", s)).toHaveLength(0);
    await a.conn.send("Page.setInterceptFileChooserDialog", { enabled: true }, s);
    await a.click(s, spot(url, "invoices"));
    expect(a.of("Page.fileChooserOpened", s)).toEqual([{ frameId: targetId, mode: "selectMultiple", backendNodeId: 42 }]);
    await a.conn.send("DOM.setFileInputFiles", { files: ["/x/y/invoice.pdf", "C:\\scans\\receipt-0142.png"], backendNodeId: 42 }, s);
    const shown = (await a.texts(s)).texts;
    expect(shown).toContain("invoice.pdf");
    expect(shown).toContain("receipt-0142.png");
    await a.click(s, spot(url, "upload", undefined, { files: { invoices: ["invoice.pdf", "receipt-0142.png"] } }));
    expect((await a.texts(s)).texts).toContain("2 files uploaded");
    expect(a.of("Network.responseReceived", s).map((e) => e.response.status)).toEqual([201]);
  });

  test("an upload without files fails like a real page: a 500, a console error", async () => {
    const a = await client();
    const url = "https://shop.example.com/upload";
    const { targetId } = await a.conn.send("Target.createTarget", { url });
    const s = await a.attach(targetId);
    await a.conn.send("Network.enable", {}, s);
    await a.conn.send("Runtime.enable", {}, s);
    await a.click(s, spot(url, "upload"));
    const failed = a.of("Network.responseReceived", s);
    expect(failed.map((e) => [e.response.url, e.response.status])).toEqual([["https://shop.example.com/api/invoices", 500]]);
    const body = await a.conn.send("Network.getResponseBody", { requestId: failed[0]?.requestId ?? "" }, s);
    expect(body.body).toContain("internal_error");
    expect(a.of("Runtime.consoleAPICalled", s).map((e) => e.type)).toEqual(["error"]);
  });

  test("a download reports its progress and lands in the download folder; cancel and deny", async () => {
    const a = await client();
    await a.conn.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/tf-downloads", eventsEnabled: true });
    const s = await a.attach("demo-tab-quota");
    const exportCsv = spot("https://dashboard.example.com/billing", "export-csv");
    await a.click(s, exportCsv);
    const begin = a.of("Browser.downloadWillBegin");
    expect(begin).toHaveLength(1);
    expect(begin[0]).toMatchObject({ frameId: "demo-tab-quota", url: "https://dashboard.example.com/billing/usage-2026-10.csv", suggestedFilename: "usage-2026-10.csv" });
    const guid = begin[0]?.guid ?? "";
    clock.advance(2250);
    const progress = a.of("Browser.downloadProgress");
    expect(progress).toHaveLength(10);
    expect(progress.every((p) => p.guid === guid && p.state === "inProgress" && p.totalBytes === 188_416)).toBe(true);
    expect(progress.map((p) => p.receivedBytes)).toEqual([...progress.map((p) => p.receivedBytes)].sort((x, y) => x - y));
    clock.advance(250);
    expect(a.of("Browser.downloadProgress").at(-1)).toEqual({ guid, totalBytes: 188_416, receivedBytes: 188_416, state: "completed", filePath: "/tmp/tf-downloads/usage-2026-10.csv" });

    await a.click(s, exportCsv);
    const second = a.of("Browser.downloadWillBegin")[1]?.guid ?? "";
    clock.advance(500);
    await a.conn.send("Browser.cancelDownload", { guid: second });
    clock.advance(5000);
    expect(a.of("Browser.downloadProgress").filter((p) => p.guid === second).at(-1)?.state).toBe("canceled");

    await a.conn.send("Browser.setDownloadBehavior", { behavior: "deny" });
    await a.click(s, exportCsv);
    clock.advance(3000);
    expect(a.of("Browser.downloadWillBegin")).toHaveLength(2);
  });

  test("closeTarget destroys the tab, detaches its sessions and shows the window's next tab", async () => {
    const a = await client();
    const b = await client();
    await b.conn.send("Target.setDiscoverTargets", { discover: true });
    const start = await a.attach("demo-tab-start");
    const mail = await a.attach("demo-tab-mail");
    await a.conn.send("Page.startScreencast", { format: "jpeg" }, start);
    await flush();
    await a.conn.send("Page.screencastFrameAck", { sessionId: 1 }, start);
    await a.conn.send("Target.activateTarget", { targetId: "demo-tab-mail" });
    await expect(a.conn.send("Target.closeTarget", { targetId: "nope" })).rejects.toMatchObject({ code: -32000 });
    expect(await a.conn.send("Target.closeTarget", { targetId: "demo-tab-mail" })).toEqual({ success: true });
    expect(b.of("Target.targetDestroyed")).toEqual([{ targetId: "demo-tab-mail" }]);
    expect(a.of("Target.detachedFromTarget")).toEqual([{ sessionId: mail, targetId: "demo-tab-mail" }]);
    expect(b.of("Target.detachedFromTarget")).toHaveLength(0);
    await expect(a.conn.send("Page.reload", {}, mail)).rejects.toMatchObject({ code: -32000 });
    expect((await a.conn.send("Target.getTargets", {})).targetInfos.map((t) => t.targetId)).not.toContain("demo-tab-mail");
    await flush();
    expect(a.of("Page.screencastFrame", start).map((f) => f.sessionId)).toEqual([1, 2]);
  });

  test("the panel's scripts: favicon and its icon, cursor, element, measure", async () => {
    const a = await client();
    const s = await a.attach("demo-tab-start");
    const evaluate = async (expression: string) => (await a.conn.send("Runtime.evaluate", { expression, returnByValue: true }, s)).result;
    expect(await evaluate(FAVICON_SCRIPT)).toEqual({ type: "string", value: "https://start.teleflock.demo/favicon.png" });
    const options = { disableCache: false, includeCredentials: false };
    const { resource } = await a.conn.send("Network.loadNetworkResource", { frameId: "demo-tab-start", url: "https://start.teleflock.demo/favicon.png", options }, s);
    expect(resource).toMatchObject({ success: true, httpStatusCode: 200 });
    expect(await a.conn.send("IO.read", { handle: resource.stream ?? "" }, s)).toEqual({ base64Encoded: true, data: "ICON-start.teleflock.demo", eof: true });
    await a.conn.send("IO.close", { handle: resource.stream ?? "" }, s);
    expect((await a.conn.send("Network.loadNetworkResource", { frameId: "demo-tab-start", url: "https://start.teleflock.demo/logo.svg", options }, s)).resource).toMatchObject({ success: false, httpStatusCode: 404 });

    const tile = spot("https://start.teleflock.demo/", "tile-mail");
    const field = spot("https://start.teleflock.demo/", "q");
    expect((await evaluate(cursorScript(tile.x, tile.y))).value).toBe("pointer");
    expect((await evaluate(cursorScript(field.x, field.y))).value).toBe("text");
    expect((await evaluate(cursorScript(3, 700))).value).toBe("default");
    // The fake answers the element and measure scripts with what they return: that is what is under test.
    expect((await evaluate(elementScript(tile))).value).toMatchObject({ tag: "a", label: "Mail", textLabel: true, href: "https://mail.example.com/", sensitive: false });
    // Where the viewport shows it (here a short one the page scrolls in), measured again by its ref after a scroll, gone after a navigation.
    const short = { width: 1280, height: 300 };
    await a.conn.send("Emulation.setDeviceMetricsOverride", { ...short, deviceScaleFactor: 1, mobile: false }, s);
    const at = spot("https://start.teleflock.demo/", "tile-mail", short);
    const mail = (await evaluate(elementScript(at))).value as ElementInfo;
    expect(mail).toMatchObject({ tag: "a", label: "Mail", scroll: { x: 0, y: 0 } });
    const rect = mail.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    expect([rect.x + rect.width / 2, rect.y + rect.height / 2]).toEqual([at.x, at.y]);
    await a.conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: 100, modifiers: 0, button: "none", buttons: 0, clickCount: 0 }, s);
    const measured = (await evaluate(measureScript([mail.ref ?? "", "1:nope"]))).value as Measured;
    expect(measured.scroll.y).toBeGreaterThan(0);
    expect(measured.rects).toEqual([{ ...rect, y: rect.y - measured.scroll.y }, null]);
    expect((await evaluate(elementScript())).value).toBeNull();
    expect(await evaluate("document.title")).toEqual({ type: "undefined" });
    expect((await a.conn.send("Page.createIsolatedWorld", { frameId: "demo-tab-start", worldName: "teleflock" }, s)).executionContextId).toBeGreaterThan(0);
    await a.conn.send("Page.navigate", { url: "https://docs.example.com/guide" }, s);
    clock.advance(1000);
    await flush();
    expect((await evaluate(measureScript([mail.ref ?? ""]))).value).toEqual({ scroll: { x: 0, y: 0 }, rects: [null] });
  });

  test("demoAgentStep drives the agents' tabs through the pages", async () => {
    const a = await client();
    await a.conn.send("Target.setDiscoverTargets", { discover: true });
    await a.conn.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/agent", eventsEnabled: true });
    const s = await a.attach("demo-tab-quota");
    await a.conn.send("Page.startScreencast", { format: "jpeg" }, s);
    await flush();
    expect(demoAgentStep("nope")).toBe(false);

    expect(demoAgentStep("demo-tab-quota")).toBe(true);
    await a.conn.send("Page.screencastFrameAck", { sessionId: 1 }, s);
    await flush();
    expect(a.of("Page.screencastFrame", s).at(-1)?.metadata.scrollOffsetY).toBeGreaterThan(0);

    const until = (done: () => boolean) => {
      for (let i = 0; i < 12 && !done(); i++) {
        expect(demoAgentStep("demo-tab-quota")).toBe(true);
        clock.advance(400);
      }
    };
    until(() => a.of("Browser.downloadWillBegin").length > 0);
    expect(a.of("Browser.downloadWillBegin")).toMatchObject([{ frameId: "demo-tab-quota", suggestedFilename: "usage-2026-10.csv" }]);
    const filtered = (await a.texts(s)).texts;
    expect(filtered).toContain("acme");
    expect(filtered).toContain("acme-staging");
    expect(filtered).not.toContain("globex-eu");

    const lastUrl = () => a.of("Target.targetInfoChanged").at(-1)?.targetInfo.url;
    until(() => lastUrl() === "https://dashboard.example.com/invoices");
    expect((await a.conn.send("Page.getNavigationHistory", {}, s)).entries.at(-1)).toMatchObject({ url: "https://dashboard.example.com/invoices", transitionType: "link" });
    until(() => lastUrl() === "https://dashboard.example.com/billing");
    expect((await a.conn.send("Page.getNavigationHistory", {}, s)).currentIndex).toBe(0);

    const ci = await a.attach("demo-tab-ci");
    expect(demoAgentStep("demo-tab-ci")).toBe(true);
    clock.advance(400);
    expect(a.of("Page.frameNavigated", ci).map((e) => e.frame.url)).toEqual(["https://ci.example.com/runs/1842"]);
    for (let i = 0; i < 3; i++) {
      demoAgentStep("demo-tab-ci");
      clock.advance(400);
    }
    expect(a.of("Page.frameNavigated", ci).map((e) => e.frame.url)).toEqual(["https://ci.example.com/runs/1842", "https://ci.example.com/runs"]);
    demoAgentStep("demo-tab-ci");
    clock.advance(400);
    expect(a.of("Page.frameNavigated", ci).at(-1)?.frame.url).toBe("https://ci.example.com/runs/1841");

    const { targetId } = await a.conn.send("Target.createTarget", { url: "https://docs.example.com/guide" });
    const g = await a.attach(targetId);
    expect(demoAgentStep(targetId)).toBe(true);
    expect((await a.texts(g)).scrollY).toBe(140);
  });
});
