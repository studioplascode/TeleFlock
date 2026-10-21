import type { ChangedFile, Column, ModelInfo, ModelRef, RoleBinding, ThinkingLevel, TodoPhase } from "@/core/gen";

export const HOME = "/home/demo";
/** herdr's default linked-worktree directory. */
export const WORKTREES = `${HOME}/.herdr/worktrees`;

export const MODELS: (ModelInfo & { label: string; inPerM: number; outPerM: number })[] = [
  { provider: "anthropic", id: "claude-opus-5", label: "opus-5", thinking: ["off", "low", "medium", "high", "xhigh", "max"], contextWindow: 200_000, inPerM: 5, outPerM: 25 },
  { provider: "anthropic", id: "claude-sonnet-5", label: "sonnet-5", thinking: ["off", "low", "medium", "high"], contextWindow: 1_000_000, inPerM: 3, outPerM: 15 },
  { provider: "openai", id: "gpt-5.5", label: "gpt-5.5", thinking: ["minimal", "low", "medium", "high", "xhigh"], contextWindow: 400_000, inPerM: 2.5, outPerM: 15 },
  { provider: "openai-codex", id: "gpt-6-luna", label: "luna", thinking: ["low", "medium", "high"], contextWindow: 272_000, inPerM: 0.4, outPerM: 1.6 },
  { provider: "google", id: "gemini-3-pro", label: "gemini-3-pro", thinking: ["low", "high"], contextWindow: 1_000_000, inPerM: 2, outPerM: 12 },
];

export const ROLES: RoleBinding[] = [
  { role: "default", model: "anthropic/claude-opus-5:high" },
  { role: "smol", model: "openai-codex/gpt-6-luna:low" },
  { role: "slow", model: "openai/gpt-5.5:xhigh" },
  { role: "plan", model: "anthropic/claude-opus-5:xhigh" },
  { role: "task", model: "anthropic/claude-sonnet-5:medium" },
];

export function modelRef(label: string): ModelRef {
  const m = MODELS.find((x) => x.label === label) ?? (MODELS[0] as (typeof MODELS)[number]);
  return { provider: m.provider, id: m.id, label: m.label };
}

export function modelByRef(ref: string): (typeof MODELS)[number] | undefined {
  const [provider, rest] = ref.includes("/") ? [ref.split("/")[0], ref.slice(ref.indexOf("/") + 1)] : [undefined, ref];
  const id = rest?.split(":")[0];
  return MODELS.find((m) => (provider === undefined || m.provider === provider) && (m.id === id || m.label === id));
}

export interface RepoDef {
  name: string;
  root: string;
  remote: string;
  files: string[];
  branches: string[];
}

