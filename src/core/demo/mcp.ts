/**
 * Demo `mcp.*`: omp's MCP servers on a demo host, with tf-hostd's semantics (`tf_proto::mcp`).
 *
 * - Config: the user file (`~/.omp/agent/mcp.json` with its `disabledServers` / `enabledServers`
 *   lists), project files (`<folder>/.omp/mcp.json`) and read-only imports (Claude Code, Cursor).
 *   Precedence like omp: project over user over imported; the loser of a name is `shadowed`.
 * - Secrets: env / header values and URL query values whose name says so, secret flags and JSON
 *   keys in arguments and the OAuth client secret are listed as `SECRET_MASK`; the mask sent back
 *   keeps the stored value (a mask with nothing stored behind it is refused).
 * - Checks: a list without fresh results (new or changed definition, or older than 10 min) starts a
 *   check that ends ~1.2 s later (`check.running`, statuses `checking` until then); `waitMs` waits
 *   for it on the demo clock; `refresh` checks everything again. Changes check what they touched.
 * - Running sessions: the host's live omp agents (`liveSessions`; for a project only those started
 *   in its folder). Every change answers with what `/mcp reload` did to them.
 * - Sign-in: `mcp.authStart` runs a scripted browser flow through the host's `auth.*` flows
 *   (`./auth`); done → signed in (per URL, like omp's credential store) and checked again.
 * - `mcp.search`: a fixture of Smithery registry entries.
 *
 * Demo knobs (the page's URL): `?demo&mcp=empty` (no servers anywhere), `mcp=broken` (the check
 * fails as a whole and an imported file is invalid JSON), `mcp=error` (`mcp.list` fails).
 */
import type {
  Agent,
  AuthFlow,
  McpChanged,
  McpCheckState,
  McpFileError,
  McpKeyValue,
  McpList,
  McpReload,
  McpRegistryEntry,
  McpScope,
  McpServer,
  McpServerDraft,
  McpServerInfo,
  McpStatus,
  McpTestResult,
  McpTool,
} from "../gen";
import { apiError } from "../errors";
import type { DemoAuthFlows } from "./auth";
import type { DemoClock } from "./clock";

/** `tf_proto::mcp::SECRET_MASK`. */
export const DEMO_SECRET_MASK = "••••••••";

export interface McpHostEnv {
  /** false: the host's tf-hostd predates MCP servers (every method answers `unknown_method`). */
  supported: boolean;
  clock: DemoClock;
  home: string;
  /** The host's agents: live omp ones are the sessions `/mcp reload` reaches. */
  agents(): Agent[];
  /** The host's sign-in flows (`auth.*`). */
  auth: DemoAuthFlows;
  ompVersion(): string | undefined;
  /** Demo knob (`?demo&mcp=…`); read from the page URL when absent. */
  knob?: "empty" | "broken" | "error" | null;
}

const CHECK_MS = 1200;
/** A result older than this is checked again on the next list (hostd's freshness). */
const FRESH_MS = 10 * 60_000;
const MAX_WAIT_MS = 25_000;
const NAME_RE = /^[a-zA-Z0-9_.:-]+( [a-zA-Z0-9_.:-]+)*$/;
const SECRET_NAME = /token|key|secret|password|passwd|auth|cookie|session|credential|private/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function secretName(name: string): boolean {
  return SECRET_NAME.test(name) || name.trim().toLowerCase() === "authorization";
}

interface Entry {
  name: string;
  /** As stored in the file: secrets in clear. */
  server: McpServerDraft;
  /** The entry's own `enabled` flag (imported: the source's). */
  enabled: boolean;
  extra: string[];
}

interface ConfigFile {
  path: string;
  entries: Entry[];
}

interface Imported extends Entry {
  sourceLabel: string;
  path: string;
}

interface CheckResult {
  fingerprint: string;
  status: McpStatus;
  error?: string;
  tools: McpTool[];
  serverInfo?: McpServerInfo;
  checkedAt: number;
}

interface CheckCtx {
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** Server ids the running check covers. */
  pending: Set<string>;
  cancel?: () => void;
  waiters: Set<() => void>;
}

/** One server as a session in a folder (or the home folder) sees it. */
interface Resolved {
  id: string;
  name: string;
  origin: "user" | "project" | "imported";
  entry: Entry;
  path: string;
  sourceLabel?: string;
  enabled: boolean;
  shadowed: boolean;
  skipNote?: string;
}

interface Outcome {
  status: McpStatus;
  error?: string;
  tools: McpTool[];
  serverInfo?: McpServerInfo;
  ms: number;
}

function t(name: string, description: string): McpTool {
  return { name, description };
}

// ---------------------------------------------------------------- tool catalogs (real servers' tools)

