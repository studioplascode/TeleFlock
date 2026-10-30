import { describe, expect, test } from "bun:test";
import type { PastSession, SearchPage, SearchSnippet, SessionSearchHit } from "@/core/gen";
import { applyPage, failed, IDLE, mergeEntries, searchNote, searchQuery, SEARCHING, type SearchState, snippetLabel, startSearch } from "./searchModel";

const sess = (file: string, title: string, over: Partial<PastSession> = {}): PastSession => ({ file, id: `id-${file}`, title, cwd: "/code/app", updatedAt: 1, live: false, ...over });
const hit = (s: PastSession, matches = 1): SessionSearchHit => ({ session: s, matches, snippets: [] });
const page = (hits: SessionSearchHit[], over: Partial<SearchPage> = {}): SearchPage => ({ searchId: "s1", hits, total: hits.length, files: 1, filesTotal: 4, bytes: 0, elapsedMs: 10, done: false, ...over });

/** Lets pending promise continuations run (microtasks only). */
async function tick() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** A host whose answers the test releases one by one, recording every request. */
function fakeHost() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const waiting: ((v: unknown) => void)[] = [];
  let inflight = 0;
  let maxInflight = 0;
  return {
    calls,
    maxInflight: () => maxInflight,
    host: {
      call: ((method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "search.cancel") return Promise.resolve({});
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        // tsconfig's lib predates Promise.withResolvers
        return new Promise((resolve, reject) =>
          waiting.push((v) => {
            inflight--;
            if (v instanceof Error) reject(v);
            else resolve(v);
          }),
        );
      }) as never,
    },
    /** Releases the oldest request, then lets the code under test react (microtasks only). */
    async answer(v: unknown) {
      (waiting.shift() as (v: unknown) => void)(v);
      await tick();
    },
  };
}

describe("searchQuery", () => {
  test("needs two non-space characters and trims", () => {
    expect(searchQuery("a")).toBeNull();
    expect(searchQuery("a ")).toBeNull();
    expect(searchQuery(" a  b ")).toBe("a  b");
    expect(searchQuery("ab")).toBe("ab");
  });
});

describe("applyPage / failed", () => {
  test("pages append hits and carry progress; done ends the search", () => {
    const a = sess("a", "A");
    const b = sess("b", "B");
    let s: SearchState = SEARCHING;
    s = applyPage(s, page([hit(a)]));
    s = applyPage(s, page([hit(b)], { files: 4, done: true, stopped: "time" }));
    expect(s).toMatchObject({ status: "done", files: 4, filesTotal: 4, stopped: "time" });
    expect(s.hits.map((h) => h.session.file)).toEqual(["a", "b"]);
  });

  test("unknown_method means unsupported; other failures keep the hits found", () => {
    expect(failed(SEARCHING, { code: "unknown_method", message: "x" })).toMatchObject({ status: "unsupported", hits: [] });
    const held = applyPage(SEARCHING, page([hit(sess("a", "A"))]));
    expect(failed(held, new Error("boom"))).toMatchObject({ status: "error", error: "boom", hits: [{ session: { file: "a" } }] });
  });
});

