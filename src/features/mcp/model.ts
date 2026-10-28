/**
 * Pure helpers of the MCP servers page: secrets, names, the shell-like argument line, registry
 * inputs, the editor form ⇄ `McpServerDraft`, row summaries and status labels, reload notes.
 */
import type { McpKeyValue, McpList, McpOAuthSettings, McpReload, McpRegistryInput, McpScope, McpServer, McpServerDraft, McpStatus, McpTool, McpTransport, Workspace } from "@/core/gen";
import { basename, expandTilde, tildify } from "@/features/workspace/shared/paths";
import type { McpTemplateInput } from "./templates";

/** Stands in for a stored secret (`tf_proto::mcp::SECRET_MASK`): sent back unchanged in a draft, it keeps the stored value. */
export const SECRET_MASK = "••••••••";

const SECRET_NAME = /token|key|secret|password|passwd|auth|cookie|session|credential|private/i;

/** An env variable or header whose name says it holds a credential (new rows default to secret). */
export function looksSecret(key: string): boolean {
  return SECRET_NAME.test(key) || key.trim().toLowerCase() === "authorization";
}

// ---------------------------------------------------------------- names

/** omp's limit (`validateServerName`). */
export const NAME_MAX = 100;
const NAME_RE = /^[a-zA-Z0-9_.:-]+( [a-zA-Z0-9_.:-]+)*$/;

/** omp's check of a server name (`validateServerName`; hostd `validate_name`), phrased for the field. */
export function nameError(name: string): string | null {
  if (!name) return "Enter a name";
  if (name.length > NAME_MAX) return `At most ${NAME_MAX} characters`;
  if (!NAME_RE.test(name)) return "Letters, digits, - _ . : and single spaces only";
  return null;
}

/** omp accepts spaces and colons, but tools are named `mcp__<server>_<tool>`: plain slugs read best. */
export function nameAdvice(name: string): string | null {
  return /[ :]/.test(name) ? "Works, but a name without spaces or colons (like “my-server”) reads better in tool names." : null;
}

/** "Hugging Face" → "hugging-face". */
export function slugName(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "server"
  );
}

/** `base`, else `base-2`, `base-3`… not in `taken`. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

// ---------------------------------------------------------------- arguments

/** Characters the argument line gives a meaning to (whitespace aside). */
const LINE_SPECIAL = /[\s'"\\$]/;

/** One argument as the line writes it: plain, '…', or $'…' when it holds line breaks or tabs. */
export function quoteArg(arg: string): string {
  if (arg === "") return "''";
  if (!LINE_SPECIAL.test(arg)) return arg;
  if (/[\n\r\t]/.test(arg)) return `$'${arg.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function joinArgs(args: readonly string[]): string {
  return args.map(quoteArg).join(" ");
}

const ANSI_ESC: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };

/**
 * Splits the argument line the way a POSIX shell would for these cases: whitespace separates,
 * '…' is literal, "…" honours \" \\ \$, $'…' honours \n \r \t \\ \', and outside quotes a backslash
 * escapes whitespace, a quote, `$` or another backslash (else it stays, so `C:\x` survives).
 */
export function splitArgs(line: string): { args: string[]; error?: string } {
  const args: string[] = [];
  let cur = "";
  let inWord = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (/\s/.test(c)) {
      if (inWord) args.push(cur);
      cur = "";
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { args, error: "Unclosed ' in the arguments" };
      cur += line.slice(i + 1, end);
      i = end + 1;
    } else if (c === "$" && line[i + 1] === "'") {
      let j = i + 2;
      let closed = false;
      while (j < line.length) {
        const d = line[j] as string;
        if (d === "\\" && j + 1 < line.length) {
          const e = line[j + 1] as string;
          cur += ANSI_ESC[e] ?? `\\${e}`;
          j += 2;
        } else if (d === "'") {
          closed = true;
          j++;
          break;
        } else {
          cur += d;
          j++;
        }
      }
      if (!closed) return { args, error: "Unclosed $' in the arguments" };
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        const d = line[j] as string;
        if (d === "\\" && /["\\$`]/.test(line[j + 1] ?? "")) {
          cur += line[j + 1];
          j += 2;
        } else if (d === '"') {
          closed = true;
          j++;
          break;
        } else {
          cur += d;
          j++;
        }
      }
      if (!closed) return { args, error: 'Unclosed " in the arguments' };
      i = j;
    } else if (c === "\\" && i + 1 < line.length && /[\s'"\\$]/.test(line[i + 1] as string)) {
      cur += line[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (inWord) args.push(cur);
  return { args };
}

/** The line with argument `index` set to `value` (appended when the line is shorter). */
export function setArgAt(line: string, index: number, value: string): string {
  const { args, error } = splitArgs(line);
  if (error) return line;
  const next = [...args];
  if (index < next.length) next[index] = value;
  else next.push(value);
  return joinArgs(next);
}

/** The arguments with the JSON after `--config` replaced (appended with `--config` when absent). */
export function withConfigArg(args: readonly string[], json: string): string[] {
  const i = args.indexOf("--config");
  if (i < 0) return [...args, "--config", json];
  const next = [...args];
  if (i + 1 < next.length) next[i + 1] = json;
  else next.push(json);
  return next;
}

/** The JSON object a registry server's `--config` argument carries, typed per input kind (blank inputs left out). */
export function registryConfig(inputs: readonly McpRegistryInput[], values: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of inputs) {
    const raw = (values[input.key] ?? "").trim();
    if (input.kind === "boolean") {
      if (raw === "true" || raw === "false") out[input.key] = raw === "true";
    } else if (raw === "") {
      continue;
    } else if (input.kind === "number") {
      const n = Number(raw);
      out[input.key] = Number.isFinite(n) ? n : raw;
    } else {
      out[input.key] = raw;
    }
  }
  return out;
}

/** The starting values of registry inputs: their defaults (booleans as "true"/"false"). */
export function registryDefaults(inputs: readonly McpRegistryInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of inputs) out[input.key] = input.defaultValue ?? (input.kind === "boolean" ? "false" : "");
  return out;
}

