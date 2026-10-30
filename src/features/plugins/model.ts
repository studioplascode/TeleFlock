/**
 * Pure helpers of the Skills & plugins page: skills grouped by where they come from (registry
 * installs joined with the skill they unpack to), plugin keys and refs, pending updates, the
 * scripts listing omp refuses an install with, install-spec and marketplace-source kinds, catalog
 * filtering and "installed" marks, change lines for toasts, and list sharing for memoized rows.
 */
import type { Agent, ApiError, CatalogPlugin, InstallScope, MarketplacePlugin, McpReload, PackagePlugin, PluginList, RegistrySkill, SkillInfo, SkillList, SkillSearchHit } from "@/core/gen";
import { plural } from "@/features/mcp/model";

// ---------------------------------------------------------------- skills

export type SkillGroupId = "registry" | "omp" | "plugins" | "other";

/** The page's skill groups, in order. */
export const SKILL_GROUPS: readonly { id: SkillGroupId; title: string; detail: string }[] = [
  { id: "registry", title: "Registry", detail: "Installed from the Skillshare registry" },
  { id: "omp", title: "omp's own", detail: "Skill folders of omp and this project" },
  { id: "plugins", title: "From plugins", detail: "Come with an installed plugin" },
  { id: "other", title: "From other tools", detail: "Claude Code, Codex, .agents… · switch them off for omp" },
];

/** omp's providers of skills that come with a plugin: marketplace installs, extension packages, Agent Plugins. */
const PLUGIN_PROVIDERS: Record<string, true> = { "claude-plugins": true, "omp-plugins": true, "agent-plugins": true };
/** omp's own folders: `~/.omp/agent/skills`, a project's `.omp/skills`, auto-learned skills, `skills.customDirectories`. */
const OMP_PROVIDERS: Record<string, true> = { native: true, "omp-managed": true, custom: true };

/** Where a skill comes from, as the page groups it (providers omp may add later count as other tools). */
export function skillGroup(s: Pick<SkillInfo, "provider" | "registryId">): SkillGroupId {
  if (s.registryId || s.provider === "skillshare") return "registry";
  if (Object.hasOwn(PLUGIN_PROVIDERS, s.provider)) return "plugins";
  if (Object.hasOwn(OMP_PROVIDERS, s.provider)) return "omp";
  return "other";
}

/** One row of the skills list: a registry install (with the skill it unpacks to, when it does), or any other skill. */
export interface SkillItem {
  key: string;
  skill?: SkillInfo;
  registry?: RegistrySkill;
}

export function registryKey(r: Pick<RegistrySkill, "id" | "scope">): string {
  return `reg:${r.scope}:${r.id}`;
}

export function skillKey(s: Pick<SkillInfo, "path">): string {
  return `skill:${s.path}`;
}

/** The install scope a skill's level stands for (`native` is omp's user level). */
export function levelScope(level: string): InstallScope {
  return level === "project" ? "project" : "user";
}

const byName = (a: SkillItem, b: SkillItem) => (a.skill?.name ?? "").localeCompare(b.skill?.name ?? "");

/**
 * The skills by group. Registry installs keep omp's order (user level, then the project's) and
 * carry the skill omp loads from them (matched by package id and scope); an install missing from
 * omp's store has none. omp's own: the project's first; plugin skills by plugin; other tools' by tool.
 */
export function groupSkills(list: Pick<SkillList, "skills" | "registry">): Record<SkillGroupId, SkillItem[]> {
  const groups: Record<SkillGroupId, SkillItem[]> = { registry: [], omp: [], plugins: [], other: [] };
  const claimed = new Set<SkillInfo>();
  for (const r of list.registry) {
    const mine = list.skills.filter((s) => s.registryId === r.id && !claimed.has(s));
    const sameId = list.registry.filter((o) => o.id === r.id).length;
    const skill = mine.find((s) => levelScope(s.level) === r.scope) ?? (sameId === 1 && mine.length === 1 ? mine[0] : undefined);
    if (skill) claimed.add(skill);
    groups.registry.push({ key: registryKey(r), registry: r, skill });
  }
  for (const s of list.skills) if (!claimed.has(s)) groups[skillGroup(s)].push({ key: skillKey(s), skill: s });
  groups.omp.sort((a, b) => Number(b.skill?.level === "project") - Number(a.skill?.level === "project") || byName(a, b));
  groups.plugins.sort((a, b) => (a.skill?.plugin ?? "").localeCompare(b.skill?.plugin ?? "") || byName(a, b));
  groups.other.sort((a, b) => (a.skill?.providerName ?? "").localeCompare(b.skill?.providerName ?? "") || byName(a, b));
  return groups;
}