describe("startSearch", () => {
  test("starts, then polls after the hits held until done, one request at a time", async () => {
    const f = fakeHost();
    const got: SearchPage[] = [];
    const run = startSearch(f.host, { query: "needle", cwd: "/code/app" }, { page: (p) => got.push(p), error: () => {} });
    await tick();
    await f.answer(page([hit(sess("a", "A")), hit(sess("b", "B"))]));
    await f.answer(page([], { files: 3 }));
    await f.answer(page([hit(sess("c", "C"))], { files: 4, done: true }));
    await run.settled;
    expect(f.calls.map((c) => c.method)).toEqual(["search.start", "search.poll", "search.poll"]);
    expect(f.calls[0]?.params).toMatchObject({ query: "needle", cwd: "/code/app", waitMs: 1500 });
    expect(f.calls.slice(1).map((c) => c.params.after)).toEqual([2, 2]);
    expect(got).toHaveLength(3);
    expect(f.maxInflight()).toBe(1);
  });

  test("a cancel mid-search reports nothing more and cancels the host's search", async () => {
    const f = fakeHost();
    const got: SearchPage[] = [];
    const run = startSearch(f.host, { query: "needle" }, { page: (p) => got.push(p), error: () => {} });
    await tick();
    await f.answer(page([hit(sess("a", "A"))]));
    run.cancel();
    expect(f.calls.at(-1)).toEqual({ method: "search.cancel", params: { searchId: "s1" } });
    await f.answer(page([hit(sess("b", "B"))], { done: false }));
    await run.settled;
    expect(got).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === "search.poll")).toHaveLength(1);
  });

  test("a cancel before the start answers still cancels the search the host began", async () => {
    const f = fakeHost();
    const got: SearchPage[] = [];
    const run = startSearch(f.host, { query: "needle" }, { page: (p) => got.push(p), error: () => {} });
    await tick();
    run.cancel();
    expect(f.calls.map((c) => c.method)).toEqual(["search.start"]);
    await f.answer(page([]));
    await run.settled;
    expect(got).toHaveLength(0);
    expect(f.calls.map((c) => c.method)).toEqual(["search.start", "search.cancel"]);
  });

  test("a finished search is not cancelled", async () => {
    const f = fakeHost();
    const run = startSearch(f.host, { query: "needle" }, { page: () => {}, error: () => {} });
    await tick();
    await f.answer(page([], { done: true }));
    await run.settled;
    run.cancel();
    expect(f.calls.map((c) => c.method)).toEqual(["search.start"]);
  });

  test("the next run waits for the previous one's pending request", async () => {
    const f = fakeHost();
    const first = startSearch(f.host, { query: "one" }, { page: () => {}, error: () => {} });
    await tick();
    first.cancel();
    const second = startSearch(f.host, { query: "two" }, { page: () => {}, error: () => {} }, first.settled);
    await tick();
    expect(f.calls.map((c) => c.params.query)).toEqual(["one"]);
    await f.answer(page([], { done: true }));
    await f.answer(page([], { searchId: "s2", done: true }));
    await second.settled;
    expect(f.calls.filter((c) => c.method === "search.start").map((c) => c.params.query)).toEqual(["one", "two"]);
    expect(f.maxInflight()).toBe(1);
  });

  test("errors are reported, a cancelled run's are not", async () => {
    const f = fakeHost();
    const errors: unknown[] = [];
    const run = startSearch(f.host, { query: "needle" }, { page: () => {}, error: (e) => errors.push(e) });
    await tick();
    await f.answer(Object.assign(new Error("old"), { code: "unknown_method" }));
    await run.settled;
    expect(errors).toHaveLength(1);
    const g = fakeHost();
    const gone = startSearch(g.host, { query: "needle" }, { page: () => {}, error: (e) => errors.push(e) });
    await tick();
    gone.cancel();
    await g.answer(new Error("late"));
    await gone.settled;
    expect(errors).toHaveLength(1);
  });
});

describe("mergeEntries", () => {
  const a = sess("a", "Pricing page");
  const b = sess("b", "Relay spike");
  const c = sess("c", "Old session");

  test("no query lists the sessions as they are", () => {
    expect(mergeEntries([a, b], [], "").map((e) => e.s.file)).toEqual(["a", "b"]);
  });

  test("title/folder/id matches and content hits merge by file; hit-only sessions are added", () => {
    const hb = hit(b, 3);
    const hc = hit(c);
    const out = mergeEntries([a, b], [hb, hc], "pricing");
    expect(out.map((e) => [e.s.file, e.hit?.matches])).toEqual([["a", undefined], ["b", 3], ["c", 1]]);
  });

  test("the list's copy of a session wins over the hit's, and nothing else is listed", () => {
    const fresh = { ...b, live: true, agentId: "ag" };
    const out = mergeEntries([a, fresh], [hit({ ...b, live: false })], "zzz");
    expect(out).toHaveLength(1);
    expect(out[0]?.s).toMatchObject({ file: "b", live: true, agentId: "ag" });
  });

  test("an id or folder match counts", () => {
    expect(mergeEntries([a, b], [], "id-b").map((e) => e.s.file)).toEqual(["b"]);
    expect(mergeEntries([a, b], [], "/code/app")).toHaveLength(2);
  });
});

describe("labels and notes", () => {
  const sn = (over: Partial<SearchSnippet>): SearchSnippet => ({ kind: "user", before: "", hit: "x", after: "", ...over });
  test("snippet labels", () => {
    expect(snippetLabel(sn({}))).toBe("You");
    expect(snippetLabel(sn({ kind: "assistant" }))).toBe("omp");
    expect(snippetLabel(sn({ kind: "toolCall", tool: "bash" }))).toBe("bash call");
    expect(snippetLabel(sn({ kind: "toolOutput", tool: "read" }))).toBe("read output");
    expect(snippetLabel(sn({ kind: "toolOutput" }))).toBe("tool output");
    expect(snippetLabel(sn({ kind: "thinking" }))).toBe("thinking");
    expect(snippetLabel(sn({ kind: "summary" }))).toBe("summary");
  });

  test("progress and stop notes", () => {
    expect(searchNote(IDLE)).toBeUndefined();
    expect(searchNote({ ...SEARCHING, files: 34, filesTotal: 77 })).toBe("Searching messages… 34 of 77 sessions");
    expect(searchNote(SEARCHING)).toBe("Searching messages…");
    expect(searchNote({ ...IDLE, status: "done", stopped: "time", elapsedMs: 20_100 })).toBe("Stopped after 20 s");
    expect(searchNote({ ...IDLE, status: "done", stopped: "hits", hits: Array.from({ length: 100 }, () => hit(a2())) })).toBe("Showing the first 100 matching sessions");
    expect(searchNote({ ...IDLE, status: "unsupported" })).toBe("This host's TeleFlock is too old to search messages");
    expect(searchNote({ ...IDLE, status: "done" })).toBeUndefined();
  });
});

function a2(): PastSession {
  return sess("z", "Z");
}
