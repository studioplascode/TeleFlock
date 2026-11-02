import { describe, expect, test } from "bun:test";
import type { BrowserEvent, ElementInfo } from "@/features/browser/observe";
import { EventLog, HOLD_MS, isSensitiveElement, looksSecret, MAX_ERRORS, maskUrl, type RecEvent, recordingTime, scrubSecrets } from "./model";

const field = (over: Partial<ElementInfo> = {}): ElementInfo => ({ tag: "input", type: "text", label: "Search", selector: "input#q", sensitive: false, ...over });
const password = field({ type: "password", label: "Password", selector: "input#pw", sensitive: true });

/** A log on a clock where epoch ms = recording ms, fed events at given times. */
function logOf() {
  const log = new EventLog({ clock: (at) => at, startGraceMs: 0 });
  const feed = (...events: BrowserEvent[]) => {
    for (const e of events) log.add(e);
  };
  const all = (): RecEvent[] => {
    log.flush();
    return log.take();
  };
  return { log, feed, all };
}

const key = (at: number, k: string, el: ElementInfo = field(), modifiers = 0, tabId = "t1"): BrowserEvent => ({ at, tabId, type: "key", key: k, code: k, modifiers, ...(k.length === 1 && !(modifiers & 6) ? { text: k } : {}), element: el });
const typeText = (at: number, text: string, el: ElementInfo = field()) => [...text].map((c, i) => key(at + i * 100, c, el));
const down = (at: number, x: number, y: number, el?: ElementInfo, clickCount = 1, tabId = "t1"): BrowserEvent => ({ at, tabId, type: "pointer", action: "down", x, y, button: "left", clickCount, modifiers: 0, ...(el ? { element: el } : {}) });
const up = (at: number, x: number, y: number, clickCount = 1, tabId = "t1"): BrowserEvent => ({ at, tabId, type: "pointer", action: "up", x, y, button: "left", clickCount, modifiers: 0 });
const nav = (at: number, url: string, tabId = "t1", title?: string): BrowserEvent => ({ at, tabId, type: "navigation", url, sameDocument: false, ...(title ? { title } : {}) });

