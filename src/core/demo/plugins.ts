/**
 * Demo `skills.*` / `plugins.*`: omp's skills and plugins on a demo host, with tf-hostd's
 * semantics (`tf_proto::plugins`).
 *
 * - Skills from several providers: omp's own (user level, a project's, auto-learned), Claude Code
 *   (one switched off), Codex, `.agents`, a marketplace plugin's, and Skillshare registry installs:
 *   `@acme/changelog` (an update within its range, the registry's latest outside it),
 *   `@oh-my-pi/review-checklist` (current), `@tools/screenshot` (missing from omp's store; its
 *   version ships scripts, so restoring it needs consent), and in ~/code/teleflock a private
 *   package the registry can't be asked about.
 * - `skills.list` takes ~1.5 s (hostd runs a throwaway omp), `updates: true` asks the registry
 *   (~1.2 s more). The last check is kept per list folder and merged into later lists for entries
 *   whose id, scope and version are unchanged (hostd's cache).
 * - `skills.install` / `skills.update` of a version that ships scripts answer `scripts_need_consent`
 *   (omp's listing of the files) until `allowScripts`. `skills.search` searches a fixture registry.
 * - Plugins: npm, git and linked packages, marketplace plugins (one with an update in the cached
 *   catalog, one installed for ~/code/teleflock too, which shadows the user install there), two
 *   marketplaces with catalogs; refreshing them publishes one more update. Installs take seconds.
 * - Running sessions: the host's live omp agents (for a project change only those started in its
 *   folder); every change answers with what `/reload-plugins` did to them. Skill switches reload
 *   nothing (omp applies them itself) and say so in `note`.
 *
 * Demo knobs (the page's URL): `?demo&plugins=empty` (nothing installed, no marketplaces, an empty
 * registry: what a fresh host sees today), `plugins=error` (both lists fail).
 */
import type {
  Agent,
  CatalogPlugin,
  InstallScope,
  Marketplace,
  MarketplacePlugin,
  McpReload,
  PackagePlugin,
  PluginCatalog,
  PluginList,
  PluginsChanged,
  RegistrySkill,
  SkillInfo,
  SkillList,
  SkillSearchHit,
  SkillSearchResult,
  SkillsChanged,
} from "../gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

export interface PluginsHostEnv {
  /** false: the host's tf-hostd predates skills and plugins (every method answers `unknown_method`). */
  supported: boolean;
  clock: DemoClock;
  home: string;
  /** The host's agents: live omp ones are the sessions `/reload-plugins` reaches. */
  agents(): Agent[];
  ompVersion(): string | undefined;
  /** Demo knob (`?demo&plugins=…`); read from the page URL when absent. */
  knob?: "empty" | "error" | null;
  /** Whether a folder exists on the host (absent: every one does); hostd answers `not_found` for one that doesn't. */
  folderExists?(path: string): boolean;
}

const REGISTRY_URL = "https://skills.omp.sh";
const DAY = 86_400_000;
const PER_PAGE = 6;
const SKILL_SWITCH_NOTE = "Running omp sessions apply skill switches on their own.";
const PACKAGE_NOTE = "A package plugin's code loads when a session starts: restart running sessions to use the change.";

/** How long hostd takes (a throwaway omp, the registry, npm / git). */
const MS = {
  skillsList: 1500,
  updates: 1200,
  search: 700,
  skillInstall: 2200,
  skillRemove: 600,
  skillSwitch: 300,
  pluginsList: 500,
  discover: 400,
  packageInstall: 2600,
  marketplaceInstall: 1800,
  folderInstall: 800,
  pluginRemove: 900,
  pluginSwitch: 500,
  upgrade: 2400,
  marketplaceAdd: 2400,
  marketplaceUpdate: 1600,
  marketplaceRemove: 400,
  reload: 300,
};

// ---------------------------------------------------------------- the registry

interface RegistryPackage {
  id: string;
  /** The SKILL.md `name` it unpacks to. */
  skill: string;
  description: string;
  publisher: string;
  keywords: string[];
  /** Ascending. */
  versions: string[];
  latest: string;
  /** How long ago the latest version was published. */
  ageDays: number;
  weeklyDownloads: number;
  deprecated?: string;
  /** Files the versions ship that omp asks about (omp's listing lines). */
  scripts?: string[];
  /** Not on the public registry (a private scope): the registry can't be asked about it. */
  private?: boolean;
}

const REGISTRY: RegistryPackage[] = [
  {
    id: "@acme/changelog",
    skill: "changelog",
    description: "Write a changelog entry from the commits since the last tag",
    publisher: "acme",
    keywords: ["changelog", "release", "git"],
    versions: ["1.0.0", "1.2.0", "1.3.0", "2.0.0"],
    latest: "2.0.0",
    ageDays: 6,
    weeklyDownloads: 1840,
  },
  {
    id: "@oh-my-pi/review-checklist",
    skill: "review-checklist",
    description: "A pre-merge review checklist: tests, docs, migrations, risky diffs",
    publisher: "oh-my-pi",
    keywords: ["review", "pull request", "checklist"],
    versions: ["0.3.0", "0.4.1"],
    latest: "0.4.1",
    ageDays: 20,
    weeklyDownloads: 5200,
  },
  {
    id: "@tools/screenshot",
    skill: "screenshot",
    description: "Capture and annotate screenshots of a running app",
    publisher: "tools",
    keywords: ["screenshot", "browser", "ui"],
    versions: ["0.9.0"],
    latest: "0.9.0",
    ageDays: 3,
    weeklyDownloads: 960,
    scripts: ["scripts/capture.sh (executable)", "scripts/annotate.py"],
  },
  {
    id: "@labs/pdf-tools",
    skill: "pdf-tools",
    description: "Read, split, merge and fill in PDF files",
    publisher: "labs",
    keywords: ["pdf", "documents", "forms"],
    versions: ["0.2.0", "0.3.0"],
    latest: "0.3.0",
    ageDays: 9,
    weeklyDownloads: 3100,
    scripts: ["scripts/extract.py (executable)", "scripts/merge.sh (executable)", "bin/pdfinfo-lite (executable)"],
  },
  {
    id: "@docs/mermaid-diagrams",
    skill: "mermaid-diagrams",
    description: "Draw architecture and sequence diagrams as Mermaid",
    publisher: "docs",
    keywords: ["diagrams", "mermaid", "docs"],
    versions: ["1.1.0"],
    latest: "1.1.0",
    ageDays: 30,
    weeklyDownloads: 2400,
  },
  {
    id: "@team/api-contracts",
    skill: "api-contracts",
    description: "Keep OpenAPI specs, handlers and their tests in step",
    publisher: "team",
    keywords: ["api", "openapi", "contracts"],
    versions: ["0.7.2"],
    latest: "0.7.2",
    ageDays: 45,
    weeklyDownloads: 410,
  },
  {
    id: "@writing/plain-english",
    skill: "plain-english",
    description: "Rewrite docs and UI copy in plain English",
    publisher: "writing",
    keywords: ["writing", "docs", "copy"],
    versions: ["2.0.1"],
    latest: "2.0.1",
    ageDays: 60,
    weeklyDownloads: 1300,
  },
  {
    id: "@sec/secret-scan",
    skill: "secret-scan",
    description: "Look for keys and tokens in the working tree",
    publisher: "sec",
    keywords: ["security", "secrets"],
    versions: ["0.2.0"],
    latest: "0.2.0",
    ageDays: 200,
    weeklyDownloads: 220,
    deprecated: "Use @sec/leak-guard: it scans the history too",
  },
  {
    id: "@sec/leak-guard",
    skill: "leak-guard",
    description: "Find leaked keys and tokens in the diff and the history",
    publisher: "sec",
    keywords: ["security", "secrets", "git"],
    versions: ["1.0.0"],
    latest: "1.0.0",
    ageDays: 14,
    weeklyDownloads: 780,
  },
  {
    id: "@teleflock/release-checklist",
    skill: "release-checklist",
    description: "TeleFlock's release steps",
    publisher: "teleflock",
    keywords: [],
    versions: ["0.2.0"],
    latest: "0.2.0",
    ageDays: 90,
    weeklyDownloads: 0,
    private: true,
  },
];

