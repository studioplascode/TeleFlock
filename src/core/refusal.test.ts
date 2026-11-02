import { describe, expect, test } from "bun:test";
import type { RefusalRule, TranscriptItem } from "./gen";
import { categoryMatches, categoryOf, firstMatch, lastRefusalRowId, MAX_RULES, modelName, normalizeRule, ruleMatches, selectorMatches, splitLevel, validateRules } from "./refusal";

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const SONNET = { provider: "anthropic", id: "claude-sonnet-5-5" };
const CYBER = { category: "cyber" };
const rule = (r: Partial<RefusalRule> = {}): RefusalRule => ({ category: "cyber", from: "anthropic/claude-opus-5-5", to: "anthropic/claude-sonnet-5-5", after: "stay", ...r });

describe("names", () => {
  test("Anthropic ids read as the family and version however the catalog words the label", () => {
    expect(modelName({ id: "claude-opus-5-5", label: "Claude Opus 5.5" })).toBe("Opus 5.5");
    expect(modelName({ id: "claude-opus-5-5", label: "opus-5.5" })).toBe("Opus 5.5");
    expect(modelName({ id: "claude-sonnet-5" })).toBe("Sonnet 5");
    expect(modelName({ id: "claude-opus-4-5-20251101" })).toBe("Opus 4.5");
    expect(modelName({ id: "claude-opus-5-20251101" })).toBe("Opus 5");
    expect(modelName({ id: "gpt-5.5", label: "GPT-5.5" })).toBe("GPT-5.5");
    expect(modelName({ id: "llama3:8b" })).toBe("llama3:8b");
  });
});

describe("a rule as tf-hostd keeps it", () => {
  test("category: trimmed and lower-cased; none, empty or any is every refusal", () => {
    expect(categoryOf(" Cyber ")).toBe("cyber");
    expect(categoryOf("ANY")).toBeUndefined();
    expect(categoryOf("  ")).toBeUndefined();
    expect(categoryOf(undefined)).toBeUndefined();
    expect(normalizeRule(rule({ category: "Any" })).category).toBeUndefined();
    expect("category" in normalizeRule(rule({ category: "" }))).toBe(false);
  });

  test("a model to refuse on: trimmed, a real :level dropped, nothing for empty or *", () => {
    expect(normalizeRule(rule({ from: " anthropic/claude-opus-5-5:high " })).from).toBe("anthropic/claude-opus-5-5");
    expect(normalizeRule(rule({ from: "ollama/llama3:8b" })).from).toBe("ollama/llama3:8b");
    expect("from" in normalizeRule(rule({ from: "*" }))).toBe(false);
    expect("from" in normalizeRule(rule({ from: "  " }))).toBe(false);
    expect(normalizeRule(rule({ from: "anthropic/*" })).from).toBe("anthropic/*");
  });

  test("a model to go to: a level on it becomes the thinking level unless one is set", () => {
    expect(normalizeRule(rule({ to: "anthropic/claude-sonnet-5-5:high" }))).toMatchObject({ to: "anthropic/claude-sonnet-5-5", thinking: "high" });
    expect(normalizeRule(rule({ to: "anthropic/claude-sonnet-5-5:high", thinking: "low" }))).toMatchObject({ to: "anthropic/claude-sonnet-5-5", thinking: "low" });
    expect("thinking" in normalizeRule(rule())).toBe(false);
  });

  test("ids keep the case they were typed in", () => {
    expect(normalizeRule(rule({ from: "Anthropic/Claude-Opus-5-5", to: "Anthropic/Claude-Sonnet-5-5" }))).toMatchObject({ from: "Anthropic/Claude-Opus-5-5", to: "Anthropic/Claude-Sonnet-5-5" });
  });

  test("only a real thinking level is a level", () => {
    expect(splitLevel("anthropic/claude-opus-5-5:xhigh")).toEqual({ model: "anthropic/claude-opus-5-5", level: "xhigh" });
    expect(splitLevel("anthropic/claude-opus-5-5:fast")).toEqual({ model: "anthropic/claude-opus-5-5:fast" });
    expect(splitLevel("ollama/llama3:8b:low")).toEqual({ model: "ollama/llama3:8b", level: "low" });
    expect(splitLevel(":high")).toEqual({ model: ":high" });
  });
});