describe("masking", () => {
  test("password, card and one-time-code fields are sensitive by flag, type, autocomplete, name or label; lookalike words are not", () => {
    expect(isSensitiveElement(password)).toBe(true);
    expect(isSensitiveElement(field({ type: "password" }))).toBe(true);
    expect(isSensitiveElement(field({ autocomplete: "cc-number" }))).toBe(true);
    expect(isSensitiveElement(field({ autocomplete: "section-pay one-time-code" }))).toBe(true);
    expect(isSensitiveElement(field({ name: "api_key", label: "" }))).toBe(true);
    expect(isSensitiveElement(field({ label: "PIN" }))).toBe(true);
    expect(isSensitiveElement(field({ label: "Card number" }))).toBe(true);
    expect(isSensitiveElement(field({ id: "cvc" }))).toBe(true);
    expect(isSensitiveElement(field({ label: "Shipping address" }))).toBe(false);
    expect(isSensitiveElement(field({ label: "Spinner speed" }))).toBe(false);
    expect(isSensitiveElement(field({ autocomplete: "email" }))).toBe(false);
  });

  test("URLs lose credentials and the values of credential-like parameters, also in an OAuth fragment", () => {
    const out = maskUrl("https://me:secret@shop.test/cb?code=4/0Ab-x&state=xyz&q=red+shoes#access_token=ya29.a0AfH6&expires_in=3599");
    expect(out).not.toContain("me:secret");
    expect(out).not.toContain("4/0Ab-x");
    expect(out).not.toContain("ya29");
    expect(out).toContain("state=xyz");
    expect(out).toContain("q=red+shoes");
    expect(out).toContain("expires_in=3599");
    expect(out).toContain("code=***");
    expect(out).toContain("access_token=***");
  });

  test("tokens in a URL's path, in a fragment without parameters and as a bare query are masked; ordinary paths stay", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk";
    expect(maskUrl(`https://app.test/verify/${jwt}?next=/home`)).toBe("https://app.test/verify/***?next=/home");
    // A webhook-style path (not a real service's host, so secret scanners leave the fixture alone).
    expect(maskUrl("https://hooks.chat.test/services/T0123ABCD/B0456EFGH/aB3dE5fG7hJ9kL1mN3pQ5rS7")).toBe("https://hooks.chat.test/services/T0123ABCD/B0456EFGH/***");
    expect(maskUrl("https://api.test/keys/sk-live-abcdefghijklmnopqrstuv/usage")).toBe("https://api.test/keys/***/usage");
    expect(maskUrl("https://app.test/#/reset/Xk9aP2qL8mZ3vB7nR4tY6wQ1")).toBe("https://app.test/#/reset/***");
    expect(maskUrl(`https://app.test/magic?${jwt}`)).toBe("https://app.test/magic?***");
    expect(maskUrl("https://docs.test/guide/getting-started/v2#install-step-2")).toBe("https://docs.test/guide/getting-started/v2#install-step-2");
  });

  test("secret-looking text is spotted whole and scrubbed inside other text", () => {
    expect(looksSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk")).toBe(true);
    expect(looksSecret("sk-proj-abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksSecret("Xk9aP2qL8mZ3vB7nR4tY6wQ1")).toBe(true);
    expect(looksSecret("hello world")).toBe(false);
    expect(looksSecret("https://example.com/AVeryLongPathSegment123456")).toBe(false);
    expect(scrubSecrets("401: token ghp_abcdefghijklmnopqrstuvwxyz0123 expired")).toBe("401: token ••• expired");
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwx")).toBe("Authorization: Bearer •••");
  });
});

describe("typing", () => {
  test("keys into one field are one entry; Backspace edits it; Enter ends it as submitted", () => {
    const { feed, all } = logOf();
    feed(...typeText(1000, "helo"), key(1400, "Backspace"), ...typeText(1500, "lo"), key(1700, "Enter"));
    expect(all()).toEqual([{ t: 1000, tab: "t1", kind: "type", text: "hello", submitted: true, element: { tag: "input", type: "text", label: "Search", selector: "input#q" } }]);
  });

  test("a password field's typing is logged as hidden, without its characters", () => {
    const { feed, all } = logOf();
    feed(...typeText(1000, "hunter2", password), key(1800, "Enter", password));
    const [e] = all();
    expect(e).toMatchObject({ kind: "type", hidden: true, text: "", submitted: true });
    expect(JSON.stringify(e)).not.toContain("hunter2");
  });

  test("a pasted key in a normal field is hidden; other pastes are their own entry", () => {
    const { feed, all } = logOf();
    feed({ at: 1000, tabId: "t1", type: "text", via: "paste", text: "sk-live-abcdefghijklmnopqrstu", element: field({ label: "Key", selector: "input#k" }) });
    feed({ at: 2000, tabId: "t1", type: "text", via: "paste", text: "red shoes", element: field() });
    const [a, b] = all();
    expect(a).toMatchObject({ kind: "type", pasted: true, hidden: true, text: "" });
    expect(b).toMatchObject({ kind: "type", pasted: true, text: "red shoes" });
  });

  test("typing that pauses longer than the gap becomes two entries; another field starts a new one", () => {
    const { log, feed, all } = logOf();
    feed(...typeText(1000, "ab"));
    log.tick(1100 + 2600);
    feed(...typeText(4000, "cd"), ...typeText(4300, "x", field({ label: "Name", selector: "input#name" })));
    expect(all().map((e) => (e.kind === "type" ? e.text : e.kind))).toEqual(["ab", "cd", "x"]);
  });

  test("shortcuts are keys of their own and end the typing before them; repeats are counted", () => {
    const { feed, all } = logOf();
    feed(...typeText(1000, "hi"), key(1300, "s", field(), 2), key(1400, "ArrowDown"), key(1500, "ArrowDown"), key(1600, "ArrowDown"));
    expect(all().map((e) => (e.kind === "key" ? `${e.combo}×${e.repeat ?? 1}` : e.kind === "type" ? e.text : e.kind))).toEqual(["hi", "Ctrl+S×1", "ArrowDown×3"]);
  });

  test("Option-typed characters (Alt with text, as a Mac sends them) are typing; in a password field they stay hidden", () => {
    const { feed, all } = logOf();
    const email = field({ type: "email", label: "Email", selector: "input#email" });
    feed(...typeText(1000, "jane", email), key(1400, "@", email, 1), ...typeText(1500, "x.io", email));
    feed(...typeText(5000, "pa", password), key(5200, "@", password, 1), key(5300, "€", password, 1), ...typeText(5400, "ss", password), key(5600, "Enter", password));
    const events = all();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "type", text: "jane@x.io" });
    expect(events[1]).toMatchObject({ kind: "type", hidden: true, text: "", submitted: true });
  });

  test("a sensitive field's printable keys never make a line, shortcuts included (Ctrl+Alt is AltGr on Windows)", () => {
    const { feed, all } = logOf();
    feed(key(1000, "a", password, 2), key(1100, "@", password, 3), key(1200, "q", password, 4), key(1300, "ArrowLeft", password), key(1400, "s", field(), 2));
    expect(all().map((e) => (e.kind === "key" ? e.combo : e.kind))).toEqual(["ArrowLeft", "Ctrl+S"]);
  });

  test("a label that is a sensitive element's own text is left out; a field's label stays", () => {
    const { feed, all } = logOf();
    feed(down(1000, 5, 5, { tag: "div", id: "pin", label: "4711", textLabel: true, selector: "#pin", sensitive: false }), up(1050, 5, 5));
    feed(down(2000, 5, 5, { tag: "div", id: "menu", label: "Account", textLabel: true, selector: "#menu", sensitive: false }), up(2050, 5, 5));
    feed(down(3000, 5, 5, password), up(3050, 5, 5));
    expect(all().map((e) => (e.kind === "click" ? (e.element?.label ?? "") : e.kind))).toEqual(["", "Account", "Password"]);
  });
});