const TOOLS = {
  context7: [
    t("resolve-library-id", "Resolves a package/product name to a Context7-compatible library ID and returns matching libraries."),
    t("query-docs", "Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework."),
  ],
  filesystem: [
    t("read_file", "Read the complete contents of a file as text. DEPRECATED: use read_text_file instead."),
    t("read_text_file", "Read the complete contents of a file as text; head or tail reads only the first or last N lines."),
    t("read_media_file", "Read an image or audio file and return its base64 data with the MIME type."),
    t("read_multiple_files", "Read several files at once; a failed read doesn't stop the others."),
    t("write_file", "Create a new file or overwrite an existing one. Use with caution."),
    t("edit_file", "Make line-based edits to a text file and return a git-style diff of the changes."),
    t("create_directory", "Create a directory (with its parents) or make sure it exists."),
    t("list_directory", "List a directory's files and folders with [FILE] and [DIR] prefixes."),
    t("list_directory_with_sizes", "List a directory with [FILE] / [DIR] prefixes, file sizes and totals."),
    t("move_file", "Move or rename files and directories. Fails if the destination exists."),
    t("search_files", "Recursively search for files and directories matching a glob pattern."),
    t("directory_tree", "Get a recursive JSON tree of a directory's files and folders."),
    t("get_file_info", "Get size, timestamps, type and permissions of a file or directory."),
    t("list_allowed_directories", "List the directories this server is allowed to access."),
  ],
  memory: [
    t("create_entities", "Create multiple new entities in the knowledge graph"),
    t("create_relations", "Create multiple new relations between entities in the knowledge graph"),
    t("add_observations", "Add new observations to existing entities in the knowledge graph"),
    t("delete_entities", "Delete multiple entities and their associated relations from the knowledge graph"),
    t("delete_observations", "Delete specific observations from entities in the knowledge graph"),
    t("delete_relations", "Delete multiple relations from the knowledge graph"),
    t("read_graph", "Read the entire knowledge graph"),
    t("search_nodes", "Search for nodes in the knowledge graph based on a query"),
    t("open_nodes", "Open specific nodes in the knowledge graph by their names"),
  ],
  thinking: [t("sequentialthinking", "A detailed tool for dynamic and reflective problem-solving through thoughts.")],
  huggingface: [
    t("hf_whoami", "Inspect the current Hugging Face authentication context: account, organizations and access."),
    t("hub_repo_search", "Search Hugging Face models, datasets and Spaces with one query interface."),
    t("hub_repo_details", "Get details for one or more Hugging Face repos (model, dataset or Space)."),
    t("hf_fs", "Browse files of Hub repositories, collections, papers and docs."),
  ],
  cloudflare: [t("search_cloudflare_documentation", "Search the Cloudflare documentation."), t("migrate_pages_to_workers_guide", "ALWAYS read this guide before migrating Pages projects to Workers.")],
  deepwiki: [
    t("read_wiki_structure", "Get a list of documentation topics for a GitHub repository."),
    t("read_wiki_contents", "View documentation about a GitHub repository."),
    t("ask_wiki_question", "Ask any question about a GitHub repository's codebase and get an AI-powered answer."),
  ],
  github: [
    t("get_me", "Get details of the authenticated GitHub user."),
    t("search_repositories", "Find GitHub repositories by name, description, readme, topics or other metadata."),
    t("get_file_contents", "Get the contents of a file or directory from a GitHub repository."),
    t("list_issues", "List issues in a GitHub repository, filtered by state, labels and dates."),
    t("issue_read", "Get an issue with its comments, labels and sub-issues."),
    t("create_issue", "Create a new issue in a GitHub repository."),
    t("add_issue_comment", "Add a comment to an issue or pull request."),
    t("list_pull_requests", "List pull requests in a GitHub repository."),
    t("pull_request_read", "Get a pull request with its diff, files, reviews and status checks."),
    t("create_pull_request", "Create a new pull request in a GitHub repository."),
    t("list_workflow_runs", "List GitHub Actions workflow runs of a repository."),
    t("get_job_logs", "Download the logs of a GitHub Actions job (or every failed job of a run)."),
  ],
  linear: [
    t("list_issues", "List issues in the user's Linear workspace"),
    t("get_issue", "Retrieve a Linear issue's details by ID"),
    t("create_issue", "Create a new Linear issue"),
    t("update_issue", "Update an existing Linear issue"),
    t("list_projects", "List projects in the user's Linear workspace"),
    t("list_teams", "List teams in the user's Linear workspace"),
    t("list_cycles", "Retrieve cycles for a specific Linear team"),
    t("create_comment", "Create a comment on a specific Linear issue"),
    t("search_documentation", "Search Linear's documentation to learn about features and usage"),
  ],
  notion: [
    t("notion-search", "Search the Notion workspace and connected sources"),
    t("notion-fetch", "Retrieve a Notion page or database by URL or ID"),
    t("notion-create-pages", "Create one or more Notion pages"),
    t("notion-update-page", "Update a Notion page's properties or content"),
    t("notion-get-comments", "Get the comments of a Notion page"),
    t("notion-create-comment", "Add a comment to a Notion page"),
  ],
  sentry: [
    t("whoami", "Identify the authenticated Sentry user."),
    t("find_organizations", "Find the organizations the user can access."),
    t("find_projects", "Find projects in a Sentry organization."),
    t("search_issues", "Search for grouped issues with a natural-language query."),
    t("get_issue_details", "Get an issue's details, stack trace and latest event."),
    t("search_events", "Search events and aggregate counts with a natural-language query."),
    t("analyze_issue_with_seer", "Have Seer find the root cause of an issue and suggest a fix."),
    t("update_issue", "Resolve, ignore or assign an issue."),
    t("find_releases", "Find releases of a Sentry organization or project."),
    t("search_docs", "Search the Sentry documentation and SDK guides."),
  ],
  supabase: [
    t("list_projects", "Lists all Supabase projects for the user."),
    t("list_tables", "Lists all tables in one or more schemas."),
    t("execute_sql", "Executes raw SQL in the Postgres database."),
    t("apply_migration", "Applies a migration to the database."),
    t("list_migrations", "Lists all migrations in the database."),
    t("get_logs", "Gets logs for a Supabase project by service type."),
    t("list_edge_functions", "Lists all Edge Functions in a Supabase project."),
    t("deploy_edge_function", "Deploys an Edge Function to a Supabase project."),
    t("generate_typescript_types", "Generates TypeScript types for a project."),
  ],
  docs: [
    t("search_docs", "Search TeleFlock's docs: architecture, bridge protocol and feature READMEs."),
    t("read_doc", "Read one document by its path under docs/ or src/features."),
    t("list_docs", "List the documents the other tools can read."),
  ],
} satisfies Record<string, McpTool[]>;

const OAUTH_HOSTS: Record<string, { tools: McpTool[]; info: McpServerInfo; authorize: string; account: string }> = {
  "mcp.linear.app": { tools: TOOLS.linear, info: { name: "Linear MCP", version: "1.4.0" }, authorize: "https://mcp.linear.app/authorize", account: "you@flock.dev (Flock)" },
  "mcp.notion.com": { tools: TOOLS.notion, info: { name: "Notion MCP", version: "1.2.3" }, authorize: "https://mcp.notion.com/authorize", account: "you@flock.dev" },
  "mcp.sentry.dev": { tools: TOOLS.sentry, info: { name: "Sentry MCP", version: "0.42.0" }, authorize: "https://mcp.sentry.dev/oauth/authorize", account: "you@flock.dev (flock)" },
  "mcp.supabase.com": { tools: TOOLS.supabase, info: { name: "supabase", version: "0.6.1" }, authorize: "https://api.supabase.com/v1/oauth/authorize", account: "you@flock.dev" },
  "api.githubcopilot.com": { tools: TOOLS.github, info: { name: "github-mcp-server", version: "0.24.0" }, authorize: "https://github.com/login/oauth/authorize", account: "flock-dev" },
};

const OPEN_HOSTS: Record<string, { tools: McpTool[]; info: McpServerInfo }> = {
  "mcp.context7.com": { tools: TOOLS.context7, info: { name: "Context7", version: "4.4.3" } },
  "huggingface.co": { tools: TOOLS.huggingface, info: { name: "huggingface.co/mcp", version: "0.4.31" } },
  "docs.mcp.cloudflare.com": { tools: TOOLS.cloudflare, info: { name: "docs-ai-search", version: "0.5.0" } },
  "mcp.deepwiki.com": { tools: TOOLS.deepwiki, info: { name: "DeepWiki", version: "2.14.3" } },
};

const NPM_PACKAGES: Record<string, { tools: McpTool[]; info: McpServerInfo }> = {
  "@modelcontextprotocol/server-filesystem": { tools: TOOLS.filesystem, info: { name: "secure-filesystem-server", version: "2.0.1" } },
  "@modelcontextprotocol/server-memory": { tools: TOOLS.memory, info: { name: "memory-server", version: "2.0.0" } },
  "@modelcontextprotocol/server-sequential-thinking": { tools: TOOLS.thinking, info: { name: "sequential-thinking-server", version: "2.0.0" } },
};

// ---------------------------------------------------------------- registry fixture (Smithery)

function smitheryLocal(id: string): McpServerDraft {
  return { transport: "stdio", command: "bunx", args: ["-y", "@smithery/cli", "run", id, "--config", "{}"], env: [], headers: [] };
}

function smitheryRemote(id: string): McpServerDraft {
  return { transport: "http", url: `https://server.smithery.ai/${id}/mcp`, args: [], env: [], headers: [] };
}

function reg(e: Partial<McpRegistryEntry> & Pick<McpRegistryEntry, "id" | "name" | "title" | "server">): McpRegistryEntry {
  return { useCount: 0, verified: false, remote: e.server.transport !== "stdio", inputs: [], warnings: [], tools: [], ...e };
}

