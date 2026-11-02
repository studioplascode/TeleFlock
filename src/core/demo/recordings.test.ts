import { describe, expect, test } from "bun:test";
import type { AppEvent, RecordingAppended, RecordingDetail, RecordingInfo, RecordingList } from "@/core/gen";
import { ManualClock } from "./clock";
import { DemoRecordings } from "./recordings";

function demo() {
  const clock = new ManualClock();
  const events: AppEvent[] = [];
  const recs = new DemoRecordings({ clock, emit: (e) => events.push(e) });
  return { clock, events, recs };
}

describe("demo recordings", () => {
  test("record, pause, stop: saved after a moment, then a transcript; the list follows every change", () => {
    const { clock, events, recs } = demo();
    const started = recs.call("recording.start", {}) as RecordingInfo;
    expect(started).toMatchObject({ state: "recording", voice: { state: "on" }, transcript: { state: "waiting" } });
    expect(() => recs.call("recording.start", {})).toThrow("A recording is running");
    clock.advance(2000);
    const appended = recs.call("recording.append", { id: started.id, frames: [{ t: 100, data: "AAAA", width: 1280, height: 832 }], events: [{ t: 100, kind: "navigate", url: "http://a.test/" }], shots: [{ name: "001-00m00s-start.jpg", data: "AAAA" }, { name: "002-00m01s-click.jpg", data: "AAA=" }] }) as RecordingAppended;
    expect(appended.durationMs).toBe(2000);
    recs.call("recording.pause", { id: started.id });
    clock.advance(5000);
    recs.call("recording.resume", { id: started.id });
    clock.advance(4000);
    expect(recs.call("recording.stop", { id: started.id })).toMatchObject({ state: "processing", durationMs: 6000 });
    clock.advance(800);
    clock.advance(1500);
    const list = recs.call("recording.list", {}) as RecordingList;
    expect(list.recordings[0]).toMatchObject({ id: started.id, state: "ready", video: "recording.mov", width: 1280, transcript: { state: "done" } });
    expect(list.recordings[0]?.transcript.segments.length).toBe(3);
    const detail = recs.call("recording.get", { id: started.id }) as RecordingDetail;
    expect(detail.events).toEqual([{ t: 100, kind: "navigate", url: "http://a.test/" }]);
    expect(detail.shots).toEqual([
      { name: "001-00m00s-start.jpg", size: 3 },
      { name: "002-00m01s-click.jpg", size: 2 },
    ]);
    expect(recs.call("recording.read", { id: started.id, file: "shots/002-00m01s-click.jpg", offset: 0, length: 10 })).toEqual({ data: "AAA=", size: 2 });
    expect(events.every((e) => e.type === "recordings")).toBe(true);
    expect(events.length).toBeGreaterThan(5);
  });

  test("an info it handed out doesn't change when the recording moves on: the review sheet follows the list, not an object it holds", () => {
    const { clock, events, recs } = demo();
    const started = recs.call("recording.start", {}) as RecordingInfo;
    const stopped = recs.call("recording.stop", { id: started.id }) as RecordingInfo;
    const lastList = () => (events.at(-1) as Extract<AppEvent, { type: "recordings" }>).recordings;
    const held = lastList().recordings[0];
    expect(held).toMatchObject({ state: "processing" });
    clock.advance(800);
    clock.advance(1500);
    expect(stopped.state).toBe("processing");
    expect(held).toMatchObject({ state: "processing", transcript: { state: "waiting" } });
    expect(lastList().recordings[0]).toMatchObject({ state: "ready", transcript: { state: "done" } });
    expect((recs.call("recording.get", { id: started.id }) as RecordingDetail).info).toMatchObject({ state: "ready" });
  });

  test("the seeded recording reviews and renders; a cut renders a shorter video", () => {
    const { recs } = demo();
    recs.seed();
    const [r] = (recs.call("recording.list", {}) as RecordingList).recordings;
    expect(r).toMatchObject({ title: "Checkout total stays at 0 · Demo Shop", state: "ready" });
    const bundle = recs.call("recording.render", { id: r?.id, cuts: [{ startMs: 9000, endMs: 11_000 }], files: [{ name: "timeline.md", text: "# x" }] });
    expect(bundle).toMatchObject({ video: { file: "bundle/recording.mov" }, files: [{ file: "bundle/timeline.md", size: 3 }], durationMs: 13_000 });
    recs.call("recording.delete", { id: r?.id });
    expect((recs.call("recording.list", {}) as RecordingList).recordings).toEqual([]);
  });
});
