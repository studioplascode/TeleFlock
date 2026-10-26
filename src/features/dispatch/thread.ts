import type { Agent, BranchList, HostState, Workspace } from "@/core/gen";
import { basename } from "@/features/workspace/shared/paths";
import { slugFromPrompt, slugify } from "@/features/workspace/shared/slug";
import type { DispatchEntry } from "./store";

/** Dispatch branches are `dispatch/<name>`; the agent and its workspace are called `<name>`. */
export const BRANCH_PREFIX = "dispatch/";

/** herdr agent names start with a letter; prompts without usable words fall back to `task`. */
export function baseSlug(prompt: string): string {
  const s = slugFromPrompt(prompt);
  if (!s) return "task";
  return /^[a-z]/.test(s) ? s : `t-${s}`.slice(0, 24).replace(/-+$/, "");
}

/** herdr refuses agent names longer than this; a dispatch's name is its agent name. */
export const MAX_AGENT_NAME = 32;

/**
 * `slug`, else `slug-2`, `slug-3`… — free as an agent name and as `dispatch/<name>`, and never
 * longer than herdr's agent-name limit (the base gives way to the suffix).
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const free = (n: string) => !taken.has(n) && !taken.has(`${BRANCH_PREFIX}${n}`);
  const first = base.slice(0, MAX_AGENT_NAME).replace(/-+$/, "");
  if (free(first)) return first;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const n = `${base.slice(0, MAX_AGENT_NAME - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (free(n)) return n;
  }
}

/** Asks omp's tiny model for a branch slug; null = no usable answer (use the prompt's slug). */
export type BranchSuggester = (prompt: string) => Promise<string | null>;

/** Longest AI-made dispatch name: herdr's 32-char agent-name limit, with room for `uniqueSlug`'s `-N`. */
const MAX_AI_SLUG = 28;

/**
 * A suggested slug as a dispatch name: kebab `[a-z0-9-]`, ≤ 28 chars (cut at a word boundary),
 * starts with a letter, no `dispatch/`. Unusable → null.
 */
export function cleanSuggestion(s: string | null | undefined): string | null {
  if (!s) return null;
  let slug = slugify(s.trim().replace(/^(refs\/heads\/)?dispatch\//i, ""), 200);
  if (slug.length > MAX_AI_SLUG) {
    const cut = slug.slice(0, MAX_AI_SLUG + 1);
    const at = cut.lastIndexOf("-");
    // Whole words when there is a boundary; a single over-long word is cut short.
    slug = (at > 0 ? cut.slice(0, at) : cut.slice(0, MAX_AI_SLUG)).replace(/-+$/, "");
  }
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

/**
 * Phase `naming`: the AI slug when the suggester gives a usable one, else the prompt's slug. Not
 * yet unique: the caller dedupes it synchronously right after the await, so sends whose answers
 * arrive together (identical prompts share one call) still see each other's names.
 * A suggester that fails or throws counts as no answer.
 */
export async function nameDispatch(prompt: string, suggest?: BranchSuggester | null): Promise<{ slug: string; ai: boolean }> {
  let ai: string | null = null;
  if (suggest) {
    try {
      ai = cleanSuggestion(await suggest(prompt));
    } catch {
      ai = null;
    }
  }
  return { slug: ai ?? baseSlug(prompt), ai: ai !== null };
}

/** Words a task needs before its name is fetched ahead of sending. */
const PREFETCH_MIN_WORDS = 3;

/** The exact text a send would name (the composer sends it trimmed), or null while it's too short to bother. */
export function prefetchKey(draft: string): string | null {
  const t = draft.trim();
  return t.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length >= PREFETCH_MIN_WORDS ? t : null;
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

/**
 * The base a thread shows and sends. Untouched (nothing remembered, the default picked, or a
 * pre-0.5 remembered local default branch) → the host's default base: `param` absent, so a 0.5
 * host forks from `origin/<default>` after fetching; an older host (no `defaultBase`) gets its
 * default branch spelled out (absent meant HEAD there). A remembered branch the repo no longer
 * has falls back to the default too. Without a branch list a pre-0.5 base can't be told from the
 * default, so it counts as untouched.
 */
export function threadBase(list: BranchList | undefined, stored: string | undefined, legacy: boolean): { shown: string; param?: string; untouched: boolean } {
  const def = list?.defaultBase ?? list?.defaultBranch;
  const known = !list || stored === "HEAD" || list.branches.some((b) => b.name === stored);
  const untouched = !stored || stored === def || (legacy && (!list || stored === list.defaultBranch)) || !known;
  if (!untouched && stored) return { shown: stored, param: stored, untouched };
  const param = list && !list.defaultBase ? list.defaultBranch : undefined;
  return { shown: def ?? "default branch", ...(param ? { param } : {}), untouched };
}

export interface RecentRepo {
  root: string;
  name: string;
  /** Last activity (agent start / state change, or last dispatch); 0 = unknown. */
  at: number;
  /** `origin` URL, when a workspace of the repo reported it (Auto mode matches clones across hosts by it). */
  remoteUrl?: string;
}

/**
 * Repositories to offer in the picker: repo roots of the host's workspaces (linked worktrees fold
 * into their main repo) plus repos dispatched to before, most recently active first.
 */
export function recentRepos(state: Pick<HostState, "workspaces" | "agents"> | undefined, dispatched: Readonly<Record<string, number>>): RecentRepo[] {
  const byRoot = new Map<string, RecentRepo>();
  const touch = (root: string, name: string, at: number, remoteUrl?: string) => {
    const cur = byRoot.get(root);
    if (!cur) byRoot.set(root, remoteUrl ? { root, name, at, remoteUrl } : { root, name, at });
    else {
      if (at > cur.at) cur.at = at;
      if (remoteUrl && !cur.remoteUrl) cur.remoteUrl = remoteUrl;
    }
  };
  const wsRoot = new Map<string, string>();
  for (const ws of state?.workspaces ?? []) {
    if (!ws.repo) continue;
    wsRoot.set(ws.id, ws.repo.root);
    touch(ws.repo.root, ws.repo.name, 0, ws.repo.remoteUrl);
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