const REGISTRY: McpRegistryEntry[] = [
  reg({
    id: "@upstash/context7-mcp",
    name: "context7",
    title: "Context7",
    description: "Fetch up-to-date, version-specific documentation and code examples straight from the source.",
    useCount: 182_340,
    verified: true,
    homepage: "https://smithery.ai/server/@upstash/context7-mcp",
    server: smitheryRemote("@upstash/context7-mcp"),
    tools: TOOLS.context7,
  }),
  reg({
    id: "exa",
    name: "exa",
    title: "Exa Search",
    description: "Fast, intelligent web search and crawling for code, companies and research papers.",
    useCount: 156_020,
    verified: true,
    homepage: "https://smithery.ai/server/exa",
    server: { transport: "http", url: "https://mcp.exa.ai/mcp", args: [], env: [], headers: [] },
    warnings: ["omp skips Exa servers: its built-in web search uses Exa already."],
    tools: [t("web_search_exa", "Search the web with Exa"), t("get_code_context_exa", "Find code examples and docs for a library")],
  }),
  reg({
    id: "@smithery-ai/github",
    name: "github",
    title: "GitHub",
    description: "Manage repositories, issues and pull requests through the GitHub API.",
    useCount: 96_210,
    verified: true,
    homepage: "https://smithery.ai/server/@smithery-ai/github",
    server: smitheryLocal("@smithery-ai/github"),
    inputs: [
      { key: "githubPersonalAccessToken", label: "GitHub personal access token", kind: "string", required: true, description: "A token with the `repo` scope (or fine-grained repository access).", choices: [], secret: true },
      { key: "githubApiUrl", label: "API URL", kind: "string", required: false, defaultValue: "https://api.github.com", description: "Change for GitHub Enterprise Server.", choices: [], secret: false },
    ],
    tools: [t("search_repositories", "Search for GitHub repositories"), t("create_issue", "Create a new issue in a GitHub repository"), t("create_pull_request", "Create a new pull request"), t("get_file_contents", "Get the contents of a file or directory")],
  }),
  reg({
    id: "@microsoft/playwright-mcp",
    name: "playwright",
    title: "Playwright",
    description: "Browser automation with Playwright: navigate, click, fill forms and take snapshots.",
    useCount: 88_400,
    verified: true,
    homepage: "https://smithery.ai/server/@microsoft/playwright-mcp",
    server: smitheryLocal("@microsoft/playwright-mcp"),
    warnings: ["omp skips browser automation servers: its built-in browser tool replaces them."],
    tools: [t("browser_navigate", "Navigate to a URL"), t("browser_click", "Click an element"), t("browser_snapshot", "Capture an accessibility snapshot of the page")],
  }),
  reg({
    id: "@smithery-ai/brave-search",
    name: "brave-search",
    title: "Brave Search",
    description: "Web and local search with Brave's independent index.",
    useCount: 74_530,
    verified: true,
    homepage: "https://smithery.ai/server/@smithery-ai/brave-search",
    server: smitheryLocal("@smithery-ai/brave-search"),
    inputs: [{ key: "braveApiKey", label: "Brave Search API key", kind: "string", required: true, description: "From api-dashboard.search.brave.com.", choices: [], secret: true }],
    tools: [t("brave_web_search", "Search the web with Brave"), t("brave_local_search", "Search for local businesses and places")],
  }),
  reg({
    id: "@wonderwhy-er/desktop-commander",
    name: "desktop-commander",
    title: "Desktop Commander",
    description: "Run terminal commands, manage processes and edit files on the machine.",
    useCount: 64_310,
    homepage: "https://smithery.ai/server/@wonderwhy-er/desktop-commander",
    server: smitheryLocal("@wonderwhy-er/desktop-commander"),
    tools: [t("execute_command", "Run a terminal command"), t("list_processes", "List running processes"), t("edit_block", "Apply a surgical text edit to a file")],
  }),
  reg({
    id: "@notionhq/notion-mcp-server",
    name: "notion",
    title: "Notion",
    description: "Search, read and update your Notion workspace.",
    useCount: 51_240,
    verified: true,
    homepage: "https://smithery.ai/server/@notionhq/notion-mcp-server",
    server: smitheryRemote("@notionhq/notion-mcp-server"),
    tools: TOOLS.notion,
  }),
  reg({
    id: "@smithery-ai/fetch",
    name: "fetch",
    title: "Fetch",
    description: "Fetch URLs and turn web pages into clean Markdown.",
    useCount: 47_930,
    verified: true,
    homepage: "https://smithery.ai/server/@smithery-ai/fetch",
    server: smitheryRemote("@smithery-ai/fetch"),
    tools: [t("fetch", "Fetch a URL and extract its contents as Markdown")],
  }),
  reg({
    id: "@smithery-ai/slack",
    name: "slack",
    title: "Slack",
    description: "Read channels and threads, post messages and add reactions in a Slack workspace.",
    useCount: 41_870,
    verified: true,
    homepage: "https://smithery.ai/server/@smithery-ai/slack",
    server: smitheryLocal("@smithery-ai/slack"),
    inputs: [
      { key: "slackBotToken", label: "Bot token", kind: "string", required: true, description: "The xoxb- token of your Slack app.", choices: [], secret: true },
      { key: "slackTeamId", label: "Workspace ID", kind: "string", required: true, description: "Starts with T, e.g. T01234567.", choices: [], secret: false },
      { key: "slackChannelIds", label: "Channel IDs", kind: "string", required: false, description: "Comma-separated; empty: every public channel.", choices: [], secret: false },
    ],
    tools: [t("slack_list_channels", "List public channels"), t("slack_post_message", "Post a message to a channel"), t("slack_get_thread_replies", "Get all replies in a thread")],
  }),
  reg({
    id: "@supabase-community/supabase-mcp",
    name: "supabase",
    title: "Supabase",
    description: "Manage Supabase projects: database tables, SQL, migrations, edge functions and logs.",
    useCount: 38_960,
    verified: true,
    homepage: "https://smithery.ai/server/@supabase-community/supabase-mcp",
    server: smitheryLocal("@supabase-community/supabase-mcp"),
    inputs: [
      { key: "accessToken", label: "Personal access token", kind: "string", required: true, description: "From supabase.com/dashboard/account/tokens.", choices: [], secret: true },
      { key: "readOnly", label: "Read-only", kind: "boolean", required: false, defaultValue: "true", description: "Run every query as a read-only Postgres user.", choices: [], secret: false },
      { key: "projectRef", label: "Project ref", kind: "string", required: false, description: "Limit the server to one project.", choices: [], secret: false },
    ],
    tools: TOOLS.supabase,
  }),
  reg({
    id: "@smithery-ai/postgres",
    name: "postgres",
    title: "PostgreSQL",
    description: "Read-only access to a PostgreSQL database: inspect schemas and run queries.",
    useCount: 33_020,
    homepage: "https://smithery.ai/server/@smithery-ai/postgres",
    server: smitheryLocal("@smithery-ai/postgres"),
    inputs: [{ key: "postgresConnectionString", label: "Connection string", kind: "string", required: true, description: "postgresql://user:password@host:5432/db", choices: [], secret: true }],
    tools: [t("query", "Run a read-only SQL query")],
  }),
  reg({
    id: "@mem0ai/mem0-memory-mcp",
    name: "mem0-memory",
    title: "Mem0 Memory",
    description: "Long-term memory for agents: store, search and recall facts across sessions.",
    useCount: 22_740,
    homepage: "https://smithery.ai/server/@mem0ai/mem0-memory-mcp",
    server: smitheryLocal("@mem0ai/mem0-memory-mcp"),
    inputs: [
      { key: "mem0ApiKey", label: "Mem0 API key", kind: "string", required: true, choices: [], secret: true },
      { key: "userId", label: "User ID", kind: "string", required: false, defaultValue: "omp", description: "Memories are kept per user ID.", choices: [], secret: false },
      { key: "topK", label: "Results per search", kind: "number", required: false, defaultValue: "8", choices: [], secret: false },
    ],
    tools: [t("add_memory", "Store a memory"), t("search_memories", "Search stored memories"), t("delete_memory", "Delete a memory")],
  }),
  reg({
    id: "@neondatabase/mcp-server-neon",
    name: "neon",
    title: "Neon",
    description: "Manage serverless Postgres databases on Neon: projects, branches and queries in natural language.",
    useCount: 19_310,
    verified: true,
    homepage: "https://smithery.ai/server/@neondatabase/mcp-server-neon",
    server: smitheryRemote("@neondatabase/mcp-server-neon"),
    tools: [t("list_projects", "List Neon projects"), t("create_branch", "Create a database branch"), t("run_sql", "Run a SQL statement")],
  }),
  reg({
    id: "@isdaniel/mcp_weather_server",
    name: "weather",
    title: "Weather (Open-Meteo)",
    description: "Current weather and forecasts for any city, no API key needed.",
    useCount: 12_410,
    homepage: "https://smithery.ai/server/@isdaniel/mcp_weather_server",
    server: smitheryRemote("@isdaniel/mcp_weather_server"),
    inputs: [
      { key: "units", label: "Units", kind: "string", required: false, defaultValue: "metric", choices: ["metric", "imperial"], secret: false },
      { key: "forecastDays", label: "Forecast days", kind: "number", required: false, defaultValue: "7", description: "1–16", choices: [], secret: false },
    ],
    tools: [t("get_current_weather", "Current weather for a city"), t("get_weather_forecast", "Daily forecast for a city")],
  }),
  reg({
    id: "@kazuph/mcp-taskmanager",
    name: "taskmanager",
    title: "Task Manager",
    description: "Plan work as a queue of tasks the agent works through and marks done.",
    useCount: 8_120,
    homepage: "https://smithery.ai/server/@kazuph/mcp-taskmanager",
    server: smitheryLocal("@kazuph/mcp-taskmanager"),
    tools: [t("request_planning", "Register a request and plan its tasks"), t("get_next_task", "Get the next pending task"), t("mark_task_done", "Mark a task as done")],
  }),
];