/** A required registry input that is still blank, or a number input that isn't one. */
export function registryInputError(input: McpRegistryInput, value: string): string | null {
  const v = value.trim();
  if (input.required && v === "" && input.kind !== "boolean") return `${input.label} is required`;
  if (input.kind === "number" && v !== "" && !Number.isFinite(Number(v))) return `${input.label} must be a number`;
  return null;
}

// ---------------------------------------------------------------- summaries

/** `mcp.example.com/mcp` (no scheme, query or trailing slash). */
export function urlHostPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/** One line for the row: `command args…` or the URL's host and path. */
export function summarize(d: McpServerDraft): string {
  if (d.transport === "stdio") return [d.command ?? "", ...d.args.map(quoteArg)].join(" ").trim();
  return d.url ? urlHostPath(d.url) : "";
}

export type StatusTone = "ok" | "warn" | "error" | "busy" | "muted";

export const STATUS_META: Record<McpStatus, { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "ok" },
  needsAuth: { label: "Sign in needed", tone: "warn" },
  failed: { label: "Failed", tone: "error" },
  pending: { label: "Starting…", tone: "busy" },
  checking: { label: "Checking…", tone: "busy" },
  disabled: { label: "Off", tone: "muted" },
  skipped: { label: "Skipped", tone: "muted" },
  unknown: { label: "Not checked", tone: "muted" },
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Connected · 14 tools", "Sign in needed", … */
export function statusLabel(status: McpStatus, tools: number): string {
  return status === "connected" ? `Connected · ${plural(tools, "tool")}` : STATUS_META[status].label;
}

/** HTTP and SSE servers sign in with OAuth; stdio servers take their credentials from env / args. */
export function canSignIn(d: McpServerDraft): boolean {
  return d.transport !== "stdio";
}

/** Stable identity of a listed server (one name can appear in several origins). */
export function serverKey(s: Pick<McpServer, "origin" | "name">): string {
  return `${s.origin}:${s.name}`;
}

/** The definition `mcp.*` refs address: `user` / `project` for omp's files, absent for imported ones. */
export function scopeOf(s: Pick<McpServer, "origin">): McpScope | undefined {
  return s.origin === "imported" ? undefined : s.origin;
}

/** omp's servers (project and user files) and the ones it imports from other tools. */
export function groupServers(servers: readonly McpServer[]): { omp: McpServer[]; imported: McpServer[] } {
  return { omp: servers.filter((s) => s.origin !== "imported"), imported: servers.filter((s) => s.origin === "imported") };
}