describe("pointer", () => {
  test("down and up in place is a click with the element; far apart a drag; a double click stays one entry", () => {
    const btn = { tag: "button", role: "button", label: "Save", selector: "button#save", sensitive: false };
    const { feed, all } = logOf();
    feed(down(1000, 10, 20, btn), up(1080, 11, 20));
    feed(down(2000, 10, 20, btn), up(2050, 300, 40));
    feed(down(3000, 50, 50, btn), up(3050, 50, 50), down(3200, 50, 50, btn, 2), up(3250, 50, 50, 2));
    const events = all();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "click", x: 10, y: 20, count: 1, element: { role: "button", label: "Save" } });
    expect(events[1]).toMatchObject({ kind: "click", to: { x: 300, y: 40 } });
    expect(events[2]).toMatchObject({ kind: "click", count: 2 });
  });
});

describe("covers", () => {
  const at = (y: number, scrollY = 0) => ({ rect: { x: 10, y, width: 200, height: 30 }, scroll: { x: 0, y: scrollY } });
  const card = field({ label: "Card number", autocomplete: "cc-number", selector: "input#card", ref: "p1-1", ...at(300, 1200) });
  const pay: ElementInfo = { tag: "button", label: "Pay", textLabel: true, selector: "button#pay", sensitive: false, ref: "p1-2", ...at(400, 1200) };
  const key = field({ label: "Key", selector: "input#key", ref: "p1-3", ...at(500, 1200) });

  test("the focused sensitive field, then every sensitive field typed into on the page, also once the focus moved on", () => {
    const { log, feed } = logOf();
    feed(down(1000, 20, 310, card), up(1050, 20, 310));
    expect(log.covers("t1")).toEqual([{ ref: "p1-1", ...at(300, 1200) }]);
    feed(...typeText(1100, "4242", card), down(2000, 50, 410, pay), up(2050, 50, 410));
    expect(log.covers("t1")).toEqual([{ ref: "p1-1", ...at(300, 1200) }]);
    // A secret pasted into an ordinary field: covered too (the log hid it).
    feed({ at: 3000, tabId: "t1", type: "text", via: "paste", text: "sk-live-abcdefghijklmnopqrstu", element: key });
    expect(log.covers("t1").map((c) => c.ref)).toEqual(["p1-1", "p1-3"]);
    expect(log.covers("t2")).toEqual([]);
  });

  test("measured again: moved with the page, gone until it shows again; closing the tab forgets them", () => {
    const { log, feed } = logOf();
    feed(down(1000, 20, 310, card), up(1050, 20, 310), ...typeText(1100, "4242", card));
    log.measured("t1", ["p1-1"], { scroll: { x: 0, y: 1300 }, rects: [{ x: 10, y: 200, width: 200, height: 30 }] });
    expect(log.covers("t1")).toEqual([{ ref: "p1-1", ...at(200, 1300) }]);
    log.measured("t1", ["p1-1"], { scroll: { x: 0, y: 0 }, rects: [null] });
    expect(log.covers("t1")).toEqual([]);
    expect(log.coverRefs("t1")).toEqual(["p1-1"]);
    log.measured("t1", ["p1-1"], { scroll: { x: 0, y: 900 }, rects: [{ x: 10, y: 600, width: 200, height: 30 }] });
    expect(log.covers("t1")).toEqual([{ ref: "p1-1", ...at(600, 900) }]);
    feed({ at: 5000, tabId: "t1", type: "tab", change: "closed", url: "http://shop.test/", title: "Shop" });
    expect(log.covers("t1")).toEqual([]);
    expect(log.coverRefs("t1")).toEqual([]);
  });

  test("a typed run that turns out to be a secret is covered once it ends; typing while paused is not logged but is covered", () => {
    const { log, feed, all } = logOf();
    feed(...typeText(1000, "Xk9aP2qL8mZ3vB7nR4tY6wQ1", key));
    log.tick(9000);
    expect(log.covers("t1").map((c) => c.ref)).toEqual(["p1-3"]);
    log.notePaused({ at: 10_000, tabId: "t1", type: "key", key: "4", code: "Digit4", modifiers: 0, text: "4", element: card });
    expect(log.covers("t1").map((c) => c.ref)).toEqual(["p1-3", "p1-1"]);
    expect(all()).toHaveLength(1);
  });
});