// ---------------------------------------------------------------- the demo

function readKnob(): McpHostEnv["knob"] {
  try {
    const v = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("mcp");
    return v === "empty" || v === "broken" || v === "error" ? v : null;
  } catch {
    return null;
  }
}

export class DemoMcp {
  private readonly user: ConfigFile;
  private readonly projects = new Map<string, ConfigFile>();
  private readonly imported: Imported[] = [];
  /** omp's user-level lists (`disabledServers` wins over `enabledServers`). */
  private readonly disabledServers = new Set<string>();
  private readonly enabledServers = new Set<string>();
  /** URLs omp holds an OAuth credential for. */
  private readonly signedIn = new Set<string>();
  private readonly results = new Map<string, CheckResult>();
  /** Checks by context ("" = user level, else the project folder). */
  private readonly checks = new Map<string, CheckCtx>();
  /** How often each server was started (a first `npx` start can still be downloading). */
  private readonly starts = new Map<string, number>();
  private readonly knob: McpHostEnv["knob"];
  private readonly fileErrors: McpFileError[] = [];

  constructor(private readonly env: McpHostEnv) {
    this.knob = env.knob === undefined ? readKnob() : env.knob;
    this.user = { path: `${env.home}/.omp/agent/mcp.json`, entries: [] };
    if (env.supported && this.knob !== "empty") this.seed();
  }

