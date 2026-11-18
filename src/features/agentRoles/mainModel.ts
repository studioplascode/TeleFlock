/**
 * A launch's main model as a launch form picks it (Dispatch, New worktree / New agent, Fan out):
 * `default` (the host's default role), one of omp's model roles as `@<role>` (`@slow`, `@smol`, …:
 * omp resolves it when the agent starts, the agent's own roles included), or a `provider/id`. And
 * the thinking levels that choice offers. Pure (tested in mainModel.test.ts).
 */
import type { HostInfo, ModelInfo, RoleBinding, ThinkingLevel } from "@/core/gen";
import { versionBelow } from "@/features/hosts/kinds";
import { BUILTIN_ROLES, parseRoleSelector, THINKING_LEVELS } from "@/features/ompSettings/model";
import type { RoleMap } from "./roles";

const DEFAULT = "default";

/** `AgentSpec.model` as `@<role>` needs tf-hostd 0.9.6; an older one refuses it as no `provider/id`. */
export const ROLE_MODEL_MIN_HOSTD = "0.9.6";

/** The host's tf-hostd starts an agent on a role (`@slow`); a version not known yet counts as no. */
export function hostTakesRoleModel(info: Pick<HostInfo, "hostdVersion"> | undefined): boolean {
  return !!info?.hostdVersion && !versionBelow(info.hostdVersion, ROLE_MODEL_MIN_HOSTD);
}

/** The role a main model names (`@slow` → `slow`), else null. */
export function roleOf(model: string): string | null {
  return model.startsWith("@") && model.length > 1 ? model.slice(1) : null;
}

/** omp's roles that pick a model of a kind (image, web search, speech, …): never a main model. */
const KIND_ROLES = new Set(BUILTIN_ROLES.filter((r) => r.kind).map((r) => r.id));

/**
 * The roles a launch can start on, with what each runs: the host's bindings with the agent's own
 * (`own`, More options) over them, then roles only the agent has. Not `default` (that is "Host
 * default") nor the kind roles.
 */
export function mainRoles(host: readonly RoleBinding[], own: RoleMap = {}): RoleBinding[] {
  const seen = new Set(host.map((r) => r.role));
  const all = [...host.map((r) => ({ role: r.role, model: own[r.role] ?? r.model })), ...Object.entries(own).filter(([role]) => !seen.has(role)).map(([role, model]) => ({ role, model }))];
  return all.filter((r) => r.role !== DEFAULT && !KIND_ROLES.has(r.role));
}

/** A role's name as omp's settings show it (`slow` → `Thinking`), else the role itself. */
export function roleName(role: string): string {
  return BUILTIN_ROLES.find((r) => r.id === role)?.name ?? role;
}

/**
 * The `provider/id[:level]` a main model runs, as far as known: the host's default role for
 * `default`, a role's binding for `@<role>` (the agent's own first), else the model itself.
 */
export function mainSelector(model: string, host: readonly RoleBinding[], own: RoleMap = {}): string | undefined {
  const role = model === DEFAULT ? DEFAULT : roleOf(model);
  if (!role) return model;
  return own[role] ?? host.find((r) => r.role === role)?.model;
}

/**
 * The thinking levels a main model offers: those of the model it runs (`selector`, see
 * `mainSelector`) as the catalog lists them, `auto` included; every level when the catalog
 * doesn't say (an unknown model, a role not bound, the catalog not loaded yet).
 */
export function thinkingChoices(models: readonly ModelInfo[], selector: string | undefined): ThinkingLevel[] {
  const id = selector ? parseRoleSelector(selector).model : undefined;
  const info = id ? models.find((m) => `${m.provider}/${m.id}` === id) : undefined;
  // `off` alone: a reasoning model whose efforts the catalog doesn't list.
  if (!info || info.thinking.length < 2) return [...THINKING_LEVELS];
  return info.thinking.includes("auto") ? [...info.thinking] : [...info.thinking, "auto"];
}
