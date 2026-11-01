import type { ForwardRule } from "@/core/gen";

/*
 * Host-to-host forwarding rules (`forward.*`, docs/architecture.md §6.7): the rule's field formats and the
 * validation the app core applies on `forward.save`. The editor runs the same checks to show every problem
 * at once before saving; the demo host throws the first one as `invalid_params` with the field prefix the
 * core uses (`name: …`, `toHost: …`, `shell: …`, `tools: …`, `ports: …`), which `parseFieldError` maps back to a field.
 */

export type ForwardField = "fromHost" | "toHost" | "name" | "shell" | "tools" | "ports";

export interface FieldError {
  field: ForwardField;
  message: string;
}

export type FieldErrors = Partial<Record<ForwardField, string>>;

/** Fields in the order the editor shows them (and the demo reports the first failure). */
export const FIELD_ORDER: readonly ForwardField[] = ["fromHost", "toHost", "name", "shell", "tools", "ports"];

export const NAME_MAX = 32;
export const TOOL_MAX = 64;
/** `tf-forward` itself lives next to the tool shims on the from-host; no tool may take its name. */
export const LAUNCHER = "tf-forward";
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const TOOL_RE = /^[A-Za-z0-9._+-]+$/;

export const NAME_RULE = `1–${NAME_MAX} lowercase letters, digits or dashes, starting with a letter or digit`;

export function validName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX && NAME_RE.test(name);
}

/** Names Windows opens as devices whatever the extension: CON, PRN, AUX, NUL, COM1–9, LPT1–9, with or without `.ext`. */
export function isWindowsDeviceName(tool: string): boolean {
  const stem = (tool.split(".")[0] ?? "").toLowerCase();
  return stem === "con" || stem === "prn" || stem === "aux" || stem === "nul" || /^(com|lpt)[1-9]$/.test(stem);
}

export function validTool(tool: string): boolean {
  return tool.length >= 1 && tool.length <= TOOL_MAX && TOOL_RE.test(tool) && tool !== "." && tool !== "..";
}

export function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * A rule name for a host's label: lowercase, runs of anything else become one dash, at most 32
 * characters, never starting or ending on a dash (`"Studio PC"` → `studio-pc`). `taken` (the names
 * already used on the from-host) gets `-2`, `-3`… appended until it is free. An unusable label gives `host`.
 */
export function slugify(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/, "");
  const root = base || "host";
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Every problem of `rule` by field, as the core's `forward.save` would find them. `hosts` are the hosts
 * that exist; `others` the saved rules apart from this one (names are unique per from-host, listen ports
 * too, across its rules).
 */
export function ruleErrors(rule: ForwardRule, hosts: readonly { id: string; name: string }[], others: readonly ForwardRule[]): FieldErrors {
  const out: FieldErrors = {};
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;
  if (!hosts.some((h) => h.id === rule.fromHost)) out.fromHost = `no host ${rule.fromHost}`;
  if (!hosts.some((h) => h.id === rule.toHost)) out.toHost = `no host ${rule.toHost}`;
  else if (rule.toHost === rule.fromHost) out.toHost = "choose a host other than the one the forward is used from";

  const sameFrom = others.filter((r) => r.fromHost === rule.fromHost);
  if (!validName(rule.name)) out.name = `use ${NAME_RULE}`;
  else if (sameFrom.some((r) => r.name === rule.name)) out.name = `${nameOf(rule.fromHost)} already has a forward called "${rule.name}"`;

  if (!rule.shell && rule.tools.length === 0 && rule.ports.length === 0) out.shell = "turn on the shell, a tool or a port";

  const seenTools = new Set<string>();
  for (const tool of rule.tools) {
    if (!validTool(tool)) {
      out.tools = `"${tool}" is not a command name (letters, digits, . _ + - only, up to ${TOOL_MAX})`;
      break;
    }
    if (tool === LAUNCHER) {
      out.tools = `"${LAUNCHER}" is TeleFlock's own command`;
      break;
    }
    if (isWindowsDeviceName(tool)) {
      out.tools = `"${tool}" is a device name on Windows`;
      break;
    }
    if (seenTools.has(tool)) {
      out.tools = `"${tool}" is listed twice`;
      break;
    }
    // One shim per command name on a host: the from-host's other rules must not forward it too.
    const holder = sameFrom.find((r) => r.tools.includes(tool));
    if (holder) {
      out.tools = `${nameOf(rule.fromHost)} already forwards "${tool}" in forward "${holder.name}"`;
      break;
    }
    seenTools.add(tool);
  }

  const seenListen = new Set<number>();
  for (const { listen, target } of rule.ports) {
    if (!validPort(listen) || !validPort(target)) {
      out.ports = "port numbers are 1–65535";
      break;
    }
    if (seenListen.has(listen)) {
      out.ports = `${listen} is listed twice`;
      break;
    }
    const clash = sameFrom.find((r) => r.ports.some((p) => p.listen === listen));
    if (clash) {
      out.ports = `${nameOf(rule.fromHost)} already listens on ${listen} in forward "${clash.name}"`;
      break;
    }
    seenListen.add(listen);
  }
  return out;
}

/** The wire form of one field error: `name: <message>`. */
export function fieldErrorMessage(e: FieldError): string {
  return `${e.field}: ${e.message}`;
}

/** The first failure in `FIELD_ORDER`, or null. */
export function firstFieldError(errors: FieldErrors): FieldError | null {
  for (const field of FIELD_ORDER) {
    const message = errors[field];
    if (message) return { field, message };
  }
  return null;
}

/** An `invalid_params` message from `forward.save` → its field and text; null when it names no field. */
export function parseFieldError(message: string): FieldError | null {
  const m = /^(fromHost|toHost|name|shell|tools|ports):\s*(.+)$/s.exec(message.trim());
  if (!m) return null;
  return { field: m[1] as ForwardField, message: m[2] as string };
}
