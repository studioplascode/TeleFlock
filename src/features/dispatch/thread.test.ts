import { describe, expect, test } from "bun:test";
import type { Agent, Workspace } from "@/core/gen";
import type { DispatchEntry } from "./store";
import { baseSlug, cleanSuggestion, nameDispatch, prefetchKey, recentRepos, resolveAgent, slimThreads, uniqueSlug } from "./thread";

const agent = (p: Partial<Agent>): Agent => ({
  id: "a",
  name: "a",
  kind: "omp",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  state: "working",
  stateSince: 1,
  column: "running",
  archived: false,
  turns: 0,
  title: "",
  live: { streaming: false, thinking: false },
  ...p,
});

const entry = (p: Partial<DispatchEntry>): DispatchEntry => ({
  id: "e1",
  prompt: "x",
  createdAt: 1,
  branch: "dispatch/x",
  name: "x",
  options: { templateId: null, model: "default", thinking: "default", plan: false },
  phase: "started",
  ...p,
});

describe("dispatch naming", () => {
  test("slug from the prompt, whole words, starting with a letter", () => {
    expect(baseSlug("Refactor the reconnect backoff into its own module")).toBe("refactor-reconnect");
    expect(baseSlug("Add offline caching to the client")).toBe("offline-caching-client");
    expect(baseSlug("2fa for the login")).toBe("t-2fa-login");
    expect(baseSlug("!!!")).toBe("task");
  });

  test("dedupes against agent names and dispatch branches", () => {
    expect(uniqueSlug("fix-ci", new Set())).toBe("fix-ci");
    expect(uniqueSlug("fix-ci", new Set(["fix-ci"]))).toBe("fix-ci-2");
    expect(uniqueSlug("fix-ci", new Set(["dispatch/fix-ci", "fix-ci-2"]))).toBe("fix-ci-3");
  });

  test("names stay within herdr's 32-char agent-name limit, suffix included", () => {
    const long = "implement-websocket-reconnection-backoff";
    expect(uniqueSlug(long, new Set())).toBe("implement-websocket-reconnection");
    expect(uniqueSlug(long, new Set(["implement-websocket-reconnection"]))).toBe("implement-websocket-reconnecti-2");
    const base = "a".repeat(32);
    expect(uniqueSlug(base, new Set([base]))).toBe(`${"a".repeat(30)}-2`);
    const taken = new Set<string>([base]);
    for (let i = 2; i < 12; i++) taken.add(`${"a".repeat(32 - `-${i}`.length)}-${i}`);
    expect(uniqueSlug(base, taken)).toBe(`${"a".repeat(29)}-12`);
  });

  test("AI suggestions are cleaned to a dispatch name or rejected", () => {
    expect(cleanSuggestion("offline-cache-client")).toBe("offline-cache-client");
    expect(cleanSuggestion("dispatch/Offline Cache")).toBe("offline-cache");
    expect(cleanSuggestion("  Offline_Cache!  ")).toBe("offline-cache");
    expect(cleanSuggestion("2fa-login")).toBeNull();
    expect(cleanSuggestion("")).toBeNull();
    expect(cleanSuggestion(null)).toBeNull();
    // ≤ 28 chars, cut at a word boundary (a single long word is cut short)
    expect(cleanSuggestion("implement-websocket-reconnection-backoff")).toBe("implement-websocket");
    expect(cleanSuggestion("add-offline-caching-to-client-x")).toBe("add-offline-caching-to");
    expect(cleanSuggestion("add-offline-caching-to-clien")).toBe("add-offline-caching-to-clien");
    expect(cleanSuggestion("a".repeat(60))).toBe("a".repeat(28));
  });

  test("naming phase: AI slug when usable, else the prompt's slug", async () => {
    const prompt = "Add offline caching to the client";
    expect(await nameDispatch(prompt, async () => "service-worker-cache")).toEqual({ slug: "service-worker-cache", ai: true });
    expect(await nameDispatch(prompt, async () => null)).toEqual({ slug: "offline-caching-client", ai: false });
    expect(await nameDispatch(prompt, async () => "!!!")).toEqual({ slug: "offline-caching-client", ai: false });
    expect(
      await nameDispatch(prompt, async () => {
        throw new Error("timeout");
      }),
    ).toEqual({ slug: "offline-caching-client", ai: false });
    expect(await nameDispatch(prompt, null)).toEqual({ slug: "offline-caching-client", ai: false });
  });

  test("prefetch only once the draft has a few words", () => {
    expect(prefetchKey("fix")).toBeNull();
    expect(prefetchKey("fix the  ")).toBeNull();
    expect(prefetchKey("  fix the flaky ci  ")).toBe("fix the flaky ci");
    expect(prefetchKey("fix — ci")).toBeNull();
  });
});