/** Who hides a shadowed server: the same name in a file of higher precedence. */
export function shadowedBy(s: McpServer, servers: readonly McpServer[]): string | null {
  if (!s.shadowed) return null;
  const w = servers.find((x) => x.name === s.name && !x.shadowed && x !== s);
  if (!w) return "Hidden by a server of the same name";
  const where = w.origin === "project" ? "this project's" : w.origin === "user" ? "omp's" : `${w.sourceLabel ?? "another tool"}'s`;
  return `Hidden by ${where} “${w.name}”`;
}

/** Tools whose name or description has `query` (case-insensitive). */
export function filterTools(tools: readonly McpTool[], query: string): McpTool[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tools];
  return tools.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q));
}

/** Answers whose servers didn't change keep their old objects, so memoized rows skip rendering. */
export function shareList(prev: McpList | undefined, next: McpList): McpList {
  if (!prev) return next;
  const old = new Map(prev.servers.map((s) => [serverKey(s), s]));
  let same = prev.servers.length === next.servers.length;
  const servers = next.servers.map((s, i) => {
    const o = old.get(serverKey(s));
    const keep = o && JSON.stringify(o) === JSON.stringify(s) ? o : s;
    if (keep !== prev.servers[i]) same = false;
    return keep;
  });
  return { ...next, servers: same ? prev.servers : servers };
}

/** Project folders of the host's workspaces (repository root, else the folder), in board order. */
export function projectFolders(workspaces: readonly Workspace[], home?: string): { path: string; label: string; hint: string }[] {
  const seen = new Set<string>();
  const out: { path: string; label: string; hint: string }[] = [];
  for (const ws of [...workspaces].sort((a, b) => a.order - b.order)) {
    const path = ws.repo?.root ?? ws.cwd;
    if (!path || seen.has(path) || path === home) continue;
    seen.add(path);
    out.push({ path, label: basename(path) || path, hint: tildify(path, home) });
  }
  return out;
}

/**
 * What a change did to running sessions, as one line ("applied to 2 running sessions · 1 more
 * when it finishes its turn · restart 1 session to use it"); null when nothing ran.
 */
export function reloadNote(r: McpReload): string | null {
  const parts: string[] = [];
  if (r.reloaded > 0) parts.push(`applied to ${plural(r.reloaded, "running session")}`);
  if (r.queued > 0) {
    const when = r.queued === 1 ? "when it finishes its turn" : "when they finish their turns";
    parts.push(r.reloaded > 0 ? `${r.queued} more ${when}` : `${plural(r.queued, "busy session")} pick it up ${when}`);
  }
  if (r.restartNeeded > 0) parts.push(`restart ${plural(r.restartNeeded, "session")} to use it`);
  return parts.length ? parts.join(" · ") : null;
}

// ---------------------------------------------------------------- editor form

export type FieldKey = "name" | "command" | "args" | "env" | "url" | "headers" | "timeout" | "oauth";

const FIELD_OF: Record<string, FieldKey> = { name: "name", command: "command", arguments: "args", args: "args", env: "env", url: "url", headers: "headers", timeout: "timeout", oauth: "oauth" };
const FIELD_PREFIX = /^([a-zA-Z]+)(?:\.[a-zA-Z]+)?: /;

/**
 * The editor field a host error is about, else null. hostd prefixes its `invalid_params` messages
 * with the field (`name: …`, `headers: …`, `oauth.clientSecret: …`; `cwd:` is the page's folder,
 * not a field); omp's own wording (`Server "x": stdio server requires "command"`) is recognised too.
 */
export function errorField(message: string): FieldKey | null {
  const p = FIELD_PREFIX.exec(message);
  if (p) return p[1] && Object.hasOwn(FIELD_OF, p[1]) ? (FIELD_OF[p[1]] ?? null) : null;
  // `Server "<name>": …` would match the words of the name itself.
  const m = message.replace(/^Server "[^"]*":\s*/, "");
  if (/already exists|server name/i.test(m)) return "name";
  if (/"command"/.test(m)) return "command";
  if (/"url"/.test(m)) return "url";
  return null;
}

