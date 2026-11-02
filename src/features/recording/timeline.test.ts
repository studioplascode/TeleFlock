import { describe, expect, test } from "bun:test";
import type { RecEvent } from "./model";
import { buildTimeline, describeEvent, formatLength, formatTime, keptLength, mapTime, removedRanges, type Spoken, timelineJson, timelineMarkdown } from "./timeline";

const btn = { tag: "button", role: "button", label: "Save", selector: "button#save" };
const events: RecEvent[] = [
  { t: 0, tab: "t1", kind: "tab", change: "activated", url: "http://shop.test/", title: "Shop" },
  { t: 900, tab: "t1", kind: "shot", name: "001-00m00s-start.jpg", reason: "start" },
  { t: 5000, tab: "t1", kind: "click", x: 640, y: 412, button: "left", count: 1, element: btn },
  { t: 5000, tab: "t1", kind: "shot", name: "002-00m05s-click.jpg", reason: "click" },
  { t: 5300, tab: "t1", kind: "console", level: "error", text: "TypeError: cart is undefined", source: "http://shop.test/app.js:41:13" },
  { t: 5400, tab: "t1", kind: "request", method: "POST", url: "http://shop.test/api/cart?id=7", status: 500, statusText: "Internal Server Error", body: '{"error":"db locked"}' },
  { t: 8000, tab: "t1", kind: "type", text: "", hidden: true, element: { tag: "input", type: "password", label: "Password", selector: "input#pw", sensitive: true } },
  { t: 12_000, tab: "t1", kind: "navigate", url: "http://shop.test/cart", title: "Cart" },
];
const spoken: Spoken[] = [
  { startMs: 2000, endMs: 4800, text: "Okay look, I add the shoes to the cart." },
  { startMs: 5000, endMs: 6000, text: "And it breaks." },
  { startMs: 9000, endMs: 11_000, text: "This part is private." },
];

describe("time", () => {
  test("video times read as omp's seek selectors take them", () => {
    expect(formatTime(0)).toBe("00:00.0");
    expect(formatTime(12_345)).toBe("00:12.3");
    expect(formatTime(3_723_400)).toBe("1:02:03.4");
    expect(formatLength(102_400)).toBe("1:42");
    expect(formatLength(3_723_000)).toBe("1:02:03");
  });

  test("removed parts: trim and cuts merged; times after them move up; times inside them are gone", () => {
    const removed = removedRanges({ v: 1, trim: { start: 1000, end: 20_000 }, cuts: [{ start: 9000, end: 11_000 }, { start: 10_000, end: 12_000 }] }, 30_000);
    expect(removed).toEqual([
      { start: 0, end: 1000 },
      { start: 9000, end: 12_000 },
      { start: 20_000, end: 30_000 },
    ]);
    expect(mapTime(500, removed)).toBeNull();
    expect(mapTime(5000, removed)).toBe(4000);
    expect(mapTime(10_000, removed)).toBeNull();
    expect(mapTime(13_000, removed)).toBe(9000);
    expect(keptLength(30_000, removed)).toBe(16_000);
  });
});

describe("merge", () => {
  test("log and speech in time order, speech first at the same moment; errors and shots collected", () => {
    const tl = buildTimeline({ events, spoken, duration: 15_000 });
    expect(tl.entries.map((e) => `${e.at}:${e.kind}`)).toEqual(["0:tab", "900:shot", "2000:speech", "5000:speech", "5000:click", "5000:shot", "5300:console", "5400:request", "8000:type", "9000:speech", "12000:navigate"]);
    expect(tl.errors.map((e) => e.kind)).toEqual(["console", "request"]);
    expect(tl.shots.map((s) => s.name)).toEqual(["001-00m00s-start.jpg", "002-00m05s-click.jpg"]);
    expect(tl.start).toEqual({ url: "http://shop.test/", title: "Shop" });
  });

  test("a removed part drops what happened and was said in it; hidden lines are left out", () => {
    const tl = buildTimeline({ events, spoken, duration: 15_000, doc: { v: 1, cuts: [{ start: 7500, end: 11_500 }], hidden: [5] } });
    expect(tl.entries.map((e) => `${e.at}:${e.kind}`)).toEqual(["0:tab", "900:shot", "2000:speech", "5000:speech", "5000:click", "5000:shot", "5300:console", "8000:navigate"]);
    expect(tl.duration).toBe(11_000);
  });

  test("speech starting inside a removed part but mostly after it starts where the part ends", () => {
    const tl = buildTimeline({ events: [], spoken: [{ startMs: 1000, endMs: 5000, text: "hello" }], duration: 6000, doc: { v: 1, cuts: [{ start: 500, end: 1500 }] } });
    expect(tl.speech.map((e) => e.at)).toEqual([500]);
  });
});

