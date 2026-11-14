/**
 * Model presets (`Settings.modelPresets`, saved on this device): a launch's main model, thinking,
 * own omp model roles and fallback chains under a name, applied in one pick. Reset all applies the
 * empty preset (and the host's decide-for-me policy); One model for every role fills them all with
 * one model. Pure helpers, no React, no I/O (tested in presets.test.ts).
 */
import type { AutoAnswer, ModelInfo, ModelPreset, ThinkingLevel } from "@/core/gen";
import { BUILTIN_ROLES, deepEqual, formatRoleSelector, parseRoleSelector, ROLE_NAME, withRole } from "@/features/ompSettings/model";
import { type ChainMap, cleanChains, cleanRoles, overridesSummary, type RoleMap, selectorLabel } from "./roles";

const DEFAULT = "default";

/** tf-client's limits (`settings::validate`). */
export const MAX_PRESETS = 32;
export const MAX_PRESET_NAME = 48;

/** What a preset sets on a launch: the main model and thinking ("default" = the host's), the agent's own roles and chains. */
export interface PresetFields {
  /** `provider/id`, or "default" for the host's default role. */
  model: string;
  thinking: ThinkingLevel | "default";
  roleModels: RoleMap;
  fallbackChains: ChainMap;
}

/**
 * A launch form's preset fields with its decide-for-me policy (undefined: the host's): what the
 * presets section reads, and what applying a preset, Reset all or One model for every role spreads
 * over the form. Only Reset all (and its Undo) carries `autoAnswer`; a preset leaves it alone.
 */
export type PresetPatch = PresetFields & { autoAnswer?: AutoAnswer };

/** The preset's fields, each a fresh copy (editing the form never touches the saved preset). */
export function presetFields(p: ModelPreset): PresetFields {
  return {
    model: p.model?.trim() || DEFAULT,
    thinking: p.thinking ?? DEFAULT,
    roleModels: cleanRoles(p.roleModels),
    fallbackChains: cleanChains(p.fallbackChains),
  };
}

/** Reset all: the host's main model, thinking, roles and chains, and its decide-for-me policy. Plan mode is no model choice and stays. */
export function resetPatch(): PresetPatch {
  return { model: DEFAULT, thinking: DEFAULT, roleModels: {}, fallbackChains: {}, autoAnswer: undefined };
}

/** Nothing of its own: Reset all would change nothing. */
export function isHostDefaults(v: PresetPatch): boolean {
  return v.model === DEFAULT && v.thinking === DEFAULT && Object.keys(cleanRoles(v.roleModels)).length === 0 && Object.keys(cleanChains(v.fallbackChains)).length === 0 && v.autoAnswer === undefined;
}

/** Same main model, thinking, roles and chains (key order aside). */
export function sameFields(a: PresetFields, b: PresetFields): boolean {
  return (
    a.model === b.model &&
    a.thinking === b.thinking &&
    deepEqual(cleanRoles(a.roleModels), cleanRoles(b.roleModels)) &&
    deepEqual(cleanChains(a.fallbackChains), cleanChains(b.fallbackChains))
  );
}

/** The saved preset the fields are (the pickers mark it); the first of equal ones. */
export function matchingPreset(presets: readonly ModelPreset[], f: PresetFields): ModelPreset | undefined {
  return presets.find((p) => sameFields(presetFields(p), f));
}

/**
 * `form` (a launch's options) with a preset, Reset all or One model for every role applied: those
 * fields replaced, a selected template cleared (the preset's main model replaces the template's),
 * plan mode and everything else kept.
 */
export function withPreset<T extends object>(form: T, patch: PresetPatch): T {
  return "templateId" in form ? { ...form, ...patch, templateId: null } : { ...form, ...patch };
}

// ───────────────────────────── saving ─────────────────────────────

