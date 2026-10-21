/**
 * omp's builtin slash commands (omp 18.12 `slash-commands/builtin-*.ts`; `docs/research/omp.md` §1.3),
 * with how TeleFlock runs each one remotely. hostd keeps the same name list in
 * `crates/tf-hostd/src/inject.rs` (`CATALOG`): keep them in sync.
 *
 * Modes:
 * - `direct`: injected through `agent.slash`; the effect shows up in the session (transcript, state).
 * - `report`: injected through `agent.slash`; omp prints the result in its TUI only, so the client
 *   opens the agent's terminal to show it.
 * - `terminal`: opens a TUI selector, panel or dashboard; the client opens the terminal next to the
 *   session and runs the command there, so the user continues in the real TUI.
 */
export type OmpCommandMode = "direct" | "report" | "terminal";

export interface OmpSubcommand {
  name: string;
  /** Argument hint after the subcommand, e.g. `<id>|all`. */
  args?: string;
  description: string;
  /** Overrides the command's mode for this subcommand. */
  mode?: OmpCommandMode;
}

export interface OmpCommand {
  name: string;
  aliases?: string[];
  /** Argument hint, e.g. `[on|off|status]`. */
  args?: string;
  description: string;
  /** Mode with arguments (and without, unless `bare` says otherwise). */
  mode: OmpCommandMode;
  /** Mode when run without arguments. */
  bare?: OmpCommandMode;
  /** Refuse to run without arguments (omp would only print usage). */
  needsArgs?: boolean;
  /** Destructive or disruptive: ask before running. */
  confirm?: string;
  subs?: OmpSubcommand[];
  group: "Modes" | "Session" | "Context" | "Tools" | "Info" | "Setup" | "App";
}

const ON_OFF_STATUS = (what: string): OmpSubcommand[] => [
  { name: "on", description: `Enable ${what}` },
  { name: "off", description: `Disable ${what}` },
  { name: "status", description: `Show ${what} status`, mode: "report" },
];