function vparts(v: string): number[] {
  return v.split(/[.+-]/, 3).map((x) => Number.parseInt(x, 10) || 0);
}

function vcmp(a: string, b: string): number {
  const x = vparts(a);
  const y = vparts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** `^1.2.0` (same major, or same minor below 1.0), `~1.2.0` (same minor), an exact version, a dist-tag (`latest`). */
function satisfies(version: string, range: string, latest: string): boolean {
  if (range === "latest" || range === "^latest") return version === latest || vcmp(version, latest) <= 0;
  const caret = range.startsWith("^");
  const tilde = range.startsWith("~");
  const base = caret || tilde ? range.slice(1) : range;
  if (!caret && !tilde) return vcmp(version, base) === 0;
  if (vcmp(version, base) < 0) return false;
  const [vM, vm] = vparts(version);
  const [bM, bm] = vparts(base);
  if (tilde || bM === 0) return vM === bM && vm === bm;
  return vM === bM;
}

function newestIn(pkg: RegistryPackage, range: string): string | undefined {
  return [...pkg.versions].reverse().find((v) => satisfies(v, range, pkg.latest));
}

function scriptsListing(pkg: RegistryPackage, version: string): string {
  return [`${pkg.id}@${version} ships scripts:`, ...(pkg.scripts ?? []).map((f) => `  ${f}`)].join("\n");
}

// ---------------------------------------------------------------- marketplaces

interface CatalogEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  keywords: string[];
  provides: string[];
  homepage?: string;
  /** Skills the plugin brings (SKILL.md name → description). */
  skills?: Record<string, string>;
}

interface DemoMarketplace {
  name: string;
  sourceType: string;
  source: string;
  description?: string;
  owner?: string;
  /** The catalog as last fetched. */
  catalog: CatalogEntry[];
  /** What the next refresh fetches (newer versions published since). */
  upstream: Record<string, string>;
  updatedAt: number;
}

const cat = (name: string, version: string, category: string, provides: string[], description: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name,
  version,
  category,
  provides,
  description,
  author: "Anthropic",
  keywords: [],
  ...extra,
});

function officialCatalog(): CatalogEntry[] {
  return [
    cat("agent-sdk-dev", "1.0.0", "development", ["commands", "agents"], "Scaffold and check apps built on the Claude Agent SDK", { keywords: ["sdk", "agents"] }),
    cat("code-review", "1.1.0", "productivity", ["commands", "agents"], "Review a pull request with several agents and confidence-scored findings", { keywords: ["review", "pr"] }),
    cat("commit-commands", "1.0.0", "productivity", ["commands"], "Commit, push and open pull requests with one command", { keywords: ["git", "commit"] }),
    cat("explanatory-output-style", "1.0.0", "learning", ["hooks"], "Explains the choices behind the code it writes", { keywords: ["style"] }),
    cat("feature-dev", "1.0.0", "development", ["commands", "agents"], "A guided feature workflow: explore, design, build, review", { keywords: ["workflow"] }),
    cat("frontend-design", "1.0.0", "design", ["skills"], "Distinctive, production-grade frontend interfaces instead of generic ones", {
      keywords: ["ui", "css", "design"],
      skills: { "frontend-design": "Build distinctive frontend interfaces with a clear visual direction" },
    }),
    cat("hookify", "0.9.0", "productivity", ["commands", "hooks"], "Turn a complaint about agent behaviour into a hook that prevents it", { keywords: ["hooks"] }),
    cat("learning-output-style", "1.0.0", "learning", ["hooks"], "Asks you to write the key pieces yourself while it explains", { keywords: ["style", "learning"] }),
    cat("plugin-dev", "1.0.0", "development", ["commands", "agents", "skills"], "Build, check and publish your own plugins", {
      keywords: ["plugins"],
      skills: { "plugin-structure": "Lay out a plugin: manifest, commands, agents, hooks and skills" },
    }),
    cat("pr-review-toolkit", "1.0.0", "productivity", ["commands", "agents"], "Specialised review agents: tests, comments, types, silent failures", { keywords: ["review"] }),
    cat("ralph-wiggum", "1.0.0", "productivity", ["commands", "hooks"], "Keep an agent iterating on a task until it is really done", { keywords: ["loop"] }),
    cat("security-guidance", "1.0.0", "security", ["hooks"], "Warns about risky patterns (injection, unsafe eval, secrets) as files change", { keywords: ["security"] }),
  ];
}

function acmeCatalog(): CatalogEntry[] {
  const acme = { author: "Acme platform team" };
  return [
    cat("deploy-guard", "0.3.0", "deployment", ["hooks", "mcpServers"], "Stops deploys outside the release window and checks the change log", { ...acme, keywords: ["deploy"] }),
    cat("jira-sync", "1.2.0", "productivity", ["commands", "mcpServers"], "Link the work to Jira issues and keep their status current", { ...acme, keywords: ["jira", "issues"] }),
    cat("release-train", "0.4.2", "deployment", ["commands", "skills"], "Cut, tag and announce a release the Acme way", {
      ...acme,
      keywords: ["release"],
      skills: { "release-train": "Cut a release branch, tag it and write the announcement" },
    }),
    cat("oncall-helper", "0.1.0", "operations", ["agents", "commands"], "Summarise alerts and draft the incident notes", { ...acme, keywords: ["oncall", "incidents"] }),
  ];
}