/** A name as tf-client keeps it: trimmed, inner whitespace one space. */
export function cleanPresetName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Why `name` can't name a preset (empty, too long, another preset's); null when it can. `selfId`: the preset being renamed. */
export function presetNameProblem(name: string, presets: readonly ModelPreset[], selfId?: string): string | null {
  const n = cleanPresetName(name);
  if (!n) return "Give it a name";
  if ([...n].length > MAX_PRESET_NAME) return `At most ${MAX_PRESET_NAME} characters`;
  const lower = n.toLowerCase();
  if (presets.some((p) => p.id !== selfId && cleanPresetName(p.name).toLowerCase() === lower)) return "A preset with that name exists";
  return null;
}

export function newPresetId(now = Date.now(), random = Math.random): string {
  return `mp-${now.toString(36)}-${random().toString(36).slice(2, 6) || "0"}`;
}

/** A preset of the fields: the host's model or thinking left out, maps cleaned. */
export function newPreset(id: string, name: string, f: PresetFields): ModelPreset {
  return {
    id,
    name: cleanPresetName(name),
    ...(f.model !== DEFAULT ? { model: f.model } : {}),
    ...(f.thinking !== DEFAULT ? { thinking: f.thinking } : {}),
    roleModels: cleanRoles(f.roleModels),
    fallbackChains: cleanChains(f.fallbackChains),
  };
}

/** Insert, or replace the preset with the same id in place. */
export function upsertPreset(list: readonly ModelPreset[], p: ModelPreset): ModelPreset[] {
  return list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
}

export function renamePreset(list: readonly ModelPreset[], id: string, name: string): ModelPreset[] {
  return list.map((p) => (p.id === id ? { ...p, name: cleanPresetName(name) } : p));
}

export function removePreset(list: readonly ModelPreset[], id: string): ModelPreset[] {
  return list.filter((p) => p.id !== id);
}

/** `p` back at `index` (Undo of a delete); a list that has it again stays as it is. */
export function restorePreset(list: readonly ModelPreset[], p: ModelPreset, index: number): ModelPreset[] {
  if (list.some((x) => x.id === p.id)) return [...list];
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), p, ...list.slice(at)];
}

function modelLabel(models: readonly ModelInfo[], model: string): string {
  const m = models.find((x) => `${x.provider}/${x.id}` === model);
  return m ? (m.label ?? m.id) : (model.split("/").pop() ?? model);
}

/** The one model the main model and every own role run on (`One model for every role`); undefined when they differ or there are no roles. */
export function everywhereModel(f: PresetFields): string | undefined {
  const selectors = Object.values(cleanRoles(f.roleModels));
  if (f.model === DEFAULT || selectors.length === 0) return undefined;
  return selectors.every((s) => parseRoleSelector(s).model === f.model) ? f.model : undefined;
}

/** A name for a new preset of the fields, unused by the saved ones: `opus-5 everywhere`, `opus-5 max`, `Own roles`. */
export function suggestPresetName(f: PresetFields, models: readonly ModelInfo[], presets: readonly ModelPreset[]): string {
  const one = everywhereModel(f);
  const roles = Object.keys(cleanRoles(f.roleModels)).length > 0;
  const base = one
    ? `${modelLabel(models, one)} everywhere`
    : f.model !== DEFAULT
      ? [modelLabel(models, f.model), f.thinking !== DEFAULT && f.thinking].filter(Boolean).join(" ")
      : roles
        ? "Own roles"
        : Object.keys(f.fallbackChains).length > 0
          ? "Fallback chains"
          : f.thinking !== DEFAULT
            ? `Thinking ${f.thinking}`
            : "Host defaults";
  const stem = [...cleanPresetName(base)].slice(0, MAX_PRESET_NAME - 3).join("").trim();
  const taken = new Set(presets.map((p) => cleanPresetName(p.name).toLowerCase()));
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
}

// ───────────────────────────── showing ─────────────────────────────

