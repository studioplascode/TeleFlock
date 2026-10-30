/**
 * Pure helpers for one agent's own omp model roles and `retry.fallbackChains` (and the host-global
 * chains editor): cleaning, chain keys, chain rows ↔ record, entries with their thinking suffix,
 * validation like tf-hostd (`agentcfg::AgentOmp::validate`) with friendlier messages, and the
 * summary chips show. No React, no I/O (tested in roles.test.ts).
 */
import type { AgentSpec, HostInfo, ModelInfo, ThinkingLevel } from "@/core/gen";
import { versionBelow } from "@/features/hosts/kinds";
import { formatRoleSelector, parseRoleSelector, ROLE_NAME, roleRecord } from "@/features/ompSettings/model";

export type RoleMap = Record<string, string>;
export type ChainMap = Record<string, string[]>;

/** tf-hostd's limits. */
export const MAX_ROLES = 64;
export const MAX_CHAINS = 64;
export const MAX_CHAIN_ENTRIES = 16;
export const MAX_SELECTOR = 256;

// ───────────────────────────── maps ─────────────────────────────

/** A role map: string values only, trimmed, empty ones dropped. Key order kept. */
export function cleanRoles(value: unknown): RoleMap {
  const out: RoleMap = {};
  for (const [k, v] of Object.entries(roleRecord(value))) {
    const role = k.trim();
    const selector = v.trim();
    if (role && selector) out[role] = selector;
  }
  return out;
}

/** A chain map: string entries only, trimmed, empty ones dropped (an empty chain stays: it means "no fallbacks"). */
export function cleanChains(value: unknown): ChainMap {
  const out: ChainMap = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (!key || !Array.isArray(v)) continue;
    out[key] = v.flatMap((e) => (typeof e === "string" && e.trim() ? [e.trim()] : []));
  }
  return out;
}

/** An agent's own roles and chains (`AgentSpec.roleModels`) need tf-hostd 0.7; an older one starts the agent on the host's models without a word. */
export const ROLES_MIN_HOSTD = "0.7";

/** The host's tf-hostd takes per-agent roles (a version not known yet counts as yes). */
export function hostTakesRoles(info: Pick<HostInfo, "hostdVersion"> | undefined): boolean {
  return !versionBelow(info?.hostdVersion, ROLES_MIN_HOSTD);
}

/**
 * The spec fields of an agent's own roles and chains: each only when it holds something, and none for a
 * host that would ignore them (`takes` = `hostTakesRoles`).
 */