describe("saving rules, as tf-hostd does", () => {
  const bad = (rules: unknown) => {
    const r = validateRules(rules);
    return r.ok ? undefined : r.message;
  };

  test("a good list comes back normalised, in order, nothing deduplicated", () => {
    const r = validateRules([rule({ category: " Cyber ", from: "anthropic/claude-opus-5-5:high" }), rule({ category: "any", from: "*" }), rule(), rule()]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.rules).toEqual([
      { category: "cyber", from: "anthropic/claude-opus-5-5", to: "anthropic/claude-sonnet-5-5", after: "stay" },
      { to: "anthropic/claude-sonnet-5-5", after: "stay" },
      rule(),
      rule(),
    ]);
    expect(validateRules([])).toEqual({ ok: true, rules: [] });
  });

  test("the whole list is refused with the rule's number (1-based), one error at a time", () => {
    expect(bad([rule(), rule({ category: "bio hazard" })])).toBe("rule 2: the category is one word of at most 64 characters");
    expect(bad([rule({ category: "x".repeat(65) })])).toBe("rule 1: the category is one word of at most 64 characters");
    expect(bad([rule({ category: "x".repeat(64) })])).toBeUndefined();
    expect(bad([rule({ from: "anth*/claude" })])).toBe('rule 1: "from" is a model as provider/id, an id, provider/* or a prefix ending in *');
    expect(bad([rule({ from: "a b" })])).toContain('"from" is a model');
    expect(bad([rule({ to: "claude-sonnet-5-5" })])).toBe('rule 1: "to" is a model as provider/id');
    expect(bad([rule({ to: "anthropic/*" })])).toBe('rule 1: "to" is a model as provider/id');
    expect(bad([rule({ to: "" })])).toBe('rule 1: "to" is a model as provider/id');
    expect(bad([rule({ from: "Anthropic/Claude-Sonnet-5-5:high" })])).toBe("rule 1: a model cannot fall back to itself");
    expect(bad(Array.from({ length: MAX_RULES + 1 }, () => rule()))).toBe(`at most ${MAX_RULES} rules`);
    expect(bad(Array.from({ length: MAX_RULES }, () => rule()))).toBeUndefined();
  });

  test("a * ends a family and nothing else; the model to go to carries no *", () => {
    expect(bad([rule({ from: "anthropic/*" }), rule({ from: "claude-opus-*" }), rule({ from: "claude-opus-5-5" })])).toBeUndefined();
    expect(bad([rule({ from: "*/claude" })])).toContain('"from"');
    expect(bad([rule({ from: "anthropic/*", to: "anthropic/claude-sonnet-5-5" })])).toBeUndefined();
  });
});

