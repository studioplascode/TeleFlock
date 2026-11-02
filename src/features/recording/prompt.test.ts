import { describe, expect, test } from "bun:test";
import type { RecordingInfo } from "@/core/gen";
import type { RecEvent } from "./model";
import { docOf, fileStem, INLINE_MAX_LINES, inlineTimeline, pickShots, recordingRef, SILENT_TASK, spokenText, taskText, voiceNote } from "./prompt";
import { buildTimeline, type Spoken } from "./timeline";

const shot = (t: number, reason: "start" | "click" | "page" | "error" | "end"): RecEvent => ({ t, kind: "shot", name: `${t}-${reason}.jpg`, reason });

describe("inline timeline", () => {
  test("short timelines go inline as plain lines; long ones only as the file", () => {
    const few: RecEvent[] = [{ t: 0, kind: "navigate", url: "http://a.test/" }, shot(100, "start")];
    expect(inlineTimeline(buildTimeline({ events: few, spoken: [], duration: 1000 }), (n) => `/h/${n}`)).toBe("00:00.0 page http://a.test/ loaded\n00:00.1 screenshot: /h/100-start.jpg");
    const many: RecEvent[] = Array.from({ length: INLINE_MAX_LINES + 1 }, (_, i) => ({ t: i * 1000, kind: "key", combo: "Enter" }));
    expect(inlineTimeline(buildTimeline({ events: many, spoken: [], duration: 100_000 }), (n) => n)).toBeNull();
    const wide: RecEvent[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 1000, kind: "console", level: "error", text: "x".repeat(400) }));
    expect(inlineTimeline(buildTimeline({ events: wide, spoken: [], duration: 100_000 }), (n) => n)).toBeNull();
  });
});

describe("screenshots", () => {
  test("error shots first, then clicks just before an error, start, end and pages; the chosen ones in time order", () => {
    const events: RecEvent[] = [shot(0, "start"), shot(1000, "page"), shot(4000, "click"), { t: 5000, kind: "exception", text: "boom" }, shot(5400, "error"), shot(9000, "click"), shot(20_000, "end")];
    const tl = buildTimeline({ events, spoken: [], duration: 21_000 });
    expect(pickShots(tl, 3)).toEqual(["0-start.jpg", "4000-click.jpg", "5400-error.jpg"]);
    expect(pickShots(tl, 5)).toEqual(["0-start.jpg", "1000-page.jpg", "4000-click.jpg", "5400-error.jpg", "20000-end.jpg"]);
    expect(pickShots(tl, 0)).toEqual([]);
  });
});

describe("prompt block", () => {
  test("names the timeline first, the video with how to seek, the screenshots, and carries a short timeline", () => {
    const ref = recordingRef({
      title: "Cart breaks",
      duration: 102_000,
      timeline: "/h/up/cart-1a2b-timeline.md",
      json: "/h/up/cart-1a2b-timeline.json",
      video: { path: "/h/up/cart-1a2b.mov", bytes: 12.3 * 1024 * 1024 },
      shotFiles: 9,
      shotImages: 4,
      inline: "00:00.0 page http://a.test/ loaded",
    });
    expect(ref).toBe(
      [
        'Attached recording "Cart breaks" (1:42, made in the TeleFlock Browser): what I did and said, and what failed, in order, with times into the video.',
        "- Timeline: /h/up/cart-1a2b-timeline.md (read it first; the same as data: /h/up/cart-1a2b-timeline.json)",
        "- Video: /h/up/cart-1a2b.mov (12.3 MB, 10 fps; read it to see it, or read /h/up/cart-1a2b.mov:00:14.0 for the frame at a time in the timeline)",
        "- Screenshots: 9 files, named in the timeline at the moment each was taken; 4 of them attached as images too",
        "",
        "Timeline:",
        "00:00.0 page http://a.test/ loaded",
      ].join("\n"),
    );
  });

  test("without voice it says why; without screenshots or video those lines are left out", () => {
    const ref = recordingRef({ title: "x", duration: 1000, timeline: "/t.md", shotFiles: 0, shotImages: 0, voiceNote: "no speech model on the recording device (Settings → Dictation)" });
    expect(ref).toContain("- No transcript: no speech model on the recording device (Settings → Dictation)");
    expect(ref).not.toContain("Video:");
    expect(ref).not.toContain("Screenshots:");
  });
});

describe("task text", () => {
  const info = (over: Partial<RecordingInfo>): Pick<RecordingInfo, "voice" | "transcript" | "doc"> => ({ voice: { state: "on" }, transcript: { state: "done", segments: [{ startMs: 0, endMs: 1000, text: "Fix the cart." }] }, ...over });

  test("an edit wins, then Rambler's rewrite when chosen, then what was said, then a default", () => {
    expect(taskText({ v: 1, task: " Mine ", cleaned: "Clean", useCleaned: true }, "said")).toBe("Mine");
    expect(taskText({ v: 1, cleaned: "Clean", useCleaned: true }, "said")).toBe("Clean");
    expect(taskText({ v: 1, cleaned: "Clean" }, "said")).toBe("said");
    expect(taskText({ v: 1 }, "  ")).toBe(SILENT_TASK);
  });

  test("what was said leaves out removed and hidden lines", () => {
    const spoken: Spoken[] = [
      { startMs: 0, endMs: 1000, text: "One." },
      { startMs: 2000, endMs: 3000, text: "Two." },
      { startMs: 4000, endMs: 5000, text: "Three." },
    ];
    const tl = buildTimeline({ events: [], spoken, duration: 6000, doc: { v: 1, cuts: [{ start: 1800, end: 3200 }], hiddenSpeech: [2] } });
    expect(spokenText(spoken, tl)).toBe("One.");
  });

  test("why there is no transcript, from the voice and the transcription", () => {
    expect(voiceNote(info({}))).toBeUndefined();
    expect(voiceNote(info({ voice: { state: "off" } }))).toBe("recorded without the microphone");
    expect(voiceNote(info({ voice: { state: "failed", message: "permission denied" } }))).toBe("the microphone didn't work: permission denied");
    expect(voiceNote(info({ transcript: { state: "noModel", segments: [] } }))).toBe("no speech model on the recording device (Settings → Dictation)");
    expect(voiceNote(info({ transcript: { state: "running", progress: 0.4, segments: [] } }))).toBe("the transcript was not ready yet");
    expect(voiceNote(info({ transcript: { state: "done", segments: [{ startMs: 0, endMs: 1, text: " " }] } }))).toBe("nothing was said");
  });

  test("a stored document of another shape is ignored; file names come from the title", () => {
    expect(docOf({ doc: { v: 2, task: "x" } })).toEqual({ v: 1 });
    expect(docOf({ doc: { v: 1, task: "x" } })).toEqual({ v: 1, task: "x" });
    expect(fileStem("Shop — Cart Ärger! · 14:03", "rec_ab12cd34ef")).toBe("shop-cart-arger-ab12");
    expect(fileStem("···", "rec_zz")).toBe("recording-zz");
  });
});
