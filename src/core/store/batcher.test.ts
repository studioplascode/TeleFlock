import { describe, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { FrameBatcher, type FrameScheduler } from "./batcher";
import { reduceEvents } from "./reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "./state";

/** A scheduler that runs frames only when the test says so. */
function manualFrames(): { schedule: FrameScheduler; frame(): void; scheduled(): number } {
  let pending: (() => void)[] = [];
  let count = 0;
  return {
    schedule(cb) {
      count++;
      pending.push(cb);
      return () => {
        pending = pending.filter((x) => x !== cb);
      };
    },
    frame() {
      const run = pending;
      pending = [];
      for (const cb of run) cb();
    },
    scheduled: () => count,
  };
}

const status = (phase: "online" | "offline", since: number): CoreEvent => ({ type: "hostStatus", hostId: "h", status: { phase, since, attempt: 0 } });

describe("FrameBatcher", () => {
  test("many pushes in one frame → one flush, in order", () => {
    const frames = manualFrames();
    const flushed: number[][] = [];
    const b = new FrameBatcher<number>((items) => flushed.push(items), frames.schedule);
    for (let i = 0; i < 100; i++) b.push(i);
    expect(frames.scheduled()).toBe(1);
    expect(flushed).toHaveLength(0);
    frames.frame();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(Array.from({ length: 100 }, (_, i) => i));
    b.push(100);
    expect(frames.scheduled()).toBe(2);
    frames.frame();
    expect(flushed).toEqual([flushed[0] as number[], [100]]);
  });

  test("flushNow cancels the scheduled frame", () => {
    const frames = manualFrames();
    let flushes = 0;
    const b = new FrameBatcher<number>(() => flushes++, frames.schedule);
    b.push(1);
    b.flushNow();
    frames.frame();
    expect(flushes).toBe(1);
    expect(b.pending).toBe(0);
  });

  test("a frame of AppEvents produces exactly one store update", () => {
    const frames = manualFrames();
    const store = createStore<CoreState>(() => initialCoreState("demo"));
    let updates = 0;
    store.subscribe(() => updates++);
    const b = new FrameBatcher<CoreEvent>((events) => {
      store.setState(reduceEvents(store.getState(), events).state, true);
    }, frames.schedule);
    for (let i = 0; i < 50; i++) b.push(status(i % 2 ? "online" : "offline", i));
    b.push({ type: "settings", settings: { motion: "full", notifyNeeds: true, notifyFinished: true, notifyErrors: true, notifySound: false, keepAlive: true, terminalFontSize: 13, defaultPlan: false, deviceName: "x", mutedAgents: [], templates: [], autoUpdate: true, closeDone: true } });
    expect(updates).toBe(0);
    frames.frame();
    expect(updates).toBe(1);
    expect(store.getState().status.h?.since).toBe(49);
    expect(store.getState().settings?.motion).toBe("full");
  });
});
