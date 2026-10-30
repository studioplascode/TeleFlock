import { describe, expect, test } from "bun:test";
import type { FindHit, PastSession, SearchPage, SessionFindResult, SessionRows, TranscriptItem } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { DemoSearch } from "./search";

const NOW = 1_800_000_000_000;

const user = (id: string, at: number, text: string): TranscriptItem => ({ kind: "user", id, at, text, images: [], steering: false, synthetic: false });
const say = (id: string, at: number, text: string): TranscriptItem => ({ kind: "assistant", id, at, text, streaming: false });

function fixture(variant = true) {
  const live: TranscriptItem[] = [
    user("a1", NOW - 5000, "Please fix the Websocket reconnect"),
    say("a2", NOW - 4000, "The websocket drops after 30 s; I will look at the heartbeat."),
    {
      kind: "tool", id: "a3", at: NOW - 3000, callId: "a3", tool: "bash", title: "bun test", args: {}, status: "ok", truncated: false,
      view: { type: "bash", command: "bun test", output: "\u001b[31mfail\u001b[0m websocket heartbeat", exitCode: 1, background: false, timedOut: false },
    },
  ];
  const sessions: PastSession[] = [
    { file: "/s/live.jsonl", id: "L1", title: "Live one", cwd: "/code/teleflock", updatedAt: NOW, messages: 3, live: true, agentId: "live" },
    { file: "/s/old-a.jsonl", id: "O1", title: "Draft pricing page copy", cwd: "/home/demo/code/marketing-site", updatedAt: NOW - 3_600_000, messages: 30, live: false },
    { file: "/s/old-b.jsonl", id: "O2", title: "Fix WSL path translation", cwd: "/home/demo/code/teleflock", updatedAt: NOW - 7_200_000, messages: 9, live: false },
  ];
  const search = new DemoSearch({ now: () => NOW, supported: () => variant, sessions: () => sessions, rows: (id) => (id === "live" ? live : undefined) });
  const call = <T>(method: string, p: Record<string, unknown>) => search.call(method, p) as T;
  /** Runs a search to its end like the client does. */
  const all = (p: Record<string, unknown>) => {
    let page = call<SearchPage>("search.start", p);
    const hits = [...page.hits];
    while (!page.done) {
      page = call<SearchPage>("search.poll", { searchId: page.searchId, after: hits.length });
      hits.push(...page.hits);
    }
    return { page, hits };
  };
  return { call, all, search, live };
}

