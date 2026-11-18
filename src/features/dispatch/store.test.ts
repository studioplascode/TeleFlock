import { beforeAll, describe, expect, test } from "bun:test";
import { CHAT_REPO, CHATS_NEED_UPDATE } from "@/core/chats";
import type { Agent, AutoAnswer, HostState, StartParams, Workspace, WorktreeCreateParams } from "@/core/gen";
import type * as StoreModule from "./store";
import type { DispatchEntry } from "./store";
import { baseSlug, uniqueSlug } from "./thread";

// The store persists to localStorage, which bun doesn't provide: an in-memory stand-in.
const mem: Record<string, string> = {};
beforeAll(() => {
  globalThis.localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => {
      mem[k] = v;
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
});

describe("dispatch naming phase", () => {
  test("identical sends named by one shared answer get distinct names", async () => {
    // Dynamic: the store hydrates from localStorage at module load, so it must load after the stub.
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    // Identical prompts share one in-flight AI call (ai.ts), so both answers land in the same tick.
    let answer!: (slug: string) => void;
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const shared = new Promise<string>((r) => {
      answer = r;
    });
    const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
    const send = () => dispatchTask({ hostId: "h", repo: "/r/app", prompt: "fix flaky login test", options, taken: [], suggest: () => shared });
    const a = send();
    const b = send();
    expect(a.phase).toBe("naming");
    expect(a.name).not.toBe(b.name);

    answer("fix-flaky-login-test");
    await shared;
    await Promise.resolve();
    await Promise.resolve();

    const names = (useDispatch.getState().threads[threadKey("h", "/r/app")] ?? []).map((e) => [e.name, e.branch, e.aiNamed]);
    expect(names).toEqual([
      ["fix-flaky-login-test", "fix-flaky-login-test", true],
      ["fix-flaky-login-test-2", "fix-flaky-login-test-2", true],
    ]);
  });
});

describe("hosts, images and workload", () => {
  const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
  const img = { mime: "image/png", data: "iVBORw0KGgo=", preview: "data:image/png;base64,iVBORw0KGgo=" };

  test("an image-only task is named after its images and keeps them with the entry", async () => {
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    const { loadEntryImages } = await import("./images");
    const e = dispatchTask({ hostId: "h2", repo: "/r/app", prompt: "", images: [img], options, taken: [], suggest: null });
    expect(e).toMatchObject({ name: "image-task", branch: "image-task", images: 1, hostId: "h2", repo: "/r/app" });
    expect(await loadEntryImages(e.id)).toEqual([{ mime: "image/png", data: "iVBORw0KGgo=" }]);
    // Dismissed → its images go too.
    useDispatch.getState().remove(threadKey("h2", "/r/app"), [e.id]);
    expect(await loadEntryImages(e.id)).toBeNull();
  });

  test("Auto entries live in the group thread but belong to (and reserve names on) their host", async () => {
    const { dispatchTask, entryHost, entryRepo, threadKey, useDispatch } = await import("./store");
    const key = threadKey("auto:farm", "github.com/acme/app");
    const a = dispatchTask({ key, hostId: "h3", repo: "/home/a/app", prompt: "fix the login page", options, taken: [], suggest: null });
    expect(useDispatch.getState().threads[key]?.map((x) => x.id)).toEqual([a.id]);
    expect(entryHost(key, a)).toBe("h3");
    expect(entryRepo(key, a)).toBe("/home/a/app");
    // Same host, another (single-host) thread: the Auto entry's name is taken there.
    const b = dispatchTask({ hostId: "h3", repo: "/home/a/app", prompt: "fix the login page", options, taken: [], suggest: null });
    expect(b.name).toBe(`${a.name}-2`);
    // Another host of the group: free.
    const c = dispatchTask({ key, hostId: "h4", repo: "/srv/app", prompt: "fix the login page", options, taken: [], suggest: null });
    expect(c.name).toBe(a.name);
    // Entries from before 0.5 (no hostId / repo) belong to the thread's host and repo.
    expect(entryHost(threadKey("old", "/x"), { hostId: undefined })).toBe("old");
    expect(entryRepo(threadKey("old", "/x"), { repo: undefined })).toBe("/x");
  });

  test("dispatches on their way count per host", async () => {
    const { pendingByHost } = await import("./store");
    const entry = (p: Pick<DispatchEntry, "phase"> & Partial<DispatchEntry>): DispatchEntry => ({ id: Math.random().toString(36), prompt: "x", createdAt: 1_000, branch: "x", name: "x", options, ...p });
    const threads: Record<string, DispatchEntry[]> = {
      "auto:farm\u0000repo": [
        entry({ phase: "naming", hostId: "a" }),
        entry({ phase: "started", startedAt: 50_000, hostId: "a", agentId: "ag1" }),
        entry({ phase: "started", startedAt: 50_000, hostId: "b", agentId: "ag2" }),
        entry({ phase: "started", startedAt: 1_000, hostId: "b" }),
        entry({ phase: "failed", hostId: "b" }),
      ],
      "c\u0000/r": [entry({ phase: "naming" })],
    };
    // ag2 is already running (counted as an agent), the old start is past the window.
    expect(pendingByHost(threads, new Set(["ag2"]), 70_000)).toEqual({ a: 2, c: 1 });
  });
});

describe("the Quick capture webview", () => {
  test("is told apart from the main window by its page", async () => {
    const { isCaptureWebview } = await import("./store");
    expect(isCaptureWebview("/capture.html")).toBe(true);
    expect(isCaptureWebview("/src/capture/capture")).toBe(true);
    expect(isCaptureWebview("/")).toBe(false);
    expect(isCaptureWebview("/index.html")).toBe(false);
  });

  test("does not fail the main window's uploading entries on load, the main window does", async () => {
    const entry = { id: "up1", prompt: "x", createdAt: 1, branch: "x", name: "x", phase: "uploading", options: { templateId: null, model: "default", thinking: "default", plan: false } };
    const persisted = () => JSON.stringify({ state: { threads: { "h\u0000/r": [entry] }, lastHost: null, lastRepo: null }, version: 2 });
    const phaseOf = () => (JSON.parse(mem["tf.dispatch"] ?? "{}") as { state?: { threads?: Record<string, { phase: string }[]> } }).state?.threads?.["h\u0000/r"]?.[0]?.phase;
    const here = (globalThis as { location?: unknown }).location;
    try {
      // Distinct specifiers load the module afresh: its startup code runs once per load.
      const capture = "./store?capture-window";
      const main = "./store?main-window";
      mem["tf.dispatch"] = persisted();
      (globalThis as { location?: unknown }).location = { pathname: "/capture.html" };
      const c = (await import(capture)) as typeof import("./store");
      expect(c.useDispatch.getState().threads["h\u0000/r"]?.[0]?.phase).toBe("uploading");
      expect(phaseOf()).toBe("uploading");

      mem["tf.dispatch"] = persisted();
      (globalThis as { location?: unknown }).location = { pathname: "/index.html" };
      const m = (await import(main)) as typeof import("./store");
      expect(m.useDispatch.getState().threads["h\u0000/r"]?.[0]?.phase).toBe("failed");
    } finally {
      (globalThis as { location?: unknown }).location = here;
    }
  });
});

describe("decide for me", () => {
  test("a task's own policy goes only to a host with decide for me (Auto: the host it went to)", async () => {
    // Dynamic, as above: these load the store, which hydrates from localStorage at module load.
    const { core } = await import("@/core");
    const { coreStore } = await import("@/core/store/store");
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    const policy: AutoAnswer = { enabled: true, afterSecs: 600, onlyWhenNoApp: true };
    const host = (autoAnswer?: AutoAnswer) => ({ rev: 1, state: { info: autoAnswer ? { autoAnswer } : {}, agents: [], workspaces: [] } as unknown as HostState });
    const hosts = coreStore.getState().hosts;
    // aaNew has decide for me (its default off), aaOld is a tf-hostd from before it.
    coreStore.setState({ hosts: { ...hosts, aaNew: host({ enabled: false, afterSecs: 1_200, onlyWhenNoApp: false }), aaOld: host() } });
    const SENDS = 5;
    const sent = new Map<string, WorktreeCreateParams>();
    let allSent!: () => void;
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const created = new Promise<void>((r) => {
      allSent = r;
    });
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        const p = params as unknown as WorktreeCreateParams;
        if (method === "worktree.create" && hostId.startsWith("aa")) sent.set(`${hostId}/${p.label}`, p);
        if (sent.size === SENDS) allSent();
        return Promise.resolve({ path: "/w", branch: p.branch, workspaceId: "w" } as never);
      },
    });
    try {
      const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
      const auto = threadKey("auto:farm", "github.com/acme/decide");
      const send = (hostId: string, prompt: string, own: boolean, key?: string) =>
        [hostId, dispatchTask({ key, hostId, repo: "/r/decide", prompt, options: own ? { ...options, autoAnswer: policy } : options, taken: [], suggest: null })] as const;
      const runs = [
        send("aaNew", "own policy", true),
        send("aaNew", "host default", false),
        send("aaOld", "older host", true),
        send("aaNew", "auto picked new", true, auto),
        send("aaOld", "auto picked old", true, auto),
      ];
      expect(runs.length).toBe(SENDS);
      await created;
      const policies = runs.map(([hostId, e]) => sent.get(`${hostId}/${e.name}`)?.agent?.autoAnswer ?? null);
      expect(policies).toEqual([policy, null, null, policy, null]);
      // The composer keeps it for the next send, whichever host that goes to.
      expect(useDispatch.getState().options?.autoAnswer).toEqual(policy);
    } finally {
      core.host = realHost;
      coreStore.setState({ hosts });
    }
  });
});

