import { beforeEach, describe, expect, test } from "bun:test";
import { type DraftImageBackend, getDraftImages, hydrateDraftImages, setDraftImageBackend, setDraftImages, type StoredDraft, updateDraftImages } from "./draftImages";
import { type DraftEntry, draftKey, drafts, pruneDrafts, useDrafts } from "./drafts";
import { answerDraftKey, staleAnswerDrafts } from "./draftSweep";
import type { CoreState } from "./store/state";

const DAY = 86_400_000;
const limits = { maxEntries: 3, maxAgeMs: 10 * DAY, maxChars: 40 };

describe("pruneDrafts", () => {
  test("drops expired and malformed entries", () => {
    const now = 100 * DAY;
    const all = { a: { v: "x", at: now - DAY }, old: { v: "y", at: now - 11 * DAY }, bad: { v: 3, at: now } } as unknown as Record<string, DraftEntry>;
    expect(Object.keys(pruneDrafts(all, now, limits))).toEqual(["a"]);
  });

  test("keeps the newest within the entry cap", () => {
    const all = { a: { v: "1", at: 1 }, b: { v: "2", at: 4 }, c: { v: "3", at: 3 }, d: { v: "4", at: 2 } };
    expect(Object.keys(pruneDrafts(all, 5, limits)).sort()).toEqual(["b", "c", "d"]);
  });

  test("skips an entry too big for the remaining budget but still fits smaller older ones", () => {
    const all = { new: { v: "x".repeat(20), at: 3 }, big: { v: "y".repeat(30), at: 2 }, small: { v: "z", at: 1 } };
    expect(Object.keys(pruneDrafts(all, 4, limits)).sort()).toEqual(["new", "small"]);
  });
});

describe("drafts", () => {
  beforeEach(() => {
    useDrafts.setState({ drafts: {} });
  });

  test("a value equal to the field's default deletes the draft", () => {
    drafts.set("k", "hello");
    expect(drafts.get("k")).toBe("hello");
    drafts.set("k", "");
    expect(useDrafts.getState().drafts.k).toBeUndefined();
  });

  test("with a prefilled default, an emptied field is a real draft", () => {
    drafts.set("title", "", "Current title");
    expect(drafts.get("title", "Current title")).toBe("");
    drafts.set("title", "Current title", "Current title");
    expect(useDrafts.getState().drafts.title).toBeUndefined();
    expect(drafts.get("title", "Live title")).toBe("Live title");
  });

  test("clear and clearWhere only touch matching keys", () => {
    drafts.set(draftKey("a", "1"), "x");
    drafts.set(draftKey("a", "2"), "y");
    drafts.set(draftKey("b", "1"), "z");
    drafts.clear(draftKey("a", "1"));
    expect(drafts.keys().sort()).toEqual([draftKey("a", "2"), draftKey("b", "1")].sort());
    drafts.clearWhere((k) => k.startsWith(draftKey("b")));
    expect(drafts.keys()).toEqual([draftKey("a", "2")]);
  });
});

describe("staleAnswerDrafts", () => {
  const key = (agent: string, req: string) => answerDraftKey(agent, req, "other");
  const online = { phase: "online" as const, since: 0 };
  const state = {
    status: { h: online, off: { phase: "offline" as const, since: 0 } },
    hosts: { h: {}, off: {} },
    agents: { "h::a": { needs: { requestId: "r1" } }, "off::b": {} },
  } as unknown as Pick<CoreState, "agents" | "hosts" | "status">;

  test("prunes answers whose request is gone from an online host, after a grace period", () => {
    const entries = {
      [key("h::a", "r1")]: { at: 0 },
      [key("h::a", "r0")]: { at: 0 },
      [key("h::gone", "r9")]: { at: 0 },
      [key("h::a", "r2")]: { at: 99_000 },
      [key("off::b", "r5")]: { at: 0 },
      [draftKey("composer", "h::gone")]: { at: 0 },
    };
    expect(staleAnswerDrafts(state, entries, 100_000).sort()).toEqual([key("h::a", "r0"), key("h::gone", "r9")].sort());
  });
});

describe("draft images without IndexedDB", () => {
  test("live in memory, capped at 8, and clear", async () => {
    await hydrateDraftImages("img");
    const img = (n: number) => ({ mime: "image/png", data: String(n), preview: `data:image/png;base64,${n}` });
    setDraftImages("img", Array.from({ length: 10 }, (_, i) => img(i)));
    expect(getDraftImages("img")).toHaveLength(8);
    setDraftImages("img", []);
    expect(getDraftImages("img")).toEqual([]);
  });
});

describe("draft images edited while the stored ones load", () => {
  const img = (data: string) => ({ mime: "image/png", data, preview: `data:image/png;base64,${data}` });
  const stored: StoredDraft = { images: [{ mime: "image/png", data: "old" }], at: Date.now() };

  /** A store whose read waits for `release()`; records every write. */
  function deferredStore() {
    const writes: [string, StoredDraft | null][] = [];
    let release = () => {};
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const read = new Promise<StoredDraft>((resolve) => (release = () => resolve(stored)));
    const backend: DraftImageBackend = { read: () => read, write: (key, value) => void writes.push([key, value]) };
    return { backend, writes, release: () => release() };
  }

  test("a clear before the read resolves stays a clear", async () => {
    const store = deferredStore();
    const prev = setDraftImageBackend(store.backend);
    try {
      const hydrated = hydrateDraftImages("race-clear");
      setDraftImages("race-clear", []);
      store.release();
      await hydrated;
      expect(getDraftImages("race-clear")).toEqual([]);
      expect(store.writes).toEqual([["race-clear", null]]);
    } finally {
      setDraftImageBackend(prev);
    }
  });

  test("added and removed images replay on top of the stored ones, written only after the read", async () => {
    const store = deferredStore();
    const prev = setDraftImageBackend(store.backend);
    try {
      const pasted = img("pasted");
      const dropped = img("dropped");
      // Editing a key nobody has hydrated yet starts the read.
      updateDraftImages("race-edit", (cur) => [...cur, pasted, dropped]);
      updateDraftImages("race-edit", (cur) => cur.filter((i) => i !== dropped));
      expect(getDraftImages("race-edit").map((i) => i.data)).toEqual(["pasted"]);
      expect(store.writes).toEqual([]);
      store.release();
      await hydrateDraftImages("race-edit");
      expect(getDraftImages("race-edit").map((i) => i.data)).toEqual(["old", "pasted"]);
      expect(store.writes.map(([k, v]) => [k, v?.images.map((i) => i.data)])).toEqual([["race-edit", ["old", "pasted"]]]);
    } finally {
      setDraftImageBackend(prev);
    }
  });
});