  call(method: string, p: Record<string, unknown>): unknown {
    if (!this.env.supported) throw apiError("unknown_method", `Unknown method ${method}`);
    switch (method) {
      case "mcp.list":
        return this.list(p);
      case "mcp.save":
        return this.save(p);
      case "mcp.remove":
        return this.remove(p);
      case "mcp.setEnabled":
        return this.setEnabled(p);
      case "mcp.test":
        return this.test(p);
      case "mcp.reload":
        return this.reloadSessions(this.cwdOf(p));
      case "mcp.authStart":
        return this.authStart(p);
      case "mcp.signOut":
        return this.signOut(p);
      case "mcp.search":
        return this.search(p);
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private seed(): void {
    const h = this.env.home;
    const http = (url: string, extra: Partial<McpServerDraft> = {}): McpServerDraft => ({ transport: "http", url, args: [], env: [], headers: [], ...extra });
    const stdio = (command: string, args: string[], extra: Partial<McpServerDraft> = {}): McpServerDraft => ({ transport: "stdio", command, args, env: [], headers: [], ...extra });
    this.user.entries.push(
      { name: "context7", server: http("https://mcp.context7.com/mcp"), enabled: true, extra: [] },
      {
        name: "github",
        server: http("https://api.githubcopilot.com/mcp/", { oauth: { clientId: "Ov23liTf7Demo4Flock", clientSecret: "3c9e1f0a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e" } }),
        enabled: true,
        extra: [],
      },
      { name: "filesystem", server: stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", `${h}/code`, `${h}/notes`]), enabled: true, extra: [] },
      {
        name: "postgres",
        server: stdio("uvx", ["postgres-mcp", "--access-mode=restricted"], {
          env: [
            { key: "DATABASE_URI", value: "postgresql://app@localhost:5432/app", secret: false },
            { key: "PGPASSWORD", value: "hunter2-but-longer", secret: true },
          ],
        }),
        enabled: true,
        extra: [],
      },
      { name: "sentry", server: http("https://mcp.sentry.dev/mcp", { timeoutMs: 60_000 }), enabled: true, extra: ["auth"] },
      { name: "sequential-thinking", server: stdio("npx", ["-y", "@modelcontextprotocol/server-sequential-thinking"]), enabled: true, extra: [] },
    );
    this.signedIn.add("https://mcp.sentry.dev/mcp");
    this.projects.set(`${h}/code/teleflock`, {
      path: `${h}/code/teleflock/.omp/mcp.json`,
      entries: [{ name: "teleflock-docs", server: stdio("bun", ["run", "scripts/docs-mcp.ts"], { cwd: `${h}/code/teleflock` }), enabled: true, extra: [] }],
    });
    this.imported.push(
      { name: "linear", sourceLabel: "Claude Code", path: `${h}/.claude.json`, server: http("https://mcp.linear.app/mcp"), enabled: true, extra: [] },
      { name: "playwright", sourceLabel: "Cursor", path: `${h}/.cursor/mcp.json`, server: stdio("npx", ["@playwright/mcp@latest"]), enabled: true, extra: [] },
      {
        name: "context7",
        sourceLabel: "Cursor",
        path: `${h}/.cursor/mcp.json`,
        server: http("https://mcp.context7.com/mcp", { headers: [{ key: "CONTEXT7_API_KEY", value: "ctx7sk-2f8e1d9c4b7a", secret: true }] }),
        enabled: true,
        extra: [],
      },
    );
    this.disabledServers.add("linear");
    if (this.knob === "broken") this.fileErrors.push({ path: `${h}/.codeium/windsurf/mcp_config.json`, message: "Expected ',' or '}' after property value in JSON at position 214 (line 9 column 5)" });
  }

  // ---------------------------------------------------------------- resolution

  private cwdOf(p: Record<string, unknown>): string | undefined {
    const cwd = p.cwd;
    if (cwd === undefined || cwd === null) return undefined;
    if (typeof cwd !== "string" || !cwd.startsWith("/")) throw apiError("invalid_params", `cwd: \`${String(cwd)}\` is not an absolute path`);
    const trimmed = cwd.replace(/\/+$/, "") || "/";
    return trimmed === this.env.home ? undefined : trimmed;
  }

  private projectFile(cwd: string): ConfigFile {
    let f = this.projects.get(cwd);
    if (!f) {
      f = { path: `${cwd}/.omp/mcp.json`, entries: [] };
      this.projects.set(cwd, f);
    }
    return f;
  }

  /** The servers a session in `cwd` loads, in omp's precedence order (project, user, imported). */
  private resolve(cwd: string | undefined): Resolved[] {
    const out: Resolved[] = [];
    const winners = new Set<string>();
    const add = (origin: Resolved["origin"], entry: Entry, path: string, sourceLabel?: string) => {
      const shadowed = winners.has(entry.name);
      winners.add(entry.name);
      const listed = origin === "imported" ? (!this.disabledServers.has(entry.name) && (entry.enabled || this.enabledServers.has(entry.name))) : entry.enabled && !this.disabledServers.has(entry.name);
      const id = origin === "imported" ? `imported:${path}:${entry.name}` : origin === "project" ? `project:${cwd}:${entry.name}` : `user:${entry.name}`;
      out.push({ id, name: entry.name, origin, entry, path, sourceLabel, enabled: listed, shadowed, skipNote: skipNote(entry.server, entry.name) });
    };
    if (cwd) for (const e of this.projects.get(cwd)?.entries ?? []) add("project", e, this.projectFile(cwd).path);
    for (const e of this.user.entries) add("user", e, this.user.path);
    for (const e of this.imported) add("imported", e, e.path, e.sourceLabel);
    return out;
  }

  private fingerprint(r: Resolved): string {
    return JSON.stringify([r.entry.server, r.entry.server.url ? this.signedIn.has(r.entry.server.url) : false]);
  }

  /** Servers a session would start (on, not shadowed, not skipped by omp). */
  private checkable(cwd: string | undefined): Resolved[] {
    return this.resolve(cwd).filter((r) => r.enabled && !r.shadowed && !r.skipNote);
  }

  private ctx(cwd: string | undefined): CheckCtx {
    const k = cwd ?? "";
    let c = this.checks.get(k);
    if (!c) {
      c = { running: false, pending: new Set(), waiters: new Set() };
      this.checks.set(k, c);
    }
    return c;
  }

  private fresh(r: Resolved): boolean {
    const res = this.results.get(r.id);
    return !!res && res.fingerprint === this.fingerprint(r) && this.env.clock.now() - res.checkedAt < FRESH_MS;
  }

  /** Starts (or extends) the context's check for `servers`. */
  private check(cwd: string | undefined, servers: Resolved[]): void {
    if (servers.length === 0) return;
    const c = this.ctx(cwd);
    const now = this.env.clock.now();
    if (!c.running) {
      c.running = true;
      c.startedAt = now;
      c.finishedAt = undefined;
      c.error = undefined;
      c.pending.clear();
    }
    for (const r of servers) c.pending.add(r.id);
    c.cancel?.();
    c.cancel = this.env.clock.after(CHECK_MS, () => this.finish(cwd, c));
  }

  private finish(cwd: string | undefined, c: CheckCtx): void {
    const now = this.env.clock.now();
    if (this.knob === "broken") {
      const v = this.env.ompVersion();
      c.error = `omp${v ? ` ${v}` : ""} exited before it reported the servers (exit status 1): TypeError: undefined is not an object (evaluating 'manager.waitForStartup')`;
    } else {
      for (const r of this.resolve(cwd)) {
        if (!c.pending.has(r.id)) continue;
        const o = this.simulate(r.entry.server, r.id);
        this.results.set(r.id, { fingerprint: this.fingerprint(r), status: o.status, error: o.error, tools: o.tools, serverInfo: o.serverInfo, checkedAt: now });
      }
    }
    c.running = false;
    c.finishedAt = now;
    c.pending.clear();
    c.cancel = undefined;
    for (const w of [...c.waiters]) w();
  }

  private listOf(cwd: string | undefined): McpList {
    const c = this.ctx(cwd);
    const servers: McpServer[] = this.resolve(cwd).map((r) => {
      const url = r.entry.server.url;
      const res = this.results.get(r.id);
      const valid = res && res.fingerprint === this.fingerprint(r) ? res : undefined;
      let status: McpStatus;
      let note: string | undefined;
      if (!r.enabled) status = "disabled";
      else if (r.skipNote) {
        status = "skipped";
        note = r.skipNote;
      } else if (r.shadowed) status = "unknown";
      else if (valid) status = valid.status;
      else if (c.running && c.pending.has(r.id)) status = "checking";
      else status = "unknown";
      const shown = status === "disabled" || status === "skipped" || status === "unknown" || status === "checking" ? undefined : valid;
      return {
        name: r.name,
        origin: r.origin,
        path: r.path,
        sourceLabel: r.sourceLabel,
        server: maskDraft(r.entry.server),
        enabled: r.enabled,
        signedIn: !!url && this.signedIn.has(url),
        shadowed: r.shadowed,
        status,
        error: shown?.error,
        note,
        tools: shown?.tools ?? (valid && status !== "checking" ? valid.tools : []),
        serverInfo: shown?.serverInfo,
        checkedAt: shown?.checkedAt,
        extra: [...r.entry.extra],
      };
    });
    const check: McpCheckState = { running: c.running, startedAt: c.startedAt, finishedAt: c.finishedAt, error: c.error };
    return {
      cwd,
      userPath: this.user.path,
      projectPath: cwd ? `${cwd}/.omp/mcp.json` : undefined,
      servers,
      check,
      ompVersion: this.env.ompVersion(),
      liveSessions: this.sessions(cwd).filter((s) => s.reachable).length,
      fileErrors: structuredClone(this.fileErrors),
    };
  }

  private list(p: Record<string, unknown>): McpList | Promise<McpList> {
    if (this.knob === "error") throw apiError("io_error", `can't read ${this.user.path}: Permission denied (os error 13)`, { hint: "Check the file's owner and permissions on the host." });
    const cwd = this.cwdOf(p);
    if (p.refresh === true) this.check(cwd, this.checkable(cwd));
    else if (!this.ctx(cwd).running) this.check(cwd, this.checkable(cwd).filter((r) => !this.fresh(r)));
    const c = this.ctx(cwd);
    const wait = typeof p.waitMs === "number" ? Math.min(Math.max(0, p.waitMs), MAX_WAIT_MS) : 0;
    if (!c.running || wait === 0) return this.listOf(cwd);
    // Executor form: the app's TS lib (ES2023) predates `Promise.withResolvers`.
    return new Promise<McpList>((resolve) => {
      let cancel: () => void = () => {};
      const wake = () => {
        c.waiters.delete(wake);
        cancel();
        resolve(this.listOf(cwd));
      };
      c.waiters.add(wake);
      cancel = this.env.clock.after(wait, wake);
    });
  }

  // ---------------------------------------------------------------- sessions

  private sessions(cwd: string | undefined): { busy: boolean; reachable: boolean }[] {
    return this.env
      .agents()
      .filter((a) => a.kind === "omp" && !a.parked && a.omp && (!cwd || a.cwd === cwd || (a.cwd ?? "").startsWith(`${cwd}/`)))
      .map((a) => ({ busy: a.state === "working", reachable: a.omp?.link === "live" }));
  }

  private reloadSessions(cwd: string | undefined): McpReload {
    const r: McpReload = { reloaded: 0, queued: 0, restartNeeded: 0, errors: [] };
    for (const s of this.sessions(cwd)) {
      if (!s.reachable) r.restartNeeded += 1;
      else if (s.busy) r.queued += 1;
      else r.reloaded += 1;
    }
    return r;
  }

  private changed(cwd: string | undefined, scope: McpScope | undefined): McpChanged {
    // A user-level change reaches every session; a project's only those started in its folder.
    return { list: this.listOf(cwd), reload: this.reloadSessions(scope === "project" ? cwd : undefined) };
  }

  // ---------------------------------------------------------------- changes

  private scopeOf(p: Record<string, unknown>): McpScope | undefined {
    const s = p.scope;
    if (s === undefined || s === null) return undefined;
    if (s !== "user" && s !== "project") throw apiError("invalid_params", "scope must be user or project");
    return s;
  }

  private file(scope: McpScope, cwd: string | undefined): ConfigFile {
    if (scope === "user") return this.user;
    if (!cwd) throw apiError("invalid_params", "cwd: the project folder is needed for a project server");
    return this.projectFile(cwd);
  }

  /** The definition `name` refers to: in `scope`'s file, else the one sessions use (`native`: omp's own files only, like hostd's `locate`). */
  private find(cwd: string | undefined, name: string, scope: McpScope | undefined, native = false): Resolved {
    const all = this.resolve(cwd).filter((r) => r.name === name && (!native || r.origin !== "imported"));
    const hit = scope ? all.find((r) => r.origin === scope) : (all.find((r) => !r.shadowed) ?? all[0]);
    if (!hit) throw apiError("not_found", `no server named “${name}” in omp's config`);
    return hit;
  }

  /** hostd's sign-in target: a server of omp's own files that connects over HTTP and is on. */
  private authTarget(cwd: string | undefined, name: string, scope: McpScope | undefined): Resolved {
    const r = this.resolve(cwd).find((x) => x.name === name && x.origin !== "imported" && (!scope || x.origin === scope));
    if (!r) throw apiError("not_found", `no server named “${name}” in omp's config`, { hint: "Sign-in works for servers in omp's own config files." });
    if (r.entry.server.transport === "stdio" || !r.entry.server.url) throw apiError("invalid_params", `“${name}” is a local (stdio) server: it has no sign-in`, { hint: "Give it its credentials through its environment." });
    if (!r.entry.enabled) throw apiError("invalid_params", `“${name}” is switched off`, { hint: "Switch it on first." });
    return r;
  }

  private save(p: Record<string, unknown>): McpChanged {
    const scope = this.scopeOf(p);
    if (!scope) throw apiError("invalid_params", "scope must be user or project");
    const cwd = this.cwdOf(p);
    const file = this.file(scope, cwd);
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const nameProblem = validateName(name);
    if (nameProblem) throw apiError("invalid_params", nameProblem);
    const previous = typeof p.previousName === "string" && p.previousName.trim() ? p.previousName.trim() : undefined;
    const old = previous !== undefined ? file.entries.find((e) => e.name === previous) : undefined;
    if (previous !== undefined && !old) throw apiError("not_found", `no server named “${previous}” in ${file.path}`);
    if ((previous === undefined || previous !== name) && file.entries.some((e) => e.name === name)) throw apiError("already_exists", `name: “${name}” is already used in ${file.path}`);
    const draft = parseDraft(p.server);
    const server = unmaskDraft(draft, old?.server);
    const enabled = typeof p.enabled === "boolean" ? p.enabled : (old?.enabled ?? true);
    if (old) {
      old.name = name;
      old.server = server;
      old.enabled = enabled;
    } else {
      file.entries.push({ name, server, enabled, extra: [] });
    }
    // A rename carries the user-level list entries along (they are keyed by name).
    if (previous !== undefined && previous !== name) {
      for (const list of [this.disabledServers, this.enabledServers]) {
        if (list.delete(previous)) list.add(name);
      }
    }
    this.recheck(cwd, name);
    return this.changed(cwd, scope);
  }

  /** Checks the server sessions now use under `name` (when it is on). */
  private recheck(cwd: string | undefined, name: string): void {
    // Results are kept per definition, so the other scope's list sees them too.
    this.check(cwd, this.checkable(cwd).filter((r) => r.name === name));
  }

  private remove(p: Record<string, unknown>): McpChanged {
    const cwd = this.cwdOf(p);
    const name = typeof p.name === "string" ? p.name : "";
    const r = this.find(cwd, name, this.scopeOf(p), true);
    const file = this.file(r.origin === "project" ? "project" : "user", cwd);
    file.entries = file.entries.filter((e) => e !== r.entry);
    this.results.delete(r.id);
    this.recheck(cwd, name);
    return this.changed(cwd, r.origin === "project" ? "project" : "user");
  }

  private setEnabled(p: Record<string, unknown>): McpChanged {
    const cwd = this.cwdOf(p);
    const name = typeof p.name === "string" ? p.name : "";
    if (typeof p.enabled !== "boolean") throw apiError("invalid_params", "enabled must be true or false");
    const on = p.enabled;
    const r = this.find(cwd, name, this.scopeOf(p));
    if (r.origin === "imported") {
      // omp's user-level lists: never the other tool's file.
      if (on) {
        this.disabledServers.delete(name);
        if (!r.entry.enabled) this.enabledServers.add(name);
      } else {
        this.disabledServers.add(name);
        this.enabledServers.delete(name);
      }
    } else {
      r.entry.enabled = on;
      if (on) this.disabledServers.delete(name);
    }
    if (on) this.recheck(cwd, name);
    return this.changed(cwd, r.origin === "imported" ? "user" : r.origin);
  }

  private signOut(p: Record<string, unknown>): McpChanged {
    const cwd = this.cwdOf(p);
    const name = typeof p.name === "string" ? p.name : "";
    const r = this.authTarget(cwd, name, this.scopeOf(p));
    this.signedIn.delete(r.entry.server.url ?? "");
    r.entry.extra = r.entry.extra.filter((x) => x !== "auth");
    this.recheck(cwd, name);
    return this.changed(cwd, r.origin === "project" ? "project" : "user");
  }

  private authStart(p: Record<string, unknown>): AuthFlow {
    const cwd = this.cwdOf(p);
    const name = typeof p.name === "string" ? p.name : "";
    const r = this.authTarget(cwd, name, this.scopeOf(p));
    const url = r.entry.server.url ?? "";
    const running = this.env.auth.list().find((f) => f.kind === "mcp" && f.subject === name && (f.state === "starting" || f.state === "waiting"));
    if (running) return running;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      throw apiError("invalid_params", `“${name}” has no valid URL to sign in to`);
    }
    const known = OAUTH_HOSTS[host];
    const o = r.entry.server.oauth;
    const port = o?.callbackPort ?? 3000;
    const redirect = o?.redirectUri ?? `http://localhost:${port}/callback`;
    const state = Math.abs(hashOf(`${name}${this.env.clock.now()}`)).toString(16).padStart(12, "0");
    const q = new URLSearchParams({ response_type: "code", client_id: o?.clientId ?? `omp-${state.slice(0, 8)}`, redirect_uri: redirect, state, code_challenge: `c${state}${state}`.slice(0, 43), code_challenge_method: "S256", resource: url });
    if (o?.scope) q.set("scope", o.scope);
    return this.env.auth.start({
      kind: "mcp",
      title: name,
      subject: name,
      method: "browser",
      url: `${known?.authorize ?? `${new URL(url).origin}/authorize`}?${q.toString()}`,
      instructions: `Sign in to ${host} in your browser. omp on the host receives the sign-in on localhost:${port}.`,
      account: known?.account,
      check: (text) => (/[?&]code=/.test(text) ? undefined : "that address has no sign-in code (code=…): copy the whole address from the browser"),
      onDone: () => {
        this.signedIn.add(url);
        if (!r.entry.extra.includes("auth")) r.entry.extra.push("auth");
        this.recheck(cwd, name);
      },
    });
  }

  private test(p: Record<string, unknown>): Promise<McpTestResult> {
    const cwd = this.cwdOf(p);
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const scope = this.scopeOf(p);
    let server: McpServerDraft;
    let id: string;
    if (p.server !== undefined && p.server !== null) {
      const draft = parseDraft(p.server);
      let stored: McpServerDraft | undefined;
      try {
        stored = name ? this.find(cwd, name, scope, true).entry.server : undefined;
      } catch {
        stored = undefined;
      }
      server = unmaskDraft(draft, stored);
      id = `test:${name}`;
    } else {
      const r = this.find(cwd, name, scope);
      server = r.entry.server;
      id = r.id;
    }
    const o = this.simulate(server, id);
    return new Promise((resolve) => {
      this.env.clock.after(o.ms, () => resolve({ status: o.status, error: o.error, tools: o.tools, serverInfo: o.serverInfo, ms: o.ms }));
    });
  }

  private search(p: Record<string, unknown>): Promise<{ entries: McpRegistryEntry[] }> | { entries: McpRegistryEntry[] } {
    const query = typeof p.query === "string" ? p.query.trim().toLowerCase() : "";
    if (!query) return { entries: [] };
    const limit = Math.min(30, Math.max(1, typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 12));
    const words = query.split(/\s+/).filter(Boolean);
    const entries = REGISTRY.filter((e) => {
      const text = `${e.id} ${e.name} ${e.title} ${e.description ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, limit);
    return new Promise((resolve) => {
      this.env.clock.after(900 + Math.min(900, query.length * 60), () => resolve({ entries: structuredClone(entries) }));
    });
  }

  // ---------------------------------------------------------------- what a connection does

  /** What connecting `server` gives, the way omp would report it on the demo host. */
  private simulate(server: McpServerDraft, id: string): Outcome {
    const starts = (this.starts.get(id) ?? 0) + 1;
    this.starts.set(id, starts);
    if (server.transport === "stdio") {
      const command = (server.command ?? "").trim();
      const base = command.split("/").pop() ?? command;
      if (base === "uvx" || base === "uv") return { status: "failed", error: `spawn ${base} ENOENT: ${base} is not installed on this host (no such file in PATH)`, tools: [], ms: 240 };
      if (base === "bun" && server.args.join(" ") === "run scripts/docs-mcp.ts") return { status: "connected", tools: TOOLS.docs, serverInfo: { name: "teleflock-docs", version: "0.1.0" }, ms: 380 };
      if (base === "npx" || base === "bunx") {
        const args = server.args.filter((a) => a !== "-y" && a !== "--yes");
        const pkg = args[0] ?? "";
        if (pkg === "@smithery/cli") return this.smithery(server.args);
        const known = NPM_PACKAGES[pkg.replace(/@latest$/, "")];
        if (!known) return { status: "failed", error: `npm error 404 Not Found - GET https://registry.npmjs.org/${encodeURIComponent(pkg).replace("%40", "@")} - Not found`, tools: [], ms: 1600 };
        if (pkg === "@modelcontextprotocol/server-filesystem" && args.length < 2) {
          return { status: "failed", error: "MCP error -32000: Connection closed (the server exited: mcp-server-filesystem needs at least one folder to allow)", tools: [], ms: 1900 };
        }
        // A first start downloads the package: it can still be starting when the check ends.
        if (pkg === "@modelcontextprotocol/server-sequential-thinking" && starts === 1) return { status: "pending", tools: [], ms: 2400 };
        return { status: "connected", tools: known.tools, serverInfo: known.info, ms: 1700 + (hashOf(id) % 600) };
      }
      return { status: "failed", error: `spawn ${command || "''"} ENOENT`, tools: [], ms: 120 };
    }
    let u: URL;
    try {
      u = new URL(server.url ?? "");
    } catch {
      return { status: "failed", error: `invalid URL: ${server.url ?? ""}`, tools: [], ms: 20 };
    }
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return { status: "failed", error: `fetch failed: connect ECONNREFUSED 127.0.0.1:${u.port || (u.protocol === "https:" ? 443 : 80)}`, tools: [], ms: 60 };
    const open = OPEN_HOSTS[u.host];
    if (open) return { status: "connected", tools: open.tools, serverInfo: open.info, ms: 700 + (hashOf(id) % 500) };
    const oauth = OAUTH_HOSTS[u.host];
    if (oauth) {
      const bearer = server.headers.find((h) => h.key.toLowerCase() === "authorization")?.value ?? "";
      const token = bearer.replace(/^Bearer\s+/i, "");
      const signed = this.signedIn.has(server.url ?? "");
      if (signed || (u.host === "api.githubcopilot.com" && /^(ghp_|github_pat_)\w{8,}/.test(token))) return { status: "connected", tools: oauth.tools, serverInfo: oauth.info, ms: 900 + (hashOf(id) % 500) };
      const why = bearer ? "Token is not authorized" : u.host === "api.githubcopilot.com" ? "No access token was provided in this request" : "the server asks for an OAuth sign-in";
      return { status: "needsAuth", error: `401 Unauthorized from ${u.host}: ${why}`, tools: [], ms: 650 };
    }
    if (u.host === "server.smithery.ai") {
      const entry = REGISTRY.find((e) => e.server.url === `${u.origin}${u.pathname}`);
      if (entry && this.signedIn.has(server.url ?? "")) return { status: "connected", tools: entry.tools, serverInfo: { name: entry.title, version: "1.0.0" }, ms: 1100 };
      if (entry) return { status: "needsAuth", error: "401 Unauthorized from server.smithery.ai: sign in to Smithery to use this server", tools: [], ms: 700 };
    }
    return { status: "failed", error: `fetch failed: getaddrinfo ENOTFOUND ${u.hostname}`, tools: [], ms: 300 };
  }

  /** `bunx -y @smithery/cli run <id> --config <json>`: runs when every required input is set. */
  private smithery(args: string[]): Outcome {
    const i = args.indexOf("run");
    const id = i >= 0 ? (args[i + 1] ?? "") : "";
    const entry = REGISTRY.find((e) => e.id === id);
    if (!entry) return { status: "failed", error: `Smithery: server ${id || "(none)"} not found in the registry`, tools: [], ms: 1400 };
    const c = args.indexOf("--config");
    let config: Record<string, unknown> = {};
    try {
      config = c >= 0 ? (JSON.parse(args[c + 1] ?? "{}") as Record<string, unknown>) : {};
    } catch {
      return { status: "failed", error: "Smithery: --config is not valid JSON", tools: [], ms: 900 };
    }
    const missing = entry.inputs.filter((x) => x.required && (config[x.key] === undefined || config[x.key] === ""));
    if (missing.length) return { status: "failed", error: `Smithery: missing required config ${missing.map((m) => m.key).join(", ")}`, tools: [], ms: 1500 };
    return { status: "connected", tools: entry.tools, serverInfo: { name: entry.title, version: "1.0.0" }, ms: 2100 };
  }
}

// ---------------------------------------------------------------- validation and secrets

/** hostd's `validate_name` (omp's `validateServerName`), messages included. */
function validateName(name: string): string | undefined {
  if (!name) return "name: enter a name";
  if (name.length > 100) return "name: at most 100 characters";
  if (!NAME_RE.test(name)) return "name: letters, digits, `-`, `_`, `.`, `:` and single spaces only";
  return undefined;
}

function kvList(v: unknown, what: string): McpKeyValue[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw apiError("invalid_params", `${what} must be a list`);
  return v.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return { key: String(o.key ?? "").trim(), value: String(o.value ?? ""), secret: o.secret === true };
  });
}

