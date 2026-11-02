import type { ModelInfo, Refusal, RefusalAfter, RefusalRule, ThinkingLevel } from "@/core/gen";
import { CLAUDE, categoryMatches, categoryOf, firstMatch, MAX_RULES, type ModelLike, modelKey, modelName, normalizeRule, selectorMatches, splitLevel } from "@/core/refusal";

/*
 * Refusal fallback in the app (architecture §3.22): the pure half. tf-hostd decides what a rule does
 * (`crates/tf-hostd/src/refusal.rs`; the matching and normalising it mirrors is `@/core/refusal`); what is here is
 * what the app says about rules: names, the model "Retry with" starts on, the suggestion in Settings, the rule form.
 */

// ───────────────────────────── names ─────────────────────────────

/** The catalog's entry for `provider/id`, else for a bare id. */
export function findModel(models: readonly ModelInfo[], selector: string): ModelInfo | undefined {
  return models.find((m) => modelKey(m) === selector) ?? models.find((m) => m.id === selector);
}

/** What a rule's model selector reads as: "Opus 5.5", "any model", "any anthropic model", `claude-opus-*`. */
export function selectorName(models: readonly ModelInfo[], selector: string | undefined): string {
  const sel = selector?.trim() ? splitLevel(selector.trim()).model : "";
  if (!sel || sel === "*") return "any model";
  if (/^[^/*]+\/\*$/.test(sel)) return `any ${sel.slice(0, -2)} model`;
  if (sel.endsWith("*")) return sel;
  const hit = findModel(models, sel);
  return hit ? modelName(hit) : sel;
}

/** `Cyber refusals`, `Any refusal`, `Bio refusals`. */
export function categoryName(category: string | undefined): string {
  const c = categoryOf(category);
  return c ? `${c.charAt(0).toUpperCase()}${c.slice(1)} refusals` : "Any refusal";
}

/** The same rule once normalised, ids compared ignoring case (undo removes exactly what it added). */
export function sameRule(a: RefusalRule, b: RefusalRule): boolean {
  const [x, y] = [normalizeRule(a), normalizeRule(b)];
  return x.category === y.category && x.from?.toLowerCase() === y.from?.toLowerCase() && x.to.toLowerCase() === y.to.toLowerCase() && x.thinking === y.thinking && x.after === y.after;
}

// ───────────────────────────── the model a refusal happened on ─────────────────────────────

/**
 * The model a refused row names (omp's id, or a label in the demo) as a rule would name it. The session's own
 * model has a provider; one only the catalog knows is looked up; anything else stays a bare id, which a rule
 * matches on any provider.
 */
export function refusedModel(models: readonly ModelInfo[], text: string | undefined, current?: ModelLike): ModelLike | undefined {
  const t = text?.trim();
  if (!t) return current;
  if (current && (current.id === t || modelKey(current) === t)) return current;
  const hit = models.find((m) => modelKey(m) === t) ?? models.find((m) => m.id === t) ?? models.find((m) => m.label === t);
  if (hit) return { provider: hit.provider, id: hit.id };
  const slash = t.indexOf("/");
  return slash > 0 ? { provider: t.slice(0, slash), id: t.slice(slash + 1) } : { id: t };
}

// ───────────────────────────── what "Retry with" starts on ─────────────────────────────

/** `[major, minor]` of an Anthropic id; undefined for anything else. */
function versionOf(id: string): [number, number] | undefined {
  const c = CLAUDE.exec(id);
  return c ? [Number(c[2]), Number(c[3] ?? 0)] : undefined;
}

/** Newest first; models without a version after those that have one; a dated snapshot after its undated name. */
function newestFirst(a: ModelInfo, b: ModelInfo): number {
  const va = versionOf(a.id);
  const vb = versionOf(b.id);
  if (va && vb) return vb[0] - va[0] || vb[1] - va[1] || Number(/-\d{8}$/.test(a.id)) - Number(/-\d{8}$/.test(b.id));
  if (va || vb) return va ? -1 : 1;
  return 0;
}

export interface RetryTarget {
  /** `provider/id`. */
  model: string;
  /** The rule's level; absent: the refused turn's is kept. */
  thinking?: ThinkingLevel;
  /** Why this model: the host's own rule for the refusal, a Sonnet, or just another model. */
  why: "rule" | "sonnet" | "other";
}

/**
 * The model "Retry with" starts on: what the host's first matching rule goes to, else the newest Sonnet (the
 * refused model's provider first), else another model of that provider, else any other. Never the refused model.
 * Absent when the host has no other model.
 */
export function retryTarget(models: readonly ModelInfo[], rules: readonly RefusalRule[], refusal: Pick<Refusal, "category">, refused: ModelLike | undefined): RetryTarget | undefined {
  if (refused) {
    const rule = firstMatch(rules, refusal, refused);
    if (rule) {
      const to = splitLevel(rule.to.trim());
      return { model: to.model, thinking: rule.thinking ?? to.level, why: "rule" };
    }
  }
  const others = models.filter((m) => !refused || (refused.provider ? modelKey(m) !== modelKey(refused) : m.id !== refused.id));
  const ranked = (list: ModelInfo[]) => [...list].sort((a, b) => Number(b.provider === refused?.provider) - Number(a.provider === refused?.provider) || newestFirst(a, b));
  const sonnet = ranked(others.filter((m) => /sonnet/i.test(m.id)))[0];
  if (sonnet) return { model: modelKey(sonnet), why: "sonnet" };
  const alike = ranked(others.filter((m) => m.provider === refused?.provider))[0] ?? ranked(others)[0];
  return alike ? { model: modelKey(alike), why: "other" } : undefined;
}

// ───────────────────────────── the suggestion in Settings ─────────────────────────────

/**
 * "Opus 5.5 → Sonnet 5.5 for cyber refusals": the newest Opus that has a Sonnet of its own version on its provider
 * (Sonnet's safety classifier is the newer one). Absent without such a pair, or once a rule already decides
 * cyber refusals on that Opus.
 */
export function suggestedRule(models: readonly ModelInfo[], rules: readonly RefusalRule[]): RefusalRule | undefined {
  const opuses = models.filter((m) => CLAUDE.exec(m.id)?.[1] === "opus").sort(newestFirst);
  for (const opus of opuses) {
    const version = versionOf(opus.id)?.join(".");
    const sonnet = models.filter((m) => m.provider === opus.provider && CLAUDE.exec(m.id)?.[1] === "sonnet" && versionOf(m.id)?.join(".") === version).sort(newestFirst)[0];
    if (!sonnet) continue;
    if (rules.some((r) => categoryMatches(r.category, { category: "cyber" }) && (!r.from?.trim() || selectorMatches(r.from, opus)))) return undefined;
    return { category: "cyber", from: modelKey(opus), to: modelKey(sonnet), after: "stay" };
  }
  return undefined;
}

// ───────────────────────────── words ─────────────────────────────

export interface RuleWords {
  /** "Cyber refusals on Opus 5.5". */
  when: string;
  /** "Sonnet 5.5". */
  to: string;
  /** "Keeps the thinking level · stays on Sonnet 5.5". */
  then: string;
  /** The whole rule: "Cyber refusals on Opus 5.5: the turn goes on with Sonnet 5.5, keeping the thinking level; the agent then stays on Sonnet 5.5." */
  sentence: string;
}

export function ruleWords(rule: RefusalRule, models: readonly ModelInfo[]): RuleWords {
  const to = selectorName(models, rule.to);
  const from = rule.from?.trim() ? selectorName(models, rule.from) : undefined;
  const back = !from || from.startsWith("any ") || from.endsWith("*") ? "the refused model" : from;
  const when = `${categoryName(rule.category)} on ${selectorName(models, rule.from)}`;
  const follow = rule.after === "back" ? `switches back to ${back}` : `stays on ${to}`;
  const thinking = rule.thinking ?? splitLevel(rule.to.trim()).level;
  return {
    when,
    to,
    then: `${thinking ? `Thinking ${thinking}` : "Keeps the thinking level"} · ${follow}${rule.after === "back" ? " afterwards" : ""}`,
    sentence: `${when}: the turn goes on with ${to}${thinking ? ` at thinking ${thinking}` : ", keeping the thinking level"}; the agent then ${follow}.`,
  };
}

// ───────────────────────────── the form ─────────────────────────────

export type CategoryChoice = "cyber" | "any" | "other";

export interface RuleDraft {
  category: CategoryChoice;
  /** The category when `category` is "other" (`bio`). */
  other: string;
  /** `provider/id`, `provider/*` or a prefix; absent: any model. */
  from?: string;
  /** `provider/id`; absent until picked. */
  to?: string;
  /** Absent: the refused turn's level is kept. */
  thinking?: ThinkingLevel;
  after: RefusalAfter;
}

export const NEW_DRAFT: RuleDraft = { category: "cyber", other: "", after: "stay" };

export function draftOf(rule: RefusalRule): RuleDraft {
  const c = categoryOf(rule.category);
  const category: CategoryChoice = c === undefined ? "any" : c === "cyber" ? "cyber" : "other";
  return { category, other: category === "other" ? (c as string) : "", from: rule.from?.trim() || undefined, to: rule.to, thinking: rule.thinking, after: rule.after };
}

/** The rule a draft stands for, as tf-hostd keeps it (`normalizeRule`): the category lower-cased, a level on a model moved to the thinking field, nothing in it that means "default". */
export function ruleOf(d: RuleDraft): RefusalRule {
  return normalizeRule({ category: d.category === "other" ? d.other : d.category === "cyber" ? "cyber" : undefined, from: d.from, to: d.to ?? "", thinking: d.thinking, after: d.after });
}

export type DraftField = "category" | "from" | "to" | "rule";

export interface DraftCheck {
  /** The rule to save; absent while a field is wrong. */
  rule?: RefusalRule;
  errors: Partial<Record<DraftField, string>>;
  /** Not wrong, but worth knowing. */
  notes: string[];
}

/** Whether `earlier` decides every refusal `later` would (so `later`, below it, never applies). */
function shadows(earlier: RefusalRule, later: RefusalRule): boolean {
  const e = categoryOf(earlier.category);
  return (e === undefined || e === categoryOf(later.category)) && (!earlier.from?.trim() || earlier.from.trim().toLowerCase() === later.from?.trim().toLowerCase());
}

/**
 * The checks of the rule form, those of tf-hostd's save (a category of one word, a concrete `provider/id` to go to, a `*`
 * only at the end of the refused model, never to itself, at most 32 rules) in the form's words. `editing`: the index of
 * the rule being edited, which neither counts as a duplicate nor shadows itself. A rule that an earlier one shadows
 * saves, with a note ("the first matching rule decides").
 */
export function checkDraft(draft: RuleDraft, rules: readonly RefusalRule[], editing: number | null): DraftCheck {
  const errors: DraftCheck["errors"] = {};
  const notes: string[] = [];
  const rule = ruleOf(draft);
  const others = rules.filter((_, i) => i !== editing);
  if (draft.category === "other") {
    if (!rule.category) errors.category = "Name the category the provider gives (cyber, bio, …)";
    else if (/\s/.test(rule.category) || rule.category.length > 64) errors.category = "One word of at most 64 characters, as the provider names it";
  }
  if (!rule.to) errors.to = "Pick the model to go on with";
  else if (/\s/.test(rule.to)) errors.to = "No spaces in a model id";
  else if (rule.to.includes("*")) errors.to = "A concrete model, not a family";
  else if (!/^[^/]+\/.+$/.test(rule.to)) errors.to = "Use provider/id";
  if (rule.from) {
    if (/\s/.test(rule.from)) errors.from = "No spaces in a model id";
    else if (rule.from.indexOf("*") !== -1 && rule.from.indexOf("*") !== rule.from.length - 1) errors.from = "A * only ends a family: anthropic/* or claude-opus-*";
    else if (rule.to && !errors.to && rule.from.toLowerCase() === rule.to.toLowerCase()) errors.from = "That is the model it goes to: a model can't fall back to itself";
  }
  if (!errors.category && !errors.from && !errors.to) {
    if (editing === null && rules.length >= MAX_RULES) errors.rule = `At most ${MAX_RULES} rules`;
    else if (others.some((r) => sameRule(r, rule))) errors.rule = "That rule already exists";
  }
  const earlier = (editing === null ? rules : rules.slice(0, editing)).find((r) => shadows(r, rule));
  if (earlier && !errors.rule) notes.push("A rule above already decides these refusals: the first matching rule wins, so this one only applies to what that one doesn't match.");
  return { rule: Object.keys(errors).length === 0 ? rule : undefined, errors, notes };
}

/** `rules` with `rule` replacing the one at `index`, or put first (a new rule from a refusal row decides before the rest). */
export function withRule(rules: readonly RefusalRule[], rule: RefusalRule, index: number | null, where: "first" | "last" = "last"): RefusalRule[] {
  if (index !== null) return rules.map((r, i) => (i === index ? rule : r));
  return where === "first" ? [rule, ...rules] : [...rules, rule];
}

/** `rules` with the rule at `index` moved by `by` places (the first match decides, so the order is the setting). */
export function moved(rules: readonly RefusalRule[], index: number, by: -1 | 1): RefusalRule[] {
  const to = index + by;
  if (to < 0 || to >= rules.length) return [...rules];
  const next = [...rules];
  const [r] = next.splice(index, 1);
  next.splice(to, 0, r as RefusalRule);
  return next;
}

/** `rules` without `rule`: the one at `index` while it is still that rule, else the first alike; undefined when none is left. */
export function without(rules: readonly RefusalRule[], rule: RefusalRule, index = -1): RefusalRule[] | undefined {
  const there = rules[index];
  const at = there && sameRule(there, rule) ? index : rules.findIndex((r) => sameRule(r, rule));
  return at < 0 ? undefined : rules.filter((_, i) => i !== at);
}

/** The undo of a removal: `rules` (as they are now) with `rule` back at `index`, or last when fewer are left; undefined while it is there. */
export function restored(rules: readonly RefusalRule[], rule: RefusalRule, index: number): RefusalRule[] | undefined {
  if (rules.some((r) => sameRule(r, rule))) return undefined;
  return [...rules.slice(0, index), rule, ...rules.slice(index)];
}

/** The same rules in the same order (`sameRule`): a list a view showed is still the host's. */
export function sameRules(a: readonly RefusalRule[], b: readonly RefusalRule[]): boolean {
  return a.length === b.length && a.every((r, i) => {
    const other = b[i];
    return other !== undefined && sameRule(r, other);
  });
}
