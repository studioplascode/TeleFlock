import { describe, expect, test } from "bun:test";
import type { BrowserStatus, BrowserTabOwner } from "@/core/gen";
import type { TargetInfo } from "./cdp/protocol";
import { addressToUrl, containRect, keyEventParams, type KeyLike, nextZoom, routeKey, toPagePoint, virtualKeyCode, wheelDelta } from "./input";
import { groupTabActions, groupTabs, ownerColors, ownerOf, userDrives } from "./owners";
import { agentRequestView, requestViews, waitingText } from "./requests";
import { cycleTab, EMPTY_TABS, popClosed, reduceTabs, type TabsState, tabLabel } from "./tabs";

const key = (over: Partial<KeyLike> = {}): KeyLike => ({ key: "a", code: "KeyA", keyCode: 65, location: 0, repeat: false, isComposing: false, altGraph: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });
const target = (id: string, over: Partial<TargetInfo> = {}): TargetInfo => ({ targetId: id, type: "page", title: id, url: `https://${id}.test/`, attached: false, ...over });

describe("input mapping", () => {
  test("keys: page, browser chrome, app, paste/copy and composition go where a browser sends them", () => {
    expect(routeKey(key(), false)).toEqual({ kind: "page" });
    expect(routeKey(key({ ctrlKey: true, code: "KeyL", key: "l" }), false)).toEqual({ kind: "chrome", action: "focusAddress" });
    expect(routeKey(key({ metaKey: true, code: "KeyL", key: "l" }), true)).toEqual({ kind: "chrome", action: "focusAddress" });
    // Ctrl+L on a Mac is the page's (Cmd is the browser's modifier there).
    expect(routeKey(key({ ctrlKey: true, code: "KeyL", key: "l" }), true)).toEqual({ kind: "page" });
    expect(routeKey(key({ ctrlKey: true, shiftKey: true, code: "KeyT", key: "T" }), false)).toEqual({ kind: "chrome", action: "reopenTab" });
    expect(routeKey(key({ ctrlKey: true, key: "Tab", code: "Tab", keyCode: 9 }), false)).toEqual({ kind: "chrome", action: "nextTab" });
    expect(routeKey(key({ altKey: true, key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }), false)).toEqual({ kind: "chrome", action: "back" });
    expect(routeKey(key({ ctrlKey: true, key: "+", code: "Equal", shiftKey: true }), false)).toEqual({ kind: "chrome", action: "zoomIn" });
    expect(routeKey(key({ ctrlKey: true, key: "2", code: "Digit2", keyCode: 50 }), false)).toEqual({ kind: "app" });
    expect(routeKey(key({ ctrlKey: true, key: "j", code: "KeyJ" }), false)).toEqual({ kind: "app" });
    expect(routeKey(key({ ctrlKey: true, key: "v", code: "KeyV" }), false)).toEqual({ kind: "paste" });
    expect(routeKey(key({ ctrlKey: true, key: "x", code: "KeyX" }), false)).toEqual({ kind: "copy", cut: true });
    expect(routeKey(key({ isComposing: true }), false)).toEqual({ kind: "ime" });
    expect(routeKey(key({ key: "Process", keyCode: 229 }), false)).toEqual({ kind: "ime" });
    // Ctrl+A, Ctrl+F, Escape, Tab belong to the page.
    expect(routeKey(key({ ctrlKey: true }), false)).toEqual({ kind: "page" });
    expect(routeKey(key({ key: "Escape", code: "Escape", keyCode: 27 }), false)).toEqual({ kind: "page" });
  });

  test("key events: text only for typing keys, AltGr types, macOS editing commands, keyUp carries no text", () => {
    const a = keyEventParams(key(), "down", false);
    expect(a).toMatchObject({ type: "keyDown", key: "a", text: "a", windowsVirtualKeyCode: 65, modifiers: 0 });
    const ctrlA = keyEventParams(key({ ctrlKey: true }), "down", false);
    expect(ctrlA).toMatchObject({ type: "rawKeyDown", modifiers: 2 });
    expect(ctrlA.text).toBeUndefined();
    const altGr = keyEventParams(key({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true }), "down", false);
    expect(altGr).toMatchObject({ type: "keyDown", text: "@", modifiers: 0 });
    expect(keyEventParams(key({ key: "å", code: "KeyA", altKey: true }), "down", true)).toMatchObject({ text: "å" });
    expect(keyEventParams(key({ metaKey: true }), "down", true).commands).toEqual(["selectAll"]);
    expect(keyEventParams(key({ key: "Enter", code: "Enter", keyCode: 13 }), "down", false).text).toBe("\r");
    expect(keyEventParams(key(), "up", false)).toMatchObject({ type: "keyUp" });
    expect(keyEventParams(key(), "up", false).text).toBeUndefined();
    // A webview that reports keyCode 0 still gets Windows virtual key codes from `code`.
    expect(virtualKeyCode({ keyCode: 0, code: "Digit7", key: "7" })).toBe(55);
    expect(virtualKeyCode({ keyCode: 0, code: "F5", key: "F5" })).toBe(116);
  });

  test("pointer and wheel map through the letterboxed frame into page CSS pixels", () => {
    const image = containRect({ left: 100, top: 50, width: 800, height: 800 }, 1280, 800);
    expect(image).toEqual({ left: 100, top: 200, width: 800, height: 500 });
    const map = { image, page: { width: 1280, height: 800 } };
    expect(toPagePoint(500, 450, map)).toEqual({ x: 640, y: 400, inside: true });
    expect(toPagePoint(500, 100, map)).toMatchObject({ y: 0, inside: false });
    // Lines become 40 px; Shift+wheel scrolls sideways outside macOS.
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, 800, 1.6, false)).toEqual({ deltaX: 0, deltaY: 120 });
    expect(wheelDelta({ deltaX: 0, deltaY: 10, deltaMode: 0, shiftKey: true }, 800, 2, false)).toEqual({ deltaX: 20, deltaY: 0 });
  });

  test("address bar: URLs as typed, hosts get a scheme, the rest is a search", () => {
    expect(addressToUrl("example.com/a?b")).toBe("https://example.com/a?b");
    expect(addressToUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(addressToUrl("http://x.test")).toBe("http://x.test");
    expect(addressToUrl("how to bake")).toBe("https://duckduckgo.com/?q=how%20to%20bake");
    expect(addressToUrl("   ")).toBeNull();
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(5, 1)).toBe(5);
  });
});

