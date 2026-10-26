import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { aiNamingEnabled, core, getAgentViews, suggestBranch, toApiError, useSettings } from "@/core";
import type { Agent, AgentSpec, Column, StartTarget, ThinkingLevel, Workspace } from "@/core/gen";
import { classifyHerdrError, describeError, type HerdrFailure } from "@/features/workspace/shared/errors";
import { BRANCH_PREFIX, type BranchSuggester, baseSlug, nameDispatch, resolveAgent, slimThreads, uniqueSlug } from "./thread";

/*
 * Dispatch threads: every message fired at a repo becomes one `worktree.create` with an omp agent
 * spec. Entries persist per host + repo (localStorage, capped) so the thread survives reloads; the
 * live state of each agent always comes from host state, `last` keeps a summary for agents that
 * have since been closed.
 */

/** Entries kept per thread (oldest dropped first). */
export const MAX_ENTRIES = 200;
/** Worktree creations running at once per thread; the rest wait in "queued". */
export const MAX_CONCURRENT = 3;
/**
 * Persisted budget (localStorage is ~5 MB per origin, shared with the rest of the app): prompts
 * are stored up to this many characters, and at most this many entries across all threads.
 */
export const MAX_STORED_PROMPT = 4000;
export const MAX_STORED_ENTRIES = 600;

const DEFAULT = "default";

/** Errors after which the host may still be creating the worktree / agent (the answer got lost). */
const UNCERTAIN_CODES: Record<string, true> = { timeout: true, not_connected: true, disconnected: true };

/** Per-dispatch agent options (`"default"` = the host's default for model / thinking). */
export interface DispatchOptions {
  templateId: string | null;
  model: string;
  thinking: ThinkingLevel | "default";
  plan: boolean;
}

/**
 * `naming` (omp's tiny model is naming the branch; skipped when AI naming is off) → `queued` →
 * `creating` (worktree.create in flight) → `started` (herdr answered; the agent's own progress
 * comes from host state), `failed` (herdr refused), or `unknown` (the request timed out or the
 * connection dropped: the host may still be creating it, so the entry keeps looking for its
 * agent). A `queued`/`creating` entry that is no longer in flight was interrupted by a reload; a
 * `naming` one never reached the host and resumes under its fallback name.
 */
export type DispatchPhase = "naming" | "queued" | "creating" | "started" | "failed" | "unknown";

export interface DispatchError {
  title: string;
  hint?: string;
  kind: HerdrFailure["kind"];
}

/** Last state seen in host state, shown once the agent is gone (archived and closed, pane killed…). */
export interface LastSeen {
  column: Column;
  title: string;
  turns: number;
  at: number;
}

export interface DispatchEntry {
  id: string;
  prompt: string;
  createdAt: number;
  /** `dispatch/<slug>` (while `naming`: the fallback, the prompt's slug). */
  branch: string;
  /** Agent name and workspace label (`<slug>`). */
  name: string;
  /** The slug came from omp's tiny model. */
  aiNamed?: boolean;
  /** Base ref; absent = HEAD. */
  base?: string;
  options: DispatchOptions;
  phase: DispatchPhase;
  /** When herdr answered (phase `started`). */
  startedAt?: number;
  workspaceId?: string;
  agentId?: string;
  paneId?: string;
  path?: string;
  error?: DispatchError;
  last?: LastSeen;
  /** The agent's omp session, captured while it is live: finds it again once resumed under a new id, or pruned. */
  sessionId?: string;
}

/** Persisted thread key: one thread per host + repository root. */
export function threadKey(hostId: string, repo: string): string {
  return `${hostId}\u0000${repo}`;
}

interface DispatchState {
  threads: Record<string, DispatchEntry[]>;
  /** Last host used, and the last repo per host. */
  lastHost: string | null;
  lastRepo: Record<string, string>;
  /** Base branch per thread (absent = the repo's default branch). */
  bases: Record<string, string>;
  /** Threads whose repo the user trusted (`--trust-repository`). */
  trusted: Record<string, true>;
  /** Composer options of the last dispatch (null = Settings defaults). */
  options: DispatchOptions | null;
  select(hostId: string, repo?: string | null): void;
  setBase(key: string, base: string | null): void;
  setOptions(options: DispatchOptions): void;
  trust(key: string): void;
  add(key: string, entry: DispatchEntry): void;
  patch(key: string, id: string, patch: Partial<DispatchEntry>): void;
  remove(key: string, ids: readonly string[]): void;
  clear(key: string): void;
}

