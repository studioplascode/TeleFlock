import { describe, expect, test } from "bun:test";
import { flushAll, onFlush, trackDraftWork } from "./draftFlush";
import { draftSlots, type SlotBackend } from "./draftSlots";

interface Stored {
  items: string[];
  at: number;
}

/** A draft kind whose storage answers when told: reads on `release()`, writes on `complete()`. */
function kind(stored: Record<string, string[]> = {}, opts: { readNow?: boolean } = {}) {
  const records = new Map(Object.entries(stored));
  const waiting: (() => void)[] = [];
  let release = () => {};
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  const gate = opts.readNow ? Promise.resolve() : new Promise<void>((resolve) => (release = resolve));
  const backend: SlotBackend<Stored> = {
    read: async (key) => {
      await gate;
      const items = records.get(key);
      return items ? { items, at: 1 } : undefined;
    },
    write: (key, value) =>
      new Promise<void>((resolve) => {
        waiting.push(() => {
          if (value) records.set(key, value.items);
          else records.delete(key);
          resolve();
        });
      }),
  };
  const slots = draftSlots<string[], Stored>({ backend, empty: [], isEmpty: (v) => v.length === 0, decode: (s) => s?.items ?? [], encode: (items) => ({ items, at: Date.now() }) });
  return {
    slots,
    records,
    release: () => release(),
    complete: () => {
      for (const done of waiting.splice(0)) done();
    },
  };
}

/** Lets every promise that can settle without outside help settle (no clock involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("flushAll: every unsent draft stored before the app ends", () => {
  test("waits for an attachment still waiting for its stored list, then for its write", async () => {
    const k = kind({ k: ["pasted before the restart"] });
    // Added before the stored list was read: held, then written on top of it.
    k.slots.update("k", (cur) => [...cur, "pasted just now"]);
    let done = false;
    const flushed = flushAll().then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    k.release();
    await settle();
    expect(done).toBe(false);
    k.complete();
    await flushed;
    expect(k.records.get("k")).toEqual(["pasted before the restart", "pasted just now"]);
  });

  test("waits for an image being read and stores it too", async () => {
    const k = kind({}, { readNow: true });
    await k.slots.hydrate("img");
    let read = () => {};
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const reading = new Promise<void>((resolve) => (read = resolve)).then(() => k.slots.update("img", (cur) => [...cur, "screenshot"]));
    trackDraftWork(reading);
    let done = false;
    const flushed = flushAll().then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    read();
    await settle();
    k.complete();
    await flushed;
    expect(k.records.get("img")).toEqual(["screenshot"]);
  });

  test("work that never ends holds it up only for the bound, and what was there is stored first", async () => {
    const calls: string[] = [];
    const off = onFlush(() => void calls.push("text written"));
    let unstick = () => {};
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    trackDraftWork(new Promise<void>((resolve) => (unstick = resolve)));
    try {
      // The bound is a real timer by design (a decode can hang); 20 ms keeps it short.
      await flushAll(20);
      expect(calls).toEqual(["text written", "text written"]);
    } finally {
      off();
      unstick();
    }
  });
});