describe("chats", () => {
  const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
  type Call = { method: string; params: unknown };

  /** Resolves once `done()` holds, checked as sends and retries settle (other tests' sends settle too). */
  const until = (onSettled: (cb: () => void) => () => unknown, done: () => boolean) =>
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    new Promise<void>((resolve) => {
      if (done()) {
        resolve();
        return;
      }
      const off = onSettled(() => {
        if (!done()) return;
        off();
        resolve();
      });
    });

  test("a chat is one agent.start with the chat target: no branch, base or worktree, a name free on its host", async () => {
    // Dynamic, as above: these load the store, which hydrates from localStorage at module load.
    const { core } = await import("@/core");
    const { dispatchTask, isInFlight, onDispatchSettled, threadKey, useDispatch } = await import("./store");
    const calls: Call[] = [];
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hc") calls.push({ method, params });
        return Promise.resolve({ agentId: `chat-${calls.length}`, paneId: `wc:p${calls.length}`, workspaceId: "wc" } as never);
      },
    });
    try {
      const prompt = "Which hiking boots should I buy for the Alps?";
      const slug = baseSlug(prompt);
      // `slug` is a live agent's name on the host; the second chat finds the first one's name taken too.
      const second = uniqueSlug(slug, new Set([slug]));
      const third = uniqueSlug(slug, new Set([slug, second]));
      const a = dispatchTask({ hostId: "hc", repo: CHAT_REPO, prompt, options: { ...options, plan: true }, taken: [slug], suggest: null });
      const b = dispatchTask({ hostId: "hc", repo: CHAT_REPO, prompt, options, taken: [slug], suggest: null });
      expect([a.name, b.name]).toEqual([second, third]);
      expect(a).toMatchObject({ chat: true, branch: "", hostId: "hc" });
      expect([a.repo, a.base, a.baseLabel]).toEqual([undefined, undefined, undefined]);
      await until(onDispatchSettled, () => !isInFlight(a.id) && !isInFlight(b.id));
      expect(calls.map((c) => c.method)).toEqual(["agent.start", "agent.start"]);
      expect(calls[0]?.params).toMatchObject({ target: { kind: "chat" }, spec: { kind: "omp", name: second, plan: true, prompt } });
      const thread = useDispatch.getState().threads[threadKey("hc", CHAT_REPO)] ?? [];
      expect(thread.map((e) => [e.phase, e.agentId, e.paneId, e.workspaceId])).toEqual([
        ["started", "chat-1", "wc:p1", "wc"],
        ["started", "chat-2", "wc:p2", "wc"],
      ]);
    } finally {
      core.host = realHost;
    }
  });

  test("a daemon from before chats fails the chat with the update words", async () => {
    const { apiError, core } = await import("@/core");
    const { dispatchTask, isInFlight, onDispatchSettled, threadKey, useDispatch } = await import("./store");
    const realHost = core.host;
    core.host = () => ({ call: () => Promise.reject(apiError("invalid_params", "agent.start: unknown variant `chat`, expected one of `workspace`, `pane`, `cwd`")) });
    try {
      const e = dispatchTask({ hostId: "hold", repo: CHAT_REPO, prompt: "What's a good book about bridges?", options, taken: [], suggest: null });
      await until(onDispatchSettled, () => !isInFlight(e.id));
      const failed = useDispatch.getState().threads[threadKey("hold", CHAT_REPO)]?.find((x) => x.id === e.id);
      expect(failed).toMatchObject({ phase: "failed", error: { title: CHATS_NEED_UPDATE.title, hint: CHATS_NEED_UPDATE.hint } });
    } finally {
      core.host = realHost;
    }
  });

  test("a retry links the chat's own agent, else starts the chat again, never in a worktree", async () => {
    const { apiError, core } = await import("@/core");
    const { dispatchTask, isInFlight, onDispatchSettled, retryDispatch, threadKey, useDispatch } = await import("./store");
    const key = threadKey("hr", CHAT_REPO);
    const entryOf = (id: string) => useDispatch.getState().threads[key]?.find((x) => x.id === id);
    const calls: Call[] = [];
    let answer: () => Promise<unknown> = () => Promise.reject(apiError("internal", "herdr is restarting"));
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hr") calls.push({ method, params });
        return answer() as Promise<never>;
      },
    });
    const send = async (prompt: string) => {
      const e = dispatchTask({ hostId: "hr", repo: CHAT_REPO, prompt, options, taken: [], suggest: null });
      await until(onDispatchSettled, () => !isInFlight(e.id));
      return e;
    };
    const retry = async (id: string, agents: Agent[]) => {
      calls.length = 0;
      await retryDispatch({ key, id, taken: agents.map((a) => a.name), host: { agents, workspaces: [] } });
      await until(onDispatchSettled, () => !isInFlight(id));
    };
    try {
      // Failed; meanwhile a worktree agent took its name: not the chat's, so it starts again under a free one.
      const failed = await send("Draft a polite reply to my landlord");
      expect(entryOf(failed.id)?.phase).toBe("failed");
      answer = () => Promise.resolve({ agentId: "chat-new", paneId: "wc:p7", workspaceId: "wc" });
      await retry(failed.id, [{ id: "wt9", name: failed.name, kind: "omp", paneId: "w2:p1", workspaceId: "w2", column: "running" } as Agent]);
      const fresh = uniqueSlug(failed.name, new Set([failed.name]));
      expect(calls).toMatchObject([{ method: "agent.start", params: { target: { kind: "chat" }, spec: { name: fresh } } }]);
      expect(entryOf(failed.id)).toMatchObject({ phase: "started", name: fresh, agentId: "chat-new" });

      // Failed, but its chat agent is there after all: linked, nothing started.
      answer = () => Promise.reject(apiError("internal", "herdr is restarting"));
      const there = await send("Plan meals for next week");
      await retry(there.id, [{ id: "chat-7", name: there.name, kind: "omp", paneId: "wc:p8", workspaceId: "wc", column: "running", chat: true } as Agent]);
      expect(calls).toEqual([]);
      expect(entryOf(there.id)).toMatchObject({ phase: "started", agentId: "chat-7", paneId: "wc:p8" });

      // Unconfirmed (the answer got lost) and not on the board: started again under its own name.
      answer = () => Promise.reject(apiError("timeout", "agent.start timed out"));
      const lost = await send("Explain how tides work");
      expect(entryOf(lost.id)?.phase).toBe("unknown");
      answer = () => Promise.resolve({ agentId: "chat-9", paneId: "wc:p9", workspaceId: "wc" });
      await retry(lost.id, []);
      expect(calls).toMatchObject([{ method: "agent.start", params: { target: { kind: "chat" }, spec: { name: lost.name } } }]);
      expect(entryOf(lost.id)).toMatchObject({ phase: "started", name: lost.name, agentId: "chat-9" });
    } finally {
      core.host = realHost;
    }
  });

  test("the chat choice and chat entries survive a reload; a focus request doesn't", async () => {
    const { threadKey, useDispatch } = await import("./store");
    const key = threadKey("hp", CHAT_REPO);
    useDispatch.getState().select("hp", CHAT_REPO);
    useDispatch.getState().add(key, { id: "chat-saved", prompt: "hi", createdAt: Date.now(), branch: "", name: "hi", options, phase: "started", hostId: "hp", chat: true, agentId: "a1" });
    useDispatch.getState().focusComposer();
    // A distinct specifier loads the module afresh, as a reload does.
    const reload = "./store?chat-reload";
    const s = ((await import(reload)) as typeof StoreModule).useDispatch.getState();
    expect([s.lastHost, s.lastRepo.hp]).toEqual(["hp", CHAT_REPO]);
    expect(s.threads[key]?.map((e) => [e.id, e.chat, e.branch])).toEqual([["chat-saved", true, ""]]);
    expect(s.composerFocus).toBe(0);
  });
});