/** The source chip of a skill row; null where the group already says it (omp's folders, the registry). */
export function skillSource(s: Pick<SkillInfo, "provider" | "providerName" | "plugin">): string | null {
  switch (s.provider) {
    case "native":
    case "skillshare":
      return null;
    case "omp-managed":
      return "Auto-learned";
    case "custom":
      return "Custom folder";
    case "agents":
      return ".agents folder";
    default:
      return Object.hasOwn(PLUGIN_PROVIDERS, s.provider) ? (s.plugin ?? s.providerName) : s.providerName || s.provider;
  }
}

/**
 * What a registry install needs: `restore` (listed, but not unpacked in omp's store or never
 * installed: sessions skip it until `skills.update` restores it), `update` (a newer version within
 * its range), or nothing.
 */
export function registryNeed(r: Pick<RegistrySkill, "stored" | "version" | "update">): "restore" | "update" | null {
  if (!r.stored || !r.version) return "restore";
  if (r.update && r.update !== r.version) return "update";
  return null;
}

/** The registry's latest version when the install's range keeps it out ("2.0.0" outside `^1.2.0`). */
export function latestOutsideRange(r: Pick<RegistrySkill, "latest" | "version" | "update">): string | null {
  return r.latest && r.latest !== r.version && r.latest !== r.update ? r.latest : null;
}

// ---------------------------------------------------------------- plugins

export type AnyPlugin = PackagePlugin | MarketplacePlugin;

export function isMarketplacePlugin(p: AnyPlugin): p is MarketplacePlugin {
  return "marketplace" in p;
}

export function pluginKey(p: AnyPlugin): string {
  return isMarketplacePlugin(p) ? `mkt:${p.scope}:${p.id}` : `pkg:${p.name}`;
}

/** The `plugins.*` reference of a plugin: the package name, or `name@marketplace` with the install's scope. */
export function pluginRef(p: AnyPlugin): { id: string; scope?: InstallScope } {
  return isMarketplacePlugin(p) ? { id: p.id, scope: p.scope } : { id: p.name };
}

/** A marketplace plugin with a newer version in its (last fetched) catalog. */
export function pluginUpdate(p: AnyPlugin): string | null {
  return isMarketplacePlugin(p) && p.update && p.update !== p.version ? p.update : null;
}

// ---------------------------------------------------------------- updates

export interface PendingUpdates {
  skills: RegistrySkill[];
  plugins: MarketplacePlugin[];
  total: number;
}

/** Registry skills with a newer version in range and marketplace plugins with a newer catalog version. */
export function pendingUpdates(skills?: Pick<SkillList, "registry">, plugins?: Pick<PluginList, "marketplace">): PendingUpdates {
  const s = (skills?.registry ?? []).filter((r) => registryNeed(r) === "update");
  const p = (plugins?.marketplace ?? []).filter((x) => pluginUpdate(x) !== null);
  return { skills: s, plugins: p, total: s.length + p.length };
}

/** "2 skill updates and 1 plugin update", or null when there is none. */
export function updatesText(u: Pick<PendingUpdates, "skills" | "plugins">): string | null {
  const parts = [u.skills.length > 0 && plural(u.skills.length, "skill update"), u.plugins.length > 0 && plural(u.plugins.length, "plugin update")].filter(Boolean);
  return parts.length ? parts.join(" and ") : null;
}

/** Reload outcomes of several changes as one: the most sessions reached per kind, every error. */
export function mergeReload(a: McpReload | undefined, b: McpReload): McpReload {
  if (!a) return b;
  return { reloaded: Math.max(a.reloaded, b.reloaded), queued: Math.max(a.queued, b.queued), restartNeeded: Math.max(a.restartNeeded, b.restartNeeded), errors: [...a.errors, ...b.errors] };
}

