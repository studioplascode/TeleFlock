import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Compositor, type Overlay } from "./compose";

interface Call {
  fn: string;
  args: unknown[];
  fillStyle: unknown;
}

/** What the compositor drew on the canvas `canvas`: covers are the rectangles filled in the cover colour. */
interface Drawn {
  canvas: { width: number; height: number; getContext(): unknown };
  calls: Call[];
}

function fakeCanvas(): Drawn {
  const calls: Call[] = [];
  const state: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(state, {
    get: (s, k) => (k in s ? s[k] : (...args: unknown[]) => (calls.push({ fn: String(k), args, fillStyle: s.fillStyle }), k === "measureText" ? { width: 0 } : undefined)),
    set: (s, k, v) => {
      s[k] = v;
      return true;
    },
  });
  return { canvas: { width: 0, height: 0, getContext: () => ctx }, calls };
}

let drawn: Drawn;
const realDocument = globalThis.document;
// The page's picture: the fake context draws nothing of it.
const image = {} as CanvasImageSource;

beforeEach(() => {
  drawn = fakeCanvas();
  // The compositor only asks the document for its canvas.
  globalThis.document = { createElement: () => drawn.canvas } as unknown as Document;
});

afterEach(() => {
  globalThis.document = realDocument;
});

const covers = () => drawn.calls.filter((c) => c.fn === "fillRect" && c.fillStyle === "#2a2e37").map((c) => c.args);
const outlines = () => drawn.calls.filter((c) => c.fn === "strokeRect").map((c) => c.args);
const overlay = (o: Partial<Overlay>): Overlay => ({ clicks: [], masks: [], ...o });
const field = (y: number, scrollY: number) => ({ rect: { x: 10, y, width: 200, height: 30 }, scroll: { x: 0, y: scrollY } });
// 1280×800 pictures of a 1280×800 viewport: the page's area starts under the 32 px address strip.
const picture = (scrollY: number) => ({ width: 1280, height: 800, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: scrollY } });

describe("compositor", () => {
  test("on a page scrolled far down, a field's cover is where the picture shows the field", () => {
    new Compositor(1280, 800).draw(image, picture(1200), overlay({ masks: [field(300, 1200)] }));
    expect(covers()).toEqual([[10, 332, 200, 30]]);
  });

  test("a picture from before the page's last scroll covers the field where it was and where the scroll moved it", () => {
    // Measured at 1200, the picture shows 1100: a field scrolling with the page is 100 px lower there, a fixed one is not.
    new Compositor(1280, 800).draw(image, picture(1100), overlay({ masks: [field(300, 1200)], outline: field(300, 1200) }));
    expect(covers()).toEqual([[10, 332, 200, 130]]);
    // The clicked element's outline moves with the page.
    expect(outlines()).toEqual([[8, 430, 204, 34]]);
  });

  test("covers stay inside the page's area of the picture (not over the strip or the letterbox)", () => {
    // A narrower panel: a 640 px wide picture, centred in the 1280 px video.
    const narrow = { width: 640, height: 800, viewport: { width: 640, height: 800 } };
    new Compositor(1280, 800).draw(image, narrow, overlay({ masks: [{ rect: { x: -50, y: -10, width: 100, height: 30 } }, { rect: { x: 0, y: 900, width: 100, height: 30 } }] }));
    expect(covers()).toEqual([[320, 32, 50, 20]]);
  });
});