describe("demo search", () => {
  test("finds a word in live rows case-insensitively, with snippets whose row ids are the transcript's", () => {
    const { all, live } = fixture();
    const { hits, page } = all({ query: "WEBSOCKET" });
    const hit = hits.find((h) => h.session.agentId === "live");
    expect(hit?.matches).toBe(3);
    expect(hit?.snippets.map((s) => s.rowId)).toEqual(["a1", "a2", "a3"]);
    expect(hit?.snippets.map((s) => s.kind)).toEqual(["user", "assistant", "toolOutput"]);
    expect(hit?.snippets[0]).toMatchObject({ before: "Please fix the ", hit: "Websocket", after: " reconnect", at: NOW - 5000 });
    expect(hit?.snippets[2]?.tool).toBe("bash");
    expect(live.some((r) => r.id === "a3")).toBe(true);
    expect(page.done).toBe(true);
    expect(page.total).toBe(hits.length);
  });

  test("ANSI escapes are not searched and the case switch is honoured", () => {
    const { all } = fixture();
    expect(all({ query: "31m" }).hits).toHaveLength(0);
    expect(all({ query: "Websocket", caseSensitive: true }).hits[0]?.matches).toBe(1);
  });

  test("seeded old sessions have rows: every snippet row is in search.read, and the window is centred on it", () => {
    const { all, call } = fixture();
    const { hits } = all({ query: "timeout" });
    const old = hits.find((h) => h.session.file === "/s/old-a.jsonl");
    expect(old?.snippets.length).toBeGreaterThan(0);
    const snip = old?.snippets[0];
    const read = call<SessionRows>("search.read", { file: "/s/old-a.jsonl", around: snip?.rowId, limit: 10 });
    expect(read.rows).toBe(30);
    expect(read.items).toHaveLength(10);
    expect(read.items.some((r) => r.id === snip?.rowId)).toBe(true);
    expect(read.start).toBeGreaterThanOrEqual(0);
  });

  test("search.read pages older and newer rows and answers not_found for an unknown row or file", () => {
    const { call } = fixture();
    const newest = call<SessionRows>("search.read", { file: "/s/old-a.jsonl", limit: 10 });
    expect(newest.start).toBe(20);
    const older = call<SessionRows>("search.read", { file: "/s/old-a.jsonl", before: newest.items[0]?.id, limit: 10 });
    expect(older).toMatchObject({ start: 10, rows: 30 });
    expect(older.items.at(-1)?.id).not.toBe(newest.items[0]?.id);
    const newer = call<SessionRows>("search.read", { file: "/s/old-a.jsonl", after: older.items.at(-1)?.id, limit: 10 });
    expect(newer.items[0]?.id).toBe(newest.items[0]?.id);
    const byTime = call<SessionRows>("search.read", { file: "/s/old-a.jsonl", aroundAt: (newest.items[0]?.at ?? 0) - 1000, limit: 6 });
    expect(byTime.items).toHaveLength(6);
    expect(() => call("search.read", { file: "/s/old-a.jsonl", before: "nope" })).toThrow();
    expect(() => call("search.read", { file: "/nope.jsonl" })).toThrow();
  });

  test("progress: files grow page by page, hits arrive in the order found, a poll after the end stays done", () => {
    const { call, all } = fixture();
    const first = call<SearchPage>("search.start", { query: "the" });
    expect(first.filesTotal).toBe(3);
    const { page, hits } = all({ query: "the" });
    expect(page.files).toBe(3);
    expect(hits.map((h) => h.session.file)).toEqual(["/s/live.jsonl", "/s/old-a.jsonl", "/s/old-b.jsonl"]);
  });

  test("the limit stops the search; cwd scopes it; cancel forgets it", () => {
    const { call, all } = fixture();
    const limited = all({ query: "the", limit: 1 });
    expect(limited.hits).toHaveLength(1);
    expect(limited.page.stopped).toBe("hits");
    expect(all({ query: "the", cwd: "/home/demo/code/marketing-site" }).hits.map((h) => h.session.file)).toEqual(["/s/old-a.jsonl"]);
    const p = call<SearchPage>("search.start", { query: "the" });
    call("search.cancel", { searchId: p.searchId });
    expect(() => call("search.poll", { searchId: p.searchId, after: 0 })).toThrow();
    expect(() => call("search.start", { query: "  " })).toThrow();
  });

  test("session.find lists matching rows of the live agent with their index, honouring before", () => {
    const { call } = fixture();
    const r = call<SessionFindResult>("session.find", { agentId: "live", query: "websocket" });
    expect(r).toEqual({ hits: [{ id: "a1", index: 0, count: 1 }, { id: "a2", index: 1, count: 1 }, { id: "a3", index: 2, count: 1 }] as FindHit[], rows: 3, truncated: false });
    expect(call<SessionFindResult>("session.find", { agentId: "live", query: "websocket", before: "a3" }).hits.map((h) => h.id)).toEqual(["a1", "a2"]);
    expect(call<SessionFindResult>("session.find", { agentId: "live", query: "websocket", limit: 1 })).toMatchObject({ truncated: true, hits: [{ id: "a3" }] });
    expect(() => call("session.find", { agentId: "ghost", query: "x" })).toThrow();
  });

  test("a host that predates search leaves every method to unknown_method", () => {
    const { search } = fixture(false);
    expect(search.call("search.start", { query: "x" })).toBeUndefined();
    expect(search.call("session.find", { agentId: "live", query: "x" })).toBeUndefined();
    expect(search.call("host.sessions", {})).toBeUndefined();
  });
});

describe("demo host search", () => {
  function rig(host: string) {
    const clock = new ManualClock();
    const engine = new DemoEngine({ mode: "backend", clock });
    engine.subscribe(() => {});
    clock.advance(8000);
    return async <T>(method: string, params: unknown = {}): Promise<T> => {
      const p = engine.callHost(host, method, params);
      clock.advance(400);
      return (await p) as T;
    };
  }

  test("forge: a word of the seeded old sessions lists them, and the row of a snippet is readable", async () => {
    const call = rig("forge");
    let page = await call<SearchPage>("search.start", { query: "benchmark" });
    const hits = [...page.hits];
    while (!page.done) {
      page = await call<SearchPage>("search.poll", { searchId: page.searchId, after: hits.length });
      hits.push(...page.hits);
    }
    expect(hits.length).toBeGreaterThan(0);
    const old = hits.find((h) => !h.session.live);
    const snip = old?.snippets[0];
    expect(snip?.rowId).toBeTruthy();
    const read = await call<SessionRows>("search.read", { file: old?.session.file, around: snip?.rowId });
    expect(read.items.some((r) => r.id === snip?.rowId)).toBe(true);
  });

  test("forge: session.find over a live agent", async () => {
    const call = rig("forge");
    const sessions = await call<{ sessions: PastSession[] }>("host.sessions", { limit: 50 });
    const live = sessions.sessions.find((s) => s.live && s.agentId);
    const r = await call<SessionFindResult>("session.find", { agentId: live?.agentId, query: "a" });
    expect(r.rows).toBeGreaterThan(0);
  });
});