export function launchOverrides(roles: RoleMap | undefined, chains: ChainMap | undefined, takes = true): Pick<AgentSpec, "roleModels" | "fallbackChains"> {
  if (!takes) return {};
  return {
    ...(roles && Object.keys(roles).length > 0 ? { roleModels: { ...roles } } : {}),
    ...(chains && Object.keys(chains).length > 0 ? { fallbackChains: Object.fromEntries(Object.entries(chains).map(([k, v]) => [k, [...v]])) } : {}),
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Chip text: `3 roles · 1 fallback chain`; null when the agent has none of its own. */
export function overridesSummary(roles: RoleMap | undefined, chains: ChainMap | undefined): string | null {
  const r = Object.keys(roles ?? {}).length;
  const c = Object.keys(chains ?? {}).length;
  const parts = [r > 0 && plural(r, "role"), c > 0 && plural(c, "fallback chain")].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

/** `opus-5 · high` for `anthropic/claude-opus-5:high`: the catalog's label (else the id) and the level. */
export function selectorLabel(models: readonly ModelInfo[], selector: string): string {
  const { model, thinking } = parseRoleSelector(selector);
  const m = models.find((x) => `${x.provider}/${x.id}` === model);
  return [m ? (m.label ?? m.id) : model, thinking].filter(Boolean).join(" · ");
}

/**
 * A launch form's main model (its Model / Thinking fields; `default` = the host's), for the
 * read-only Default role: `gpt-5.5 · high`, `host default (opus-5) · low`.
 */
export function launchMainText(models: readonly ModelInfo[], model: string, thinking: string, hostDefault: string | undefined): string {
  const host = hostDefault ? parseRoleSelector(hostDefault) : undefined;
  const name = model === "default" ? (host ? `host default (${selectorLabel(models, host.model)})` : "host default") : selectorLabel(models, model);
  const level = thinking !== "default" ? thinking : model === "default" ? host?.thinking : undefined;
  return level ? `${name} · ${level}` : name;
}

// ───────────────────────────── selectors ─────────────────────────────

/** Why `s` is no `provider/rest` selector (tf-hostd's `selector_ok`); undefined when it is one. */
export function selectorProblem(s: string): string | undefined {
  if (!s) return "Pick a model";
  if (s.length > MAX_SELECTOR) return `At most ${MAX_SELECTOR} characters`;
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return "No spaces in a model selector";
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return "Use provider/model, e.g. openai/gpt-5.5";
  return undefined;
}

/** `provider/*` or `provider/prefix/*`: a fallback (or chain key) that stands for many models. */
export function isWildcard(s: string): boolean {
  if (!s.endsWith("/*") || selectorProblem(s)) return false;
  const base = s.slice(0, -2);
  return base.length > 0 && !base.endsWith("/") && !base.includes("*");
}

/** A concrete `provider/id[:thinking]` selector (no wildcard). */
export function isModelSelector(s: string): boolean {
  return !selectorProblem(s) && !s.includes("*");
}

export interface ChainEntry {
  /** `provider/id`, `provider/*` or `provider/prefix/*`. */
  model: string;
  /** Explicit level; absent: the failing turn's. Never set on a wildcard. */
  thinking?: ThinkingLevel;
  wildcard: boolean;
}

/** A fallback entry: model + thinking suffix (`a/b:high`); `ollama/llama3:8b` keeps its tag; wildcards never carry a level. */
export function parseChainEntry(entry: string): ChainEntry {
  const { model, thinking } = parseRoleSelector(entry.trim());
  if (isWildcard(model)) return { model, wildcard: true };
  return thinking ? { model, thinking, wildcard: false } : { model, wildcard: false };
}

/** The entry text; a wildcard keeps no level (it always inherits the failing turn's). */
export function formatChainEntry(model: string, thinking?: ThinkingLevel): string {
  return isWildcard(model) ? model : formatRoleSelector(model, thinking);
}

// ───────────────────────────── chain keys ─────────────────────────────

/** What a chain key names: a role, one model, every model of a provider, or a provider's ids under a prefix. */
export type ChainKeyKind = "role" | "model" | "provider" | "prefix";

export const CHAIN_KEY_KINDS: readonly { kind: ChainKeyKind; label: string; hint: string }[] = [
  { kind: "role", label: "Role", hint: "While a role's model runs (default, smol, …)" },
  { kind: "model", label: "Exact model", hint: "Whenever this model runs, in any role" },
  { kind: "provider", label: "Provider wildcard", hint: "Any model of a provider (provider/*)" },
  { kind: "prefix", label: "Id-prefixed wildcard", hint: "A provider's ids under a prefix (openrouter/google/*)" },
];

export function chainKeyKind(key: string): ChainKeyKind {
  if (!key.includes("/")) return "role";
  if (key.endsWith("/*")) return key.slice(0, -2).includes("/") ? "prefix" : "provider";
  return "model";
}

/** Key → kind + the text its field edits (role name, model selector, provider, `provider/prefix`). */
export function splitChainKey(key: string): { kind: ChainKeyKind; value: string } {
  const kind = chainKeyKind(key);
  return { kind, value: kind === "provider" || kind === "prefix" ? key.slice(0, -2) : key };
}

/** Kind + field text → key (`openrouter` as a provider wildcard → `openrouter/*`); empty text → "". */
export function joinChainKey(kind: ChainKeyKind, value: string): string {
  const v = value.trim();
  if (!v) return "";
  return kind === "provider" || kind === "prefix" ? `${v}/*` : v;
}

/** Why a key's field text doesn't make a key of its kind; undefined when it does. */
export function chainKeyProblem(kind: ChainKeyKind, value: string): string | undefined {
  const v = value.trim();
  switch (kind) {
    case "role":
      if (!v) return "Pick a role";
      return ROLE_NAME.test(v) ? undefined : "Letters, digits, - and _, starting with a letter (max 32)";
    case "model": {
      if (!v) return "Pick a model";
      if (v.includes("*")) return "Wildcards are their own key types";
      return selectorProblem(v);
    }
    case "provider":
      if (!v) return "Type a provider";
      return /^[^\s/*]+$/.test(v) && v.length < MAX_SELECTOR ? undefined : "Just the provider, e.g. openrouter";
    case "prefix": {
      if (!v) return "Type provider/prefix";
      const slash = v.indexOf("/");
      const ok = slash > 0 && slash < v.length - 1 && !v.endsWith("/") && !/[\s*]/.test(v) && v.length + 2 <= MAX_SELECTOR;
      return ok ? undefined : "Use provider/prefix, e.g. openrouter/google";
    }
  }
}

// ───────────────────────────── chain rows ─────────────────────────────

/** One chain as the editors hold it: the key split into its kind and field text, entries in order. */
export interface ChainRow {
  /** Stable within one editor (React keys). */
  id: number;
  kind: ChainKeyKind;
  value: string;
  entries: string[];
}

/** Record → rows, in the record's order. */
export function chainRows(record: ChainMap): ChainRow[] {
  return Object.entries(record).map(([key, entries], i) => ({ id: i + 1, ...splitChainKey(key), entries: [...entries] }));
}

/**
 * Rows → record, in row order. Only rows whose key is complete and valid go in, the first of a
 * key that repeats (the editors show why the others are left out).
 */
export function chainRecord(rows: readonly ChainRow[]): ChainMap {
  const out: ChainMap = {};
  for (const r of rows) {
    if (chainKeyProblem(r.kind, r.value)) continue;
    const key = joinChainKey(r.kind, r.value);
    if (!Object.hasOwn(out, key)) out[key] = [...r.entries];
  }
  return out;
}

export function nextChainId(rows: readonly ChainRow[]): number {
  return rows.reduce((n, r) => Math.max(n, r.id), 0) + 1;
}

// ───────────────────────────── validation ─────────────────────────────

export interface RolesCheck {
  ok: boolean;
  /** Role → what's wrong with it. */
  errors: Record<string, string>;
  /** Problems of the map as a whole (too many roles). */
  general: string[];
}

/** Role names and values (a value may list several selectors, comma-separated). */
export function validateRoles(roles: RoleMap): RolesCheck {
  const errors: Record<string, string> = {};
  const general: string[] = [];
  const names = Object.keys(roles);
  if (names.length > MAX_ROLES) general.push(`At most ${MAX_ROLES} roles`);
  for (const role of names) {
    if (!ROLE_NAME.test(role)) {
      errors[role] = "Role names are letters, digits, - and _, starting with a letter (max 32)";
      continue;
    }
    const bad = (roles[role] ?? "").split(",").map((s) => selectorProblem(s.trim())).find(Boolean);
    if (bad) errors[role] = bad;
  }
  return { ok: general.length === 0 && Object.keys(errors).length === 0, errors, general };
}

export interface ChainRowCheck {
  key?: string;
  /** Per entry, in order. */
  entries: (string | undefined)[];
  /** The chain as a whole (too many fallbacks). */
  chain?: string;
}

export interface ChainsCheck {
  ok: boolean;
  /** Per row, in order. */
  rows: ChainRowCheck[];
  /** Problems of the chains as a whole (too many chains). */
  general: string[];
}

/** Keys (complete, valid for their kind, unique), entries (selectors or wildcards) and limits. */
export function validateChains(rows: readonly ChainRow[]): ChainsCheck {
  const general: string[] = [];
  if (rows.length > MAX_CHAINS) general.push(`At most ${MAX_CHAINS} fallback chains`);
  const seen = new Set<string>();
  const checks = rows.map((r): ChainRowCheck => {
    let key = chainKeyProblem(r.kind, r.value);
    const joined = joinChainKey(r.kind, r.value);
    if (!key && seen.has(joined)) key = "Another chain already uses this key";
    if (!key) seen.add(joined);
    const entries = r.entries.map((e) => selectorProblem(e));
    const chain = r.entries.length > MAX_CHAIN_ENTRIES ? `At most ${MAX_CHAIN_ENTRIES} fallbacks per chain` : undefined;
    return { key, entries, chain };
  });
  const ok = general.length === 0 && checks.every((c) => !c.key && !c.chain && c.entries.every((e) => !e));
  return { ok, rows: checks, general };
}

/** Both maps as the host receives them. */
export function validateOverrides(roles: RoleMap, chains: ChainMap): { ok: boolean; roles: RolesCheck; chains: ChainsCheck } {
  const r = validateRoles(roles);
  const c = validateChains(chainRows(chains));
  return { ok: r.ok && c.ok, roles: r, chains: c };
}