/** hostd's checks of env / header rows (`secrets.rs`), messages included. */
function checkKeys(list: readonly McpKeyValue[], what: "env" | "headers"): void {
  const seen = new Set<string>();
  for (const { key, value } of list) {
    if (!key) throw apiError("invalid_params", `${what}: a value has no name`);
    if (what === "headers" && !HEADER_NAME.test(key)) throw apiError("invalid_params", `headers: \`${key}\` is not a valid header name`);
    const k = what === "headers" ? key.toLowerCase() : key;
    if (seen.has(k)) throw apiError("invalid_params", `${what}: \`${key}\` is set twice`);
    seen.add(k);
    if (what === "headers" && /[\r\n]/.test(value)) throw apiError("invalid_params", `headers: \`${key}\` has a line break in its value`);
  }
}

/** A draft as hostd reads it, checked the way omp's `validateServerConfig` and hostd do (messages name the field). */
function parseDraft(v: unknown): McpServerDraft {
  const o = (v ?? {}) as Record<string, unknown>;
  const transport = o.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") throw apiError("invalid_params", `transport: \`${String(transport)}\` is not stdio, http or sse`);
  const args = Array.isArray(o.args) ? o.args.map(String) : [];
  const env = kvList(o.env, "env");
  const headers = kvList(o.headers, "headers");
  const command = typeof o.command === "string" ? o.command.trim() : "";
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (transport === "stdio") {
    if (!command) throw apiError("invalid_params", "command: enter the program to start");
    if (/[\n\r]/.test(command)) throw apiError("invalid_params", "command: one line only");
    checkKeys(env, "env");
  } else {
    if (!url) throw apiError("invalid_params", "url: enter the server's address");
    if (!/^https?:\/\/[^/\s?#]+/i.test(url) || /\s/.test(url)) throw apiError("invalid_params", "url: an http:// or https:// address");
    checkKeys(headers, "headers");
  }
  const timeout = o.timeoutMs;
  if (timeout !== undefined && timeout !== null && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0)) throw apiError("invalid_params", "timeout: a whole number of milliseconds");
  const oauth = (o.oauth ?? undefined) as McpServerDraft["oauth"];
  if (oauth?.callbackPort !== undefined && (!Number.isInteger(oauth.callbackPort) || oauth.callbackPort < 1 || oauth.callbackPort > 65535)) throw apiError("invalid_params", "oauth.callbackPort: 1–65535");
  if (oauth?.redirectUri && !/^https?:\/\//.test(oauth.redirectUri.trim())) throw apiError("invalid_params", "oauth.redirectUri: an http:// or https:// address");
  const draft: McpServerDraft =
    transport === "stdio"
      ? { transport, command, args, cwd: typeof o.cwd === "string" && o.cwd.trim() ? o.cwd.trim() : undefined, env, headers: [] }
      : { transport, url, args: [], env: [], headers };
  if (typeof timeout === "number") draft.timeoutMs = timeout;
  if (oauth && transport !== "stdio" && Object.values(oauth).some((x) => x !== undefined && x !== "")) draft.oauth = { ...oauth };
  return draft;
}

function skipNote(server: McpServerDraft, name: string): string | undefined {
  const text = `${name} ${server.command ?? ""} ${server.args.join(" ")} ${server.url ?? ""}`.toLowerCase();
  if (/mcp\.exa\.ai/.test(text)) return "omp's built-in web search uses Exa already, so it doesn't load this server.";
  if (/(^|[\s/@])(playwright|puppeteer|browserbase)([\s/@-]|$)|@playwright\/mcp|server-puppeteer/.test(text)) return "omp's built-in browser tool replaces browser automation servers.";
  return undefined;
}

const SECRET_FLAG = /^(--?[\w.-]*)(=(.*))?$/s;

function maskArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const m = SECRET_FLAG.exec(a);
    const prev = i > 0 ? (args[i - 1] as string) : "";
    const pm = SECRET_FLAG.exec(prev);
    if (m && m[2] !== undefined && secretName(m[1] ?? "")) out.push(`${m[1]}=${DEMO_SECRET_MASK}`);
    else if (pm && pm[2] === undefined && secretName(pm[1] ?? "") && !a.startsWith("-")) out.push(DEMO_SECRET_MASK);
    else if (a.trim().startsWith("{")) out.push(maskJson(a));
    else out.push(a);
  }
  return out;
}