/** Sources `plugins.marketplaceAdd` can fetch in the demo (anything else fails the way a missing repository does). */
const KNOWN_SOURCES: Record<string, () => DemoMarketplace> = {
  "obra/superpowers-marketplace": () => ({
    name: "superpowers-marketplace",
    sourceType: "github",
    source: "obra/superpowers-marketplace",
    description: "Skills that teach agents brainstorming, planning, TDD and debugging",
    owner: "Jesse Vincent",
    catalog: [
      cat("superpowers", "3.2.0", "development", ["skills", "commands", "hooks"], "A core library of skills: brainstorming, planning, TDD, systematic debugging", {
        author: "Jesse Vincent",
        keywords: ["skills", "tdd", "debugging"],
        skills: { brainstorming: "Turn a rough idea into a design through questions", "systematic-debugging": "Find the root cause before fixing anything" },
      }),
      cat("elements-of-style", "1.0.0", "writing", ["skills"], "Write clearly and concisely", { author: "Jesse Vincent", keywords: ["writing"], skills: { "writing-clearly": "Strunk's rules for clear, concise prose" } }),
    ],
    upstream: {},
    updatedAt: 0,
  }),
};

// ---------------------------------------------------------------- npm and git

/** npm packages `plugins.install` finds in the demo. */
const NPM: Record<string, { version: string; description: string; provides: string[] }> = {
  "omp-lsp-extras": { version: "1.4.0", description: "More language servers for omp's LSP tools", provides: ["tools"] },
  "omp-theme-pack": { version: "0.8.1", description: "Extra TUI themes", provides: ["extensions"] },
  "@oh-my-pi/plan-tools": { version: "0.6.0", description: "Plan review commands and a planning tool", provides: ["commands", "tools"] },
};

/** Newer versions an upgrade of an installed package finds. */
const PACKAGE_UPGRADES: Record<string, string> = { "omp-git-tools": "2.2.0", "omp-notify-desktop": "1.0.5" };

// ---------------------------------------------------------------- state

interface Install {
  id: string;
  scope: InstallScope;
  /** Project installs: the folder. */
  project?: string;
  range?: string;
  version?: string;
  stored: boolean;
}

interface AuthoredSkill {
  info: Omit<SkillInfo, "enabled">;
  /** Project skills: the folder they belong to. */
  project?: string;
}

interface MarketInstall {
  name: string;
  marketplace: string;
  scope: InstallScope;
  project?: string;
  version: string;
  enabled: boolean;
  updatedAt: number;
}

/** A package plugin as installed (its switch lives in `disabledPackages`). */
type DemoPackage = Omit<PackagePlugin, "enabled">;

interface CheckedEntry {
  version?: string;
  update?: string;
  latest?: string;
  description?: string;
  deprecated?: string;
  yanked: boolean;
  updateError?: string;
}

/** The last `updates: true` answer per list folder ("" = user level): per `scope:id`. */
interface UpdateCheck {
  at: number;
  entries: Map<string, CheckedEntry>;
}

function readKnob(): PluginsHostEnv["knob"] {
  try {
    const v = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("plugins");
    return v === "empty" || v === "error" ? v : null;
  } catch {
    return null;
  }
}

const SKILL_ID_RE = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)(?:@(\S+))?$/i;
const FOLDER_RE = /^(\/|~(\/|$))/;
const GIT_RE = /^((github|gitlab|bitbucket):[^/\s]+\/\S+|https?:\/\/\S+|git@\S+)$/i;
const NPM_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[^\s@[\]]+)?(\[[^\]]*\])?$/i;
const MARKET_RE = /^([a-z0-9][\w.-]*)@([a-z0-9][\w.-]*)$/i;

export class DemoPlugins {
  private readonly knob: PluginsHostEnv["knob"];
  private readonly authored: AuthoredSkill[] = [];
  private readonly installs: Install[] = [];
  /** omp's `disabledExtensions` (`skill:<name>`). */
  private readonly disabledSkills = new Set<string>();
  private readonly packages: DemoPackage[] = [];
  private readonly disabledPackages = new Set<string>();
  private readonly marketplaces: DemoMarketplace[] = [];
  private readonly market: MarketInstall[] = [];
  private readonly checks = new Map<string, UpdateCheck>();
  private readonly warnings: string[] = [];

  constructor(private readonly env: PluginsHostEnv) {
    this.knob = env.knob === undefined ? readKnob() : env.knob;
    if (env.supported && this.knob !== "empty") this.seed();
  }