describe("in this folder", () => {
  const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
  type Call = { method: string; params: unknown };

  /** Resolves once none of `ids` is in flight (other tests' sends settle too). */
  const settle = async (ids: readonly string[]) => {
    // Dynamic: the store must load after the localStorage stub (it hydrates at module load).
    const { isInFlight, onDispatchSettled } = await import("./store");
    const done = () => ids.every((id) => !isInFlight(id));
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    await new Promise<void>((resolve) => {
      if (done()) {
        resolve();
        return;
      }
      const off = onDispatchSettled(() => {
        if (!done()) return;
        off();
        resolve();
      });
    });
  };

  test("a task in place is one agent.start with its folder as the cwd: no branch, base, branch list or worktree", async () => {
    const { core } = await import("@/core");
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    const calls: Call[] = [];
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hip") calls.push({ method, params });
        return Promise.resolve({ agentId: "ip-1", paneId: "w9:p1", workspaceId: "w9" } as never);
      },
    });
    try {
      const prompt = "Fix the flaky login test";
      const slug = baseSlug(prompt);
      // A base and a branch lookup don't apply in place.
      const e = dispatchTask({ hostId: "hip", repo: "/r/app", inPlace: true, prompt, options: { ...options, plan: true }, base: "dev", baseLabel: "dev", resolveBase: { legacy: false }, taken: [slug], suggest: null });
      const name = uniqueSlug(slug, new Set([slug]));
      expect(e).toMatchObject({ inPlace: true, branch: "", name, repo: "/r/app", hostId: "hip" });
      expect([e.base, e.baseLabel, e.chat]).toEqual([undefined, undefined, undefined]);
      await settle([e.id]);
      expect(calls.map((c) => c.method)).toEqual(["agent.start"]);
      expect(calls[0]?.params).toMatchObject({ target: { kind: "cwd", cwd: "/r/app", label: name }, spec: { kind: "omp", name, plan: true, prompt } });
      expect(useDispatch.getState().threads[threadKey("hip", "/r/app")]?.find((x) => x.id === e.id)).toMatchObject({ phase: "started", agentId: "ip-1", paneId: "w9:p1", workspaceId: "w9" });
    } finally {
      core.host = realHost;
    }
  });

  test("a retry links its agent in the folder, else starts it again; an unconfirmed start never becomes a second agent", async () => {
    const { apiError, core } = await import("@/core");
    const { dispatchTask, retryDispatch, threadKey, useDispatch } = await import("./store");
    const key = threadKey("hrp", "/r/app");
    const entryOf = (id: string) => useDispatch.getState().threads[key]?.find((x) => x.id === id);
    const calls: Call[] = [];
    let answer: () => Promise<unknown> = () => Promise.reject(apiError("internal", "herdr is restarting"));
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hrp") calls.push({ method, params });
        return answer() as Promise<never>;
      },
    });
    const ws = (id: string, cwd: string, extra: Partial<Workspace> = {}): Workspace => ({ id, label: id, cwd, tabs: [], rollup: "idle", order: 0, ...extra });
    const workspaces = [
      ws("w1", "/r/app", { repo: { root: "/r/app", name: "app", branch: "main" } }),
      ws("w2", "/wt/app/other", { repo: { root: "/r/app", name: "app", branch: "other" }, worktree: { path: "/wt/app/other", branch: "other" } }),
    ];
    const agent = (p: Partial<Agent>) => ({ kind: "omp", column: "running", ...p }) as Agent;
    const send = async (prompt: string) => {
      const e = dispatchTask({ hostId: "hrp", repo: "/r/app", inPlace: true, prompt, options, taken: [], suggest: null });
      await settle([e.id]);
      return e;
    };
    const retry = async (id: string, agents: Agent[]) => {
      calls.length = 0;
      await retryDispatch({ key, id, taken: agents.map((a) => a.name), host: { agents, workspaces } });
      await settle([id]);
    };
    try {
      // Failed, but its agent works in the folder after all: linked, nothing started.
      const there = await send("Fix the README typos");
      expect(entryOf(there.id)?.phase).toBe("failed");
      await retry(there.id, [agent({ id: "a1", name: there.name, paneId: "w1:p2", workspaceId: "w1", cwd: "/r/app" })]);
      expect(calls).toEqual([]);
      // Linked: the folder as the host spells it is remembered.
      expect(entryOf(there.id)).toMatchObject({ phase: "started", agentId: "a1", paneId: "w1:p2", workspaceId: "w1", path: "/r/app" });

      // Failed; meanwhile an agent in a worktree of the repository took its name: not its own, so it starts again under a free one.
      const failed = await send("Bump the lockfile");
      answer = () => Promise.resolve({ agentId: "a2", paneId: "w3:p1", workspaceId: "w3" });
      await retry(failed.id, [agent({ id: "wt", name: failed.name, paneId: "w2:p1", workspaceId: "w2", cwd: "/wt/app/other" })]);
      const fresh = uniqueSlug(failed.name, new Set([failed.name]));
      expect(calls).toMatchObject([{ method: "agent.start", params: { target: { kind: "cwd", cwd: "/r/app", label: fresh }, spec: { name: fresh } } }]);
      expect(entryOf(failed.id)).toMatchObject({ phase: "started", name: fresh, agentId: "a2" });

      // Unconfirmed (the answer got lost) and not on the board: started again under its own name.
      answer = () => Promise.reject(apiError("timeout", "agent.start timed out"));
      const lost = await send("Write the changelog");
      expect(entryOf(lost.id)?.phase).toBe("unknown");
      answer = () => Promise.resolve({ agentId: "a3", paneId: "w4:p1", workspaceId: "w4" });
      await retry(lost.id, []);
      expect(calls).toMatchObject([{ method: "agent.start", params: { target: { kind: "cwd", cwd: "/r/app", label: lost.name }, spec: { name: lost.name } } }]);
      expect(entryOf(lost.id)).toMatchObject({ phase: "started", name: lost.name, agentId: "a3" });

      // The first start may have brought its agent up: herdr refuses the name, so the entry stays unconfirmed with the name
      // held (Check & retry, Dismiss) while an agent of that name shows up where the card can't tell it is its own.
      answer = () => Promise.reject(apiError("timeout", "agent.start timed out"));
      const late = await send("Sort the imports");
      answer = () => Promise.reject(apiError("herdr_error", `agent_name_taken: agent name \`${late.name}\` is already used`));
      await retry(late.id, [agent({ id: "a4", name: late.name, paneId: "w5:p1", workspaceId: "w5", cwd: "/elsewhere" })]);
      expect(calls).toMatchObject([{ method: "agent.start", params: { spec: { name: late.name } } }]);
      expect(entryOf(late.id)).toMatchObject({ phase: "unknown", name: late.name, error: { held: true } });
      expect(entryOf(late.id)?.agentId).toBeUndefined();
      // It was this task's agent after all, now in the folder: Check & retry links it, nothing started.
      await retry(late.id, [agent({ id: "a4", name: late.name, paneId: "w1:p3", workspaceId: "w1", cwd: "/r/app" })]);
      expect(calls).toEqual([]);
      expect(entryOf(late.id)).toMatchObject({ phase: "started", agentId: "a4" });
      expect(entryOf(late.id)?.error).toBeUndefined();

      // A first send refused the same way failed: there was no earlier start to wait for.
      const refused = await send("Rename the config loader");
      expect(entryOf(refused.id)).toMatchObject({ phase: "failed" });

      // The host spells the folder another way (a symlink): its agent is found in the workspace its start opened, and
      // that spelling is remembered for later.
      useDispatch.getState().add(key, { id: "sym-1", prompt: "x", createdAt: Date.now(), branch: "", name: "sym-task", options, phase: "unknown", hostId: "hrp", repo: "/r/app", inPlace: true, workspaceId: "w9" });
      const opened = ws("w9", "/data/r/app", { label: "sym-task" });
      const sym = agent({ id: "a9", name: "sym-task", paneId: "w9:p1", workspaceId: "w9", cwd: "/data/r/app" });
      await retryDispatch({ key, id: "sym-1", taken: [sym.name], host: { agents: [sym], workspaces: [...workspaces, opened] } });
      expect(entryOf("sym-1")).toMatchObject({ phase: "started", agentId: "a9", path: "/data/r/app" });
    } finally {
      core.host = realHost;
    }
  });

  test("an entry from before keeps its dispatch/ branch: a retry finds that worktree and starts the agent there", async () => {
    const { core } = await import("@/core");
    const { retryDispatch, threadKey, useDispatch } = await import("./store");
    const key = threadKey("hlg", "/r/app");
    const calls: Call[] = [];
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hlg") calls.push({ method, params });
        if (method === "worktree.list") {
          return Promise.resolve({
            worktrees: [
              { path: "/r/app", branch: "refs/heads/main", primary: true },
              { path: "/wt/app/dispatch-old-task", branch: "refs/heads/dispatch/old-task", primary: false, workspaceId: "w7" },
            ],
          } as never);
        }
        if (method === "git.branches") return Promise.resolve({ branches: [{ name: "main", current: true, remote: false }, { name: "dispatch/old-task", current: false, remote: false }], defaultBranch: "main" } as never);
        return Promise.resolve({ agentId: "old-1", paneId: "w7:p2", workspaceId: "w7" } as never);
      },
    });
    try {
      useDispatch.getState().add(key, { id: "legacy-1", prompt: "An older task", createdAt: Date.now(), branch: "dispatch/old-task", name: "old-task", options, phase: "failed", hostId: "hlg", repo: "/r/app", error: { title: "herdr is restarting", kind: "other" } });
      await retryDispatch({ key, id: "legacy-1", taken: [], host: { agents: [], workspaces: [] } });
      await settle(["legacy-1"]);
      expect(calls.map((c) => c.method)).toEqual(["worktree.list", "git.branches", "agent.start"]);
      expect(calls[2]?.params).toMatchObject({ target: { kind: "workspace", workspaceId: "w7" }, spec: { name: "old-task" } });
      expect(useDispatch.getState().threads[key]?.[0]).toMatchObject({ phase: "started", branch: "dispatch/old-task", path: "/wt/app/dispatch-old-task", agentId: "old-1" });
    } finally {
      core.host = realHost;
    }
  });

  test("a worktree retry refused the agent's name stays unconfirmed with the name held, never started blind", async () => {
    const { apiError, core } = await import("@/core");
    const { retryDispatch, threadKey, useDispatch } = await import("./store");
    const key = threadKey("hwh", "/r/app");
    const calls: Call[] = [];
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hwh") calls.push({ method, params });
        if (method === "worktree.list") return Promise.resolve({ worktrees: [{ path: "/r/app", branch: "refs/heads/main", primary: true }, { path: "/wt/app/fix-ci", branch: "refs/heads/fix-ci", primary: false, workspaceId: "w7" }] } as never);
        if (method === "git.branches") return Promise.resolve({ branches: [{ name: "main", current: true, remote: false }, { name: "fix-ci", current: false, remote: false }], defaultBranch: "main" } as never);
        return Promise.reject(apiError("herdr_error", "agent_name_taken: agent name `fix-ci` is already used"));
      },
    });
    try {
      useDispatch.getState().add(key, { id: "wt-held", prompt: "Fix CI", createdAt: Date.now(), branch: "fix-ci", name: "fix-ci", aiNamed: true, options, phase: "unknown", hostId: "hwh", repo: "/r/app", error: { title: "worktree.create timed out", kind: "other" } });
      await retryDispatch({ key, id: "wt-held", taken: [], host: { agents: [], workspaces: [] } });
      await settle(["wt-held"]);
      expect(calls.map((c) => c.method)).toEqual(["worktree.list", "git.branches", "agent.start"]);
      expect(useDispatch.getState().threads[key]?.[0]).toMatchObject({ phase: "unknown", path: "/wt/app/fix-ci", workspaceId: "w7", error: { held: true } });
    } finally {
      core.host = realHost;
    }
  });

  test("after branch_exists a retry never adopts that branch's worktree: it renames past local and remote branches", async () => {
    const { core } = await import("@/core");
    const { retryDispatch, threadKey, useDispatch } = await import("./store");
    const key = threadKey("hbe", "/r/app");
    const calls: Call[] = [];
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hbe") calls.push({ method, params });
        if (method === "worktree.list") return Promise.resolve({ worktrees: [{ path: "/r/app", branch: "refs/heads/main", primary: true }, { path: "/wt/app/fix-ci", branch: "refs/heads/fix-ci", primary: false, workspaceId: "w8" }] } as never);
        if (method === "git.branches") {
          const branches = [{ name: "main", current: true, remote: false }, { name: "fix-ci", current: false, remote: false }, { name: "origin/fix-ci-2", current: false, remote: true }];
          return Promise.resolve({ branches, defaultBranch: "main" } as never);
        }
        const p = params as WorktreeCreateParams;
        return Promise.resolve({ path: `/wt/app/${p.branch}`, branch: p.branch, workspaceId: "w9", agent: { agentId: "a9", paneId: "w9:p1", workspaceId: "w9" } } as never);
      },
    });
    try {
      useDispatch.getState().add(key, { id: "wt-exists", prompt: "Fix CI", createdAt: Date.now(), branch: "fix-ci", name: "fix-ci", aiNamed: true, options, phase: "failed", hostId: "hbe", repo: "/r/app", error: { title: "a branch named 'fix-ci' already exists", kind: "branchExists" } });
      await retryDispatch({ key, id: "wt-exists", taken: [], host: { agents: [], workspaces: [] } });
      await settle(["wt-exists"]);
      expect(calls.map((c) => c.method)).toEqual(["worktree.list", "git.branches", "worktree.create"]);
      expect(calls[2]?.params).toMatchObject({ cwd: "/r/app", branch: "fix-ci-3", label: "fix-ci-3" });
      expect(useDispatch.getState().threads[key]?.[0]).toMatchObject({ phase: "started", name: "fix-ci-3", branch: "fix-ci-3", agentId: "a9" });
    } finally {
      core.host = realHost;
    }
  });

  test("each thread's mode and the folders picked as such survive a reload", async () => {
    const { threadKey, useDispatch } = await import("./store");
    const s = useDispatch.getState();
    const notes = threadKey("hm", "/home/a/notes");
    const app = threadKey("hm", "/r/app");
    s.select("hm", "/home/a/notes", { inPlace: true, folder: true });
    s.setInPlace(app, true);
    // A plain pick changes neither.
    s.select("hm", "/r/app");
    // A distinct specifier loads the module afresh, as a reload does.
    const reload = "./store?mode-reload";
    const t = ((await import(reload)) as typeof StoreModule).useDispatch.getState();
    expect([t.inPlace[notes], t.inPlace[app], t.folders[notes], t.folders[app], t.lastRepo.hm]).toEqual([true, true, true, undefined, "/r/app"]);
    // Back to new worktrees; the folder picked again as a repository is one.
    s.setInPlace(app, false);
    s.select("hm", "/home/a/notes", { inPlace: false, folder: false });
    const u = useDispatch.getState();
    expect([u.inPlace[notes], u.inPlace[app], u.folders[notes]]).toEqual([undefined, undefined, undefined]);
  });
});