function maskJson(a: string): string {
  try {
    const o = JSON.parse(a) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return a;
    const m: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) m[k] = typeof v === "string" && v !== "" && secretName(k) ? DEMO_SECRET_MASK : v;
    return JSON.stringify(m);
  } catch {
    return a;
  }
}

function maskUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    if (u.password) {
      u.password = "MASKED_PW";
      changed = true;
    }
    for (const [k, v] of [...u.searchParams]) {
      if (v && secretName(k)) {
        u.searchParams.set(k, "MASKED_QV");
        changed = true;
      }
    }
    return changed ? u.toString().replace(/MASKED_PW|MASKED_QV/g, DEMO_SECRET_MASK) : url;
  } catch {
    return url;
  }
}

/** The definition as listed: credentials replaced by the mask. */
function maskDraft(d: McpServerDraft): McpServerDraft {
  const kv = (x: McpKeyValue): McpKeyValue => (secretName(x.key) && x.value !== "" ? { key: x.key, value: DEMO_SECRET_MASK, secret: true } : { key: x.key, value: x.value, secret: false });
  const out: McpServerDraft = { ...structuredClone(d), args: maskArgs(d.args), env: d.env.map(kv), headers: d.headers.map(kv), url: maskUrl(d.url) };
  if (d.oauth) out.oauth = { ...d.oauth, clientSecret: d.oauth.clientSecret ? DEMO_SECRET_MASK : undefined };
  if (out.url === undefined) delete out.url;
  return out;
}

