import type { ModelInfo, Refusal, RefusalRule, ThinkingLevel, TranscriptItem } from "./gen";

/*
 * Refusal fallback rules against a refusal, as tf-hostd normalises and matches them (`crates/tf-hostd/src/refusal.rs`,
 * architecture §3.22). The app uses it to show what a rule does (the model "Retry with" starts on, the rule a
 * refusal row already has) and the demo host to play tf-hostd; the host itself decides for real.
 */

/** A model as a rule names it: `provider/id`, or only an id where the provider isn't known. */
export interface ModelLike {
  provider?: string;
  id: string;
}

export const modelKey = (m: ModelLike): string => (m.provider ? `${m.provider}/${m.id}` : m.id);

const LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/** `provider/id[:level]` → the model and its level. A `:suffix` that is no thinking level stays part of the id (`ollama/llama3:8b`). */
export function splitLevel(selector: string): { model: string; level?: ThinkingLevel } {
  const i = selector.lastIndexOf(":");
  const tail = i > 0 ? selector.slice(i + 1) : "";
  return LEVELS.includes(tail) ? { model: selector.slice(0, i), level: tail as ThinkingLevel } : { model: selector };
}

// ───────────────────────────── names ─────────────────────────────

/** Anthropic's ids: `claude-opus-5-5` (a trailing date is a snapshot of the same model). */
export const CLAUDE = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/** `Opus 5.5` for `claude-opus-5-5` however the catalog cases its label; else the label without "Claude ", else the id. */
export function modelName(m: Pick<ModelInfo, "id" | "label">): string {
  const c = CLAUDE.exec(m.id);
  if (c) return `${(c[1] as string).replace(/^./, (x) => x.toUpperCase())} ${c[3] ? `${c[2]}.${c[3]}` : c[2]}`;
  return m.label?.replace(/^claude\s+/i, "").trim() || m.id;
}

// ───────────────────────────── normalising ─────────────────────────────

/** The category as tf-hostd keeps it: trimmed and lower-cased; none, or "any", is no category (every refusal). */
export function categoryOf(category: string | undefined): string | undefined {
  const c = category?.trim().toLowerCase();
  return c && c !== "any" ? c : undefined;
}

/**
 * A rule as tf-hostd's answer to a save has it: the category as `categoryOf`, `from` trimmed with a real `:level` suffix
 * dropped and none for an empty or `*`, `to` trimmed with its level moved to `thinking` when that is unset. Ids keep the
 * case typed, the order is the caller's, and nothing is deduplicated.
 */
export function normalizeRule(rule: RefusalRule): RefusalRule {
  const from = rule.from ? splitLevel(rule.from.trim()).model : "";
  const to = splitLevel(rule.to.trim());
  const out: RefusalRule = { to: to.model, after: rule.after };
  const category = categoryOf(rule.category);
  const thinking = rule.thinking ?? to.level;
  if (category) out.category = category;
  if (from && from !== "*") out.from = from;
  if (thinking) out.thinking = thinking;
  return out;
}

/** tf-hostd keeps at most this many rules (`host.refusalFallbackSet`). */
export const MAX_RULES = 32;

/**
 * What tf-hostd does with the rules of `host.refusalFallbackSet`: normalises them (`normalizeRule`) or refuses the whole
 * list with its words (`invalid_params`, nothing saved; `N` is 1-based). The demo host plays it.
 */
