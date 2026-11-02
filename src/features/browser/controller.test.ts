import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_BROWSER_WS } from "@/core/demo/browserTabs";
import { ManualClock } from "@/core/demo/clock";
import type { BrowserStatus } from "@/core/gen";
import { coreStore } from "@/core/store/store";
import type { KeyEventParams, MouseType } from "./cdp/protocol";
import { BrowserController } from "./controller";
import { configureDemoBrowser, resetDemoBrowser } from "./demo/fakeBrowser";
import { approxMeasure, defaultMemory, findHit, freshState, layoutPage, pageFor } from "./demo/pages";
import { type BrowserEvent, measureElements, observeBrowser } from "./observe";

const MAIL = "https://mail.example.com/";
const STATUS = { state: "running", headed: false, wsUrl: DEMO_BROWSER_WS, profileDir: "/tmp/profile", cap: 1, attachments: [], requests: [], tabs: [] } satisfies BrowserStatus;

/** Lets the fake browser's answers (microtasks) and what the controller does with them through. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(what: string, done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await flush();
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

/** The centre of a field of the mail sign-in page in viewport px, as the fake lays it out. */
function spot(id: string): { x: number; y: number } {
  const page = pageFor(MAIL, defaultMemory());
  const hit = findHit(layoutPage(page, freshState(page), { width: 1280, height: 800 }, approxMeasure), id);
  if (!hit) throw new Error(`no ${id}`);
  return { x: hit.rect.x + hit.rect.width / 2, y: hit.rect.y + hit.rect.height / 2 };
}

beforeEach(() => {
  resetDemoBrowser();
  configureDemoBrowser({ clock: new ManualClock(), measure: approxMeasure, paint: async () => "AAAA", icon: async (site) => `ICON-${site.host}` });
});

afterEach(() => {
  coreStore.setState({ browser: null });
  resetDemoBrowser();
});

describe("input observed for a recording", () => {
  test("keys and a paste name the field they went into, also right after the focus moved (Tab, a click); events keep the input's order", async () => {
    coreStore.setState({ browser: STATUS });
    const ctl = new BrowserController();
    const events: BrowserEvent[] = [];
    const off = observeBrowser({ elements: true, event: (e) => events.push(e) });
    try {
      await until("the connection", () => ctl.state.phase === "open");
      await ctl.newTab(MAIL);
      await until("the tab", () => ctl.state.tabs.byId[ctl.state.tabs.active ?? ""]?.url === MAIL);
      const tab = ctl.state.tabs.active ?? "";
      const mouse = (type: MouseType, at: { x: number; y: number }) => ctl.mouse(tab, { type, ...at, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, modifiers: 0 });
      const click = (id: string) => {
        mouse("mousePressed", spot(id));
        mouse("mouseReleased", spot(id));
      };
      const key = (k: string, more: Partial<KeyEventParams> = {}) => ctl.key(tab, { type: "keyDown", key: k, code: "", text: k, modifiers: 0, windowsVirtualKeyCode: 0, ...more });
      // All within a second, as fast as input goes.
      click("email");
      for (const c of "alice") key(c);
      key("Tab", { type: "rawKeyDown", code: "Tab", text: undefined, windowsVirtualKeyCode: 9 });
      for (const c of "hunter2") key(c);
      click("email");
      key("x");
      click("password");
      ctl.insertText(tab, "Winter2026!", "paste");
      await until("the paste", () => events.some((e) => e.type === "text"));

      const seen = events.flatMap((e) => {
        if (e.type === "pointer") return [`${e.action}${e.element ? ` ${e.element.selector}` : ""}`];
        if (e.type === "key") return [`${e.key} ${e.element?.selector}`];
        if (e.type === "text") return [`${e.via} ${e.element?.selector}`];
        return [];
      });
      const typed = (text: string, field: string) => [...text].map((c) => `${c} ${field}`);
      expect(seen).toEqual(["down #email", "up", ...typed("alice", "#email"), "Tab #email", ...typed("hunter2", "#password"), "down #email", "up", "x #email", "down #password", "up", "paste #password"]);
      const pasted = events.find((e) => e.type === "text");
      expect(pasted?.type === "text" && pasted.element).toMatchObject({ type: "password", sensitive: true });

      // The field is measured again where it is now, by the ref its lookup gave.
      const ref = pasted?.type === "text" ? (pasted.element?.ref ?? "") : "";
      const measured = await measureElements(tab, [ref, "gone-1"]);
      expect(measured?.rects).toEqual([pasted?.type === "text" ? (pasted.element?.rect ?? null) : null, null]);
    } finally {
      off();
    }
  });
});
