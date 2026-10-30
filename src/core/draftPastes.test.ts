import { describe, expect, test } from "bun:test";
import { type DraftPasteBackend, draftPastes, MAX_DRAFT_PASTES, type StoredPastes } from "./draftPastes";
import type { DraftPaste } from "./pastes";

const paste = (n: number, at = n): DraftPaste => ({ n, text: `text ${n}\n`.repeat(12), mode: "inline", at });

/** A store whose reads wait for `release()`; records every write. */
function deferredStore(stored: StoredPastes | undefined) {
  const writes: [string, StoredPastes | null][] = [];
  let release = () => {};
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  const read = new Promise<StoredPastes | undefined>((resolve) => (release = () => resolve(stored)));
  const backend: DraftPasteBackend = { read: () => read, write: (key, value) => void writes.push([key, value]), keys: async () => (stored ? ["stored"] : []) };
  return { backend, writes, release: () => release() };
}

describe("draft pastes persist like draft images", () => {
  test("a reload brings them back; malformed stored entries are dropped", async () => {
    const good = paste(1);
    const store = deferredStore({ pastes: [good, { n: "x", text: 1 } as unknown as DraftPaste, { ...paste(2), mode: "weird" } as unknown as DraftPaste], at: Date.now() });
    const prev = draftPastes.setBackend(store.backend);
    try {
      const hydrated = draftPastes.hydrate("reload");
      store.release();
      await hydrated;
      expect(draftPastes.get("reload")).toEqual([good]);
      expect(store.writes).toEqual([]);
    } finally {
      draftPastes.setBackend(prev);
    }
  });

  test("a paste added while the stored ones load lands after them and is written once they are in", async () => {
    const store = deferredStore({ pastes: [paste(1)], at: Date.now() });
    const prev = draftPastes.setBackend(store.backend);
    try {
      draftPastes.update("race", (cur) => [...cur, paste(2)]);
      expect(draftPastes.get("race").map((p) => p.n)).toEqual([2]);
      expect(store.writes).toEqual([]);
      store.release();
      await draftPastes.hydrate("race");
      expect(draftPastes.get("race").map((p) => p.n)).toEqual([1, 2]);
      expect(store.writes.map(([k, v]) => [k, v?.pastes.map((p) => p.n)])).toEqual([["race", [1, 2]]]);
      // Sent: the empty list deletes the stored draft.
      draftPastes.update("race", () => []);
      expect(store.writes.at(-1)).toEqual(["race", null]);
      expect(await draftPastes.keys()).toContain("stored");
    } finally {
      draftPastes.setBackend(prev);
    }
  });

  test("capped at the newest MAX_DRAFT_PASTES, kept in number order", async () => {
    await draftPastes.hydrate("cap");
    draftPastes.update("cap", () => Array.from({ length: MAX_DRAFT_PASTES + 4 }, (_, i) => paste(i + 1)));
    const kept = draftPastes.get("cap");
    expect(kept).toHaveLength(MAX_DRAFT_PASTES);
    expect(kept[0]?.n).toBe(5);
    expect(kept.at(-1)?.n).toBe(MAX_DRAFT_PASTES + 4);
    draftPastes.update("cap", () => []);
  });
});