/** A host message shown under its field: without the field prefix, capitalised. */
export function fieldMessage(message: string): string {
  const m = message.replace(FIELD_PREFIX, "");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export interface KvRow {
  id: number;
  key: string;
  /** Typed value (without `prefix`); "" for a stored secret left as is. */
  value: string;
  secret: boolean;
  /** The value is a stored secret (listed as the mask): blank keeps it. */
  stored: boolean;
  /** Fixed text before the value (`Bearer ` for "Add bearer token"). */
  prefix?: string;
  /** The user set `secret` themselves (else it follows the key's name). */
  secretSet?: boolean;
}

export interface McpForm {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  /** stdio */
  command: string;
  argsText: string;
  cwd: string;
  env: KvRow[];
  /** http / sse */
  url: string;
  headers: KvRow[];
  timeoutMs: string;
  oauth: { clientId: string; clientSecret: string; clientSecretStored: boolean; scope: string; callbackPort: string; redirectUri: string };
}

let rowSeq = 0;
/** Fresh ids for key/value rows (React keys). */
export function nextRowId(): number {
  rowSeq += 1;
  return rowSeq;
}

export function kvRow(kv?: Partial<McpKeyValue> & { prefix?: string }): KvRow {
  const value = kv?.value ?? "";
  const stored = value === SECRET_MASK;
  const key = kv?.key ?? "";
  return { id: nextRowId(), key, value: stored ? "" : value, secret: stored || !!kv?.secret || looksSecret(key), stored, prefix: kv?.prefix };
}

export function emptyForm(scope: McpScope): McpForm {
  return {
    name: "",
    scope,
    transport: "stdio",
    command: "",
    argsText: "",
    cwd: "",
    env: [],
    url: "",
    headers: [],
    timeoutMs: "",
    oauth: { clientId: "", clientSecret: "", clientSecretStored: false, scope: "", callbackPort: "", redirectUri: "" },
  };
}

/** The editor's fields for a definition (listed: secrets masked → "Unchanged" password fields). */
export function formFromDraft(d: McpServerDraft, name: string, scope: McpScope): McpForm {
  const o = d.oauth;
  return {
    name,
    scope,
    transport: d.transport,
    command: d.command ?? "",
    argsText: joinArgs(d.args),
    cwd: d.cwd ?? "",
    env: d.env.map((kv) => kvRow(kv)),
    url: d.url ?? "",
    headers: d.headers.map((kv) => kvRow(kv)),
    timeoutMs: d.timeoutMs === undefined ? "" : String(d.timeoutMs),
    oauth: {
      clientId: o?.clientId ?? "",
      clientSecret: o?.clientSecret === SECRET_MASK ? "" : (o?.clientSecret ?? ""),
      clientSecretStored: o?.clientSecret === SECRET_MASK,
      scope: o?.scope ?? "",
      callbackPort: o?.callbackPort === undefined ? "" : String(o.callbackPort),
      redirectUri: o?.redirectUri ?? "",
    },
  };
}

/** Whether the Advanced section has anything set (it opens by itself then). */
export function hasAdvanced(f: McpForm): boolean {
  const o = f.oauth;
  return f.timeoutMs.trim() !== "" || !!(o.clientId.trim() || o.clientSecret || o.clientSecretStored || o.scope.trim() || o.callbackPort.trim() || o.redirectUri.trim()) || f.transport === "sse";
}

/**
 * The form with a template input written where it goes: argument `n` (left out while blank), or
 * the value of a header / env row (created when missing, with the template's prefix, e.g. `Bearer `).
 */
export function applyTemplateInput(f: McpForm, input: McpTemplateInput, value: string, home?: string): McpForm {
  const t = input.target;
  if ("arg" in t) {
    const v = input.path ? expandTilde(value.trim(), home) : value;
    const { args, error } = splitArgs(f.argsText);
    if (error) return f;
    const next = [...args];
    if (v === "") {
      if (t.arg < next.length) next.splice(t.arg, 1);
    } else if (t.arg < next.length) next[t.arg] = v;
    else next.push(v);
    return { ...f, argsText: joinArgs(next) };
  }
  const field = "header" in t ? "headers" : "env";
  const key = "header" in t ? t.header : t.env;
  const rows = f[field];
  const i = rows.findIndex((r) => r.key.toLowerCase() === key.toLowerCase());
  const row: KvRow = { ...(rows[i] ?? kvRow({ key })), key, value, prefix: "header" in t ? t.prefix : undefined, secret: input.secret ?? looksSecret(key), stored: false };
  return { ...f, [field]: i >= 0 ? rows.map((r, j) => (j === i ? row : r)) : [...rows, row] };
}

/** The form with the registry inputs' JSON after `--config` (a local Smithery server's settings). */
export function applyRegistryInputs(f: McpForm, inputs: readonly McpRegistryInput[], values: Readonly<Record<string, string>>): McpForm {
  const { args, error } = splitArgs(f.argsText);
  if (error) return f;
  return { ...f, argsText: joinArgs(withConfigArg(args, JSON.stringify(registryConfig(inputs, values)))) };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function kvValue(r: KvRow): string {
  return r.stored && r.value === "" ? SECRET_MASK : `${r.prefix ?? ""}${r.value}`;
}

export type FormErrors = Partial<Record<FieldKey, string>>;

/**
 * The draft `mcp.save` / `mcp.test` take, or the problems that keep it from being one. Only the
 * chosen transport's fields go in; empty rows are dropped; untouched stored secrets travel as the mask.
 */
export function draftFromForm(f: McpForm): { draft?: McpServerDraft; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = f.name.trim();
  const ne = nameError(name);
  if (ne) errors.name = ne;
  let draft: McpServerDraft;
  if (f.transport === "stdio") {
    const command = f.command.trim();
    if (!command) errors.command = "Enter the program omp starts (for example npx, uvx or a path)";
    const { args, error } = splitArgs(f.argsText);
    if (error) errors.args = error;
    const env: McpKeyValue[] = [];
    for (const r of f.env) {
      const key = r.key.trim();
      if (!key && !r.value && !r.stored) continue;
      if (!key) errors.env = "Every variable needs a name";
      else if (/[=\s]/.test(key)) errors.env = `“${key}”: variable names can't contain spaces or =`;
      else if (env.some((e) => e.key === key)) errors.env = `${key} is set twice`;
      env.push({ key, value: kvValue(r), secret: r.secret });
    }
    draft = { transport: "stdio", command, args, cwd: f.cwd.trim() || undefined, env, headers: [] };
  } else {
    const url = f.url.trim();
    if (!url) errors.url = "Enter the server's URL";
    else if (!/^https?:\/\/[^/\s]+/i.test(url)) errors.url = "Use an http:// or https:// address";
    const headers: McpKeyValue[] = [];
    for (const r of f.headers) {
      const key = r.key.trim();
      if (!key && !r.value && !r.stored) continue;
      if (!key) errors.headers = "Every header needs a name";
      else if (!HEADER_NAME.test(key)) errors.headers = `“${key}” isn't a valid header name`;
      else if (headers.some((h) => h.key.toLowerCase() === key.toLowerCase())) errors.headers = `${key} is set twice`;
      headers.push({ key, value: kvValue(r), secret: r.secret });
    }
    draft = { transport: f.transport, url, args: [], env: [], headers };
  }
  const t = f.timeoutMs.trim();
  if (t !== "") {
    if (!/^\d+$/.test(t)) errors.timeout = "A whole number of milliseconds (0 = no limit)";
    else draft.timeoutMs = Number(t);
  }
  const o = f.oauth;
  const port = o.callbackPort.trim();
  if (port !== "" && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) errors.oauth = "The callback port is a number from 1 to 65535";
  const oauth: McpOAuthSettings = {};
  if (o.clientId.trim()) oauth.clientId = o.clientId.trim();
  if (o.clientSecret) oauth.clientSecret = o.clientSecret;
  else if (o.clientSecretStored) oauth.clientSecret = SECRET_MASK;
  if (o.scope.trim()) oauth.scope = o.scope.trim();
  if (port !== "" && !errors.oauth) oauth.callbackPort = Number(port);
  if (o.redirectUri.trim()) oauth.redirectUri = o.redirectUri.trim();
  if (Object.keys(oauth).length > 0 && f.transport !== "stdio") draft.oauth = oauth;
  return Object.keys(errors).length ? { errors } : { draft, errors };
}