export function validateRules(rules: unknown): { ok: true; rules: RefusalRule[] } | { ok: false; message: string } {
  if (!Array.isArray(rules)) return { ok: false, message: "rules must be a list" };
  if (rules.length > MAX_RULES) return { ok: false, message: `at most ${MAX_RULES} rules` };
  const out: RefusalRule[] = [];
  for (const [i, raw] of rules.entries()) {
    const at = `rule ${i + 1}`;
    const r = (raw ?? {}) as Partial<RefusalRule>;
    const category = typeof r.category === "string" ? r.category.trim() : "";
    if (category && !/^\S{1,64}$/.test(category)) return { ok: false, message: `${at}: the category is one word of at most 64 characters` };
    if (r.after !== "stay" && r.after !== "back") return { ok: false, message: `${at}: after is stay or back` };
    const rule = normalizeRule({ category, from: typeof r.from === "string" ? r.from : undefined, to: typeof r.to === "string" ? r.to : "", thinking: r.thinking, after: r.after });
    const star = rule.from?.indexOf("*") ?? -1;
    if (rule.from !== undefined && (/\s/.test(rule.from) || (star !== -1 && star !== rule.from.length - 1))) {
      return { ok: false, message: `${at}: "from" is a model as provider/id, an id, provider/* or a prefix ending in *` };
    }
    if (!/^[^\s/*]+\/[^\s*]+$/.test(rule.to)) return { ok: false, message: `${at}: "to" is a model as provider/id` };
    if (rule.from?.toLowerCase() === rule.to.toLowerCase()) return { ok: false, message: `${at}: a model cannot fall back to itself` };
    out.push(rule);
  }
  return { ok: true, rules: out };
}

// ───────────────────────────── matching ─────────────────────────────

/** No category, or "any": every refusal, safety-filter flags (`sensitive`) included. */
export const isAnyCategory = (category: string | undefined): boolean => categoryOf(category) === undefined;

/** A named category covers the refusals that carry it, case-insensitively; a safety-filter flag names none, so only an "any" rule covers it. */
export function categoryMatches(category: string | undefined, refusal: Pick<Refusal, "category">): boolean {
  const c = categoryOf(category);
  return c === undefined || c === refusal.category?.trim().toLowerCase();
}

/**
 * A model selector against a model, as tf-hostd's `selector_matches` parses it, ignoring case: a `:level` suffix only
 * counts as one when it is a thinking level; `*` is any model; the part before `/` names the provider (one the model
 * doesn't name never matches) and the rest is a pattern for the id alone: the id, `*` (any model of the provider) or a
 * prefix ending in `*` (a family). A bare id or prefix matches on any provider, so `anthropic*` names no Anthropic model.
 */
export function selectorMatches(selector: string, model: ModelLike): boolean {
  const sel = splitLevel(selector.trim()).model.toLowerCase();
  if (!sel) return false;
  if (sel === "*") return true;
  const slash = sel.indexOf("/");
  const pattern = slash < 0 ? sel : sel.slice(slash + 1);
  if (slash >= 0 && sel.slice(0, slash) !== model.provider?.toLowerCase()) return false;
  if (pattern === "*") return true;
  const id = model.id.toLowerCase();
  return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern;
}

/** tf-hostd's `same_model`: `to` (`provider/id`) is the refused model: its id, on its provider or on one not known. */
function sameModel(to: string, model: ModelLike): boolean {
  const t = splitLevel(to.trim()).model.toLowerCase();
  const slash = t.indexOf("/");
  const id = slash < 0 ? t : t.slice(slash + 1);
  return model.id.toLowerCase() === id && (!model.provider || model.provider.toLowerCase() === (slash < 0 ? "" : t.slice(0, slash)));
}

/** Whether the rule applies to this refusal on this model: its category and model match, and it doesn't go to the model that refused. */
export function ruleMatches(rule: RefusalRule, refusal: Pick<Refusal, "category">, model: ModelLike): boolean {
  if (!categoryMatches(rule.category, refusal)) return false;
  if (rule.from?.trim() && !selectorMatches(rule.from, model)) return false;
  return !sameModel(rule.to, model);
}

/** The first rule that applies decides; one that would go to the model that refused is skipped, and the next may apply. */
export function firstMatch(rules: readonly RefusalRule[], refusal: Pick<Refusal, "category">, model: ModelLike): RefusalRule | undefined {
  return rules.find((r) => ruleMatches(r, refusal, model));
}

// ───────────────────────────── the transcript ─────────────────────────────

/**
 * The id of the refusal row that ended the session's last turn: from the newest row back, past what isn't the
 * conversation (notices, model and mode markers, compactions, inbound IRC), the first row is an assistant row that
 * carries the provider's refusal. Anything else after it (a prompt, a reply, a tool call) and it is no longer the
 * turn to retry. `row(i)` reads the i-th of `count` rows, oldest first.
 */
export function lastRefusalRowId(count: number, row: (i: number) => TranscriptItem | undefined): string | undefined {
  for (let i = count - 1; i >= 0; i--) {
    const it = row(i);
    if (!it || it.kind === "notice" || it.kind === "mode" || it.kind === "compaction" || it.kind === "irc") continue;
    return it.kind === "assistant" && it.refusal ? it.id : undefined;
  }
  return undefined;
}