type Persisted = Pick<DispatchState, "threads" | "lastHost" | "lastRepo" | "bases" | "trusted" | "options">;

let warnedQuota = false;

/**
 * localStorage that never throws into zustand: a full quota first retries with a much smaller
 * thread history, then gives up on persisting (the in-memory thread keeps working).
 */
const safeLocalStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
      return;
    } catch {
      // quota: fall through to the slim copy
    }
    try {
      const parsed = JSON.parse(value) as { state: Persisted; version?: number };
      parsed.state = { ...parsed.state, threads: slimThreads(parsed.state.threads, 100, 500) };
      localStorage.setItem(name, JSON.stringify(parsed));
    } catch (e) {
      if (!warnedQuota) console.warn("dispatch: couldn't save threads (storage full)", e);
      warnedQuota = true;
    }
  },
  removeItem: (name) => localStorage.removeItem(name),
};

export const useDispatch = create<DispatchState>()(
  persist(
    (set) => ({
      threads: {},
      lastHost: null,
      lastRepo: {},
      bases: {},
      trusted: {},
      options: null,
      select: (hostId, repo) =>
        set((s) => {
          if (repo === undefined) return { lastHost: hostId };
          const lastRepo = { ...s.lastRepo };
          if (repo) lastRepo[hostId] = repo;
          else delete lastRepo[hostId];
          return { lastHost: hostId, lastRepo };
        }),
      setBase: (key, base) =>
        set((s) => {
          const bases = { ...s.bases };
          if (base) bases[key] = base;
          else delete bases[key];
          return { bases };
        }),
      setOptions: (options) => set({ options }),
      trust: (key) => set((s) => ({ trusted: { ...s.trusted, [key]: true } })),
      add: (key, entry) => set((s) => ({ threads: { ...s.threads, [key]: [...(s.threads[key] ?? []), entry].slice(-MAX_ENTRIES) } })),
      patch: (key, id, patch) =>
        set((s) => {
          const list = s.threads[key];
          if (!list?.some((e) => e.id === id)) return s;
          return { threads: { ...s.threads, [key]: list.map((e) => (e.id === id ? { ...e, ...patch } : e)) } };
        }),
      remove: (key, ids) =>
        set((s) => {
          const list = s.threads[key];
          if (!list) return s;
          return { threads: { ...s.threads, [key]: list.filter((e) => !ids.includes(e.id)) } };
        }),
      clear: (key) =>
        set((s) => {
          const threads = { ...s.threads };
          delete threads[key];
          return { threads };
        }),
    }),
    {
      name: "tf.dispatch",
      version: 1,
      storage: createJSONStorage<Persisted>(() => safeLocalStorage),
      partialize: (s): Persisted => ({
        threads: slimThreads(s.threads, MAX_STORED_ENTRIES, MAX_STORED_PROMPT),
        lastHost: s.lastHost,
        lastRepo: s.lastRepo,
        bases: s.bases,
        trusted: s.trusted,
        options: s.options,
      }),
    },
  ),
);

// ---------------------------------------------------------------- running

/** Entry ids with a request (create, or a retry's check) queued or in flight in this tab. */
const inflight = new Set<string>();
const subscribers = new Set<() => void>();
const queues = new Map<string, { running: number; waiting: (() => void)[] }>();

/** False for a `queued`/`creating` entry whose request was lost to a reload. */
export function isInFlight(id: string): boolean {
  return inflight.has(id);
}

function slot(key: string): Promise<() => void> {
  let q = queues.get(key);
  if (!q) {
    q = { running: 0, waiting: [] };
    queues.set(key, q);
  }
  const queue = q;
  const release = () => {
    queue.running--;
    queue.waiting.shift()?.();
  };
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve) => {
    const start = () => {
      queue.running++;
      resolve(release);
    };
    if (queue.running < MAX_CONCURRENT) start();
    else queue.waiting.push(start);
  });
}