function masked(what: string, hint = "Its saved value is hidden and belongs to another name."): never {
  throw apiError("invalid_params", what, { hint });
}

/** The mask in `d` replaced by the stored values of `old` (`tf_proto::mcp` keep-on-mask). */
function unmaskDraft(d: McpServerDraft, old: McpServerDraft | undefined): McpServerDraft {
  const out = structuredClone(d);
  const kvs = (list: McpKeyValue[], prev: McpKeyValue[] | undefined, what: string, fold: boolean) =>
    list.map((x) => {
      if (x.value !== DEMO_SECRET_MASK) return x;
      const hit = prev?.find((y) => (fold ? y.key.toLowerCase() === x.key.toLowerCase() : y.key === x.key));
      if (!hit) masked(`${what}: enter the value of \`${x.key}\` again`);
      return { ...x, value: hit.value };
    });
  out.env = kvs(out.env, old?.env, "env", false);
  out.headers = kvs(out.headers, old?.headers, "headers", true);
  out.args = out.args.map((a, i) => unmaskArg(a, i, out.args, old?.args ?? []));
  if (out.url?.includes(DEMO_SECRET_MASK)) out.url = unmaskUrl(out.url, old?.url);
  if (out.oauth?.clientSecret === DEMO_SECRET_MASK) {
    if (!old?.oauth?.clientSecret) masked("oauth.clientSecret: enter the client secret again", "Its saved value is hidden.");
    out.oauth.clientSecret = old.oauth.clientSecret;
  }
  return out;
}

function unmaskArg(a: string, i: number, args: readonly string[], old: readonly string[]): string {
  if (!a.includes(DEMO_SECRET_MASK)) return a;
  const m = SECRET_FLAG.exec(a);
  if (m && m[3] === DEMO_SECRET_MASK) {
    const hit = old.find((x) => x.startsWith(`${m[1]}=`));
    if (!hit) masked(`arguments: enter the hidden value of argument ${i + 1} again`, "Its saved value is hidden.");
    return hit;
  }
  if (a === DEMO_SECRET_MASK) {
    const flag = args[i - 1] ?? "";
    const j = old.indexOf(flag);
    if (j < 0 || j + 1 >= old.length) masked(`arguments: enter the hidden value of argument ${i + 1} again`, "Its saved value is hidden.");
    return old[j + 1] as string;
  }
  if (a.trim().startsWith("{")) {
    try {
      const o = JSON.parse(a) as Record<string, unknown>;
      const prevArg = old.find((x, k) => x.trim().startsWith("{") && (k === i || old[k - 1] === args[i - 1]));
      const prev = prevArg ? (JSON.parse(prevArg) as Record<string, unknown>) : {};
      for (const [k, v] of Object.entries(o)) {
        if (v !== DEMO_SECRET_MASK) continue;
        if (typeof prev[k] !== "string") masked(`arguments: enter the hidden value of argument ${i + 1} again`, "Its saved value is hidden.");
        o[k] = prev[k];
      }
      return JSON.stringify(o);
    } catch {
      return a;
    }
  }
  return a;
}

function unmaskUrl(url: string, old: string | undefined): string {
  try {
    const u = new URL(url.split(DEMO_SECRET_MASK).join("MASKED"));
    const o = old ? new URL(old) : undefined;
    if (u.password === "MASKED") {
      if (!o?.password) masked("url: enter the hidden part of the address again", "Its saved value doesn't match this address.");
      u.password = o.password;
    }
    for (const [k, v] of [...u.searchParams]) {
      if (v !== "MASKED") continue;
      const prev = o?.searchParams.get(k);
      if (!prev) masked("url: enter the hidden part of the address again", "Its saved value doesn't match this address.");
      u.searchParams.set(k, prev);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