describe("tab model", () => {
  const open = (...ids: string[]): TabsState => ids.reduce((s, id) => reduceTabs(s, { type: "created", info: target(id), activate: false }), EMPTY_TABS);

  test("popups open next to their opener, the shown tab's successor is its opener, closed tabs reopen", () => {
    let s = open("a", "b");
    expect(s.active).toBe("a");
    s = reduceTabs(s, { type: "created", info: target("p1", { openerId: "a" }), activate: true });
    s = reduceTabs(s, { type: "created", info: target("p2", { openerId: "a" }), activate: false });
    expect(s.order).toEqual(["a", "p1", "p2", "b"]);
    expect(s.active).toBe("p1");
    s = reduceTabs(s, { type: "destroyed", id: "p1" });
    expect(s.active).toBe("a");
    expect(popClosed(s).url).toBe("https://p1.test/");
    expect(cycleTab(s, -1)).toBe("b");
    // Non-page targets (workers, the browser's own UI) are not tabs.
    expect(reduceTabs(s, { type: "created", info: target("w", { type: "service_worker" }), activate: true })).toBe(s);
  });

  test("a changed site drops the old favicon; a crash clears loading; labels fall back to the host", () => {
    let s = open("a");
    s = reduceTabs(s, { type: "favicon", id: "a", favicon: "data:x" });
    s = reduceTabs(s, { type: "changed", info: target("a", { url: "https://a.test/next" }) });
    expect(s.byId.a?.favicon).toBe("data:x");
    s = reduceTabs(s, { type: "changed", info: target("a", { url: "https://other.test/" }) });
    expect(s.byId.a?.favicon).toBeUndefined();
    s = reduceTabs(s, { type: "loading", id: "a", loading: true });
    s = reduceTabs(s, { type: "crashed", id: "a" });
    expect(s.byId.a).toMatchObject({ crashed: true, loading: false });
    expect(tabLabel({ title: "", url: "https://docs.example.com/x" })).toBe("docs.example.com");
    expect(tabLabel({ title: "", url: "about:blank" })).toBe("New tab");
  });
});