/** omp's lines about a change for a toast: the first `max`, then "+N more". */
export function changesLine(changes: readonly string[], max = 3): string | undefined {
  const lines = changes.map((c) => c.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, max).join(" · ");
  return lines.length > max ? `${shown} · +${lines.length - max} more` : shown;
}

// ---------------------------------------------------------------- scripts consent

export interface ScriptListing {
  /** omp's line about the version ("@labs/pdf-tools@0.3.0 ships scripts"). */
  title: string;
  files: { path: string; executable: boolean }[];
}

/**
 * The files a refused version ships, from the `scripts_need_consent` message (omp's
 * `formatScriptApproval`: `@a/b@1.2.0 ships scripts:`, then one indented line per file, `(executable)`
 * marked). Several listings in one message give several entries; text without files is one entry.
 */
export function parseScriptListing(message: string): ScriptListing[] {
  const out: ScriptListing[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      const text = line.trim();
      const executable = text.endsWith(" (executable)");
      const file = { path: executable ? text.slice(0, -" (executable)".length) : text, executable };
      const last = out[out.length - 1];
      if (last) last.files.push(file);
      else out.push({ title: "", files: [file] });
    } else {
      out.push({ title: line.trim().replace(/:$/, ""), files: [] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- install inputs

export type SpecKind = "marketplace" | "npm" | "git" | "folder";

const FOLDER_RE = /^(\/|~(\/|$)|\.{1,2}(\/|$)|[A-Za-z]:[\\/])/;
const GIT_RE = /^((github|gitlab|bitbucket|git|git\+[a-z]+):|git@|ssh:\/\/|https?:\/\/)|\.git(#\S*)?$/i;
const NPM_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[^\s@[\]]+)?(\[[^\]]*\])?$/i;
const MARKETPLACE_RE = /^([a-z0-9][\w.-]*)@([a-z0-9][\w.-]*)$/i;

/**
 * What `plugins.install` would make of a spec: a folder on the host (an absolute, `~` or relative
 * path), a git source (`github:user/repo`, a URL, `git@…`), `name@marketplace` (a marketplace the
 * host knows), an npm package (`pkg`, `@scope/pkg@1.2`, `pkg[feature]`), else null.
 */
export function specKind(spec: string, marketplaces: readonly string[] = []): SpecKind | null {
  const s = spec.trim();
  if (!s) return null;
  if (FOLDER_RE.test(s)) return "folder";
  if (GIT_RE.test(s)) return "git";
  const m = MARKETPLACE_RE.exec(s);
  if (m?.[2] && marketplaces.includes(m[2])) return "marketplace";
  return NPM_RE.test(s) ? "npm" : null;
}

/** A spec hostd would refuse for its shape: only a folder may hold spaces. */
export function specError(spec: string): string | null {
  const s = spec.trim();
  if (!s || FOLDER_RE.test(s)) return null;
  return /\s/.test(s) ? "Package names and git sources have no spaces" : null;
}

export type SourceKind = "github" | "git" | "url" | "local";

/** What `plugins.marketplaceAdd` would fetch: `owner/repo` on GitHub, a git URL, a catalog URL (`….json`), a folder on the host. */
export function sourceKind(source: string): SourceKind | null {
  const s = source.trim();
  if (!s) return null;
  if (FOLDER_RE.test(s)) return "local";
  if (/^https?:\/\/\S+\.json(\?\S*)?$/i.test(s)) return "url";
  if (GIT_RE.test(s)) return "git";
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? "github" : null;
}

export const SOURCE_LABEL: Record<SourceKind, string> = { github: "GitHub repository", git: "Git repository", url: "Catalog URL", local: "Folder on the host" };

// ---------------------------------------------------------------- catalogs and search

/** Catalog plugins of one marketplace (all when absent) whose name, description, keywords, category or author hold every word of `query`. */
export function filterCatalog(plugins: readonly CatalogPlugin[], query: string, marketplace?: string): CatalogPlugin[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return plugins.filter((p) => {
    if (marketplace && p.marketplace !== marketplace) return false;
    if (words.length === 0) return true;
    const text = [p.name, p.description ?? "", p.category ?? "", p.author ?? "", ...p.keywords].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Where a catalog plugin is installed: from the page's plugin list when there is one (fresher), else as the catalog says. */
export function installedScopes(p: Pick<CatalogPlugin, "id" | "installed">, list?: Pick<PluginList, "marketplace">): InstallScope[] {
  if (!list) return [...p.installed];
  const scopes = new Set(list.marketplace.filter((m) => m.id === p.id).map((m) => m.scope));
  return (["user", "project"] as const).filter((s) => scopes.has(s));
}

/** Where a registry hit is installed: from the page's skill list when there is one, else as the search says (the project's wins). */
export function hitInstalled(hit: Pick<SkillSearchHit, "id" | "installed">, list?: Pick<SkillList, "registry">): InstallScope | undefined {
  if (!list) return hit.installed;
  const scopes = list.registry.filter((r) => r.id === hit.id).map((r) => r.scope);
  return scopes.includes("project") ? "project" : scopes.includes("user") ? "user" : undefined;
}

/** `https://skills.omp.sh/` → `skills.omp.sh`. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  }
}

/** An ISO 8601 time as epoch ms (absent or unreadable: undefined). */
export function isoMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** The omp sessions a change reaches: every running one for a user-level change, those started in the folder for a project's. */
export function runningSessions(agents: readonly Pick<Agent, "kind" | "parked" | "omp" | "cwd">[] | undefined, cwd?: string): number {
  let n = 0;
  for (const a of agents ?? []) if (a.kind === "omp" && !a.parked && a.omp && (!cwd || a.cwd === cwd || (a.cwd ?? "").startsWith(`${cwd}/`))) n += 1;
  return n;
}

/** A host error as one line: its message, then the hint. */
export function errorLine(e: Pick<ApiError, "message" | "hint">): string {
  return [e.message, e.hint].filter(Boolean).join(" — ");
}

// ---------------------------------------------------------------- rows

/** Every row key of the lists (skills and plugins), to find what a change added. */
export function rowKeys(skills?: Pick<SkillList, "skills" | "registry">, plugins?: Pick<PluginList, "packages" | "marketplace">): Set<string> {
  const keys = new Set<string>();
  if (skills) for (const items of Object.values(groupSkills(skills))) for (const i of items) keys.add(i.key);
  if (plugins) for (const p of [...plugins.packages, ...plugins.marketplace]) keys.add(pluginKey(p));
  return keys;
}

/** The first key in `after` that `before` lacks (the row an install added). */
export function firstAdded(before: ReadonlySet<string>, after: ReadonlySet<string>): string | undefined {
  for (const k of after) if (!before.has(k)) return k;
  return undefined;
}

/** Rows that didn't change keep their old objects, so memoized rows skip rendering. */
function shareRows<T>(prev: readonly T[] | undefined, next: T[], key: (t: T) => string): T[] {
  if (!prev) return next;
  const old = new Map(prev.map((x) => [key(x), x]));
  let same = prev.length === next.length;
  const rows = next.map((x, i) => {
    const o = old.get(key(x));
    const keep = o !== undefined && JSON.stringify(o) === JSON.stringify(x) ? o : x;
    if (keep !== prev[i]) same = false;
    return keep;
  });
  return same ? (prev as T[]) : rows;
}

export function shareSkillList(prev: SkillList | undefined, next: SkillList): SkillList {
  if (!prev) return next;
  return { ...next, skills: shareRows(prev.skills, next.skills, skillKey), registry: shareRows(prev.registry, next.registry, registryKey) };
}

export function sharePluginList(prev: PluginList | undefined, next: PluginList): PluginList {
  if (!prev) return next;
  return {
    ...next,
    packages: shareRows(prev.packages, next.packages, pluginKey),
    marketplace: shareRows(prev.marketplace, next.marketplace, pluginKey),
    marketplaces: shareRows(prev.marketplaces, next.marketplaces, (m) => m.name),
  };
}