export const REPOS: RepoDef[] = [
  {
    name: "teleflock",
    root: `${HOME}/code/teleflock`,
    remote: "git@github.com:demo/teleflock.git",
    branches: ["main", "feat/kanban-board", "feat/android-push", "fix/ssh-reconnect", "feat/offline-cache", "spike/collab-relay"],
    files: [
      "README.md", "package.json", "bun.lock", "tsconfig.json", "vite.config.ts", "docs/architecture.md", "docs/spec.md",
      "src/main.tsx", "src/app/App.tsx", "src/core/index.ts", "src/core/client.ts", "src/core/store/reduce.ts",
      "src/features/board/BoardView.tsx", "src/features/board/Lane.tsx", "src/features/board/AgentCard.tsx",
      "src/features/board/persist.ts", "src/features/board/keyboard.ts", "src/features/board/columns.test.ts",
      "src/features/board/drag-drop.test.ts", "src/features/board/keyboard-move.test.ts", "src/features/session/SessionView.tsx",
      "crates/tf-client/src/lib.rs", "crates/tf-transport/src/ssh.rs", "crates/tf-transport/src/reconnect.rs",
      "android/app/build.gradle.kts", "android/app/src/main/java/dev/teleflock/notify/AgentStateWatcher.kt",
      "android/app/src/main/java/dev/teleflock/notify/NotifyModule.kt", "android/app/src/test/java/dev/teleflock/AgentStateWatcherTest.kt",
    ],
  },
  {
    name: "api-gateway",
    root: `${HOME}/code/api-gateway`,
    remote: "git@github.com:demo/api-gateway.git",
    branches: ["main", "perf/connection-pool", "feat/rate-limits", "chore/go-1.25"],
    files: [
      "README.md", "go.mod", "go.sum", "cmd/gateway/main.go", "internal/db/pool.go", "internal/db/pool_test.go",
      "internal/ratelimit/window.go", "internal/ratelimit/window_test.go", "internal/http/router.go", "internal/http/middleware.go",
      "migrations/0042_rate_limits.sql", "internal/auth/refresh.go", "internal/auth/refresh_test.go",
    ],
  },
  {
    name: "marketing-site",
    root: `${HOME}/code/marketing-site`,
    remote: "git@github.com:demo/marketing-site.git",
    branches: ["main", "redesign/hero", "copy/pricing"],
    files: [
      "package.json", "astro.config.mjs", "src/pages/index.astro", "src/components/Hero.tsx", "src/components/Flock.tsx",
      "src/styles/hero.css", "src/styles/global.css", "public/og.png", "src/components/Pricing.tsx",
    ],
  },
  {
    name: "infra",
    root: `${HOME}/code/infra`,
    remote: "git@github.com:demo/infra.git",
    branches: ["main", "ci/bun-cache"],
    files: [".github/workflows/ci.yml", ".github/workflows/release.yml", "ansible/roles/tailscale/tasks/main.yml", "ansible/roles/herdr/tasks/main.yml", "turbo.json", "README.md"],
  },
  {
    name: "herdr-web",
    root: `${HOME}/code/herdr-web`,
    remote: "git@github.com:demo/herdr-web.git",
    branches: ["main"],
    files: ["package.json", "src/index.ts", "README.md"],
  },
  {
    name: "omp-plugins",
    root: `${HOME}/code/omp-plugins`,
    remote: "git@github.com:demo/omp-plugins.git",
    branches: ["main", "feat/linear"],
    files: ["package.json", "src/linear.ts", "src/jira.ts", "README.md"],
  },
  {
    // Cloned from someone else: git reports dubious ownership until the user trusts it.
    name: "untrusted-fork",
    root: `${HOME}/code/untrusted-fork`,
    remote: "git@github.com:stranger/untrusted-fork.git",
    branches: ["main", "dev"],
    files: ["README.md", "package.json", "src/index.ts"],
  },
];

export function repoByName(name: string): RepoDef | undefined {
  return REPOS.find((r) => r.name === name);
}

/** Repo that contains `path` (root or linked worktree), if any. */
export function repoForPath(path: string): RepoDef | undefined {
  return REPOS.find((r) => path === r.root || path.startsWith(`${r.root}/`) || path.startsWith(`${WORKTREES}/${r.name}/`));
}

export function slug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

export interface WorkspaceDef {
  id: string;
  /** Absent for a plain folder (not a git repo). */
  repo?: string;
  branch?: string;
  /** Folder for non-repo workspaces. */
  cwd?: string;
  /** Linked worktree of the repo's primary workspace. */
  worktree: boolean;
  order: number;
  /** Extra shell pane next to the agent. */
  shellPane?: boolean;
}

export const WORKSPACES: WorkspaceDef[] = [
  { id: "w1", repo: "teleflock", branch: "main", worktree: false, order: 0, shellPane: true },
  { id: "w4", repo: "teleflock", branch: "feat/kanban-board", worktree: true, order: 1, shellPane: true },
  { id: "w5", repo: "teleflock", branch: "feat/android-push", worktree: true, order: 2 },
  { id: "w6", repo: "teleflock", branch: "fix/ssh-reconnect", worktree: true, order: 3 },
  { id: "w2", repo: "api-gateway", branch: "main", worktree: false, order: 4 },
  { id: "w7", repo: "api-gateway", branch: "perf/connection-pool", worktree: true, order: 5 },
  { id: "w8", repo: "api-gateway", branch: "feat/rate-limits", worktree: true, order: 6 },
  { id: "w3", repo: "marketing-site", branch: "main", worktree: false, order: 7 },
  { id: "w9", repo: "marketing-site", branch: "redesign/hero", worktree: true, order: 8 },
  { id: "w10", repo: "infra", branch: "main", worktree: false, order: 9 },
  { id: "w11", repo: "infra", branch: "ci/bun-cache", worktree: true, order: 10 },
  { id: "w12", cwd: `${HOME}/scratch`, worktree: false, order: 11 },
];

