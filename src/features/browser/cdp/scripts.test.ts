import { describe, expect, test } from "bun:test";
import type { ElementInfo } from "../observe";
import { elementScript, measureScript } from "./scripts";

/*
 * The page scripts run on a small stand-in for the DOM: elements with a box in their document's
 * viewport, open shadow roots, frames whose document the panel's world may read (same origin) or
 * not (another origin: `contentDocument` null), and a scrolled top window.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

class Win {
  frameElement: El | null = null;
  innerWidth = 800;
  innerHeight = 600;
  readonly world: Record<string, unknown> = {};
}

class Root {
  activeElement: El | null = null;
  readonly kids: El[] = [];
  readonly nodeType: number;
  constructor(
    readonly win: Win,
    readonly host: El | null = null,
  ) {
    this.nodeType = host ? 11 : 9;
  }
  get defaultView(): Win | null {
    return this.host ? null : this.win;
  }
  /** Topmost element whose box holds the point, children over parents (no shadow or frame descent: the script does that). */
  elementFromPoint(x: number, y: number): El | null {
    const walk = (els: El[]): El | null => {
      for (const e of [...els].reverse()) {
        const inner = walk(e.children);
        if (inner) return inner;
        const b = e.box;
        if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return e;
      }
      return null;
    };
    return walk(this.kids);
  }
  /** `#id` selectors only. */
  querySelector(sel: string): El | null {
    const id = /^#([\w-]+)$/.exec(sel)?.[1];
    const walk = (els: El[]): El | null => {
      for (const e of els) {
        if (e.isConnected && e.attrs.id === id) return e;
        const inner = walk(e.children);
        if (inner) return inner;
      }
      return null;
    };
    return id ? walk(this.kids) : null;
  }
}

class Doc extends Root {
  readonly body: El;
  readonly documentElement: El;
  constructor(win: Win) {
    super(win);
    this.documentElement = new El(this, "HTML", {}, { x: 0, y: 0, width: 800, height: 600 });
    this.body = new El(this, "BODY", {}, { x: 0, y: 0, width: 800, height: 600 });
  }
}