  call(method: string, p: Record<string, unknown>): unknown {
    if (!this.env.supported) throw apiError("unknown_method", `Unknown method ${method}`);
    switch (method) {
      case "skills.list":
        return this.skillsList(p);
      case "skills.search":
        return this.search(p);
      case "skills.install":
        return this.skillInstall(p);
      case "skills.update":
        return this.skillUpdate(p);
      case "skills.remove":
        return this.skillRemove(p);
      case "skills.setEnabled":
        return this.skillSwitch(p);
      case "plugins.list": {
        const cwd = this.cwdOf(p);
        return this.later(MS.pluginsList, () => this.pluginsList(cwd), this.listFailure("plugins"));
      }
      case "plugins.discover":
        return this.discover(p);
      case "plugins.install":
        return this.pluginInstall(p);
      case "plugins.remove":
        return this.pluginRemove(p);
      case "plugins.setEnabled":
        return this.pluginSwitch(p);
      case "plugins.upgrade":
        return this.upgrade(p);
      case "plugins.marketplaceAdd":
        return this.marketplaceAdd(p);
      case "plugins.marketplaceRemove":
        return this.marketplaceRemove(p);
      case "plugins.marketplaceUpdate":
        return this.marketplaceUpdate(p);
      case "plugins.reload": {
        const cwd = this.cwdOf(p);
        return this.later(MS.reload, () => this.reload(cwd));
      }
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private seed(): void {
    const h = this.env.home;
    const repo = `${h}/code/teleflock`;
    const skill = (name: string, description: string, path: string, provider: string, providerName: string, level: string, extra: Partial<SkillInfo> = {}, project?: string): AuthoredSkill => ({
      info: { name, description, path, provider, providerName, level, hidden: false, ...extra },
      project,
    });
    this.authored.push(
      skill("release-notes", "Draft release notes from the merged pull requests since the last tag", `${h}/.omp/agent/skills/release-notes/SKILL.md`, "native", "OMP", "user"),
      skill("commit-style", "How this team writes commit messages (conventional commits, imperative mood)", `${h}/.omp/agent/skills/commit-style/SKILL.md`, "native", "OMP", "user", { hidden: true }),
      skill("tf-proto", "Add a wire type to tf-proto and regenerate the TypeScript bindings", `${repo}/.omp/skills/tf-proto/SKILL.md`, "native", "OMP", "project", {}, repo),
      skill("flaky-tests", "What was learned about the flaky reconnect tests and how to rerun them", `${h}/.omp/agent/managed-skills/flaky-tests/SKILL.md`, "omp-managed", "Managed Skills (auto-learn)", "user"),
      skill("pdf", "Extract text and tables from PDF files, fill in forms", `${h}/.claude/skills/pdf/SKILL.md`, "claude", "Claude Code", "user"),
      skill("xlsx", "Create and edit spreadsheets with formulas and charts", `${h}/.claude/skills/xlsx/SKILL.md`, "claude", "Claude Code", "user"),
      skill("sql-review", "Review SQL migrations for locking, defaults and rollbacks", `${h}/.codex/skills/sql-review/SKILL.md`, "codex", "OpenAI Codex", "user"),
      skill("web-research", "Search the web, read the sources, cite them", `${h}/.agents/skills/web-research/SKILL.md`, "agents", "Agent Dirs (.agent/.agents)", "user"),
    );
    this.disabledSkills.add("xlsx");
    this.installs.push(
      { id: "@acme/changelog", scope: "user", range: "^1.2.0", version: "1.2.0", stored: true },
      { id: "@oh-my-pi/review-checklist", scope: "user", range: "^0.4.0", version: "0.4.1", stored: true },
      { id: "@tools/screenshot", scope: "user", range: "^0.9.0", version: "0.9.0", stored: false },
      { id: "@teleflock/release-checklist", scope: "project", project: repo, range: "^0.2.0", version: "0.2.0", stored: true },
    );
    this.warnings.push(`${h}/.claude/skills/old-notes/SKILL.md: no description in the frontmatter, skipped`);

    this.packages.push(
      {
        name: "omp-git-tools",
        version: "2.1.0",
        description: "Git helpers for omp: bisect, blame summaries, stacked pull requests",
        path: `${h}/.omp/plugins/node_modules/omp-git-tools`,
        linked: false,
        provides: ["commands", "tools"],
        features: [
          { name: "bisect", description: "/bisect drives git bisect with the agent", enabled: true },
          { name: "blame-summary", description: "Who changed a range and why", enabled: false },
          { name: "stacked-prs", description: "Keep a stack of branches rebased", enabled: true },
        ],
      },
      { name: "omp-plugins", version: "0.3.2", description: "Linear and Jira tools (your local checkout)", path: `${h}/code/omp-plugins`, linked: true, provides: ["tools", "commands"], features: [] },
      {
        name: "omp-notify-desktop",
        version: "1.0.4",
        description: "Desktop notifications when a turn ends or a question waits",
        path: `${h}/.omp/plugins/node_modules/omp-notify-desktop`,
        linked: false,
        provides: ["extensions", "hooks"],
        features: [],
      },
    );
    this.disabledPackages.add("omp-notify-desktop");

    const now = this.env.clock.now();
    this.marketplaces.push(
      {
        name: "claude-plugins-official",
        sourceType: "github",
        source: "anthropics/claude-plugins-official",
        description: "Anthropic's official plugins for Claude Code",
        owner: "Anthropic",
        catalog: officialCatalog(),
        upstream: { "security-guidance": "1.0.1" },
        updatedAt: now - 3 * DAY,
      },
      {
        name: "acme-tools",
        sourceType: "git",
        source: "https://git.acme.dev/omp/marketplace.git",
        description: "Plugins of the Acme platform team",
        owner: "Acme platform team",
        catalog: acmeCatalog(),
        upstream: {},
        updatedAt: now - 12 * DAY,
      },
    );
    const mi = (name: string, marketplace: string, version: string, extra: Partial<MarketInstall> = {}): MarketInstall => ({ name, marketplace, scope: "user", version, enabled: true, updatedAt: now - 20 * DAY, ...extra });
    this.market.push(
      mi("code-review", "claude-plugins-official", "1.0.0"),
      mi("frontend-design", "claude-plugins-official", "1.0.0"),
      mi("security-guidance", "claude-plugins-official", "1.0.0"),
      mi("commit-commands", "claude-plugins-official", "1.0.0"),
      mi("commit-commands", "claude-plugins-official", "1.0.0", { scope: "project", project: repo, updatedAt: now - 2 * DAY }),
      mi("release-train", "acme-tools", "0.4.2", { enabled: false }),
    );
  }

  // ---------------------------------------------------------------- plumbing

  /** `fn`'s answer after `ms` on the demo clock (its error, too); `failure` fails the call instead. */
  private later<T>(ms: number, fn: () => T, failure?: () => never): Promise<T> {
    // Executor form: the app's TS lib (ES2023) predates `Promise.withResolvers`.
    return new Promise<T>((resolve, reject) => {
      this.env.clock.after(ms, () => {
        try {
          if (failure) failure();
          resolve(fn());
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private listFailure(which: "skills" | "plugins"): (() => never) | undefined {
    if (this.knob !== "error") return undefined;
    const h = this.env.home;
    return () => {
      if (which === "skills") throw apiError("omp_error", `omp skill list exited with code 1: EACCES: permission denied, open '${h}/.omp/agent/skills.lock.json'`);
      throw apiError("io_error", `can't read ${h}/.omp/plugins/package.json: Permission denied (os error 13)`, { hint: "Check the file's owner and permissions on the host." });
    };
  }

  private cwdOf(p: Record<string, unknown>): string | undefined {
    const cwd = p.cwd;
    if (cwd === undefined || cwd === null) return undefined;
    if (typeof cwd !== "string" || !cwd.startsWith("/")) throw apiError("invalid_params", `cwd: \`${String(cwd)}\` is not an absolute path`);
    const trimmed = cwd.replace(/\/+$/, "") || "/";
    if (this.env.folderExists && !this.env.folderExists(trimmed)) {
      throw apiError("not_found", `${cwd}: No such file or directory (os error 2)`, { hint: "The folder is gone from the host: pick another project." });
    }
    return trimmed === this.env.home ? undefined : trimmed;
  }

  private str(p: Record<string, unknown>, key: string): string {
    const v = p[key];
    if (typeof v !== "string" || !v.trim()) throw apiError("invalid_params", `${key}: required`);
    return v.trim();
  }

  private scopeOf(p: Record<string, unknown>, cwd: string | undefined, required: boolean): InstallScope | undefined {
    const s = p.scope;
    if (s === undefined || s === null) {
      if (required) throw apiError("invalid_params", "scope: user or project");
      return undefined;
    }
    if (s !== "user" && s !== "project") throw apiError("invalid_params", "scope: user or project");
    if (s === "project" && !cwd) throw apiError("invalid_params", "cwd: a project install needs the project folder", { hint: "Pick a project first." });
    return s;
  }

  /** Sessions a change reaches: every live omp session for a user-level change, those in the folder for a project's. */
  private reload(cwd: string | undefined): McpReload {
    const r: McpReload = { reloaded: 0, queued: 0, restartNeeded: 0, errors: [] };
    for (const a of this.env.agents()) {
      if (a.kind !== "omp" || a.parked || !a.omp) continue;
      if (cwd && a.cwd !== cwd && !(a.cwd ?? "").startsWith(`${cwd}/`)) continue;
      if (a.omp.link !== "live") r.restartNeeded += 1;
      else if (a.state === "working") r.queued += 1;
      else r.reloaded += 1;
    }
    return r;
  }

  private static none(): McpReload {
    return { reloaded: 0, queued: 0, restartNeeded: 0, errors: [] };
  }

  // ---------------------------------------------------------------- skills

  private pkg(id: string): RegistryPackage | undefined {
    return this.knob === "empty" ? undefined : REGISTRY.find((r) => r.id === id);
  }

  private inScope(i: { scope: InstallScope; project?: string }, cwd: string | undefined): boolean {
    return i.scope === "user" || (!!cwd && i.project === cwd);
  }

  private registryOf(cwd: string | undefined): Install[] {
    return [...this.installs.filter((i) => i.scope === "user"), ...this.installs.filter((i) => i.scope === "project" && cwd && i.project === cwd)];
  }

  private skillInfos(cwd: string | undefined): SkillInfo[] {
    const h = this.env.home;
    const out: SkillInfo[] = [];
    const add = (info: Omit<SkillInfo, "enabled">) => out.push({ ...info, enabled: !this.disabledSkills.has(info.name) });
    for (const a of this.authored) if (!a.project || a.project === cwd) add(a.info);
    for (const i of this.registryOf(cwd)) {
      const pkg = REGISTRY.find((r) => r.id === i.id);
      if (!pkg || !i.stored || !i.version) continue;
      add({
        name: pkg.skill,
        description: pkg.description,
        path: `${h}/.omp/skillshare/${i.id}/${i.version}/SKILL.md`,
        provider: "skillshare",
        providerName: "Skillshare",
        level: i.scope,
        plugin: i.id,
        registryId: i.id,
        hidden: false,
      });
    }
    for (const m of this.market) {
      if (!m.enabled || !this.inScope(m, cwd) || this.shadowed(m, cwd)) continue;
      const entry = this.catalogEntry(m.marketplace, m.name);
      for (const [name, description] of Object.entries(entry?.skills ?? {})) {
        add({
          name,
          description,
          path: `${this.marketPath(m)}/skills/${name}/SKILL.md`,
          provider: "claude-plugins",
          providerName: "Claude Code Marketplace",
          level: m.scope,
          plugin: m.name,
          hidden: false,
        });
      }
    }
    return out;
  }

  private folderKey(cwd: string | undefined): string {
    return cwd ?? "";
  }

  private registryEntry(i: Install, cwd: string | undefined): RegistrySkill {
    const base: RegistrySkill = { id: i.id, scope: i.scope, range: i.range, version: i.version, stored: i.stored, yanked: false };
    const cached = this.checks.get(this.folderKey(cwd))?.entries.get(`${i.scope}:${i.id}`);
    if (!cached || cached.version !== i.version) return base;
    return { ...base, update: cached.update, latest: cached.latest, description: cached.description, deprecated: cached.deprecated, yanked: cached.yanked, updateError: cached.updateError };
  }

  /** Asks the (fixture) registry about every install of the list and keeps the answer for the folder. */
  private checkUpdates(cwd: string | undefined): void {
    const entries = new Map<string, CheckedEntry>();
    for (const i of this.registryOf(cwd)) {
      const pkg = REGISTRY.find((r) => r.id === i.id);
      if (!pkg || pkg.private || this.knob === "empty") {
        entries.set(`${i.scope}:${i.id}`, { version: i.version, yanked: false, updateError: `${i.id} was not found in the registry` });
        continue;
      }
      const newest = i.range ? newestIn(pkg, i.range) : undefined;
      const update = newest && i.version && vcmp(newest, i.version) > 0 ? newest : undefined;
      entries.set(`${i.scope}:${i.id}`, { version: i.version, update, latest: pkg.latest, description: pkg.description, deprecated: pkg.deprecated, yanked: false });
    }
    this.checks.set(this.folderKey(cwd), { at: this.env.clock.now(), entries });
  }

  private skillListOf(cwd: string | undefined): SkillList {
    return {
      skills: this.skillInfos(cwd),
      registry: this.registryOf(cwd).map((i) => this.registryEntry(i, cwd)),
      warnings: [...this.warnings],
      registryUrl: REGISTRY_URL,
      cwd,
      updatesCheckedAt: this.checks.get(this.folderKey(cwd))?.at,
      ompVersion: this.env.ompVersion(),
    };
  }

  private skillsList(p: Record<string, unknown>): Promise<SkillList> {
    const cwd = this.cwdOf(p);
    const updates = p.updates === true;
    return this.later(
      MS.skillsList + (updates ? MS.updates : 0),
      () => {
        if (updates) this.checkUpdates(cwd);
        return this.skillListOf(cwd);
      },
      this.listFailure("skills"),
    );
  }

  private skillsChanged(cwd: string | undefined, reloadCwd: string | undefined, changes: string[]): SkillsChanged {
    return { list: this.skillListOf(cwd), reload: this.reload(reloadCwd), changes };
  }

  private search(p: Record<string, unknown>): Promise<SkillSearchResult> {
    const cwd = this.cwdOf(p);
    const query = this.str(p, "query").toLowerCase();
    const sort = p.sort === "downloads" || p.sort === "recent" ? p.sort : "relevance";
    const page = typeof p.page === "number" && p.page >= 1 ? Math.floor(p.page) : 1;
    const now = this.env.clock.now();
    return this.later(MS.search, () => {
      const words = query.split(/\s+/).filter(Boolean);
      const text = (r: RegistryPackage) => `${r.id} ${r.skill} ${r.keywords.join(" ")} ${r.description}`.toLowerCase();
      const score = (r: RegistryPackage) =>
        words.reduce((n, w) => n + (r.id.toLowerCase().includes(w) || r.skill.includes(w) ? 3 : 0) + (r.keywords.some((k) => k.includes(w)) ? 2 : 0) + (r.description.toLowerCase().includes(w) ? 1 : 0), 0);
      const found = this.knob === "empty" ? [] : REGISTRY.filter((r) => !r.private && words.every((w) => text(r).includes(w)));
      found.sort((a, b) => (sort === "downloads" ? b.weeklyDownloads - a.weeklyDownloads : sort === "recent" ? a.ageDays - b.ageDays : score(b) - score(a) || b.weeklyDownloads - a.weeklyDownloads));
      const hits: SkillSearchHit[] = found.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((r) => {
        const mine = this.installs.filter((i) => i.id === r.id && this.inScope(i, cwd));
        const installed = mine.some((i) => i.scope === "project") ? "project" : mine.length ? "user" : undefined;
        return {
          id: r.id,
          description: r.description,
          version: r.latest,
          publisher: r.publisher,
          keywords: r.keywords,
          updatedAt: now - r.ageDays * DAY,
          weeklyDownloads: r.weeklyDownloads,
          deprecated: r.deprecated,
          installed,
        };
      });
      return { total: found.length, page, perPage: PER_PAGE, hits, registryUrl: REGISTRY_URL };
    });
  }

  private skillInstall(p: Record<string, unknown>): Promise<SkillsChanged> {
    const cwd = this.cwdOf(p);
    const spec = this.str(p, "spec");
    const scope = this.scopeOf(p, cwd, true) as InstallScope;
    const m = SKILL_ID_RE.exec(spec);
    if (!m?.[1]) throw apiError("invalid_params", `spec: \`${spec}\` is not a registry package (@scope/name[@version])`);
    const id = m[1];
    const want = m[2];
    const allow = p.allowScripts === true;
    return this.later(MS.skillInstall, () => {
      const pkg = this.pkg(id);
      if (!pkg || pkg.private) throw apiError("omp_error", `${id} was not found in the registry`);
      const version = want ? (pkg.versions.includes(want) ? want : newestIn(pkg, want === "latest" ? "latest" : want)) : pkg.latest;
      if (!version) throw apiError("omp_error", `no version of ${id} matches ${want}`);
      if (pkg.scripts && !allow) throw apiError("scripts_need_consent", scriptsListing(pkg, version));
      const range = want ?? `^${version}`;
      const project = scope === "project" ? cwd : undefined;
      const old = this.installs.find((i) => i.id === id && i.scope === scope && i.project === project);
      const change = old?.version ? `${id} ${old.version} → ${version}` : `+ ${id}@${version}`;
      if (old) Object.assign(old, { range, version, stored: true });
      else this.installs.push({ id, scope, project, range, version, stored: true });
      return this.skillsChanged(cwd, project, [change]);
    });
  }

  private skillUpdate(p: Record<string, unknown>): Promise<SkillsChanged> {
    const cwd = this.cwdOf(p);
    const scope = this.scopeOf(p, cwd, true) as InstallScope;
    const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
    const project = scope === "project" ? cwd : undefined;
    const targets = this.installs.filter((i) => i.scope === scope && i.project === project && (!id || i.id === id));
    if (id && targets.length === 0) throw apiError("not_found", `${id} is not installed ${scope === "user" ? "for the user" : "in this project"}`);
    const allow = p.allowScripts === true;
    return this.later(MS.skillInstall, () => {
      const plans: { install: Install; to: string; restore: boolean }[] = [];
      for (const i of targets) {
        const pkg = this.pkg(i.id);
        if (!pkg || pkg.private) continue;
        const newest = i.range ? newestIn(pkg, i.range) : pkg.latest;
        if (!i.stored || !i.version) plans.push({ install: i, to: i.version ?? newest ?? pkg.latest, restore: true });
        else if (newest && vcmp(newest, i.version) > 0) plans.push({ install: i, to: newest, restore: false });
      }
      const scripted = plans.find((x) => this.pkg(x.install.id)?.scripts);
      if (scripted && !allow) throw apiError("scripts_need_consent", scriptsListing(this.pkg(scripted.install.id) as RegistryPackage, scripted.to));
      const changes = plans.map((x) => (x.restore ? `restored ${x.install.id}@${x.to}` : `${x.install.id} ${x.install.version} → ${x.to}`));
      for (const x of plans) Object.assign(x.install, { version: x.to, stored: true });
      if (changes.length === 0) changes.push(id ? `${id} is up to date` : "Everything is up to date");
      return this.skillsChanged(cwd, project, changes);
    });
  }

  private skillRemove(p: Record<string, unknown>): Promise<SkillsChanged> {
    const cwd = this.cwdOf(p);
    const id = this.str(p, "id");
    const scope = this.scopeOf(p, cwd, true) as InstallScope;
    const project = scope === "project" ? cwd : undefined;
    const at = this.installs.findIndex((i) => i.id === id && i.scope === scope && i.project === project);
    if (at < 0) throw apiError("not_found", `${id} is not installed ${scope === "user" ? "for the user" : "in this project"}`);
    return this.later(MS.skillRemove, () => {
      const [gone] = this.installs.splice(at, 1);
      return this.skillsChanged(cwd, project, [`- ${id}${gone?.version ? `@${gone.version}` : ""}`]);
    });
  }

  private skillSwitch(p: Record<string, unknown>): Promise<SkillsChanged> {
    const cwd = this.cwdOf(p);
    const name = this.str(p, "name");
    if (typeof p.enabled !== "boolean") throw apiError("invalid_params", "enabled: true or false");
    const enabled = p.enabled;
    if (!this.skillInfos(cwd).some((s) => s.name === name)) throw apiError("not_found", `no skill named “${name}”`);
    return this.later(MS.skillSwitch, () => {
      if (enabled) this.disabledSkills.delete(name);
      else this.disabledSkills.add(name);
      return { list: this.skillListOf(cwd), reload: DemoPlugins.none(), changes: [`${enabled ? "Enabled" : "Disabled"} skill:${name}`], note: SKILL_SWITCH_NOTE };
    });
  }

  // ---------------------------------------------------------------- plugins

  private catalogEntry(marketplace: string, name: string): CatalogEntry | undefined {
    return this.marketplaces.find((m) => m.name === marketplace)?.catalog.find((c) => c.name === name);
  }

  private marketPath(m: MarketInstall): string {
    const root = m.scope === "project" && m.project ? `${m.project}/.omp` : `${this.env.home}/.omp`;
    return `${root}/plugins/cache/${m.marketplace}/${m.name}/${m.version}`;
  }

  /** A user install that the folder's project install of the same plugin wins over. */
  private shadowed(m: MarketInstall, cwd: string | undefined): boolean {
    return m.scope === "user" && !!cwd && this.market.some((o) => o !== m && o.scope === "project" && o.project === cwd && o.name === m.name && o.marketplace === m.marketplace);
  }

  private marketplaceInfo(m: DemoMarketplace): Marketplace {
    return { name: m.name, sourceType: m.sourceType, source: m.source, description: m.description, owner: m.owner, plugins: m.catalog.length, updatedAt: new Date(m.updatedAt).toISOString() };
  }

  private pluginsList(cwd: string | undefined): PluginList {
    const marketplace: MarketplacePlugin[] = this.market
      .filter((m) => this.inScope(m, cwd))
      .sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"))
      .map((m) => {
        const entry = this.catalogEntry(m.marketplace, m.name);
        return {
          id: `${m.name}@${m.marketplace}`,
          name: m.name,
          marketplace: m.marketplace,
          scope: m.scope,
          version: m.version,
          enabled: m.enabled,
          shadowed: this.shadowed(m, cwd),
          description: entry?.description,
          update: entry && vcmp(entry.version, m.version) > 0 ? entry.version : undefined,
          path: this.marketPath(m),
          updatedAt: new Date(m.updatedAt).toISOString(),
          homepage: entry?.homepage,
          provides: entry?.provides ?? [],
        };
      });
    return {
      packages: this.packages.map((pkg) => ({ ...pkg, enabled: !this.disabledPackages.has(pkg.name) })),
      marketplace,
      marketplaces: this.marketplaces.map((m) => this.marketplaceInfo(m)),
      cwd,
      warnings: [],
      ompVersion: this.env.ompVersion(),
    };
  }

  private pluginsChanged(cwd: string | undefined, reloadCwd: string | undefined, changes: string[], note?: string, reload = true): PluginsChanged {
    return { list: this.pluginsList(cwd), reload: reload ? this.reload(reloadCwd) : DemoPlugins.none(), changes, note };
  }

  private discover(p: Record<string, unknown>): Promise<PluginCatalog> {
    const cwd = this.cwdOf(p);
    const only = typeof p.marketplace === "string" && p.marketplace ? p.marketplace : undefined;
    if (only && !this.marketplaces.some((m) => m.name === only)) throw apiError("not_found", `no marketplace named “${only}”`);
    return this.later(MS.discover, () => {
      const plugins: CatalogPlugin[] = [];
      for (const m of this.marketplaces) {
        if (only && m.name !== only) continue;
        for (const c of m.catalog) {
          const scopes = new Set(this.market.filter((x) => x.marketplace === m.name && x.name === c.name && this.inScope(x, cwd)).map((x) => x.scope));
          plugins.push({
            id: `${c.name}@${m.name}`,
            name: c.name,
            marketplace: m.name,
            description: c.description,
            version: c.version,
            author: c.author,
            category: c.category,
            keywords: c.keywords,
            homepage: c.homepage,
            provides: c.provides,
            installed: (["user", "project"] as const).filter((s) => scopes.has(s)),
          });
        }
      }
      return { plugins, marketplaces: this.marketplaces.filter((m) => !only || m.name === only).map((m) => this.marketplaceInfo(m)) };
    });
  }

  /** The installed plugin `id` names: a package, or `name@marketplace` (in `scope`, else the only install). */
  private locate(id: string, scope: InstallScope | undefined, cwd: string | undefined): { pkg?: DemoPackage; install?: MarketInstall } {
    const pkg = this.packages.find((x) => x.name === id);
    if (pkg) return { pkg };
    const m = MARKET_RE.exec(id);
    const all = m ? this.market.filter((x) => x.name === m[1] && x.marketplace === m[2] && this.inScope(x, cwd)) : [];
    if (all.length === 0) throw apiError("not_found", `no plugin named “${id}” is installed`);
    if (scope) {
      const hit = all.find((x) => x.scope === scope);
      if (!hit) throw apiError("not_found", `${id} is not installed ${scope === "user" ? "for the user" : "in this project"}`);
      return { install: hit };
    }
    if (all.length > 1) throw apiError("invalid_params", `scope: ${id} is installed for the user and in this project; say which`);
    return { install: all[0] };
  }

  private pluginInstall(p: Record<string, unknown>): Promise<PluginsChanged> {
    const cwd = this.cwdOf(p);
    const spec = this.str(p, "spec");
    const scope = this.scopeOf(p, cwd, false) ?? "user";
    const force = p.force === true;
    const h = this.env.home;
    const market = MARKET_RE.exec(spec);
    const marketplace = market?.[2] ? this.marketplaces.find((m) => m.name === market[2]) : undefined;
    if (market?.[1] && marketplace) {
      const name = market[1];
      return this.later(MS.marketplaceInstall, () => {
        const entry = marketplace.catalog.find((c) => c.name === name);
        if (!entry) throw apiError("omp_error", `Plugin "${name}" not found in marketplace "${marketplace.name}"`);
        const project = scope === "project" ? cwd : undefined;
        const old = this.market.find((x) => x.name === name && x.marketplace === marketplace.name && x.scope === scope && x.project === project);
        if (old && !force) throw apiError("omp_error", `Plugin "${spec}" is already installed (${scope} scope); reinstall it with force`);
        if (old) Object.assign(old, { version: entry.version, updatedAt: this.env.clock.now() });
        else this.market.push({ name, marketplace: marketplace.name, scope, project, version: entry.version, enabled: true, updatedAt: this.env.clock.now() });
        return this.pluginsChanged(cwd, project, [`+ ${spec} ${entry.version}${scope === "project" ? " (project)" : ""}`]);
      });
    }
    if (FOLDER_RE.test(spec)) {
      const path = spec.startsWith("~") ? `${h}${spec.slice(1)}` : spec;
      const folder = path.replace(/\/+$/, "");
      if (this.env.folderExists && !this.env.folderExists(folder)) throw apiError("invalid_params", `spec: ${spec}: no such folder on the host`);
      const name = folder.split("/").pop() || "plugin";
      return this.later(MS.folderInstall, () => this.addPackage({ name, version: "0.0.0", description: undefined, path: folder, linked: true, provides: ["extensions"], features: [] }, force, cwd));
    }
    if (GIT_RE.test(spec)) {
      const name = (spec.split(/[/:]/).pop() ?? "plugin").replace(/#.*$/, "").replace(/\.git$/, "") || "plugin";
      return this.later(MS.packageInstall, () => this.addPackage({ name, version: "0.1.0", description: `Installed from ${spec}`, path: `${h}/.omp/plugins/node_modules/${name}`, linked: false, provides: ["extensions"], features: [] }, force, cwd));
    }
    if (!NPM_RE.test(spec)) throw apiError("invalid_params", `spec: \`${spec}\` is not a package, git source, folder or name@marketplace`);
    const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
    const name = (at > 0 ? spec.slice(0, at) : spec).replace(/\[.*$/, "");
    return this.later(MS.packageInstall, () => {
      const known = NPM[name];
      if (!known) throw apiError("omp_error", `npm error 404 Not Found - GET https://registry.npmjs.org/${name.replace("/", "%2f")} - Not found`);
      return this.addPackage({ name, version: known.version, description: known.description, path: `${h}/.omp/plugins/node_modules/${name}`, linked: false, provides: known.provides, features: [] }, force, cwd);
    });
  }

  private addPackage(pkg: DemoPackage, force: boolean, cwd: string | undefined): PluginsChanged {
    const old = this.packages.findIndex((x) => x.name === pkg.name);
    if (old >= 0 && !force) throw apiError("omp_error", `${pkg.name} is already installed; reinstall it with force`);
    if (old >= 0) this.packages.splice(old, 1, pkg);
    else this.packages.push(pkg);
    this.disabledPackages.delete(pkg.name);
    return this.pluginsChanged(cwd, undefined, [`+ ${pkg.name}@${pkg.version}${pkg.linked ? ` (linked ${pkg.path})` : ""}`], PACKAGE_NOTE);
  }

  private pluginRemove(p: Record<string, unknown>): Promise<PluginsChanged> {
    const cwd = this.cwdOf(p);
    const id = this.str(p, "id");
    const { pkg, install } = this.locate(id, this.scopeOf(p, cwd, false), cwd);
    return this.later(MS.pluginRemove, () => {
      if (pkg) {
        this.packages.splice(this.packages.indexOf(pkg), 1);
        this.disabledPackages.delete(pkg.name);
        return this.pluginsChanged(cwd, undefined, [`- ${pkg.name}@${pkg.version}`], PACKAGE_NOTE);
      }
      const m = install as MarketInstall;
      this.market.splice(this.market.indexOf(m), 1);
      return this.pluginsChanged(cwd, m.project, [`- ${id} ${m.version}${m.scope === "project" ? " (project)" : ""}`]);
    });
  }

  private pluginSwitch(p: Record<string, unknown>): Promise<PluginsChanged> {
    const cwd = this.cwdOf(p);
    const id = this.str(p, "id");
    if (typeof p.enabled !== "boolean") throw apiError("invalid_params", "enabled: true or false");
    const enabled = p.enabled;
    const { pkg, install } = this.locate(id, this.scopeOf(p, cwd, false), cwd);
    return this.later(MS.pluginSwitch, () => {
      const line = `${enabled ? "Enabled" : "Disabled"} ${id}`;
      if (pkg) {
        if (enabled) this.disabledPackages.delete(pkg.name);
        else this.disabledPackages.add(pkg.name);
        return this.pluginsChanged(cwd, undefined, [line], PACKAGE_NOTE);
      }
      const m = install as MarketInstall;
      m.enabled = enabled;
      return this.pluginsChanged(cwd, m.project, [line]);
    });
  }

  private upgrade(p: Record<string, unknown>): Promise<PluginsChanged> {
    const cwd = this.cwdOf(p);
    const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
    const scope = this.scopeOf(p, cwd, false);
    const found = id ? this.locate(id, scope, cwd) : undefined;
    if (found?.pkg?.linked) throw apiError("invalid_params", `${found.pkg.name} is a linked folder: edits there apply when a session restarts`);
    return this.later(MS.upgrade, () => {
      if (found?.pkg) {
        const pkg = found.pkg;
        const next = PACKAGE_UPGRADES[pkg.name];
        if (!next || vcmp(next, pkg.version) <= 0) return this.pluginsChanged(cwd, undefined, [`${pkg.name} is up to date`], undefined, false);
        const from = pkg.version;
        pkg.version = next;
        return this.pluginsChanged(cwd, undefined, [`${pkg.name} ${from} → ${next}`], PACKAGE_NOTE);
      }
      const targets = found?.install ? [found.install] : this.market.filter((m) => this.inScope(m, cwd));
      const changes: string[] = [];
      let projectOnly = true;
      for (const m of targets) {
        const entry = this.catalogEntry(m.marketplace, m.name);
        if (!entry || vcmp(entry.version, m.version) <= 0) continue;
        changes.push(`${m.name}@${m.marketplace} ${m.version} → ${entry.version}`);
        m.version = entry.version;
        m.updatedAt = this.env.clock.now();
        if (m.scope === "user") projectOnly = false;
      }
      if (changes.length === 0) return this.pluginsChanged(cwd, undefined, [id ? `${id} is up to date` : "Every marketplace plugin is up to date"], undefined, false);
      return this.pluginsChanged(cwd, projectOnly ? cwd : undefined, changes);
    });
  }

  private marketplaceAdd(p: Record<string, unknown>): Promise<PluginsChanged> {
    const cwd = this.cwdOf(p);
    const source = this.str(p, "source");
    return this.later(MS.marketplaceAdd, () => {
      const fresh = KNOWN_SOURCES[source]?.();
      const existing = this.marketplaces.find((m) => m.source === source || m.name === fresh?.name);
      if (existing) throw apiError("omp_error", `Marketplace "${existing.name}" already exists`);
      if (!fresh) {
        if (FOLDER_RE.test(source)) throw apiError("omp_error", `${source} has no .claude-plugin/marketplace.json`);
        if (/^https?:\/\/\S+\.json$/i.test(source)) throw apiError("omp_error", `Couldn't fetch ${source}: 404 Not Found`);
        throw apiError("omp_error", `Couldn't fetch the marketplace: git clone failed: repository '${source}' not found`);
      }
      fresh.updatedAt = this.env.clock.now();
      this.marketplaces.push(fresh);
      return this.pluginsChanged(cwd, undefined, [`Added marketplace ${fresh.name} (${fresh.catalog.length} plugins)`], undefined, false);
    });
  }

  private marketplaceRemove(p: Record<string, unknown>): Promise<PluginsChanged> {
    const cwd = this.cwdOf(p);
    const name = this.str(p, "name");
    const at = this.marketplaces.findIndex((m) => m.name === name);
    if (at < 0) throw apiError("omp_error", `Marketplace "${name}" not found`);
    return this.later(MS.marketplaceRemove, () => {
      this.marketplaces.splice(at, 1);
      return this.pluginsChanged(cwd, undefined, [`Removed marketplace ${name}`], undefined, false);
    });
  }

  private marketplaceUpdate(p: Record<string, unknown>): Promise<PluginsChanged> {
    const cwd = this.cwdOf(p);
    const name = typeof p.name === "string" && p.name ? p.name : undefined;
    const targets = name ? this.marketplaces.filter((m) => m.name === name) : [...this.marketplaces];
    if (name && targets.length === 0) throw apiError("omp_error", `Marketplace "${name}" not found`);
    return this.later(MS.marketplaceUpdate * Math.max(1, targets.length), () => {
      const now = this.env.clock.now();
      for (const m of targets) {
        for (const [plugin, version] of Object.entries(m.upstream)) {
          const entry = m.catalog.find((c) => c.name === plugin);
          if (entry && vcmp(version, entry.version) > 0) entry.version = version;
        }
        m.upstream = {};
        m.updatedAt = now;
      }
      return this.pluginsChanged(cwd, undefined, targets.map((m) => `Updated ${m.name}`), undefined, false);
    });
  }
}
