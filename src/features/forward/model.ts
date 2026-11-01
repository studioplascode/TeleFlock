import type { ForwardRule, ForwardState, ForwardStatus } from "@/core/gen";
import type { Status } from "@/design";

/*
 * What the Forwarding page says: the commands to copy for a rule, the paragraph to give an agent, the
 * status wording and the byte counters. Pure, so the exact strings are tested.
 */

/** The tool the editor suggests: a headed browser on the to-host is what forwarding was asked for. */
export const SUGGESTED_TOOL = "agent-browser";

/** The port a headed Chrome's DevTools listens on; the usage hint for a port pairs it with agent-browser. */
const CDP_PORT = 9222;

export interface RuleHosts {
  fromName: string;
  toName: string;
  /** The from-host is Windows: its tool shims are `.cmd` files, PATH is set the cmd.exe way and agents call them by name. */
  fromWindows: boolean;
}

export interface PortUsage {
  listen: number;
  target: number;
  /** What is true for a process on the from-host. */
  meaning: string;
  /** A command that uses it. */
  example: string;
}

export interface Snippets {
  /** `tf-forward <name> -- <command>`; null when the rule has no shell. */
  run: string | null;
  /** `tf-forward <name>`: an interactive shell on the to-host; null when the rule has no shell. */
  shell: string | null;
  /**
   * Puts the shim directory (tool shims and `tf-forward`) first on PATH for a shell started by hand; null when the
   * rule has neither a shell nor tools.
   */
  pathLine: string | null;
  /** `tf-forward` by its full path, for a hand-started shell without the PATH line; null without a shell or on Windows. */
  tfForwardPath: string | null;
  /** The tools by name, as they are called on the from-host. */
  tools: string[];
  ports: PortUsage[];
  /** One paragraph to paste into an agent's prompt or AGENTS.md. */
  instruction: string;
}

/** Version `v` is older than `min` (both `major.minor.patch`; a pre-release suffix is ignored; unparsable: false). */
export function olderThan(v: string | undefined, min: string): boolean {
  const parse = (s: string) => s.split("-")[0]?.split(".").map((n) => Number.parseInt(n, 10)) ?? [];
  if (!v) return false;
  const a = parse(v);
  const b = parse(min);
  if (a.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function quote(items: readonly string[]): string {
  return items.map((t) => `\`${t}\``).join(", ");
}

/** The hand-started shell's PATH line, in the from-host's shell dialect. */
export function pathLine(windows: boolean): string {
  return windows ? 'set "PATH=%USERPROFILE%\\.teleflock\\forward\\bin;%PATH%"' : 'export PATH="$HOME/.teleflock/forward/bin:$PATH"';
}

function portUsage(rule: ForwardRule, h: RuleHosts): PortUsage[] {
  return rule.ports.map(({ listen, target }) => {
    const browser = rule.tools.includes(SUGGESTED_TOOL) || listen === CDP_PORT || target === CDP_PORT;
    return {
      listen,
      target,
      meaning: `127.0.0.1:${listen} on ${h.fromName} reaches 127.0.0.1:${target} on ${h.toName}`,
      example: browser ? `${SUGGESTED_TOOL} --cdp ${listen}` : `curl http://127.0.0.1:${listen}`,
    };
  });
}

/**
 * `tf-forward` and the tool shims on a Unix from-host (the default tf-hostd home). omp's bash tool runs commands
 * with the PATH `~/.bashrc` leaves (its shell snapshot), so an rc that sets PATH outright drops the directory the
 * bridge put first (architecture §3.30); the agent's paragraph names them by this path, which holds anyway.
 */
const UNIX_SHIMS = "~/.teleflock/forward/bin";

/**
 * The agent's paragraph: only what the rule really offers, in the words an agent can act on. A Windows from-host
 * keeps the plain names: omp reads no rc there, so the bridge's PATH entry holds.
 */
export function agentInstruction(rule: ForwardRule, h: RuleHosts): string {
  const parts: string[] = [];
  const tfForward = h.fromWindows ? "tf-forward" : `${UNIX_SHIMS}/tf-forward`;
  if (rule.shell) {
    parts.push(`Run commands on my ${h.toName} with \`${tfForward} ${rule.name} -- <command>\`; \`${tfForward} ${rule.name}\` alone opens a shell there.`);
  }
  if (rule.tools.length > 0) {
    const one = rule.tools.length === 1;
    let tools = `${quote(rule.tools)} already run${one ? "s" : ""} on my ${h.toName} when called by ${one ? "its" : "their"} usual name`;
    if (!h.fromWindows) {
      tools += one ? `; if your shell cannot find it, it is \`${UNIX_SHIMS}/${rule.tools[0]}\`` : `; if your shell cannot find them, they are in \`${UNIX_SHIMS}/\``;
    }
    parts.push(`${tools}.`);
  }
  if (rule.tools.includes(SUGGESTED_TOOL)) parts.push("The browser there is headed: I can watch what you do.");
  const ports = portUsage(rule, h);
  if (ports.length > 0) {
    parts.push(`${ports.map((p) => `127.0.0.1:${p.listen} here is 127.0.0.1:${p.target} on ${h.toName}`).join("; ")}.`);
  }
  return parts.join(" ");
}

export function buildSnippets(rule: ForwardRule, h: RuleHosts): Snippets {
  return {
    run: rule.shell ? `tf-forward ${rule.name} -- <command>` : null,
    shell: rule.shell ? `tf-forward ${rule.name}` : null,
    pathLine: rule.shell || rule.tools.length > 0 ? pathLine(h.fromWindows) : null,
    tfForwardPath: rule.shell && !h.fromWindows ? `${UNIX_SHIMS}/tf-forward` : null,
    tools: rule.tools,
    ports: portUsage(rule, h),
    instruction: agentInstruction(rule, h),
  };
}

export interface StatusLook {
  label: string;
  tone: Status;
}

const LOOKS: Record<ForwardState, StatusLook> = {
  ready: { label: "Ready", tone: "done" },
  waiting: { label: "Waiting", tone: "idle" },
  unsupported: { label: "Update needed", tone: "review" },
  disabled: { label: "Off", tone: "idle" },
  error: { label: "Error", tone: "error" },
};

/** The status chip's word and tint; a rule the core has not reported on yet reads as waiting. */
export function statusLook(status: ForwardStatus | undefined): StatusLook {
  return status ? LOOKS[status.state] : LOOKS.waiting;
}

/**
 * Programs the from-host's own software (and omp's) call by name. The shim directory leads PATH for every
 * TeleFlock-started agent, so forwarding one of these makes the agent's own uses of it run on the to-host.
 */
const COMMON_PROGRAMS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "fish", "dash", "env", "ls", "cat", "cp", "mv", "rm", "mkdir", "sed", "awk", "find", "xargs", "tar", "sort",
  "git", "gh", "rg", "grep", "fd", "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3", "pip", "pip3", "uv",
  "curl", "wget", "ssh", "scp", "make", "cargo", "rustc", "go", "java", "ruby", "perl", "docker", "omp", "herdr",
]);

/** The tools in `tools` that shadow a common program on the from-host, in the order given. */
export function shadowedTools(tools: readonly string[]): string[] {
  return tools.filter((t) => COMMON_PROGRAMS.has(t.toLowerCase()));
}
