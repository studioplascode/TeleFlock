/** POSIX-ish path helpers for remote (host) paths. Windows hosts use `\`; we normalise display only. */

export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i <= 0) return i === 0 ? "/" : trimmed;
  return trimmed.slice(0, i);
}

export function joinPath(a: string, ...parts: string[]): string {
  const sep = a.includes("\\") && !a.includes("/") ? "\\" : "/";
  return [a.replace(/[\\/]+$/, ""), ...parts.map((s) => s.replace(/^[\\/]+|[\\/]+$/g, ""))].filter(Boolean).join(sep);
}

/** `/home/u/code/x` → `~/code/x` when under `home`. */
export function tildify(p: string, home?: string): string {
  if (!home) return p;
  const h = home.replace(/[\\/]+$/, "");
  if (p === h) return "~";
  if (p.startsWith(`${h}/`) || p.startsWith(`${h}\\`)) return `~${p.slice(h.length)}`;
  return p;
}

/** `~/x` → `/home/u/x`. */
export function expandTilde(p: string, home?: string): string {
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return joinPath(home, p.slice(2));
  return p;
}

export interface Crumb {
  label: string;
  path: string;
}

/** Breadcrumb segments for an absolute path; the home prefix collapses into `~`. */
export function crumbs(p: string, home?: string): Crumb[] {
  const out: Crumb[] = [];
  const h = home?.replace(/[\\/]+$/, "");
  let rest = p;
  let acc = "";
  if (h && (p === h || p.startsWith(`${h}/`))) {
    out.push({ label: "~", path: h });
    acc = h;
    rest = p.slice(h.length);
  } else if (p.startsWith("/")) {
    out.push({ label: "/", path: "/" });
  }
  for (const seg of rest.split(/[\\/]/).filter(Boolean)) {
    acc = acc === "" || acc === "/" ? `${acc === "/" ? "" : acc}/${seg}` : `${acc}/${seg}`;
    if (!p.startsWith("/") && out.length === 0 && acc.startsWith("/")) acc = acc.slice(1);
    out.push({ label: seg, path: acc });
  }
  return out;
}

/** herdr's worktree directory slug: `feat/x` → `feat-x`. */
export function branchSlug(branch: string): string {
  return branch.trim().replace(/[\\/]+/g, "-").replace(/\s+/g, "-");
}

/** herdr refuses agent names longer than this (tf-hostd `start_agent`). */
export const AGENT_NAME_MAX = 32;

/** A kebab name cut to `max` chars at a word boundary (one over-long word is cut hard). */
export function clipName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max + 1).replace(/-?[^-]*$/, "") || name.slice(0, max).replace(/-+$/, "");
}

/** herdr agent names: short, lowercase, `[a-z0-9-]`. Derived from the last branch segment. */
export function agentNameFromBranch(branch: string): string {
  const last = branch.trim().split("/").filter(Boolean).pop() ?? "";
  const name = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return clipName(name, AGENT_NAME_MAX);
}

/**
 * A derived (not typed) name that doesn't collide with a running agent: `docs` → `docs-2`, with the
 * suffix always within herdr's 32 chars (the base is cut at a word boundary to make room). Without
 * this the dialog would silently refuse to launch with the auto name.
 */
export function uniqueAgentName(base: string, taken: readonly string[]): string {
  if (!base) return base;
  const head = clipName(base, AGENT_NAME_MAX);
  if (!taken.includes(head)) return head;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${clipName(base, AGENT_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Validate a new git branch name (subset of `git check-ref-format`). Returns an error message or null. */
export function branchNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a branch name";
  if (/\s/.test(n)) return "No spaces in branch names";
  if (/\.\.|[~^:?*[\\]|@\{/.test(n)) return "Contains characters git doesn't allow (.. ~ ^ : ? * [ \\ @{)";
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock")) return "Can't start with - or /, or end with /, . or .lock";
  if (n.includes("//")) return "No empty path segments (//)";
  return null;
}

/** POSIX shell quoting for the command preview. */
export function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
