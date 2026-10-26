import { afterEach, describe, expect, test } from "bun:test";
import { aiTesting, suggestBranch } from "@/core/ai";
import type { Agent, Workspace } from "@/core/gen";
import { usePrefs } from "@/core/prefs";
import type { DispatchEntry } from "./store";
import { baseSlug, cleanSuggestion, nameDispatch, prefetchKey, recentRepos, resolveAgent, slimThreads, threadBase, uniqueSlug } from "./thread";

/** The 0.4.1 task Dispatch named `need-inspect-repository`, as typed (one line, inline points)… */
const FAILING_INLINE =
  "Fix the following points and release 0.5.0 when you are done. Feedback from my Linux user : - cant see currently running shells without opening a new one - can paste images in dispatch - laggy on monitors with different scaling - marking an agent done should close its pane - new worktrees should start from origin/main - dispatch named my task need-inspect-repository - want to group hosts - omp and herdr updates should be automatic - edit omp settings from the app - scheduled automations - deleted sessions keep showing up - the terminal scrolls back to top";
/** …and as a list. */
const FAILING_LIST = FAILING_INLINE.replace(" Feedback from my Linux user : - ", "\nFeedback from my Linux user :\n- ").replaceAll(" - ", "\n- ");

afterEach(() => {
  aiTesting.setComplete(null);
  aiTesting.reset();
  usePrefs.setState({ aiNaming: true });
});

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

  test("long multi-point tasks are named after their goal, not the noise", () => {
    expect(baseSlug(FAILING_INLINE)).toBe("release-0-5-0-fixes");
    expect(baseSlug(FAILING_LIST)).toBe("release-0-5-0-fixes");
    expect(baseSlug("Fix the following:\n- login crash on resume\n- slow sync")).toBe("login-crash-fixes");
    expect(baseSlug("Please address these issues:\n- flaky reconnect\n- stale badge")).toBe("flaky-reconnect-fixes");
    expect(baseSlug("Implement the following features:\n- dark mode\n- export")).toBe("dark-mode-features");
    expect(baseSlug("Could you add dark mode to settings when you're done, thanks")).toBe("dark-mode-settings");
    expect(baseSlug("Bump to 1.2.3 and tag it")).toBe("bump-1-2-3-tag");
  });

  test("the failing task never becomes need-inspect-repository", async () => {
    for (const reply of ["I need to inspect the repository", "I need to inspect the repository first.", "i-need-inspect-repository", "need-inspect-repository"]) {
      aiTesting.reset();
      aiTesting.setComplete(async () => ({ text: reply, ms: 5 }));
      for (const task of [FAILING_INLINE, FAILING_LIST]) {
        const named = await nameDispatch(task, (p) => suggestBranch("h", p));
        expect(named).toEqual({ slug: "release-0-5-0-fixes", ai: false });
      }
    }
    aiTesting.reset();
    aiTesting.setComplete(async () => ({ text: "linux-feedback-release", ms: 5 }));
    expect(await nameDispatch(FAILING_LIST, (p) => suggestBranch("h", p))).toEqual({ slug: "linux-feedback-release", ai: true });
  });

  describe("base", () => {
    const list = (p: { defaultBase?: string; defaultBranch?: string; names?: string[] } = {}) => ({
      branches: (p.names ?? ["main", "origin/main", "dev"]).map((name) => ({ name, current: false, remote: name.startsWith("origin/") })),
      defaultBranch: p.defaultBranch ?? "main",
      ...(p.defaultBase ? { defaultBase: p.defaultBase } : {}),
    });
    test("untouched → origin/<default> shown, nothing sent (the host fetches and forks from it)", () => {
      expect(threadBase(list({ defaultBase: "origin/main" }), undefined, false)).toEqual({ shown: "origin/main", untouched: true });
    });
    test("a pre-0.5 remembered local default branch counts as untouched", () => {
      expect(threadBase(list({ defaultBase: "origin/main" }), "main", true)).toEqual({ shown: "origin/main", untouched: true });
      // Picked on purpose since 0.5: the local branch is sent.
      expect(threadBase(list({ defaultBase: "origin/main" }), "main", false)).toEqual({ shown: "main", param: "main", untouched: false });
    });
    test("a picked branch or HEAD is sent; one the repo lost falls back to the default", () => {
      expect(threadBase(list({ defaultBase: "origin/main" }), "dev", false)).toEqual({ shown: "dev", param: "dev", untouched: false });
      expect(threadBase(list({ defaultBase: "origin/main" }), "HEAD", false)).toEqual({ shown: "HEAD", param: "HEAD", untouched: false });
      expect(threadBase(list({ defaultBase: "origin/main" }), "gone", false)).toEqual({ shown: "origin/main", untouched: true });
    });
    test("older hosts (no defaultBase) get their default branch spelled out (absent meant HEAD there)", () => {
      expect(threadBase(list(), undefined, false)).toEqual({ shown: "main", param: "main", untouched: true });
    });
    test("before the branch list arrives", () => {
      expect(threadBase(undefined, undefined, false)).toEqual({ shown: "default branch", untouched: true });
      // A pre-0.5 base can't be told from the default yet: nothing is sent (the host resolves it).
      expect(threadBase(undefined, "main", true)).toEqual({ shown: "default branch", untouched: true });
      expect(threadBase(undefined, "dev", false)).toEqual({ shown: "dev", param: "dev", untouched: false });
    });
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