describe("matching a refusal, as tf-hostd does", () => {
  test("a named category matches the refusals that carry it, ignoring case; no category matches every refusal", () => {
    expect(categoryMatches("Cyber", { category: "cyber" })).toBe(true);
    expect(categoryMatches("cyber", { category: "CYBER" })).toBe(true);
    expect(categoryMatches("cyber", { category: "bio" })).toBe(false);
    expect(categoryMatches(undefined, { category: "bio" })).toBe(true);
    expect(categoryMatches("any", { category: undefined })).toBe(true);
    expect(categoryMatches("", { category: undefined })).toBe(true);
  });

  test("a safety-filter flag names no category: only a rule without one covers it", () => {
    expect(categoryMatches("cyber", { category: undefined })).toBe(false);
    expect(categoryMatches(undefined, { category: undefined })).toBe(true);
  });

  test("a :suffix is dropped only when it is a thinking level", () => {
    expect(selectorMatches("anthropic/claude-opus-5-5:high", OPUS)).toBe(true);
    expect(selectorMatches("anthropic/claude-opus-5-5:fast", OPUS)).toBe(false);
    expect(selectorMatches("ollama/llama3:8b", { provider: "ollama", id: "llama3:8b" })).toBe(true);
    expect(selectorMatches("ollama/llama3:8b:high", { provider: "ollama", id: "llama3:8b" })).toBe(true);
  });

  test("a bare id matches on any provider; provider/* and a trailing * match a family", () => {
    expect(selectorMatches("claude-opus-5-5", OPUS)).toBe(true);
    expect(selectorMatches("claude-opus-5-5", { provider: "openrouter", id: "claude-opus-5-5" })).toBe(true);
    expect(selectorMatches("anthropic/claude-opus-5-5", { provider: "openrouter", id: "claude-opus-5-5" })).toBe(false);
    expect(selectorMatches("anthropic/*", OPUS)).toBe(true);
    expect(selectorMatches("anthropic/*", { provider: "openai", id: "gpt-5.5" })).toBe(false);
    expect(selectorMatches("claude-opus-*", OPUS)).toBe(true);
    expect(selectorMatches("anthropic/claude-opus-*", OPUS)).toBe(true);
    expect(selectorMatches("claude-sonnet-*", OPUS)).toBe(false);
    expect(selectorMatches("", OPUS)).toBe(false);
  });

  test("models compare ignoring case", () => {
    expect(selectorMatches("Anthropic/Claude-Opus-5-5", OPUS)).toBe(true);
    expect(selectorMatches("CLAUDE-OPUS-*", OPUS)).toBe(true);
    expect(selectorMatches("anthropic/claude-opus-5-5", { provider: "Anthropic", id: "Claude-Opus-5-5" })).toBe(true);
  });

  // tf-hostd's own cases (`crates/tf-hostd/src/refusal/tests.rs`, `model_selectors_match_by_id_provider_and_family…`): the
  // part before `/` is the provider, the rest a pattern for the id alone. A refusal that names no model is an empty id.
  test("the provider part names the provider, the pattern only the id, as tf-hostd parses them", () => {
    const opus = (provider?: string) => ({ ...(provider ? { provider } : {}), id: "claude-opus-5-5" });
    expect(selectorMatches("anthropic/claude-opus-4-8", OPUS)).toBe(false);
    expect(selectorMatches("claude-opus-5", OPUS)).toBe(false);
    expect(selectorMatches("openrouter/claude-opus-5-5", OPUS)).toBe(false);
    expect(selectorMatches("openai/*", OPUS)).toBe(false);
    expect(selectorMatches("anthropic/claude-sonnet-*", OPUS)).toBe(false);
    expect(selectorMatches("openai/claude-opus-*", OPUS)).toBe(false);
    expect(selectorMatches("claude-opus-*:xhigh", OPUS)).toBe(true);
    expect(selectorMatches("ollama/llama3", { provider: "ollama", id: "llama3:8b" })).toBe(false);
    // A bare prefix is a family of ids: `anthropic*` names no Anthropic model (a rule that would never fire there).
    expect(selectorMatches("anthropic*", OPUS)).toBe(false);
    expect(selectorMatches("anthropic/claude*", OPUS)).toBe(true);
    expect(selectorMatches("claude*", OPUS)).toBe(true);
    // A selector's provider never matches a refusal that names none; a bare id still does.
    expect(selectorMatches("anthropic/claude-opus-5-5", opus())).toBe(false);
    expect(selectorMatches("anthropic/*", opus())).toBe(false);
    expect(selectorMatches("claude-opus-5-5", opus())).toBe(true);
    // Anything; and a refusal that names no model matches only that, or its provider's `*`.
    expect(selectorMatches("*", { id: "" })).toBe(true);
    expect(selectorMatches("*:high", OPUS)).toBe(true);
    expect(selectorMatches("claude-opus-5-5", { provider: "anthropic", id: "" })).toBe(false);
    expect(selectorMatches("anthropic/claude-opus-*", { provider: "anthropic", id: "" })).toBe(false);
    expect(selectorMatches("anthropic/*", { provider: "anthropic", id: "" })).toBe(true);
  });

  test("a rule never falls back to the model that was refused", () => {
    expect(ruleMatches(rule(), CYBER, OPUS)).toBe(true);
    expect(ruleMatches(rule({ from: undefined }), CYBER, SONNET)).toBe(false);
    expect(ruleMatches(rule({ from: "anthropic/*" }), CYBER, SONNET)).toBe(false);
    expect(ruleMatches(rule({ from: "anthropic/*" }), CYBER, { provider: "anthropic", id: "claude-opus-5" })).toBe(true);
    // tf-hostd's `same_model`: a refused model whose provider isn't known is the model to go to when the ids are equal
    expect(ruleMatches(rule({ from: undefined }), CYBER, { id: "claude-sonnet-5-5" })).toBe(false);
    expect(ruleMatches(rule({ from: undefined }), CYBER, { provider: "openrouter", id: "claude-sonnet-5-5" })).toBe(true);
  });

  test("the first rule that applies decides; one that would go to the refused model is skipped", () => {
    const rules = [rule({ category: "bio", to: "openai/gpt-5.5" }), rule({ category: undefined, from: undefined, to: "openai/gpt-5.5" }), rule()];
    expect(firstMatch(rules, CYBER, OPUS)).toBe(rules[1]);
    expect(firstMatch(rules, { category: "bio" }, OPUS)).toBe(rules[0]);
    expect(firstMatch([rule()], { category: undefined }, OPUS)).toBeUndefined();
    // on the model rule 2 goes to, rule 2 is skipped and rule 3 applies
    const to = { provider: "openai", id: "gpt-5.5" };
    expect(firstMatch([rules[1] as RefusalRule, rule({ from: undefined, to: "anthropic/claude-sonnet-5-5" })], CYBER, to)?.to).toBe("anthropic/claude-sonnet-5-5");
  });
});