describe("a message that is a command", () => {
  const options = { templateId: null, model: "default", thinking: "default" as const, plan: true };
  type Call = { method: string; params: unknown };

  /** Resolves once none of `ids` is in flight (other tests' sends settle too). */
  const settle = async (ids: readonly string[]) => {
    // Dynamic: the store must load after the localStorage stub (it hydrates at module load).
    const { isInFlight, onDispatchSettled } = await import("./store");
    const done = () => ids.every((id) => !isInFlight(id));
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    await new Promise<void>((resolve) => {
      if (done()) {
        resolve();
        return;
      }
      const off = onDispatchSettled(() => {
        if (!done()) return;
        off();
        resolve();
      });
    });
  };

  test("its agent runs it instead of getting it as its prompt, named after its task; a mode command leaves the Plan option off", async () => {
    // Dynamic, as above: these load the store, which hydrates from localStorage at module load.
    const { core } = await import("@/core");
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    const calls: Call[] = [];
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hcmd") calls.push({ method, params });
        return Promise.resolve({ path: "/w", branch: "b", workspaceId: "w", agentId: "a", paneId: "p" } as never);
      },
    });
    try {
      const send = (repo: string, line: string, replacesPlan: boolean) => dispatchTask({ hostId: "hcmd", repo, prompt: line, command: { line, replacesPlan }, options, taken: [], suggest: null });
      const plan = send("/r/cmd", "/plan add a settings page", true);
      const fast = send("/r/cmd", "/fast on", false);
      const chat = send(CHAT_REPO, "/skill:review the auth module", false);
      expect([plan.name, fast.name, chat.name]).toEqual(["settings-page", "fast-on", "auth-module"]);
      // `/plan` picks the mode itself: its entry (and a retry) goes without the Plan option; the composer keeps it.
      expect([plan.options.plan, fast.options.plan]).toEqual([false, true]);
      expect(useDispatch.getState().options?.plan).toBe(true);
      await settle([plan.id, fast.id, chat.id]);
      const agentOf = (label: string) => (calls.find((c) => c.method === "worktree.create" && (c.params as WorktreeCreateParams).label === label)?.params as WorktreeCreateParams | undefined)?.agent;
      expect(agentOf("settings-page")).toMatchObject({ command: "/plan add a settings page", plan: false });
      expect(agentOf("settings-page")?.prompt).toBeUndefined();
      expect(agentOf("fast-on")).toMatchObject({ command: "/fast on", plan: true });
      const started = calls.find((c) => c.method === "agent.start")?.params as StartParams | undefined;
      expect(started).toMatchObject({ target: { kind: "chat" }, spec: { name: "auth-module", command: "/skill:review the auth module" } });
      expect(started?.spec.prompt).toBeUndefined();
      // The thread shows each message as typed.
      expect(useDispatch.getState().threads[threadKey("hcmd", "/r/cmd")]?.map((e) => [e.prompt, e.command])).toEqual([
        ["/plan add a settings page", "/plan add a settings page"],
        ["/fast on", "/fast on"],
      ]);
    } finally {
      core.host = realHost;
    }
  });

  test("goal mode: the task, on one line, becomes the agent's goal; plan is off, a role main model goes as is", async () => {
    // Dynamic, as above: the store hydrates from localStorage at module load.
    const { core } = await import("@/core");
    const { dispatchTask } = await import("./store");
    const calls: Call[] = [];
    const realHost = core.host;
    core.host = (hostId) => ({
      call: (method, params) => {
        if (hostId === "hgoal") calls.push({ method, params });
        return Promise.resolve({ path: "/w", branch: "b", workspaceId: "w", agentId: "a", paneId: "p" } as never);
      },
    });
    try {
      const goal = { ...options, model: "@slow", thinking: "max" as const, goal: true };
      const task = dispatchTask({ hostId: "hgoal", repo: "/r/goal", prompt: "Fix the flaky tests:\n- auth\n- billing", options: goal, taken: [], suggest: null });
      // A command typed in goal mode runs as typed and starts no goal.
      const cmd = dispatchTask({ hostId: "hgoal", repo: "/r/goal", prompt: "/fast on", command: { line: "/fast on", replacesPlan: false }, options: goal, taken: [], suggest: null });
      await settle([task.id, cmd.id]);
      const agentOf = (label: string) => (calls.find((c) => c.method === "worktree.create" && (c.params as WorktreeCreateParams).label === label)?.params as WorktreeCreateParams | undefined)?.agent;
      expect(agentOf(task.name)).toMatchObject({ command: "/goal set Fix the flaky tests: - auth - billing", plan: false, model: "@slow", thinking: "max" });
      expect(agentOf(task.name)?.prompt).toBeUndefined();
      expect(agentOf(cmd.name)).toMatchObject({ command: "/fast on", plan: true });
    } finally {
      core.host = realHost;
    }
  });

  test("omp's tiny model names a command after its task, and only a command that gives one", async () => {
    // Dynamic, as above: the store and the prefs read localStorage at module load.
    const { core } = await import("@/core");
    const { aiTesting } = await import("@/core/ai");
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    const asked: string[] = [];
    aiTesting.reset();
    aiTesting.setComplete(async (_hostId, p) => {
      asked.push(p.prompt);
      return { text: "settings-page", ms: 1 };
    });
    const realHost = core.host;
    core.host = () => ({ call: () => Promise.resolve({ path: "/w", branch: "b", workspaceId: "w" } as never) });
    try {
      const plan = dispatchTask({ hostId: "hai", repo: "/r/ai", prompt: "/plan add a settings page", command: { line: "/plan add a settings page", replacesPlan: true }, options, taken: [] });
      const fast = dispatchTask({ hostId: "hai", repo: "/r/ai", prompt: "/fast on", command: { line: "/fast on", replacesPlan: false }, options, taken: [] });
      expect([plan.phase, fast.phase]).toEqual(["naming", "queued"]);
      await settle([plan.id, fast.id]);
      expect(asked.length).toBe(1);
      expect(asked[0]).toContain("add a settings page");
      expect(asked[0]).not.toContain("/plan");
      expect(useDispatch.getState().threads[threadKey("hai", "/r/ai")]?.find((e) => e.id === plan.id)).toMatchObject({ name: "settings-page", aiNamed: true });
    } finally {
      aiTesting.setComplete(null);
      aiTesting.reset();
      core.host = realHost;
    }
  });
});