function specOf(e: DispatchEntry): AgentSpec {
  const template = useSettings.getState().templates.find((t) => t.id === e.options.templateId);
  const task = e.prompt.trim();
  return {
    kind: "omp",
    name: e.name,
    model: e.options.model === DEFAULT ? undefined : e.options.model,
    thinking: e.options.thinking === DEFAULT ? undefined : e.options.thinking,
    plan: e.options.plan,
    // A template's own instructions frame the task (as in Fan out).
    prompt: template?.prompt.trim() ? `${template.prompt.trim()}\n\n${task}` : task,
  };
}

/** A failure → `failed`, or `unknown` when the host may have carried on regardless. */
function failurePatch(err: unknown): Partial<DispatchEntry> {
  const uncertain = UNCERTAIN_CODES[toApiError(err).code] === true;
  return { phase: uncertain ? "unknown" : "failed", error: { ...describeError(err), kind: classifyHerdrError(err).kind } };
}

function settled(id: string): void {
  inflight.delete(id);
  for (const cb of subscribers) cb();
}

async function run(hostId: string, repo: string, id: string): Promise<void> {
  const key = threadKey(hostId, repo);
  const store = useDispatch.getState;
  inflight.add(id);
  let release: (() => void) | undefined;
  try {
    store().patch(key, id, { phase: "queued", error: undefined });
    release = await slot(key);
    const e = store().threads[key]?.find((x) => x.id === id);
    if (!e) return;
    store().patch(key, id, { phase: "creating" });
    const created = await core.host(hostId).call("worktree.create", {
      cwd: repo,
      branch: e.branch,
      base: e.base,
      label: e.name,
      existing: false,
      trust: !!store().trusted[key],
      agent: specOf(e),
    });
    store().patch(key, id, {
      phase: "started",
      startedAt: Date.now(),
      workspaceId: created.agent?.workspaceId ?? created.workspaceId,
      agentId: created.agent?.agentId,
      paneId: created.agent?.paneId,
      path: created.path,
    });
  } catch (err) {
    store().patch(key, id, failurePatch(err));
  } finally {
    release?.();
    settled(id);
  }
}

/** Called after every finished worktree.create (e.g. to refresh the branch list). */
export function onDispatchSettled(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/**
 * Names a new dispatch on this host must not use: every live entry of every thread on the host.
 * herdr agent names are unique per host, so an entry of another repo that is still being created
 * (not yet visible in host state) reserves its name too. `except` = the entry being retried.
 */
function reservedNames(hostId: string, taken: Iterable<string>, except?: string): Set<string> {
  const out = new Set(taken);
  const prefix = threadKey(hostId, "");
  for (const [k, list] of Object.entries(useDispatch.getState().threads)) {
    if (!k.startsWith(prefix)) continue;
    for (const e of list) if (e.id !== except && e.phase !== "failed") out.add(e.name);
  }
  return out;
}

let seq = 0;

/** How long a send waits for omp's tiny model to name it (shown as "Naming…"). */
export const NAMING_TIMEOUT_MS = 10_000;

/**
 * The tiny model's branch slug for a task sent to `repo`. The composer prefetches through this
 * same call while the user types, so most sends find the answer in ai.ts's cache.
 */
export function suggestDispatchName(hostId: string, repo: string, prompt: string): Promise<string | null> {
  return suggestBranch(hostId, prompt, { timeoutMs: NAMING_TIMEOUT_MS, cwd: repo });
}

/**
 * Fire one task: append an entry to the thread and create its worktree + agent in the background.
 * `taken` = names that are not free (existing branches, live agent names); the host's own
 * dispatches are added here, so rapid sends (to any repo) never collide with each other.
 * With a namer (default: omp's tiny model when AI naming is on; `null` = none) the entry first
 * goes through `naming`, holding the prompt's slug as its fallback name meanwhile.
 */
export function dispatchTask(args: {
  hostId: string;
  repo: string;
  prompt: string;
  base?: string;
  options: DispatchOptions;
  taken: Iterable<string>;
  suggest?: BranchSuggester | null;
}): DispatchEntry {
  const key = threadKey(args.hostId, args.repo);
  const s = useDispatch.getState();
  const taken = [...args.taken];
  const name = uniqueSlug(baseSlug(args.prompt), reservedNames(args.hostId, taken));
  const suggest =
    args.suggest !== undefined ? args.suggest : aiNamingEnabled(args.hostId) ? (prompt: string) => suggestDispatchName(args.hostId, args.repo, prompt) : null;
  const entry: DispatchEntry = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    prompt: args.prompt,
    createdAt: Date.now(),
    branch: `${BRANCH_PREFIX}${name}`,
    name,
    base: args.base,
    options: args.options,
    phase: suggest ? "naming" : "queued",
  };
  s.add(key, entry);
  s.setOptions(args.options);
  void (suggest ? nameThenRun(args.hostId, args.repo, entry.id, taken, suggest) : run(args.hostId, args.repo, entry.id));
  return entry;
}