describe("the refusal row that can be retried", () => {
  const user = (id: string): TranscriptItem => ({ kind: "user", id, at: 1, text: "go", images: [], steering: false, synthetic: false });
  const said = (id: string, extra: Partial<Extract<TranscriptItem, { kind: "assistant" }>> = {}): TranscriptItem => ({ kind: "assistant", id, at: 2, text: "ok", streaming: false, stopReason: "stop", ...extra });
  const refused = (id: string): TranscriptItem => said(id, { text: "", stopReason: "error", error: "Refusal (cyber): no", refusal: { kind: "refusal", category: "cyber" } });
  const notice: TranscriptItem = { kind: "notice", id: "n", at: 3, level: "warn", text: "Fallback", source: "fallback" };
  const mode: TranscriptItem = { kind: "mode", id: "m", at: 3, text: "Model: x" };
  const id = (rows: TranscriptItem[]) => lastRefusalRowId(rows.length, (i) => rows[i]);

  test("the turn ended on a refusal, notices and markers after it aside", () => {
    expect(id([user("u"), refused("r")])).toBe("r");
    expect(id([user("u"), refused("r"), notice, mode])).toBe("r");
    expect(id([refused("r"), { kind: "compaction", id: "c", at: 4, summary: "…" }])).toBe("r");
  });

  test("a prompt, a reply or a tool call after it, and it is not the turn to retry", () => {
    expect(id([refused("r"), user("u2")])).toBeUndefined();
    expect(id([user("u"), refused("r"), notice, said("a2")])).toBeUndefined();
    expect(id([refused("r"), { kind: "tool", id: "t", at: 5, callId: "c", tool: "bash", title: "ls", args: {}, status: "ok", truncated: false }])).toBeUndefined();
  });

  test("an ordinary failure, a normal turn or nothing loaded has no refusal", () => {
    expect(id([user("u"), said("a", { text: "", stopReason: "error", error: "529 Overloaded" })])).toBeUndefined();
    expect(id([user("u"), said("a")])).toBeUndefined();
    expect(id([])).toBeUndefined();
  });
});