class El {
  readonly nodeType = 1;
  readonly children: El[] = [];
  parentElement: El | null = null;
  shadowRoot: Root | null = null;
  contentDocument: Doc | null = null;
  isConnected = true;
  clientLeft = 0;
  clientTop = 0;
  innerText = "";
  constructor(
    readonly root: Root,
    readonly tagName: string,
    readonly attrs: Record<string, string>,
    public box: Box,
  ) {}
  get id(): string {
    return this.attrs.id ?? "";
  }
  get ownerDocument(): Root {
    let r = this.root;
    while (r.host) r = r.host.root;
    return r;
  }
  get labels(): El[] | undefined {
    return this.tagName === "INPUT" ? [] : undefined;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  getRootNode(): Root {
    return this.root;
  }
  getBoundingClientRect() {
    const { x, y, width, height } = this.box;
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  }
  closest(): El | null {
    for (let n: El | null = this; n; n = n.parentElement) if (/^(A|BUTTON|INPUT|TEXTAREA|SELECT|LABEL)$/.test(n.tagName) || n.attrs.role) return n;
    return null;
  }
  add(tag: string, attrs: Record<string, string>, box: Box, into: Root = this.root): El {
    const e = new El(into, tag, attrs, box);
    if (into === this.root) {
      e.parentElement = this;
      this.children.push(e);
    } else into.kids.push(e);
    return e;
  }
}

/** A top-level page scrolled to `scrollY`, with what `build` puts into its body. */
function page(scrollY: number, build: (body: El, doc: Doc) => void) {
  const win = new Win();
  const doc = new Doc(win);
  doc.kids.push(doc.body);
  build(doc.body, doc);
  const run = <T,>(script: string): T => {
    const globals = { window: win.world, document: doc, getComputedStyle: () => ({ paddingLeft: "0px", paddingTop: "0px" }), CSS: { escape: (s: string) => s }, scrollX: 0, scrollY };
    return new Function(...Object.keys(globals), `return ${script}`)(...Object.values(globals)) as T;
  };
  return { doc, win, element: (point?: { x: number; y: number }) => run<ElementInfo | null>(elementScript(point)), measure: (refs: string[]) => run<{ scroll: { x: number; y: number }; rects: (Box | null)[] }>(measureScript(refs)) };
}

/** A frame at (100, 300) with a 5 px border, showing `doc` (null: another origin's page). */
function frame(body: El, doc: Doc | null): El {
  const f = body.add("IFRAME", { id: "pay", title: "Secure payment" }, { x: 100, y: 300, width: 310, height: 110 });
  f.clientLeft = f.clientTop = 5;
  f.contentDocument = doc;
  if (doc) doc.win.frameElement = f;
  return f;
}

function sameOriginDoc(): Doc {
  const doc = new Doc(new Win());
  doc.win.innerWidth = 300;
  doc.win.innerHeight = 100;
  doc.kids.push(doc.body);
  return doc;
}

describe("element lookups", () => {
  test("rectangles are where the tab's viewport shows the element (the screencast's), with the scroll offset, on a scrolled page", () => {
    const p = page(1200, (body, doc) => {
      doc.activeElement = body.add("INPUT", { id: "otp", autocomplete: "one-time-code" }, { x: 10, y: 300, width: 120, height: 30 });
    });
    expect(p.element()).toMatchObject({ tag: "input", selector: "#otp", sensitive: true, rect: { x: 10, y: 300, width: 120, height: 30 }, scroll: { x: 0, y: 1200 } });
  });

  test("the focus inside an open shadow root is the field in it", () => {
    const p = page(0, (body, doc) => {
      const host = body.add("X-LOGIN", { id: "login" }, { x: 0, y: 100, width: 400, height: 60 });
      host.shadowRoot = new Root(doc.win, host);
      const pw = host.add("INPUT", { id: "pw", type: "password" }, { x: 20, y: 110, width: 150, height: 30 }, host.shadowRoot);
      doc.activeElement = host;
      host.shadowRoot.activeElement = pw;
    });
    expect(p.element()).toMatchObject({ tag: "input", type: "password", sensitive: true, selector: "#login >>> #pw", rect: { x: 20, y: 110 } });
  });

  test("the focus inside a same-origin frame is the field in it, placed in the tab's viewport", () => {
    const p = page(0, (body, doc) => {
      const inner = sameOriginDoc();
      const f = frame(body, inner);
      inner.activeElement = inner.body.add("INPUT", { id: "card", autocomplete: "cc-number" }, { x: 10, y: 20, width: 200, height: 30 });
      doc.activeElement = f;
    });
    expect(p.element()).toMatchObject({ tag: "input", autocomplete: "cc-number", sensitive: true, selector: "#pay >>> #card", rect: { x: 115, y: 325, width: 200, height: 30 } });
  });

  test("a focused frame of another origin can't be looked into: it is sensitive as a whole", () => {
    const p = page(0, (body, doc) => {
      doc.activeElement = frame(body, null);
    });
    expect(p.element()).toMatchObject({ tag: "iframe", label: "Secure payment", sensitive: true, rect: { x: 100, y: 300, width: 310, height: 110 } });
    // A click on it as well: whatever is typed next goes into it.
    expect(p.element({ x: 150, y: 350 })).toMatchObject({ tag: "iframe", sensitive: true });
  });

  test("a point inside a same-origin frame finds the element under it there", () => {
    const p = page(0, (body) => {
      const inner = sameOriginDoc();
      frame(body, inner);
      inner.body.add("BUTTON", { id: "pay-now" }, { x: 10, y: 60, width: 100, height: 30 }).innerText = "Pay now";
    });
    expect(p.element({ x: 140, y: 375 })).toMatchObject({ tag: "button", label: "Pay now", textLabel: true, selector: "#pay >>> #pay-now", rect: { x: 115, y: 365 } });
  });

  test("measuring looks the elements up again: moved, put back by the page under the same name, gone, never seen", () => {
    let inner = sameOriginDoc();
    let card: El | undefined;
    const p = page(0, (body, doc) => {
      inner = sameOriginDoc();
      const f = frame(body, inner);
      card = inner.body.add("INPUT", { id: "card", autocomplete: "cc-number" }, { x: 10, y: 20, width: 200, height: 30 });
      inner.activeElement = card;
      doc.activeElement = f;
    });
    const ref = p.element()?.ref ?? "";
    expect(ref).not.toBe("");
    expect(p.element()?.ref).toBe(ref);
    if (card) card.box = { ...card.box, y: 40 };
    expect(p.measure([ref, "nope"])).toEqual({ scroll: { x: 0, y: 0 }, rects: [{ x: 115, y: 345, width: 200, height: 30 }, null] });
    // Re-rendered: the old node is gone, a new one has its name.
    if (card) card.isConnected = false;
    inner.body.add("INPUT", { id: "card" }, { x: 10, y: 70, width: 200, height: 30 });
    expect(p.measure([ref]).rects).toEqual([{ x: 115, y: 375, width: 200, height: 30 }]);
    // Scrolled inside the frame out of its view: nothing of it shows.
    for (const e of inner.body.children) e.box = { ...e.box, y: -200 };
    expect(p.measure([ref]).rects).toEqual([{ x: 115, y: 305, width: 200, height: 0 }]);
  });
});