export const OMP_COMMANDS: OmpCommand[] = [
  // ── modes and model ──
  { name: "model", aliases: ["models"], description: "Open the model hub (role models)", mode: "terminal", group: "Modes" },
  { name: "switch", args: "[provider/id[:level] | @role]", description: "Switch model for this session", mode: "direct", bare: "terminal", group: "Modes" },
  {
    name: "effort",
    args: "[off|minimal|low|medium|high|xhigh|max|auto]",
    description: "Set the thinking level",
    mode: "direct",
    bare: "terminal",
    group: "Modes",
    subs: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].map((l) => ({ name: l, description: `Thinking ${l}` })),
  },
  {
    name: "fast",
    args: "[on|ultra|off|status]",
    description: "Toggle fast mode (priority service tier)",
    mode: "direct",
    group: "Modes",
    subs: [
      { name: "on", description: "Enable fast mode (priority tier)" },
      { name: "ultra", description: "Enable Ultrafast (OpenAI API, or Codex models that offer it)" },
      { name: "off", description: "Disable fast mode" },
      { name: "status", description: "Show fast mode status", mode: "report" },
    ],
  },
  {
    name: "slow",
    args: "[on|off|status]",
    description: "Flex / low-priority service tier",
    mode: "direct",
    group: "Modes",
    subs: [
      { name: "on", description: "Flex tier, or Anthropic low priority at the session limit" },
      { name: "off", description: "Standard service" },
      { name: "status", description: "Show slow mode status", mode: "report" },
    ],
  },
  { name: "plan", args: "[prompt]", description: "Toggle plan mode (plan before executing)", mode: "direct", group: "Modes" },
  { name: "plan-review", description: "Re-open the review of the latest plan", mode: "terminal", group: "Modes" },
  {
    name: "goal",
    args: "[objective | set | show | pause | resume | drop | budget <N|off>]",
    description: "Persistent autonomous objective",
    mode: "direct",
    bare: "terminal",
    group: "Modes",
    subs: [
      { name: "set", args: "<objective>", description: "Set or replace the goal" },
      { name: "show", description: "Show current goal details", mode: "report" },
      { name: "pause", description: "Pause the current goal" },
      { name: "resume", description: "Resume a paused goal" },
      { name: "drop", description: "Drop the current goal" },
      { name: "budget", args: "<N|off>", description: "Adjust the token budget" },
    ],
  },
  { name: "guided-goal", args: "[rough objective]", description: "Interview in chat, then set up goal mode", mode: "direct", group: "Modes" },
  { name: "vibe", args: "[prompt]", description: "Toggle vibe mode (director with worker sessions)", mode: "direct", group: "Modes" },
  { name: "loop", args: "[count|duration] [--while|--until '<cmd>'] [prompt]", description: "Re-submit a prompt after every yield", mode: "direct", group: "Modes" },
  { name: "queue", args: "<message>", description: "Queue a message for after the agent yields", mode: "direct", needsArgs: true, group: "Modes" },
  { name: "skillful", args: "[on|off|status]", description: "List available skills in the system prompt", mode: "direct", subs: ON_OFF_STATUS("the skills listing"), group: "Modes" },
  { name: "extended-context", args: "[on|off|status]", description: "Toggle extended context windows", mode: "direct", subs: ON_OFF_STATUS("extended context"), group: "Modes" },
  { name: "computer", args: "[on|off|status]", description: "Toggle native computer use for this session", mode: "direct", subs: ON_OFF_STATUS("computer use"), group: "Modes" },
  {
    name: "prewalk",
    args: "[restart|off]",
    description: "Arm a one-shot handoff to @smol at the first edit",
    mode: "direct",
    group: "Modes",
    subs: [
      { name: "restart", description: "Return to @default and re-arm the handoff" },
      { name: "off", description: "Cancel this session's handoff" },
    ],
  },
  {
    name: "modelpreset",
    args: "[list|save|switch|delete] [name]",
    description: "Save and switch model presets (role models + thinking)",
    mode: "direct",
    bare: "terminal",
    group: "Modes",
    subs: [
      { name: "list", description: "List saved presets", mode: "report" },
      { name: "save", args: "<name>", description: "Save the current role models and thinking level" },
      { name: "switch", args: "<name>", description: "Apply a saved preset" },
      { name: "delete", args: "<name>", description: "Delete a saved preset" },
    ],
  },
  { name: "ratchet", args: "[flow and goal]", description: "Build an eval for an LLM flow, then hill-climb it", mode: "direct", group: "Modes" },
  {
    name: "advisor",
    args: "[on|off|status|dump [raw]|configure]",
    description: "Advisor: a second model that reviews each turn",
    mode: "direct",
    group: "Modes",
    subs: [
      { name: "on", description: "Enable the advisor" },
      { name: "off", description: "Disable the advisor" },
      { name: "status", description: "Show advisor status", mode: "report" },
      { name: "dump", args: "[raw]", description: "Copy the advisor transcript to the host clipboard", mode: "report" },
      { name: "configure", description: "Open the advisor configuration editor", mode: "terminal" },
    ],
  },
  { name: "force", aliases: ["force:"], args: "<tool> [prompt]", description: "Force the next turn to use a tool", mode: "direct", needsArgs: true, group: "Modes" },

  // ── session ──
  { name: "new", description: "Start a new session", mode: "direct", group: "Session" },
  { name: "resume", args: "[session id | @claude | @codex]", description: "Resume a different session in this omp", mode: "direct", bare: "terminal", group: "Session" },
  {
    name: "fork",
    args: "[pane|window|tab]",
    description: "Fork the session (in place, or in a new pane / window)",
    mode: "direct",
    group: "Session",
    subs: [
      { name: "pane", description: "Open the fork in a new herdr pane" },
      { name: "window", description: "Open the fork in a new herdr tab" },
      { name: "tab", description: "Alias for window" },
    ],
  },
  { name: "branch", aliases: ["rewind"], description: "Rewind to a previous message (keeps the old path)", mode: "terminal", group: "Session" },
  { name: "tree", description: "Navigate the session tree (switch branches)", mode: "terminal", group: "Session" },
  { name: "rename", args: "[title]", description: "Rename the session (no title: generate one)", mode: "direct", group: "Session" },
  { name: "pin", args: "[session id]", description: "Pin or unpin a session in the resume list", mode: "direct", group: "Session" },
  { name: "seance", args: "[id|path] [--model <sel>]", description: "Consult a saved session", mode: "direct", bare: "terminal", group: "Session" },
  { name: "btw", args: "[question]", description: "Side question that doesn't touch the session", mode: "direct", bare: "terminal", group: "Session" },
  { name: "tan", args: "<work>", description: "Run a background agent on tangential work", mode: "direct", needsArgs: true, group: "Session" },
  { name: "export", args: "[--themes] [path]", description: "Export the session to HTML on the host", mode: "report", group: "Session" },
  {
    name: "dump",
    args: "[all|anon]",
    description: "Transcript dump (host clipboard, or a zip in tmp)",
    mode: "report",
    group: "Session",
    subs: [
      { name: "all", description: "Zip of transcript, LLM request JSON and subagents" },
      { name: "anon", description: "Zip of the anonymized session JSONL plus subagents" },
    ],
  },
  { name: "share", description: "Share via an encrypted link", mode: "report", group: "Session" },
  { name: "copy", args: "[code|cmd|link]", description: "Copy text or code to the host clipboard", mode: "terminal", group: "Session" },
  { name: "open", args: "[link]", description: "Open the last link in the host's browser", mode: "terminal", group: "Session" },
  {
    name: "session",
    args: "[info|delete|pin [account]]",
    description: "Session info and management",
    mode: "direct",
    bare: "report",
    group: "Session",
    subs: [
      { name: "info", description: "Show session info and stats", mode: "report" },
      { name: "delete", description: "Delete this session and return to the selector", mode: "terminal" },
      { name: "pin", args: "[account]", description: "Pin an OAuth account to this session's provider" },
    ],
  },
  { name: "delete", description: "Delete the current session and start a new one", mode: "direct", confirm: "Delete this session permanently?", group: "Session" },
  {
    name: "collab",
    args: "[start|view|list|stop|status] [relayUrl]",
    description: "Share this session live via a relay",
    mode: "report",
    group: "Session",
    subs: [
      { name: "view", description: "Share a read-only link" },
      { name: "list", description: "List active local collab hosts" },
      { name: "status", description: "Show link + participants" },
      { name: "stop", description: "Stop sharing (disconnects TeleFlock's live view)" },
    ],
  },
  { name: "join", args: "<link>", description: "Join a shared collab session in this omp", mode: "direct", needsArgs: true, group: "Session" },
  { name: "leave", description: "Leave the collab session", mode: "direct", group: "Session" },
  {
    name: "todo",
    args: "[append|start|done|drop|rm|edit|copy|export|import|expand|collapse]",
    description: "View or modify the todo list",
    mode: "direct",
    bare: "report",
    group: "Session",
    subs: [
      { name: "append", args: "[<phase>] <task…>", description: "Append a task (phase fuzzy-matched or created)" },
      { name: "start", args: "<task>", description: "Mark a task in progress" },
      { name: "done", args: "[<task|phase>]", description: "Mark task / phase / all completed" },
      { name: "drop", args: "[<task|phase>]", description: "Mark task / phase / all abandoned" },
      { name: "rm", args: "[<task|phase>]", description: "Remove task / phase / all" },
      { name: "edit", description: "Edit todos in $EDITOR on the host", mode: "terminal" },
      { name: "copy", description: "Copy todos as Markdown to the host clipboard" },
      { name: "export", args: "[<path>]", description: "Write todos as Markdown (default TODO.md)" },
      { name: "import", args: "[<path>]", description: "Replace todos from Markdown (default TODO.md)" },
      { name: "expand", description: "Show every phase and task in the TUI HUD" },
      { name: "collapse", description: "Restore the bounded HUD preview" },
    ],
  },

  // ── context ──
  {
    name: "compact",
    args: "[soft|remote|snapcompact] [focus]",
    description: "Compact the session context",
    mode: "direct",
    group: "Context",
    subs: [
      { name: "soft", args: "[focus]", description: "Soft compaction" },
      { name: "remote", args: "[focus]", description: "Provider-side compaction" },
      { name: "snapcompact", args: "[focus]", description: "Snapshot compaction" },
    ],
  },
  { name: "handoff", args: "[focus]", description: "Summarize into a handoff document and compact (idle only)", mode: "direct", group: "Context" },
  {
    name: "shake",
    args: "[elide|images|thinking]",
    description: "Drop heavy content from context",
    mode: "direct",
    group: "Context",
    subs: [
      { name: "elide", description: "Strip tool results + large blocks (default)" },
      { name: "images", description: "Strip image blocks" },
      { name: "thinking", description: "Drop all thinking blocks" },
    ],
  },
  { name: "clear", description: "Clear the conversation context in place", mode: "direct", confirm: "Clear the whole conversation context?", group: "Context" },
  { name: "fresh", description: "Reset provider stream state (transcript kept)", mode: "direct", group: "Context" },
  { name: "retry", description: "Retry the last failed turn", mode: "direct", group: "Context" },
  { name: "context", description: "Estimated context usage breakdown", mode: "report", group: "Context" },
  {
    name: "memory",
    args: "<view|stats|diagnose|queue|sync|clear|enqueue|mm …>",
    description: "Inspect and operate the memory backend",
    mode: "report",
    group: "Context",
    subs: [
      { name: "view", description: "Show the current memory injection payload" },
      { name: "stats", description: "Memory backend statistics" },
      { name: "diagnose", description: "Run memory backend diagnostics" },
      { name: "queue", description: "Pending memory deltas" },
      { name: "sync", description: "Run memory consolidation now" },
      { name: "clear", description: "Clear persisted memory data" },
      { name: "enqueue", description: "Enqueue consolidation maintenance" },
      { name: "mm", args: "<list|show|refresh|history|seed|delete|reload> [id]", description: "Mental models" },
    ],
  },
  { name: "forget-approvals", description: "Forget every remembered file/folder approval", mode: "direct", group: "Context" },
  { name: "move", args: "[<path>]", description: "Move this session to another directory", mode: "direct", bare: "terminal", group: "Context" },
  { name: "wt", aliases: ["worktree"], args: "[<branch>]", description: "Move this session into a new worktree", mode: "direct", group: "Context" },
  { name: "add-dir", args: "<path>", description: "Add a workspace directory (multi-root)", mode: "direct", needsArgs: true, group: "Context" },
  { name: "remove-dir", args: "<path>", description: "Remove a workspace directory", mode: "direct", needsArgs: true, group: "Context" },
  { name: "dirs", description: "List this session's workspace directories", mode: "report", group: "Context" },

  // ── tools and extensions ──
  {
    name: "jobs",
    args: "[full|kill <id>|kill all]",
    description: "Background jobs",
    mode: "report",
    group: "Tools",
    subs: [
      { name: "full", description: "Show full command lines" },
      { name: "kill", args: "<id>|all", description: "Cancel a background job", mode: "direct" },
    ],
  },
  { name: "tools", description: "Tools visible to the agent", mode: "report", group: "Tools" },
  {
    name: "skills",
    args: "<search|install|installed|update>",
    description: "Skill registry (skills.omp.sh)",
    mode: "report",
    needsArgs: true,
    group: "Tools",
    subs: [
      { name: "search", args: "<query>", description: "Search the skill registry" },
      { name: "install", args: "<@scope/name[@range]>… [--global]", description: "Install registry skills" },
      { name: "installed", description: "List installed registry skills" },
      { name: "update", args: "[@scope/name…] [--global]", description: "Update registry skills" },
    ],
  },
  {
    name: "mcp",
    args: "<list|add|remove|test|reauth|enable|disable|reload|resources|prompts|…>",
    description: "Manage MCP servers",
    mode: "report",
    needsArgs: true,
    group: "Tools",
    subs: [
      { name: "list", description: "List configured MCP servers" },
      { name: "add", args: "<name> [--scope project|user] [--url <url>] [-- <command…>]", description: "Add an MCP server" },
      { name: "remove", args: "<name> [--scope project|user]", description: "Remove an MCP server" },
      { name: "test", args: "<name>", description: "Test a server connection" },
      { name: "reauth", args: "<name>", description: "Reauthorize OAuth for a server", mode: "terminal" },
      { name: "unauth", args: "<name>", description: "Remove OAuth auth from a server" },
      { name: "enable", args: "<name>", description: "Enable a server" },
      { name: "disable", args: "<name>", description: "Disable a server" },
      { name: "reconnect", args: "<name>", description: "Reconnect a server" },
      { name: "reload", description: "Force reload MCP runtime tools" },
      { name: "resources", description: "Resources from connected servers" },
      { name: "prompts", description: "Prompts from connected servers" },
      { name: "notifications", description: "Notification capabilities and subscriptions" },
      { name: "smithery-search", args: "<keyword> [--scope project|user]", description: "Search Smithery and deploy a server" },
      { name: "smithery-login", description: "Log in to Smithery", mode: "terminal" },
      { name: "smithery-logout", description: "Remove the cached Smithery key" },
    ],
  },
  {
    name: "security",
    args: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
    description: "OMP-native security scans",
    mode: "report",
    group: "Tools",
    subs: [
      { name: "plan", description: "Create a security scan plan" },
      { name: "scan", description: "Start a planned or new scan" },
      { name: "status", description: "Scan operation status" },
      { name: "cancel", description: "Cancel a running scan" },
      { name: "scans", description: "List stored scans" },
      { name: "show", args: "<scan|resource>", description: "Render a scan or security:// resource" },
      { name: "import", args: "<file>", description: "Import SARIF or a Codex Security bundle" },
      { name: "export", args: "[…]", description: "Export a bundle, SARIF, or report" },
      { name: "validate", args: "<finding>", description: "Validate one finding" },
      { name: "compare", args: "<scan> <scan>", description: "Compare finding lineage across scans" },
      { name: "disposition", args: "<finding> <disposition> <rationale>", description: "Set a finding disposition" },
    ],
  },
  { name: "cleanse", args: "[request] [--all]", description: "Detect and fix project diagnostics with subagents", mode: "direct", group: "Tools" },
  { name: "omfg", args: "<complaint>", description: "Forge a rule from a complaint about recurring behavior", mode: "direct", needsArgs: true, group: "Tools" },
  {
    name: "browser",
    args: "[headless|visible]",
    description: "Browser eval prelude mode",
    mode: "direct",
    group: "Tools",
    subs: [
      { name: "headless", description: "Headless mode" },
      { name: "visible", description: "Visible mode (on the host's display)" },
    ],
  },
  {
    name: "ssh",
    args: "<add|list|remove>",
    description: "Manage SSH hosts for the agent",
    mode: "report",
    needsArgs: true,
    group: "Tools",
    subs: [
      { name: "add", args: "<name> --host <host> [--user <u>] [--port <p>] [--key <path>]", description: "Add an SSH host" },
      { name: "list", description: "List configured SSH hosts" },
      { name: "remove", args: "<name>", description: "Remove an SSH host" },
    ],
  },
  {
    name: "marketplace",
    args: "<add|remove|update|list|discover|install|uninstall|installed|upgrade>",
    description: "Marketplace plugin sources and plugins",
    mode: "report",
    bare: "terminal",
    group: "Tools",
    subs: [
      { name: "list", description: "List configured marketplaces" },
      { name: "add", args: "<source>", description: "Add a marketplace source" },
      { name: "remove", args: "<name>", description: "Remove a marketplace source" },
      { name: "update", args: "[name]", description: "Update marketplace catalogs" },
      { name: "discover", args: "[marketplace]", description: "Browse available plugins" },
      { name: "install", args: "[--force] <name@marketplace>", description: "Install a plugin" },
      { name: "uninstall", args: "<name@marketplace>", description: "Uninstall a plugin" },
      { name: "installed", description: "List installed plugins" },
      { name: "upgrade", args: "[name@marketplace]", description: "Upgrade outdated plugins" },
    ],
  },
  {
    name: "plugins",
    aliases: ["plugin"],
    args: "[list|enable|disable]",
    description: "Installed plugins",
    mode: "report",
    group: "Tools",
    subs: [
      { name: "list", description: "List installed plugins" },
      { name: "enable", args: "<plugin>", description: "Enable a plugin" },
      { name: "disable", args: "<plugin>", description: "Disable a plugin" },
    ],
  },
  { name: "reload-plugins", description: "Reload skills, commands, hooks, tools, agents, MCP", mode: "direct", group: "Tools" },

  // ── info and dashboards ──
  {
    name: "usage",
    args: "[show|reset [provider/credential]]",
    description: "Provider usage and rate limits",
    mode: "report",
    group: "Info",
    subs: [
      { name: "show", description: "Provider usage and limits" },
      { name: "reset", args: "[provider/credential-id|provider/active]", description: "Spend a saved rate-limit reset", mode: "direct" },
    ],
  },
  {
    name: "changelog",
    args: "[full|last [N]]",
    description: "omp changelog",
    mode: "report",
    group: "Info",
    subs: [
      { name: "full", description: "Complete changelog" },
      { name: "last", args: "[N]", description: "The last N releases" },
    ],
  },
  { name: "hotkeys", description: "omp TUI keyboard shortcuts", mode: "report", group: "Info" },
  { name: "stats", args: "[--port <port>] [--host <host>]", description: "Launch the stats dashboard on the host", mode: "report", group: "Info" },
  { name: "trace", description: "Open this session's trace in the stats dashboard", mode: "terminal", group: "Info" },
  { name: "agents", description: "Agents hub (per-agent model, prewalk, advisor)", mode: "terminal", group: "Info" },
  { name: "hub", description: "Live Agent Hub", mode: "terminal", group: "Info" },
  { name: "extensions", aliases: ["status"], description: "Extension Control Center", mode: "terminal", group: "Info" },
  { name: "debug", description: "Debug tools", mode: "terminal", group: "Info" },
  { name: "git", args: "[revision]", description: "omp's git UI (diff, staging, commit)", mode: "terminal", group: "Info" },

  // ── setup ──
  { name: "settings", description: "omp settings", mode: "terminal", group: "Setup" },
  { name: "setup", aliases: ["providers"], args: "[providers]", description: "Provider setup", mode: "terminal", group: "Setup" },
  { name: "login", args: "[provider|redirect URL]", description: "OAuth login (opens a browser on the host)", mode: "terminal", group: "Setup" },
  { name: "logout", args: "[provider]", description: "OAuth logout", mode: "direct", bare: "terminal", group: "Setup" },

  // ── app ──
  { name: "pause", description: "Freeze all agents until resumed in the terminal", mode: "terminal", group: "App" },
  { name: "live", description: "Realtime voice mode (host microphone)", mode: "terminal", group: "App" },
  { name: "record", description: "Record this screen to a replayable file", mode: "terminal", group: "App" },
  { name: "restart", description: "Restart omp with the same flags, resuming this session", mode: "direct", confirm: "Restart omp in this pane?", group: "App" },
  { name: "exit", aliases: ["quit", "q"], description: "Quit omp (the pane keeps its shell)", mode: "direct", confirm: "Quit omp in this pane?", group: "App" },
];

/** Every builtin name and alias (what hostd's `inject::CATALOG` accepts). */
export const OMP_COMMAND_NAMES: ReadonlySet<string> = new Set(OMP_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? []).map((a) => a.replace(/:$/, ""))]));

/** `/name args` → name (omp splits at the first whitespace or `:`; `/skill:<name>` keeps its prefix). */
export function ompCommandName(command: string): string {
  const body = command.trim().replace(/^\//, "");
  const skill = /^skill:\S+/.exec(body);
  if (skill) return skill[0];
  return body.split(/[\s:]/, 1)[0] ?? "";
}