/** `naming` → the AI name (or the fallback) made unique the moment the answer is in → `run`. */
async function nameThenRun(hostId: string, repo: string, id: string, taken: readonly string[], suggest: BranchSuggester): Promise<void> {
  const key = threadKey(hostId, repo);
  const store = useDispatch.getState;
  const prompt = store().threads[key]?.find((x) => x.id === id)?.prompt;
  if (prompt === undefined) return;
  inflight.add(id);
  const { slug, ai } = await nameDispatch(prompt, suggest);
  // Dismissed (or the thread cleared) while naming: nothing reached the host.
  if (store().threads[key]?.find((x) => x.id === id)?.phase !== "naming") {
    settled(id);
    return;
  }
  // Dedupe and claim the name in one synchronous step: identical sends share one AI answer and
  // resume in the same tick, so each must see the name the previous one just took.
  const name = uniqueSlug(slug, reservedNames(hostId, taken, id));
  store().patch(key, id, { name, branch: `${BRANCH_PREFIX}${name}`, aiNamed: ai });
  void run(hostId, repo, id);
}

/** Waits between attempts to reach the host of an interrupted `naming` entry (backs off to the max). */
const RESUME_RETRY_MS = 5_000;
const RESUME_RETRY_MAX_MS = 60_000;

/**
 * A `naming` entry whose answer was lost to a reload: nothing reached the host yet, so it goes
 * ahead under the prompt's slug once the host answers, deduped against its branches, its live
 * agents and the host's other dispatches (as `retryDispatch` does).
 */
async function resumeNaming(hostId: string, repo: string, id: string): Promise<void> {
  const key = threadKey(hostId, repo);
  const store = useDispatch.getState;
  const pending = () => store().threads[key]?.find((x) => x.id === id && x.phase === "naming");
  inflight.add(id);
  let wait = RESUME_RETRY_MS;
  for (;;) {
    if (!pending()) {
      settled(id);
      return;
    }
    try {
      const branches = await core.host(hostId).call("git.branches", { cwd: repo });
      const e = pending();
      if (!e) break;
      const live = getAgentViews()
        .filter((a) => a.hostId === hostId)
        .map((a) => a.name);
      const name = uniqueSlug(baseSlug(e.prompt), reservedNames(hostId, [...branches.branches.map((b) => b.name), ...live], id));
      store().patch(key, id, { name, branch: `${BRANCH_PREFIX}${name}`, aiNamed: false });
      void run(hostId, repo, id);
      return;
    } catch {
      // Host offline or still connecting: try again later.
      // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, RESUME_RETRY_MAX_MS);
    }
  }
  settled(id);
}

/**
 * Resume every `naming` entry a reload interrupted, in every thread (not just the one on screen).
 * Runs once the persisted threads are loaded; safe to call again (entries in flight are skipped).
 */
export function resumeInterruptedNaming(): void {
  for (const [k, list] of Object.entries(useDispatch.getState().threads)) {
    const [hostId = "", repo = ""] = k.split("\u0000");
    for (const e of list) if (e.phase === "naming" && !inflight.has(e.id)) void resumeNaming(hostId, repo, e.id);
  }
}

// localStorage is synchronous, so the threads are hydrated by now.
if (useDispatch.persist.hasHydrated()) resumeInterruptedNaming();
else useDispatch.persist.onFinishHydration(resumeInterruptedNaming);