describe("resolveAgent", () => {
  const wt = (id: string, root: string, branch: string, path = `/wt/${branch}`): Workspace => ({
    id,
    label: id,
    cwd: path,
    repo: { root, name: root.split("/").pop() ?? root, branch },
    worktree: { path, branch },
    tabs: [],
    rollup: "idle",
    order: 0,
  });
  const scope = { repo: "/r/app", workspaces: [wt("w4", "/r/app", "dispatch/fix-ci"), wt("w5", "/r/app", "dispatch/other"), wt("w7", "/r/api", "dispatch/fix-ci", "/wt/api-fix-ci")] };

  test("id, then pane with the same name, then name in the entry's worktree", () => {
    const agents = [agent({ id: "t9", name: "fix-ci", paneId: "w4:p1", workspaceId: "w4" }), agent({ id: "t2", name: "other", paneId: "w5:p1", workspaceId: "w5" })];
    const e = { name: "fix-ci", branch: "dispatch/fix-ci" };
    expect(resolveAgent(entry({ ...e, agentId: "t9", workspaceId: "w4" }), agents, scope)?.id).toBe("t9");
    expect(resolveAgent(entry({ ...e, paneId: "w4:p1" }), agents, scope)?.id).toBe("t9");
    expect(resolveAgent(entry({ ...e, phase: "creating" }), agents, scope)?.id).toBe("t9");
    expect(resolveAgent(entry({ ...e, phase: "unknown", path: "/wt/dispatch/fix-ci", branch: "dispatch/renamed" }), agents, scope)?.id).toBe("t9");
  });

  test("reused pane / workspace ids don't link a stale entry to a new agent", () => {
    const agents = [agent({ id: "fresh", name: "new-task", paneId: "w4:p1", workspaceId: "w4" })];
    expect(resolveAgent(entry({ name: "old-task", branch: "dispatch/old-task", agentId: "old-task", paneId: "w4:p1", workspaceId: "w4" }), agents, scope)).toBeUndefined();
    expect(resolveAgent(entry({ name: "new-task", phase: "failed", paneId: "w4:p1" }), agents, scope)).toBeUndefined();
  });

  test("a same-named agent of another repo never matches", () => {
    const agents = [agent({ id: "api", name: "fix-ci", paneId: "w7:p1", workspaceId: "w7" })];
    expect(resolveAgent(entry({ name: "fix-ci", branch: "dispatch/fix-ci", phase: "creating" }), agents, scope)).toBeUndefined();
    expect(resolveAgent(entry({ name: "fix-ci", branch: "dispatch/fix-ci", agentId: "api" }), agents, scope)).toBeUndefined();
  });
});

describe("slimThreads", () => {
  test("keeps the newest entries across threads and clips long prompts", () => {
    const threads = { a: [entry({ id: "1", createdAt: 1 }), entry({ id: "3", createdAt: 3, prompt: "x".repeat(50) })], b: [entry({ id: "2", createdAt: 2 })] };
    const out = slimThreads(threads, 2, 10);
    expect(Object.fromEntries(Object.entries(out).map(([k, l]) => [k, l.map((e) => e.id)]))).toEqual({ a: ["3"], b: ["2"] });
    expect(out.a?.[0]?.prompt).toHaveLength(10);
  });
});

describe("recentRepos", () => {
  test("dedupes linked worktrees into their repo, most recent first", () => {
    const ws = (id: string, root: string): Workspace => ({ id, label: id, cwd: root, repo: { root, name: root.split("/").pop() ?? root }, tabs: [], rollup: "idle", order: 0 });
    const workspaces = [ws("w1", "/r/app"), ws("w2", "/r/app"), ws("w3", "/r/api")];
    const agents = [agent({ workspaceId: "w2", stateSince: 50 }), agent({ workspaceId: "w3", stateSince: 10 })];
    expect(recentRepos({ workspaces, agents }, {}).map((r) => r.root)).toEqual(["/r/app", "/r/api"]);
    expect(recentRepos({ workspaces, agents }, { "/r/api": 99, "/r/gone": 5 }).map((r) => r.root)).toEqual(["/r/api", "/r/app", "/r/gone"]);
  });
});
