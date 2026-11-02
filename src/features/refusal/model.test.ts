import { describe, expect, test } from "bun:test";
import type { ModelInfo, RefusalRule } from "@/core/gen";
import { MAX_RULES } from "@/core/refusal";
import { checkDraft, draftOf, moved, NEW_DRAFT, type RuleDraft, refusedModel, restored, retryTarget, ruleOf, ruleWords, sameRule, sameRules, selectorName, suggestedRule, withRule, without } from "./model";

const model = (provider: string, id: string, label?: string): ModelInfo => ({ provider, id, label, thinking: ["off", "low", "high"] });
const CATALOG: ModelInfo[] = [
  model("anthropic", "claude-opus-5", "Claude Opus 5"),
  model("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
  model("anthropic", "claude-opus-4-5-20251101", "Claude Opus 4.5"),
  model("anthropic", "claude-opus-4-5", "Claude Opus 4.5"),
  model("anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
  model("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("anthropic", "claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
  model("openai", "gpt-5.5", "GPT-5.5"),
  model("ollama", "llama3:8b"),
];
const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const CYBER = { category: "cyber" };
const rule = (r: Partial<RefusalRule> = {}): RefusalRule => ({ category: "cyber", from: "anthropic/claude-opus-5-5", to: "anthropic/claude-sonnet-5-5", after: "stay", ...r });

describe("names", () => {
  test("a rule's selector: a model, any model, a provider, a prefix, one the catalog lacks", () => {
    expect(selectorName(CATALOG, "anthropic/claude-opus-5-5:high")).toBe("Opus 5.5");
    expect(selectorName(CATALOG, undefined)).toBe("any model");
    expect(selectorName(CATALOG, "*")).toBe("any model");
    expect(selectorName(CATALOG, "anthropic/*")).toBe("any anthropic model");
    expect(selectorName(CATALOG, "claude-opus-*")).toBe("claude-opus-*");
    expect(selectorName(CATALOG, "claude-sonnet-5")).toBe("Sonnet 5");
    expect(selectorName(CATALOG, "acme/model-x")).toBe("acme/model-x");
  });

  test("the same rule, however its category is cased or its optional fields are spelled", () => {
    expect(sameRule(rule(), rule({ category: "Cyber" }))).toBe(true);
    expect(sameRule(rule({ category: undefined }), rule({ category: "any" }))).toBe(true);
    expect(sameRule(rule({ to: "anthropic/claude-sonnet-5-5:high" }), rule({ thinking: "high" }))).toBe(true);
    expect(sameRule(rule(), rule({ from: "Anthropic/Claude-Opus-5-5" }))).toBe(true);
    expect(sameRule(rule(), rule({ after: "back" }))).toBe(false);
    expect(sameRule(rule(), rule({ thinking: "high" }))).toBe(false);
  });
});

describe("the model a refused row names", () => {
  test("the session's own model, then the catalog by id or label, then what the row says", () => {
    expect(refusedModel(CATALOG, "claude-opus-5-5", OPUS)).toBe(OPUS);
    expect(refusedModel(CATALOG, "claude-opus-5-5")).toEqual(OPUS);
    expect(refusedModel(CATALOG, "Claude Opus 5.5")).toEqual(OPUS);
    expect(refusedModel(CATALOG, "acme/model-x")).toEqual({ provider: "acme", id: "model-x" });
    expect(refusedModel(CATALOG, "mystery")).toEqual({ id: "mystery" });
    expect(refusedModel(CATALOG, undefined, OPUS)).toBe(OPUS);
    expect(refusedModel(CATALOG, " ")).toBeUndefined();
  });
});

describe("what Retry with starts on", () => {
  test("the host's own rule for this refusal, with its thinking level", () => {
    const rules = [rule({ to: "openai/gpt-5.5", thinking: "high" })];
    expect(retryTarget(CATALOG, rules, CYBER, OPUS)).toEqual({ model: "openai/gpt-5.5", thinking: "high", why: "rule" });
    // a level typed on the model counts as the thinking level, as the host reads it
    expect(retryTarget(CATALOG, [rule({ to: "openai/gpt-5.5:low" })], CYBER, OPUS)).toEqual({ model: "openai/gpt-5.5", thinking: "low", why: "rule" });
  });

  test("else the newest Sonnet of the refused model's provider, never a dated snapshot first", () => {
    expect(retryTarget(CATALOG, [], CYBER, OPUS)).toEqual({ model: "anthropic/claude-sonnet-5-5", why: "sonnet" });
    // Sonnet 5.5 refused too: the next Sonnet, not the same model
    expect(retryTarget(CATALOG, [], CYBER, { provider: "anthropic", id: "claude-sonnet-5-5" })).toEqual({ model: "anthropic/claude-sonnet-5", why: "sonnet" });
    const dated = [model("anthropic", "claude-sonnet-4-5-20250929"), model("anthropic", "claude-sonnet-4-5"), model("anthropic", "claude-opus-5")];
    expect(retryTarget(dated, [], CYBER, { provider: "anthropic", id: "claude-opus-5" })?.model).toBe("anthropic/claude-sonnet-4-5");
  });

  test("a rule that sends the refused model to itself isn't taken; with no Sonnet, another model of the provider, then any", () => {
    const rules = [rule({ from: undefined, to: "anthropic/claude-opus-5-5" })];
    expect(retryTarget(CATALOG, rules, CYBER, OPUS)?.why).toBe("sonnet");
    const noSonnet = [model("anthropic", "claude-opus-5-5"), model("openai", "gpt-5.5"), model("anthropic", "claude-haiku-5")];
    expect(retryTarget(noSonnet, [], CYBER, OPUS)).toEqual({ model: "anthropic/claude-haiku-5", why: "other" });
    expect(retryTarget([model("openai", "gpt-5.5")], [], CYBER, OPUS)).toEqual({ model: "openai/gpt-5.5", why: "other" });
    expect(retryTarget([model("anthropic", "claude-opus-5-5")], [], CYBER, OPUS)).toBeUndefined();
    expect(retryTarget([], [], CYBER, OPUS)).toBeUndefined();
  });

  test("a refused model with no provider is excluded by its id", () => {
    const only = [model("anthropic", "claude-opus-5-5"), model("openai", "gpt-5.5")];
    expect(retryTarget(only, [], CYBER, { id: "claude-opus-5-5" })?.model).toBe("openai/gpt-5.5");
  });
});

describe("the suggestion", () => {
  test("Opus → Sonnet of the newest version both exist in, for cyber refusals, staying on Sonnet", () => {
    expect(suggestedRule(CATALOG, [])).toEqual({ category: "cyber", from: "anthropic/claude-opus-5-5", to: "anthropic/claude-sonnet-5-5", after: "stay" });
  });

  test("a newer Opus with no Sonnet of its version doesn't make a pair; the pair is of one provider", () => {
    const models = [model("anthropic", "claude-opus-6"), model("anthropic", "claude-opus-5"), model("anthropic", "claude-sonnet-5"), model("bedrock", "claude-sonnet-6")];
    expect(suggestedRule(models, [])?.from).toBe("anthropic/claude-opus-5");
    expect(suggestedRule([model("anthropic", "claude-opus-5"), model("openai", "gpt-5.5")], [])).toBeUndefined();
    expect(suggestedRule([], [])).toBeUndefined();
  });

  test("an undated name is used rather than its snapshot", () => {
    const models = [model("anthropic", "claude-opus-4-5-20251101"), model("anthropic", "claude-opus-4-5"), model("anthropic", "claude-sonnet-4-5-20250929"), model("anthropic", "claude-sonnet-4-5")];
    expect(suggestedRule(models, [])).toMatchObject({ from: "anthropic/claude-opus-4-5", to: "anthropic/claude-sonnet-4-5" });
  });

  test("not offered once a rule already decides cyber refusals on that Opus", () => {
    expect(suggestedRule(CATALOG, [rule()])).toBeUndefined();
    expect(suggestedRule(CATALOG, [rule({ category: "Cyber" })])).toBeUndefined();
    expect(suggestedRule(CATALOG, [rule({ category: undefined, from: undefined, to: "openai/gpt-5.5" })])).toBeUndefined();
    expect(suggestedRule(CATALOG, [rule({ from: "anthropic/*" })])).toBeUndefined();
    // other categories or other models leave it open
    expect(suggestedRule(CATALOG, [rule({ category: "bio" })])).toBeDefined();
    expect(suggestedRule(CATALOG, [rule({ from: "anthropic/claude-opus-5" })])).toBeDefined();
  });
});

describe("how a rule reads", () => {
  test("when, where to and what follows", () => {
    expect(ruleWords(rule(), CATALOG)).toEqual({
      when: "Cyber refusals on Opus 5.5",
      to: "Sonnet 5.5",
      then: "Keeps the thinking level · stays on Sonnet 5.5",
      sentence: "Cyber refusals on Opus 5.5: the turn goes on with Sonnet 5.5, keeping the thinking level; the agent then stays on Sonnet 5.5.",
    });
    expect(ruleWords(rule({ category: undefined, from: undefined, thinking: "high", after: "back" }), CATALOG)).toEqual({
      when: "Any refusal on any model",
      to: "Sonnet 5.5",
      then: "Thinking high · switches back to the refused model afterwards",
      sentence: "Any refusal on any model: the turn goes on with Sonnet 5.5 at thinking high; the agent then switches back to the refused model.",
    });
    expect(ruleWords(rule({ after: "back" }), CATALOG).then).toBe("Keeps the thinking level · switches back to Opus 5.5 afterwards");
    expect(ruleWords(rule({ category: "bio", from: "anthropic/*" }), CATALOG).when).toBe("Bio refusals on any anthropic model");
    expect(ruleWords(rule({ to: "anthropic/claude-sonnet-5-5:low" }), CATALOG).then).toBe("Thinking low · stays on Sonnet 5.5");
  });
});

describe("the rule form", () => {
  const draft = (patch: Partial<RuleDraft> = {}): RuleDraft => ({ ...NEW_DRAFT, from: "anthropic/claude-opus-5-5", to: "anthropic/claude-sonnet-5-5", ...patch });

  test("cyber on Opus 5.5 → Sonnet 5.5 is a valid rule, and what is saved has no defaults in it", () => {
    const check = checkDraft(draft(), [], null);
    expect(check.errors).toEqual({});
    expect(check.rule).toEqual({ category: "cyber", from: "anthropic/claude-opus-5-5", to: "anthropic/claude-sonnet-5-5", after: "stay" });
    expect(Object.keys(check.rule as object).sort()).toEqual(["after", "category", "from", "to"]);
    // any refusal on any model: no category, no from
    expect(checkDraft(draft({ category: "any", from: undefined }), [], null).rule).toEqual({ to: "anthropic/claude-sonnet-5-5", after: "stay" });
  });

  test("the model to go on with is required, concrete and a provider/id; a level typed on it is the thinking level", () => {
    expect(checkDraft(draft({ to: undefined }), [], null).errors.to).toBe("Pick the model to go on with");
    expect(checkDraft(draft({ to: "anthropic/*" }), [], null).errors.to).toBe("A concrete model, not a family");
    expect(checkDraft(draft({ to: "claude-sonnet-5-5" }), [], null).errors.to).toBe("Use provider/id");
    expect(checkDraft(draft({ to: "anthropic/claude sonnet" }), [], null).errors.to).toBe("No spaces in a model id");
    expect(checkDraft(draft({ to: "ollama/llama3:8b", from: undefined }), [], null).errors).toEqual({});
    expect(checkDraft(draft({ to: undefined }), [], null).rule).toBeUndefined();
    expect(checkDraft(draft({ to: "anthropic/claude-sonnet-5-5:high" }), [], null).rule).toMatchObject({ to: "anthropic/claude-sonnet-5-5", thinking: "high" });
  });

  test("a * only ends the refused model", () => {
    expect(checkDraft(draft({ from: "anthropic/*" }), [], null).errors).toEqual({});
    expect(checkDraft(draft({ from: "claude-opus-*" }), [], null).errors).toEqual({});
    expect(checkDraft(draft({ from: "anth*/claude" }), [], null).errors.from).toContain("only ends a family");
    expect(checkDraft(draft({ from: "*/claude-opus-5-5" }), [], null).errors.from).toContain("only ends a family");
    // "*" alone is every model: saved as none
    expect(checkDraft(draft({ from: "*" }), [], null).rule).not.toHaveProperty("from");
  });

  test("a model can't fall back to itself, case aside, whatever level was typed", () => {
    expect(checkDraft(draft({ from: "anthropic/claude-sonnet-5-5" }), [], null).errors.from).toContain("fall back to itself");
    expect(checkDraft(draft({ from: "Anthropic/Claude-Sonnet-5-5:high" }), [], null).errors.from).toContain("fall back to itself");
    // a family or any model that contains it is fine: that one model just never falls back to itself
    expect(checkDraft(draft({ from: "anthropic/*" }), [], null).errors).toEqual({});
    expect(checkDraft(draft({ from: undefined }), [], null).errors).toEqual({});
  });

  test("another category needs a one-word name of at most 64 characters, saved lower-cased", () => {
    expect(checkDraft(draft({ category: "other", other: "  " }), [], null).errors.category).toContain("Name the category");
    expect(checkDraft(draft({ category: "other", other: "bio hazard" }), [], null).errors.category).toContain("One word");
    expect(checkDraft(draft({ category: "other", other: "x".repeat(65) }), [], null).errors.category).toContain("at most 64");
    expect(checkDraft(draft({ category: "other", other: " Bio " }), [], null).rule?.category).toBe("bio");
    // "any" typed as the category is every refusal, as tf-hostd keeps it
    expect(checkDraft(draft({ category: "other", other: "ANY" }), [], null).errors.category).toContain("Name the category");
  });

  test("an identical rule is refused; a new one is capped; editing never collides with itself", () => {
    const rules = [rule(), rule({ category: "bio" })];
    expect(checkDraft(draft(), rules, null).errors.rule).toBe("That rule already exists");
    expect(checkDraft(draft(), rules, 0).errors).toEqual({});
    expect(checkDraft(draft({ category: "other", other: "bio" }), rules, 0).errors.rule).toBe("That rule already exists");
    const full = Array.from({ length: MAX_RULES }, (_, i) => rule({ from: `anthropic/model-${i}` }));
    expect(checkDraft(draft(), full, null).errors.rule).toBe(`At most ${MAX_RULES} rules`);
    expect(checkDraft(draft({ thinking: "high" }), full, 3).errors).toEqual({});
  });

  test("a rule an earlier one shadows saves, with a note; the one above it doesn't count as shadowed by itself", () => {
    const earlier = rule({ category: undefined, from: undefined, to: "openai/gpt-5.5" });
    const note = checkDraft(draft(), [earlier], null);
    expect(note.errors).toEqual({});
    expect(note.notes).toHaveLength(1);
    expect(note.notes[0]).toContain("first matching rule wins");
    expect(checkDraft(draft(), [], null).notes).toEqual([]);
    // edited in first place: nothing is above it, however the rules below read
    expect(checkDraft(draft(), [rule({ to: "openai/gpt-5.5" }), earlier], 0).notes).toEqual([]);
    // a narrower rule above doesn't shadow a wider one
    expect(checkDraft(draft({ category: "any", from: undefined }), [rule()], null).notes).toEqual([]);
  });

  test("a rule becomes a draft and back unchanged", () => {
    for (const r of [rule(), rule({ category: undefined, from: undefined, thinking: "high", after: "back" }), rule({ category: "bio", from: "anthropic/*" })]) {
      expect(ruleOf(draftOf(r))).toEqual(r);
    }
    expect(draftOf(rule({ category: "Cyber" })).category).toBe("cyber");
    expect(draftOf(rule({ category: "any" }))).toMatchObject({ category: "any", other: "" });
    expect(draftOf(rule({ category: "bio" }))).toMatchObject({ category: "other", other: "bio" });
  });
});

describe("the list", () => {
  const [a, b, c] = [rule({ to: "a/a" }), rule({ to: "b/b" }), rule({ to: "c/c" })] as [RefusalRule, RefusalRule, RefusalRule];

  test("a rule from a refusal row decides before the rest; a form's new rule comes last", () => {
    expect(withRule([a, b], c, null, "first")).toEqual([c, a, b]);
    expect(withRule([a, b], c, null)).toEqual([a, b, c]);
    expect(withRule([a, b], c, 1)).toEqual([a, c]);
  });

  test("moving a rule changes which one decides; the ends stay", () => {
    expect(moved([a, b, c], 2, -1)).toEqual([a, c, b]);
    expect(moved([a, b, c], 0, 1)).toEqual([b, a, c]);
    expect(moved([a, b, c], 0, -1)).toEqual([a, b, c]);
    expect(moved([a, b, c], 2, 1)).toEqual([a, b, c]);
  });

  test("removing takes that rule out of the list as it is now; Undo puts it back at its place in the list as it is then", () => {
    // removed at 0 while the list was a, b, c; then b went too (another removal, another device)
    expect(without([a, b, c], a, 0)).toEqual([b, c]);
    expect(restored([c], a, 0)).toEqual([a, c]);
    // the place is kept as far as the list goes; a rule that is back already isn't added twice
    expect(restored([b], c, 2)).toEqual([b, c]);
    expect(restored([a, c], a, 0)).toBeUndefined();
    // of two alike, the one at its index; one that is gone already leaves nothing to save
    const a2 = { ...a };
    expect(without([a, b, a2], a2, 2)).toEqual([a, b]);
    expect(without([b, a, c], a, 0)).toEqual([b, c]);
    expect(without([b, c], a, 0)).toBeUndefined();
  });

  test("a list a view shows is still the host's when its rules are alike, in order", () => {
    expect(sameRules([a, b], [{ ...a, from: a.from?.toUpperCase() }, b])).toBe(true);
    expect(sameRules([a, b], [b, a])).toBe(false);
    expect(sameRules([a, b], [a])).toBe(false);
  });
});