const stripRef = (b: string | undefined) => b?.replace(/^refs\/heads\//, "");

/**
 * Run a failed, interrupted or unconfirmed entry again, optionally trusting the repository first.
 * The first attempt may have got further than it reported (a timeout while the host kept going),
 * so this checks before creating anything:
 * 1. its agent is in host state → link it;
 * 2. its worktree exists → start the agent there (if herdr says the name is taken, the agent is
 *    still starting: wait for it);
 * 3. otherwise create it again, under a fresh name if the old branch is left over.
 */
export async function retryDispatch(args: {
  hostId: string;
  repo: string;
  id: string;
  trust?: boolean;
  taken: Iterable<string>;
  host: { agents: readonly Agent[]; workspaces: readonly Workspace[] };
}): Promise<void> {
  const { hostId, repo } = args;
  const key = threadKey(hostId, repo);
  const store = useDispatch.getState;
  const e = store().threads[key]?.find((x) => x.id === args.id);
  if (!e || inflight.has(e.id)) return;
  if (args.trust) store().trust(key);

  const agent = resolveAgent({ ...e, phase: "started" }, args.host.agents, { repo, workspaces: args.host.workspaces });
  if (agent) {
    store().patch(key, e.id, { phase: "started", error: undefined, startedAt: e.startedAt ?? Date.now(), agentId: agent.id, paneId: agent.paneId, workspaceId: agent.workspaceId });
    return;
  }

  inflight.add(e.id);
  let recreate = false;
  try {
    store().patch(key, e.id, { phase: "queued", error: undefined });
    const host = core.host(hostId);
    const [worktrees, branches] = await Promise.all([host.call("worktree.list", { cwd: repo }), host.call("git.branches", { cwd: repo })]);
    const wt = worktrees.worktrees.find((w) => !w.primary && stripRef(w.branch) === e.branch);
    if (wt) {
      store().patch(key, e.id, { phase: "creating", path: wt.path });
      const target: StartTarget = wt.workspaceId ? { kind: "workspace", workspaceId: wt.workspaceId, split: null } : { kind: "cwd", cwd: wt.path, label: e.name };
      try {
        const started = await host.call("agent.start", { target, spec: specOf(e) });
        store().patch(key, e.id, { phase: "started", startedAt: Date.now(), agentId: started.agentId, paneId: started.paneId, workspaceId: started.workspaceId });
      } catch (err) {
        // The first attempt's agent is still coming up under this name: wait for it.
        if (/already taken|already exists|busy/i.test(toApiError(err).message)) store().patch(key, e.id, { phase: "started", startedAt: Date.now(), workspaceId: wt.workspaceId });
        else throw err;
      }
      return;
    }
    const taken = reservedNames(hostId, args.taken, e.id);
    for (const b of branches.branches) taken.add(b.name);
    // An AI name stays the base (a left-over branch makes it `<name>-2`); else the prompt's slug.
    const name = uniqueSlug(e.aiNamed ? e.name : baseSlug(e.prompt), taken);
    store().patch(key, e.id, { name, branch: `${BRANCH_PREFIX}${name}`, agentId: undefined, paneId: undefined, workspaceId: undefined, path: undefined, startedAt: undefined, last: undefined });
    recreate = true;
  } catch (err) {
    store().patch(key, e.id, failurePatch(err));
  } finally {
    // run() takes the entry over (and keeps it in flight) when it has to be created again.
    if (recreate) void run(hostId, repo, e.id);
    else settled(e.id);
  }
}

/**
 * Agents whose omp session was deleted (`HostInfo.pruned`) vanish from Dispatch: every entry of
 * theirs on that host goes, matched by agent id or omp session (the id changes when a parked agent
 * resumes).
 */
export function pruneAgents(hostId: string, agentIds: readonly string[], sessionIds: readonly string[] = []): void {
  const ids = new Set(agentIds);
  const sessions = new Set(sessionIds);
  const gone = (e: DispatchEntry) => (e.agentId !== undefined && ids.has(e.agentId)) || (e.sessionId !== undefined && sessions.has(e.sessionId));
  const prefix = threadKey(hostId, "");
  useDispatch.setState((s) => {
    let threads: Record<string, DispatchEntry[]> | null = null;
    for (const [key, list] of Object.entries(s.threads)) {
      if (!key.startsWith(prefix) || !list.some(gone)) continue;
      threads ??= { ...s.threads };
      threads[key] = list.filter((e) => !gone(e));
    }
    return threads ? { threads } : s;
  });
}
