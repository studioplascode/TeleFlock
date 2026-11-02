import { describe, expect, test } from "bun:test";
import type { SlotBackend } from "./draftSlots";
import { type MirrorRecord, mirroredItem } from "./mirrored";

/** localStorage as a Map; `limit`: values longer than that are refused like a full storage. */
function memoryStorage(entries: Record<string, string> = {}, limit = Infinity): Storage {
  const m = new Map(Object.entries(entries));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => {
      if (v.length > limit) throw new DOMException("quota", "QuotaExceededError");
      m.set(k, v);
    },
  };
}

/**
 * IndexedDB's copy: reads wait for `release()` unless `readNow`; writes are stored at once, or with
 * `holdWrites` when `complete()` is called. (Every item stays registered with `flushAll` for the
 * rest of the test run, so none may be left with a write that never completes.)
 */
function idb(stored?: MirrorRecord, opts: { readNow?: boolean; holdWrites?: boolean } = {}) {
  const records = new Map<string, MirrorRecord>(stored ? [["item", stored]] : []);
  const writes: MirrorRecord[] = [];
  const waiting: (() => void)[] = [];
  let release = () => {};
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  const read = opts.readNow ? Promise.resolve(stored) : new Promise<MirrorRecord | undefined>((resolve) => (release = () => resolve(stored)));
  const backend: SlotBackend<MirrorRecord> = {
    read: () => read,
    write: (key, value) =>
      new Promise<void>((resolve) => {
        if (value) writes.push(value);
        const store = () => {
          if (value) records.set(key, value);
          else records.delete(key);
          resolve();
        };
        if (opts.holdWrites) waiting.push(store);
        else store();
      }),
  };
  return {
    backend,
    records,
    writes,
    release: () => release(),
    /** Completes every write held so far. */
    complete: () => {
      for (const done of waiting.splice(0)) done();
    },
  };
}

const record = (rev: number, value: string | null): MirrorRecord => ({ rev, at: 1, value });

/** Lets every promise that can settle without outside help settle (no clock involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("a localStorage item mirrored to IndexedDB", () => {
  test("a kill that lost localStorage's last writes: the newer IndexedDB copy wins at start", async () => {
    // localStorage still has revision 4 on disk; IndexedDB got 5 before the process was killed.
    const storage = memoryStorage({ item: "draft as of rev 4", "item@rev": "4" });
    const db = idb(record(5, "draft typed right before the kill"), { readNow: true });
    const item = mirroredItem("item", { storage, backend: db.backend });
    expect(item.initial).toBe("draft as of rev 4");
    expect(await item.load()).toBe("draft typed right before the kill");
    // The next write goes past both copies' revisions.
    item.set("edited after the restart");
    expect(storage.getItem("item")).toBe("edited after the restart");
    expect(storage.getItem("item@rev")).toBe("6");
    expect(db.writes.at(-1)).toMatchObject({ rev: 6, value: "edited after the restart" });
  });

  test("localStorage's copy stands when IndexedDB's is no newer or malformed", async () => {
    for (const stored of [record(4, "older"), record(3, "even older"), { rev: "9", value: 12 } as unknown as MirrorRecord, undefined]) {
      const storage = memoryStorage({ item: "current", "item@rev": "4" });
      const item = mirroredItem("item", { storage, backend: idb(stored, { readNow: true }).backend });
      expect(await item.load()).toBeUndefined();
    }
  });

  test("a deletion is recorded in IndexedDB, so a stale localStorage copy doesn't come back", async () => {
    const storage = memoryStorage({ item: "sent prompt", "item@rev": "2" });
    const db = idb(record(2, "sent prompt"), { readNow: true });
    const item = mirroredItem("item", { storage, backend: db.backend });
    await item.load();
    item.set(null);
    db.complete();
    await item.flushed();
    expect(storage.getItem("item")).toBeNull();
    expect(db.records.get("item")).toMatchObject({ rev: 3, value: null });
    // The kill came before localStorage's commit: it still has revision 2 on disk.
    const restarted = mirroredItem("item", { storage: memoryStorage({ item: "sent prompt", "item@rev": "2" }), backend: idb(db.records.get("item"), { readNow: true }).backend });
    expect(await restarted.load()).toBeNull();
  });

  test("a value set before IndexedDB answered is written after it, and wins", async () => {
    const storage = memoryStorage({ item: "old", "item@rev": "1" });
    const db = idb(record(7, "newer copy"));
    const item = mirroredItem("item", { storage, backend: db.backend });
    item.set("typed while it loads");
    expect(storage.getItem("item")).toBe("old");
    expect(db.writes).toEqual([]);
    db.release();
    expect(await item.load()).toBeUndefined();
    expect(storage.getItem("item")).toBe("typed while it loads");
    expect(storage.getItem("item@rev")).toBe("8");
    expect(db.writes.map(({ rev, value }) => ({ rev, value }))).toEqual([{ rev: 8, value: "typed while it loads" }]);
  });

  test("a full localStorage gets the smaller value; IndexedDB the whole one", async () => {
    const storage = memoryStorage({}, 10);
    const db = idb(undefined, { readNow: true });
    const item = mirroredItem("item", { storage, backend: db.backend });
    await item.load();
    item.set("a value far too long for it", () => "short");
    expect(storage.getItem("item")).toBe("short");
    expect(db.writes.at(-1)?.value).toBe("a value far too long for it");
    // Nothing fits: localStorage keeps its old revision, so the IndexedDB copy wins next time.
    item.set("another value far too long", () => "still too long");
    expect(storage.getItem("item")).toBe("short");
    expect(storage.getItem("item@rev")).toBe("1");
    expect(db.writes.at(-1)).toMatchObject({ rev: 2, value: "another value far too long" });
  });

  test("another tab's later write is never outranked", async () => {
    const storage = memoryStorage({ item: "a", "item@rev": "3" });
    const db = idb(undefined, { readNow: true });
    const item = mirroredItem("item", { storage, backend: db.backend });
    await item.load();
    storage.setItem("item@rev", "40");
    item.set("b");
    expect(storage.getItem("item@rev")).toBe("41");
    expect(db.writes.at(-1)?.rev).toBe(41);
  });

  test("an IndexedDB that never answers holds writes up only for the load wait", async () => {
    const storage = memoryStorage();
    const db = idb(record(9, "never read"));
    // The bound is a real timer by design (the platform's IndexedDB may hang); 20 ms keeps it short.
    const item = mirroredItem("item", { storage, backend: db.backend, loadWaitMs: 20 });
    item.set("typed");
    expect(await item.load()).toBeUndefined();
    expect(storage.getItem("item")).toBe("typed");
  });

  test("flushed() resolves once IndexedDB stored everything set so far", async () => {
    const db = idb(undefined, { readNow: true, holdWrites: true });
    const item = mirroredItem("item", { storage: memoryStorage(), backend: db.backend });
    item.set("one");
    item.set("two");
    let done = false;
    const flushed = item.flushed().then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    db.complete();
    await flushed;
    expect(db.records.get("item")?.value).toBe("two");
  });
});