describe("ownership", () => {
  const entry = (targetId: string, agentId: string, over: Partial<BrowserTabOwner> = {}): BrowserTabOwner => ({ targetId, hostId: "h", agentId, agentName: agentId, lent: false, takenOver: false, detached: false, ...over });
  const status = (tabs: BrowserTabOwner[], attachments: BrowserStatus["attachments"] = []) => ({ tabs, attachments });

  test("tabs group by owner, user first; an agent's tab is watch-only until taken over", () => {
    const tabs = ["u1", "x1", "u2", "y1", "x2"].reduce((s, id) => reduceTabs(s, { type: "created", info: target(id), activate: false }), EMPTY_TABS);
    const now = 10_000;
    const groups = groupTabs(tabs, status([entry("x1", "x", { activeAt: now - 1000 }), entry("x2", "x", { takenOver: true }), entry("y1", "y", { detached: true, activeAt: now })], [{ hostId: "h", agentId: "z", agentName: "z", since: 0, hostPort: 1, scope: "turn", connections: 0 }]), now);
    expect(groups.map((g) => [g.key, g.tabs.map((t) => t.id)])).toEqual([
      ["user", ["u1", "u2"]],
      ["h::x", ["x1", "x2"]],
      ["h::y", ["y1"]],
      ["h::z", []],
    ]);
    expect(groups[1]?.driving).toBe(true);
    // A detached agent's activity is history, not driving.
    expect(groups[2]?.driving).toBe(false);
    expect(userDrives(ownerOf([entry("x1", "x")], "x1"))).toBe(false);
    expect(userDrives(ownerOf([entry("x1", "x", { takenOver: true })], "x1"))).toBe(true);
    expect(userDrives(ownerOf([], "u1"))).toBe(true);
    expect(new Set(Object.values(ownerColors(["h::x", "h::y", "h::z"]))).size).toBe(3);
  });

  test("a group's menu: take over or hand back its own tabs, give lent tabs back, close only its own", () => {
    const tabs = ["a", "b", "l"].reduce((s, id) => reduceTabs(s, { type: "created", info: target(id), activate: false }), EMPTY_TABS);
    const [, g] = groupTabs(tabs, status([entry("a", "x"), entry("b", "x", { takenOver: true }), entry("l", "x", { lent: true })]), 0);
    expect(g && groupTabActions(g)).toEqual({ takeOver: ["a"], handBack: ["b"], giveBack: ["l"], close: ["a", "b"] });
  });
});

describe("request cards", () => {
  const base: BrowserStatus = { state: "running", headed: false, profileDir: "/p", cap: 2, attachments: [], requests: [], tabs: [] };
  const att = (agentId: string) => ({ hostId: "h", agentId, agentName: agentId, since: 0, hostPort: 1, scope: "session" as const, connections: 1 });

  test("asking, waiting at the cap, and answering from a device without the browser", () => {
    const status: BrowserStatus = {
      ...base,
      attachments: [att("a"), att("b")],
      requests: [
        { id: "r2", hostId: "h", agentId: "c", agentName: "c", reason: "check CI", at: 2, waiting: true, scope: "turn" },
        { id: "r1", hostId: "h", agentId: "d", agentName: "d", reason: "sign in", at: 1, waiting: false },
      ],
    };
    expect(requestViews(status).map((v) => [v.requestId, v.phase, v.using, v.cap, v.scope ?? null])).toEqual([
      ["r1", "ask", 2, 2, null],
      ["r2", "waiting", 2, 2, "turn"],
    ]);
    expect(waitingText(2, 2)).toBe("Waiting for the browser: 2 agents use it");
    const agent = { id: "d", name: "d", hostId: "h", needs: undefined, browser: { request: { id: "r1", reason: "sign in", at: 1 } } };
    expect(agentRequestView(agent, status, true)?.phase).toBe("ask");
    // A phone (or a core without the browser) only denies, from the agent's own card.
    expect(agentRequestView(agent, status, false)).toMatchObject({ requestId: "r1", phase: "elsewhere", reason: "sign in" });
    expect(agentRequestView({ ...agent, browser: undefined }, null, false)).toBeNull();
  });
});
