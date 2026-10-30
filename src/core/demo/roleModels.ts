/**
 * One demo agent's own omp model roles and fallback chains, read from `agent.start` /
 * `worktree.create` specs, automation drafts and `agent.setRoleModels`, and checked like tf-hostd
 * (`agentcfg::AgentOmp::validate`, same messages).
 */
import { apiError } from "../errors";
import type { ThinkingLevel } from "../gen";

export interface AgentOmp {
  roles: Record<string, string>;
  chains: Record<string, string[]>;
}

const MAX_ROLES = 64;
const MAX_CHAINS = 64;
const MAX_CHAIN_LEN = 16;
const MAX_SELECTOR = 256;
const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

function invalid(message: string): never {
  throw apiError("invalid_params", message);
}

function clip(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function roleNameOk(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name);
}

/** `provider/model[:thinking]`, `provider/*` or `provider/prefix/*`: no whitespace, a provider and something after it. */
function selectorOk(s: string): boolean {
  if (!s || s.length > MAX_SELECTOR || /[\s\u0000-\u001f\u007f]/.test(s)) return false;
  const slash = s.indexOf("/");
  return slash > 0 && slash < s.length - 1;
}

/** The maps of `p` (absent = none), checked like hostd; `invalid_params` names the first bad one. */
export function agentOmpOf(p: { roleModels?: unknown; fallbackChains?: unknown }): AgentOmp {
  const roles: Record<string, string> = {};
  if (p.roleModels !== undefined && p.roleModels !== null) {
    if (typeof p.roleModels !== "object" || Array.isArray(p.roleModels)) invalid("roleModels maps roles to model selectors");
    for (const [role, value] of Object.entries(p.roleModels)) {
      if (typeof value !== "string") invalid(`model role \`${clip(role)}\`: expects a \`provider/model[:thinking]\` selector`);
      roles[role] = value;
    }
  }
  const chains: Record<string, string[]> = {};
  if (p.fallbackChains !== undefined && p.fallbackChains !== null) {
    if (typeof p.fallbackChains !== "object" || Array.isArray(p.fallbackChains)) invalid("fallbackChains maps keys to lists of model selectors");
    for (const [key, list] of Object.entries(p.fallbackChains)) {
      if (!Array.isArray(list) || list.some((e) => typeof e !== "string")) invalid(`fallback chain \`${clip(key)}\`: expects a list of selectors`);
      chains[key] = list as string[];
    }
  }
  if (Object.keys(roles).length > MAX_ROLES) invalid(`at most ${MAX_ROLES} model roles`);
  for (const [role, value] of Object.entries(roles)) {
    if (!roleNameOk(role)) invalid(`model role \`${clip(role)}\`: names are letters, digits, \`-\` and \`_\`, starting with a letter (≤ 32)`);
    // omp takes a comma list of candidates for a role.
    if (value.split(",").some((s) => !selectorOk(s))) invalid(`model role \`${role}\`: \`${clip(value)}\` is not a \`provider/model[:thinking]\` selector`);
  }
  if (Object.keys(chains).length > MAX_CHAINS) invalid(`at most ${MAX_CHAINS} fallback chains`);
  for (const [key, chain] of Object.entries(chains)) {
    if (!roleNameOk(key) && !selectorOk(key)) invalid(`fallback chain \`${clip(key)}\`: the key is a role, \`provider/model\`, \`provider/*\` or \`provider/prefix/*\``);
    if (chain.length > MAX_CHAIN_LEN) invalid(`fallback chain \`${key}\`: at most ${MAX_CHAIN_LEN} fallbacks`);
    const bad = chain.find((s) => !selectorOk(s));
    if (bad !== undefined) invalid(`fallback chain \`${key}\`: \`${clip(bad)}\` is not a \`provider/model[:thinking]\` selector`);
  }
  return { roles, chains };
}

/** The first candidate of a role value as model + level (`a/b:high`; `ollama/llama3:8b` keeps its tag). */
export function selectorParts(value: string): { model: string; thinking?: ThinkingLevel } {
  const first = value.split(",")[0]?.trim() ?? "";
  const i = first.lastIndexOf(":");
  const level = i > 0 ? LEVELS.find((l) => l === first.slice(i + 1)) : undefined;
  return level ? { model: first.slice(0, i), thinking: level } : { model: first };
}