describe("agents' tabs", () => {
  test("switching to an agent's tab logs watching; its input and pages are not the user's; back logs the switch", () => {
    const agent = { kind: "agent" as const, hostId: "h1", agentId: "a1", agentName: "fern" };
    const { feed, all } = logOf();
    feed({ at: 0, tabId: "t1", type: "tab", change: "activated", url: "http://shop.test/", title: "Shop" });
    feed({ at: 1000, tabId: "t2", type: "tab", change: "activated", url: "http://docs.test/", title: "Docs", owner: agent });
    feed(down(1500, 5, 5, undefined, 1, "t2"), up(1550, 5, 5, 1, "t2"), nav(1600, "http://docs.test/next", "t2"), ...typeText(1700, "zz").map((e) => ({ ...e, tabId: "t2" })));
    feed({ at: 3000, tabId: "t1", type: "tab", change: "activated", url: "http://shop.test/", title: "Shop" });
    expect(all().map((e) => e.kind)).toEqual(["tab", "watch", "tab"]);
  });
});

describe("pages and errors", () => {
  test("a navigation right after another without input between is its redirect; after a click it is a page of its own", () => {
    const { feed, all } = logOf();
    feed(nav(1000, "http://shop.test/login"), nav(1400, "http://shop.test/home", "t1", "Home"));
    feed(down(5000, 1, 1), up(5050, 1, 1), nav(5200, "http://shop.test/cart"));
    const navs = all().filter((e) => e.kind === "navigate");
    expect(navs).toEqual([
      { t: 1000, tab: "t1", kind: "navigate", url: "http://shop.test/home", title: "Home", redirects: ["http://shop.test/login"] },
      { t: 5200, tab: "t1", kind: "navigate", url: "http://shop.test/cart" },
    ]);
  });

  test("the same error again within moments is counted; aborted requests and favicons are noise", () => {
    const { feed, all } = logOf();
    const err = (at: number): BrowserEvent => ({ at, tabId: "t1", type: "console", level: "error", text: "TypeError: x is undefined" });
    feed(err(1000), err(1500), err(1900));
    feed({ at: 2000, tabId: "t1", type: "requestFailed", url: "http://shop.test/api/cart", method: "post", status: 500, statusText: "Internal Server Error", body: '{"error":"db locked"}' });
    feed({ at: 2100, tabId: "t1", type: "requestFailed", url: "http://shop.test/x.js", method: "GET", error: "net::ERR_ABORTED" });
    feed({ at: 2200, tabId: "t1", type: "requestFailed", url: "http://shop.test/favicon.ico", method: "GET", status: 404 });
    expect(all()).toEqual([
      { t: 1000, tab: "t1", kind: "console", level: "error", text: "TypeError: x is undefined", repeat: 3 },
      { t: 2000, tab: "t1", kind: "request", method: "POST", url: "http://shop.test/api/cart", status: 500, statusText: "Internal Server Error", body: '{"error":"db locked"}' },
    ]);
  });

  test("errors past the cap are counted, not logged", () => {
    const { log, feed, all } = logOf();
    for (let i = 0; i < MAX_ERRORS + 5; i++) feed({ at: i * 10_000, tabId: "t1", type: "exception", text: `boom ${i}` });
    expect(all()).toHaveLength(MAX_ERRORS);
    expect(log.errorsDropped).toBe(5);
  });
});

describe("handing entries over", () => {
  test("take(at) keeps entries younger than the hold window (still changeable); take() hands over everything", () => {
    const { log, feed } = logOf();
    feed(nav(1000, "http://a.test/"), down(9000, 1, 1), up(9050, 1, 1));
    expect(log.take(9100).map((e) => e.kind)).toEqual(["navigate"]);
    expect(log.take(9100 + HOLD_MS).map((e) => e.kind)).toEqual(["click"]);
    expect(log.take()).toEqual([]);
  });

  test("a repeat after its entry was handed over starts a new entry", () => {
    const { log, feed, all } = logOf();
    const err = (at: number): BrowserEvent => ({ at, tabId: "t1", type: "console", level: "error", text: "same" });
    feed(err(1000));
    expect(log.take(1000 + HOLD_MS)).toHaveLength(1);
    feed(err(1500));
    expect(all()).toHaveLength(1);
  });
});

describe("recording time", () => {
  test("pauses are left out; a time inside a pause is its start", () => {
    const pauses: [number, number][] = [[10_000, 15_000]];
    expect(recordingTime(1000 + 5000, 1000, pauses, null)).toBe(5000);
    expect(recordingTime(12_000, 1000, pauses, null)).toBe(9000);
    expect(recordingTime(20_000, 1000, pauses, null)).toBe(14_000);
    expect(recordingTime(30_000, 1000, pauses, 25_000)).toBe(19_000);
  });
});