export interface AgentDef {
  id: string;
  kind: string;
  workspace: string;
  title: string;
  column: Column;
  model?: string;
  thinking?: ThinkingLevel;
  /** Seconds since the agent entered its current state. */
  since: number;
  /** Seconds since the session started. */
  age: number;
  ctxPct?: number;
  cost?: number;
  files?: ChangedFile[];
  todos?: TodoPhase[];
  line?: string;
  link?: "live" | "notShared";
  /** Freshly started session: idle, zero turns, no history (the UI labels it "Ready"). */
  fresh?: boolean;
}

const f = (path: string, added: number, removed: number, status: ChangedFile["status"] = "modified", oldPath?: string): ChangedFile =>
  oldPath ? { path, added, removed, status, oldPath } : { path, added, removed, status };

const phase = (name: string, tasks: [string, TodoPhase["tasks"][number]["status"], string?][]): TodoPhase => ({
  name,
  tasks: tasks.map(([content, status, blocker]) => (blocker ? { content, status, blocker } : { content, status })),
});

export const AGENTS: AgentDef[] = [
  {
    id: "kanban", kind: "omp", workspace: "w4", column: "running", model: "opus-5", thinking: "high", since: 724, age: 2400, ctxPct: 38, cost: 2.41,
    title: "Drag-and-drop kanban board with column persistence",
    files: [f("src/features/board/BoardView.tsx", 188, 21), f("src/features/board/Lane.tsx", 96, 4, "added"), f("src/features/board/persist.ts", 54, 0, "added"), f("src/features/board/keyboard.ts", 41, 9), f("src/features/board/columns.test.ts", 33, 4)],
    todos: [
      phase("Board", [["Lane layout + card component", "completed"], ["Drag between lanes with dnd-kit", "completed"], ["Persist column order per host", "completed"], ["Keyboard move (J/K + Shift)", "inProgress"]]),
      phase("Polish", [["Card flight animation", "pending"], ["a11y announcements", "pending"], ["Reduced-motion fallbacks", "pending"]]),
    ],
  },
  {
    id: "pool", kind: "omp", workspace: "w7", column: "running", model: "gpt-5.5", thinking: "xhigh", since: 1631, age: 3100, ctxPct: 61, cost: 4.87,
    title: "Replace per-request Postgres connections with a pooled client",
    files: [f("internal/db/pool.go", 112, 38), f("internal/db/pool_test.go", 64, 0, "added"), f("internal/http/middleware.go", 12, 36)],
    todos: [
      phase("Investigate", [["Profile connection churn under load", "completed"], ["Map query hot paths", "inProgress"]]),
      phase("Implement", [["pgxpool client with health checks", "pending"], ["Wire pool into handlers", "pending"], ["Load test p99", "pending"], ["Docs", "pending"]]),
    ],
  },
  {
    id: "ci", kind: "omp", workspace: "w11", column: "running", model: "sonnet-5", thinking: "medium", since: 392, age: 900, ctxPct: 22, cost: 0.62,
    title: "Cache bun install + turbo artifacts in CI",
    files: [f(".github/workflows/ci.yml", 34, 9), f("turbo.json", 6, 0)],
    todos: [phase("CI cache", [["Cache ~/.bun/install/cache", "completed"], ["Cache .turbo with remote fallback", "completed"], ["Wire cache keys to bun.lock", "completed"], ["Verify a warm run", "inProgress"]])],
  },
  {
    id: "push", kind: "omp", workspace: "w5", column: "needs", model: "opus-5", thinking: "high", since: 360, age: 1080, ctxPct: 41, cost: 1.84,
    title: "Android push notifications when an agent gets blocked",
    files: [
      f("android/app/src/main/java/dev/teleflock/notify/AgentStateWatcher.kt", 46, 3),
      f("android/app/src/main/java/dev/teleflock/notify/NotifyModule.kt", 38, 0, "added"),
      f("android/app/build.gradle.kts", 6, 1),
      f("android/app/src/test/java/dev/teleflock/AgentStateWatcherTest.kt", 118, 0, "added"),
      f("crates/tf-client/src/lib.rs", 4, 13),
    ],
    todos: [
      phase("Push notifications", [
        ["Watch the herdr agent-state stream", "completed"],
        ["Debounce blocked transitions per pane", "completed"],
        ["Pick a delivery transport", "blocked", "blocked on you"],
        ["Notification actions: Answer, Open terminal", "pending"],
        ["Deep-link into the agent session", "pending"],
      ]),
    ],
  },
  {
    id: "limits", kind: "omp", workspace: "w8", column: "needs", model: "gpt-5.5", thinking: "high", since: 120, age: 1980, ctxPct: 54, cost: 3.12,
    title: "Per-tenant rate limits with a sliding window",
    files: [f("internal/ratelimit/window.go", 148, 6, "added"), f("internal/ratelimit/window_test.go", 92, 0, "added"), f("migrations/0042_rate_limits.sql", 18, 0, "added"), f("internal/http/router.go", 38, 6)],
    todos: [phase("Rate limits", [["Sliding window counter", "completed"], ["Redis-free fallback store", "completed"], ["Tenant config table", "completed"], ["Middleware wiring", "completed"], ["Run staging migration", "inProgress"], ["Load test", "pending"]])],
  },
  {
    id: "reconnect", kind: "omp", workspace: "w6", column: "review", model: "opus-5", thinking: "high", since: 1500, age: 2460, ctxPct: 47, cost: 2.06,
    title: "Auto-reconnect SSH and resume herdr attach after network change",
    line: "✓ 48 tests passed · PR #142 (draft)",
    files: [f("crates/tf-transport/src/reconnect.rs", 84, 0, "added"), f("crates/tf-transport/src/ssh.rs", 31, 29), f("crates/tf-client/src/lib.rs", 11, 12)],
    todos: [phase("Reconnect", [["Detect network change", "completed"], ["Backoff with jitter", "completed"], ["Resume herdr attach", "completed"], ["Replay missed state", "completed"], ["Tests", "completed"], ["Draft PR", "completed"]])],
  },
  {
    id: "hero", kind: "omp", workspace: "w9", column: "review", model: "sonnet-5", thinking: "medium", since: 3120, age: 4200, ctxPct: 58, cost: 3.55,
    title: "New hero with an animated flock illustration",
    line: "✓ Lighthouse 98 · preview screenshot",
    files: [
      f("src/components/Hero.tsx", 420, 160),
      f("src/components/Flock.tsx", 380, 0, "added"),
      f("src/styles/hero.css", 610, 12),
      f("src/components/HeroLegacy.tsx", 0, 240, "deleted"),
      f("src/components/FlockPath.ts", 96, 18, "renamed", "src/components/BirdPath.ts"),
      f("src/pages/index.astro", 44, 30),
      f("src/styles/tokens.css", 1650, 0, "untracked"),
      f("src/components/Pricing.tsx", 620, 410),
    ],
    todos: [phase("Hero", [["Illustration as SVG paths", "completed"], ["Flock drift animation", "completed"], ["Reduced motion", "completed"], ["Lighthouse ≥ 95", "completed"], ["Preview screenshot", "completed"]])],
  },
  {
    id: "docs", kind: "omp", workspace: "w1", column: "done", model: "sonnet-5", thinking: "low", since: 7200, age: 9000, ctxPct: 33, cost: 0.94,
    title: "README and architecture overview", line: "merged #139 · 2h ago",
    files: [],
  },
  {
    id: "flaky", kind: "omp", workspace: "w2", column: "done", model: "luna", thinking: "low", since: 18000, age: 19800, ctxPct: 12, cost: 0.08,
    title: "Fix flaky auth token refresh test", line: "merged #87 · 5h ago", link: "notShared",
    files: [],
  },
  {
    id: "deps", kind: "omp", workspace: "w10", column: "done", model: "luna", thinking: "low", since: 86400, age: 88000, ctxPct: 9, cost: 0.05,
    title: "Bump tailscale and herdr in Ansible roles", line: "merged #61 · yesterday",
    files: [],
  },
  {
    id: "copy", kind: "claude", workspace: "w3", column: "running", since: 30, age: 1300,
    title: "Tighten pricing page copy",
  },
  {
    id: "scratch", kind: "omp", workspace: "w12", column: "review", model: "opus-5", thinking: "high", since: 45, age: 45, ctxPct: 1, cost: 0,
    title: "", fresh: true,
  },
];

/** Studio PC (second demo host): small cached board shown stale while it's offline. */
export const STUDIO_AGENTS: AgentDef[] = [
  {
    id: "render", kind: "omp", workspace: "w1", column: "running", model: "sonnet-5", thinking: "medium", since: 900, age: 1800, ctxPct: 44, cost: 1.2,
    title: "Batch-render the onboarding video frames",
    files: [],
  },
  {
    id: "assets", kind: "omp", workspace: "w1", column: "review", model: "luna", thinking: "low", since: 4000, age: 5000, ctxPct: 18, cost: 0.11,
    title: "Compress app store screenshots", line: "✓ 14 images · −62% size",
    files: [],
  },
];
