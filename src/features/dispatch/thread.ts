import type { Agent, HostState, Workspace } from "@/core/gen";
import { basename } from "@/features/workspace/shared/paths";
import { slugFromPrompt } from "@/features/workspace/shared/slug";
import type { DispatchEntry } from "./store";

/** Dispatch branches are `dispatch/<name>`; the agent and its workspace are called `<name>`. */
export const BRANCH_PREFIX = "dispatch/";

/** herdr agent names start with a letter; prompts without usable words fall back to `task`. */
export function baseSlug(prompt: string): string {
  const s = slugFromPrompt(prompt);
  if (!s) return "task";
  return /^[a-z]/.test(s) ? s : `t-${s}`.slice(0, 24).replace(/-+$/, "");
}

/** `slug`, else `slug-2`, `slug-3`… — free as an agent name and as `dispatch/<name>`. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const free = (n: string) => !taken.has(n) && !taken.has(`${BRANCH_PREFIX}${n}`);
  if (free(base)) return base;
  for (let i = 2; ; i++) if (free(`${base}-${i}`)) return `${base}-${i}`;
}

/** The newest `maxEntries` entries across all threads, prompts clipped to `maxPrompt` characters (persisted copy). */
export function slimThreads(threads: Record<string, DispatchEntry[]>, maxEntries: number, maxPrompt: number): Record<string, DispatchEntry[]> {
  const all = Object.values(threads).flat();
  const cutoff = all.length > maxEntries ? (all.map((e) => e.createdAt).sort((a, b) => b - a)[maxEntries - 1] ?? 0) : 0;
  const out: Record<string, DispatchEntry[]> = {};
  for (const [k, list] of Object.entries(threads)) {
    const kept = list.filter((e) => e.createdAt >= cutoff).map((e) => (e.prompt.length > maxPrompt ? { ...e, prompt: e.prompt.slice(0, maxPrompt) } : e));
    if (kept.length) out[k] = kept;
  }
  return out;
}

/** How long a started entry may wait for its agent to show up in host state before it counts as gone. */
export const APPEAR_GRACE_MS = 20_000;
/** After this long without a first turn, a fresh agent is shown as is ("Ready") rather than "Starting". */
export const START_TIMEOUT_MS = 90_000;

export interface RecentRepo {
  root: string;
  name: string;
  /** Last activity (agent start / state change, or last dispatch); 0 = unknown. */
  at: number;
}

/**
 * Repositories to offer in the picker: repo roots of the host's workspaces (linked worktrees fold
 * into their main repo) plus repos dispatched to before, most recently active first.
 */
export function recentRepos(state: Pick<HostState, "workspaces" | "agents"> | undefined, dispatched: Readonly<Record<string, number>>): RecentRepo[] {
  const byRoot = new Map<string, RecentRepo>();
  const touch = (root: string, name: string, at: number) => {
    const cur = byRoot.get(root);
    if (!cur) byRoot.set(root, { root, name, at });
    else if (at > cur.at) cur.at = at;
  };
  const wsRoot = new Map<string, string>();
  for (const ws of state?.workspaces ?? []) {
    if (!ws.repo) continue;
    wsRoot.set(ws.id, ws.repo.root);
    touch(ws.repo.root, ws.repo.name, 0);
  }
  for (const a of state?.agents ?? []) {
    const root = wsRoot.get(a.workspaceId);
    if (root) touch(root, byRoot.get(root)?.name ?? basename(root), Math.max(a.startedAt ?? 0, a.stateSince));
  }
  for (const [root, at] of Object.entries(dispatched)) touch(root, byRoot.get(root)?.name ?? basename(root), at);
  return [...byRoot.values()].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

/** Where an entry's agent must live: the thread's repo root, and the host's workspaces to check against. */
export interface AgentScope {
  repo: string;
  workspaces: readonly Workspace[];
}

/**
 * The agent runs in the entry's worktree: its checkout path is the one herdr reported, or its
 * workspace belongs to the thread's repo (linked worktrees report the main repo root) and is on
 * the entry's `dispatch/…` branch.
 */
function inEntryWorktree(a: Agent, e: DispatchEntry, scope: AgentScope): boolean {
  const ws = scope.workspaces.find((w) => w.id === a.workspaceId);
  if (!ws) return false;
  if (e.path && (ws.worktree?.path === e.path || ws.cwd === e.path || a.cwd === e.path)) return true;
  return ws.repo?.root === scope.repo && (ws.worktree?.branch ?? ws.repo.branch ?? a.branch) === e.branch;
}

/**
 * The live agent behind an entry, always inside the entry's own worktree (agent names are unique
 * per host but get reused across repos; pane and workspace ids get reused after herdr restarts and
 * demo reloads): the id herdr reported, else its pane (the id can arrive later), else — for
 * entries whose answer never arrived (reload, timeout) — the agent with the entry's name.
 */
export function resolveAgent(e: DispatchEntry, agents: readonly Agent[], scope: AgentScope): Agent | undefined {
  const mine = (a: Agent) => inEntryWorktree(a, e, scope);
  if (e.agentId) {
    const byId = agents.find((a) => a.id === e.agentId && mine(a));
    if (byId) return byId;
  }
  if (e.phase === "failed") return undefined;
  if (e.paneId) {
    const byPane = agents.find((a) => a.paneId === e.paneId && a.name === e.name && mine(a));
    if (byPane) return byPane;
  }
  return agents.find((a) => a.name === e.name && (a.kind === "omp" || a.omp != null) && mine(a));
}
