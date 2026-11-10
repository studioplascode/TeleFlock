/**
 * One of omp's quick commands: `!cmd` runs a shell command in the session's directory and adds its
 * output to the agent's context, `!!cmd` keeps the output out of it; `$ code` and `$$ code` do the
 * same with Python in omp's eval kernel. The composer sends them with `agent.shell`; the demo host
 * runs them as omp would.
 */
export interface QuickCommand {
  prefix: "!" | "!!" | "$" | "$$";
  /** `$` / `$$`: Python; else a shell command. */
  python: boolean;
  /** `!!` / `$$`: the output stays out of the agent's context. */
  excluded: boolean;
  /** The command or code after the prefix, trimmed: what omp runs and records. */
  body: string;
}

// omp 18.18's guard for `$` (input-controller.ts): code whose first line reads like a shell command,
// or that holds a pasted stats line, is a message, not Python.
const SHELL_START =
  /^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_OPERATOR = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const STATS_LINE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

function looksLikeShell(code: string): boolean {
  const first = code.split("\n", 1)[0]?.trimStart() ?? "";
  return SHELL_START.test(first) || SHELL_OPERATOR.test(first) || STATS_LINE.test(code);
}

/**
 * The quick command `draft` is, read the way omp's composer reads its text on Enter (trimmed): `!`
 * or `!!` and a command; `$` or `$$`, whitespace and code, except a `$` whose code reads like a
 * shell command (`$ git status`, `$ ls | wc -l`). Nothing after the prefix: an ordinary message
 * (null), as is anything else.
 */
export function quickCommand(draft: string): QuickCommand | null {
  const text = draft.trim();
  if (text.startsWith("!")) {
    const excluded = text.startsWith("!!");
    const body = text.slice(excluded ? 2 : 1).trim();
    return body ? { prefix: excluded ? "!!" : "!", python: false, excluded, body } : null;
  }
  if (!text.startsWith("$")) return null;
  const n = text[1] === "$" ? 2 : 1;
  if (!/[ \t\n\r]/.test(text[n] ?? "")) return null;
  const body = text.slice(n).trim();
  if (!body || (n === 1 && looksLikeShell(body))) return null;
  return { prefix: n === 2 ? "$$" : "$", python: true, excluded: n === 2, body };
}