describe("rendering", () => {
  test("lines say what happened: element, request relative to the page, hidden typing", () => {
    expect(describeEvent(events[2] as RecEvent)).toBe('clicked button "Save" (button#save) at 640,412');
    expect(describeEvent(events[5] as RecEvent, "http://shop.test/")).toBe('POST /api/cart?id=7 → 500 Internal Server Error: {"error":"db locked"}');
    expect(describeEvent(events[6] as RecEvent)).toBe('typed something into password field "Password" (input#pw) (hidden: sensitive)');
    expect(describeEvent({ t: 0, kind: "navigate", url: "http://a.test/b", redirects: ["http://a.test/login"] })).toBe("page http://a.test/b loaded (redirected from http://a.test/login)");
  });

  test("timeline.md: header with the video and how to seek, the timeline, errors and transcript", () => {
    const tl = buildTimeline({ events, spoken, duration: 15_000 });
    const md = timelineMarkdown(tl, { title: "Cart breaks", createdAt: Date.UTC(2026, 10, 1, 13, 3), video: { ref: "/up/cart.mov", width: 1280, height: 832 }, shotRef: (n) => `/up/${n}`, jsonRef: "/up/cart.json" });
    expect(md.startsWith("# Recording: Cart breaks\n")).toBe(true);
    expect(md).toContain("Video: /up/cart.mov (1280×832, 10 fps). Read it to see it, or read `/up/cart.mov:00:14.0` for the frame at a time below.");
    expect(md).toContain('- `00:02.0` said: "Okay look, I add the shoes to the cart."');
    expect(md).toContain('- `00:05.0` clicked button "Save" (button#save) at 640,412');
    expect(md).toContain("- `00:05.0` screenshot: /up/002-00m05s-click.jpg");
    expect(md).toContain("## Errors and failed requests\n\n- `00:05.3` console error: TypeError: cart is undefined (http://shop.test/app.js:41:13)");
    expect(md).toContain("## Transcript\n\nOkay look, I add the shoes to the cart. And it breaks. This part is private.");
    expect(md).toContain("The same as data: /up/cart.json.");
  });

  test("timeline.md without voice says why", () => {
    const md = timelineMarkdown(buildTimeline({ events, spoken: [], duration: 15_000 }), { title: "x", createdAt: 0, voiceNote: "recorded without the microphone", shotRef: (n) => n });
    expect(md).toContain("No transcript: recorded without the microphone.");
    expect(md).not.toContain("## Transcript");
  });

  test("timeline.json carries entries with their fields, the transcript and the screenshots as data", () => {
    const tl = buildTimeline({ events, spoken, duration: 15_000, doc: { v: 1, cuts: [{ start: 8500, end: 11_500 }] } });
    const data = JSON.parse(timelineJson(tl, { title: "Cart breaks", createdAt: 0, shotRef: (n) => `/up/${n}` }, events, spoken));
    expect(data.format).toBe("teleflock-recording/1");
    expect(data.durationMs).toBe(12_000);
    expect(data.entries.find((e: { kind: string }) => e.kind === "request")).toMatchObject({ atMs: 5400, time: "00:05.4", method: "POST", status: 500 });
    expect(data.entries.find((e: { kind: string }) => e.kind === "speech")).toMatchObject({ said: "Okay look, I add the shoes to the cart." });
    expect(data.transcript.map((s: { text: string }) => s.text)).toEqual(["Okay look, I add the shoes to the cart.", "And it breaks."]);
    expect(data.shots[1]).toEqual({ atMs: 5000, time: "00:05.0", reason: "click", file: "/up/002-00m05s-click.jpg" });
    expect(data.removed).toEqual([{ startMs: 8500, endMs: 11_500 }]);
  });
});