/** `opus-5 · max · 10 roles · 1 fallback chain`; `host defaults` for an empty one. */
export function presetSummary(f: PresetFields, models: readonly ModelInfo[]): string {
  const main = f.model !== DEFAULT ? selectorLabel(models, f.model) : f.thinking !== DEFAULT ? "default model" : undefined;
  const parts = [main, f.thinking !== DEFAULT && f.thinking, overridesSummary(f.roleModels, f.fallbackChains)].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : "host defaults";
}

/** The preset's roles grouped by what they run, biggest group first: `{ roles: ["smol", "task"], model: "luna · low" }`. */
export function roleGroups(roles: RoleMap, models: readonly ModelInfo[]): { roles: string[]; model: string }[] {
  const by = new Map<string, string[]>();
  for (const [role, selector] of Object.entries(cleanRoles(roles))) by.set(selector, [...(by.get(selector) ?? []), role]);
  return [...by.entries()].map(([selector, rs]) => ({ roles: rs, model: selectorLabel(models, selector) })).sort((a, b) => b.roles.length - a.roles.length);
}

// ───────────────────────────── one model for every role ─────────────────────────────

const KIND_ROLES = new Set(BUILTIN_ROLES.filter((r) => r.kind).map((r) => r.id));

/**
 * The roles One model for every role sets besides the main model: omp's chat roles, then the
 * custom roles the host or the launch names. Not `default` (the main model) and not the model kinds
 * (image, web search, speech, dictation, judge), which need models of their kind.
 */
export function everyRole(hostRoles: readonly string[], own: RoleMap): string[] {
  const out = BUILTIN_ROLES.filter((r) => !r.kind && r.id !== DEFAULT).map((r) => r.id);
  for (const role of [...hostRoles, ...Object.keys(own)]) {
    if (role !== DEFAULT && !KIND_ROLES.has(role) && ROLE_NAME.test(role) && !out.includes(role)) out.push(role);
  }
  return out;
}

/** The main model and every role in `roles` on `model` (at `thinking`); the model kinds' own choices and the chains stay; an own `default` role goes (the main model is it). */
export function oneModelEverywhere(f: PresetFields, model: string, thinking: ThinkingLevel | undefined, roles: readonly string[]): PresetFields {
  const selector = formatRoleSelector(model, thinking);
  const kept = withRole(cleanRoles(f.roleModels), DEFAULT, undefined);
  for (const role of roles) if (role !== DEFAULT) kept[role] = selector;
  return { model, thinking: thinking ?? DEFAULT, roleModels: kept, fallbackChains: cleanChains(f.fallbackChains) };
}

// ───────────────────────────── a running session ─────────────────────────────

/** A running session's own roles and chains as preset fields: its own Default role is the main model. */
export function sessionFields(roles: RoleMap, chains: ChainMap): PresetFields {
  const own = cleanRoles(roles);
  const main = own[DEFAULT] ? parseRoleSelector(own[DEFAULT]) : undefined;
  return { model: main?.model ?? DEFAULT, thinking: main?.thinking ?? DEFAULT, roleModels: withRole(own, DEFAULT, undefined), fallbackChains: cleanChains(chains) };
}

/**
 * Preset fields as a running session's own roles and chains: the main model becomes its Default
 * role (a thinking level without a model goes on the host's Default, `hostDefault`); a preset's own
 * `default` role wins, as it does at launch.
 */
export function sessionMaps(f: PresetFields, hostDefault?: string): { roles: RoleMap; chains: ChainMap } {
  const own = cleanRoles(f.roleModels);
  const level = f.thinking === DEFAULT ? undefined : f.thinking;
  const base = f.model !== DEFAULT ? f.model : level && hostDefault ? parseRoleSelector(hostDefault).model : undefined;
  const main = own[DEFAULT] ?? (base ? formatRoleSelector(base, level) : undefined);
  const rest = withRole(own, DEFAULT, undefined);
  return { roles: main ? { [DEFAULT]: main, ...rest } : rest, chains: cleanChains(f.fallbackChains) };
}
