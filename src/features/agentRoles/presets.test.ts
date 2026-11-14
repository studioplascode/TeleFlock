import { describe, expect, test } from "bun:test";
import type { AutoAnswer, ModelInfo, ModelPreset } from "@/core/gen";
import {
  cleanPresetName,
  everyRole,
  everywhereModel,
  isHostDefaults,
  MAX_PRESET_NAME,
  matchingPreset,
  newPreset,
  newPresetId,
  oneModelEverywhere,
  type PresetFields,
  presetFields,
  presetNameProblem,
  presetSummary,
  removePreset,
  renamePreset,
  resetPatch,
  restorePreset,
  roleGroups,
  sessionFields,
  sessionMaps,
  suggestPresetName,
  upsertPreset,
  withPreset,
} from "./presets";

const models: ModelInfo[] = [
  { provider: "anthropic", id: "claude-opus-5", label: "opus-5", thinking: ["low", "high", "max"] },
  { provider: "openai-codex", id: "gpt-6-luna", label: "luna", thinking: ["low", "medium", "high"] },
];
const OPUS = "anthropic/claude-opus-5";
const LUNA = "openai-codex/gpt-6-luna";
const policy: AutoAnswer = { enabled: true, afterSecs: 600, onlyWhenNoApp: false };

const preset = (over: Partial<ModelPreset> = {}): ModelPreset => ({ id: "mp-1", name: "Cheap subagents", roleModels: { task: `${LUNA}:medium` }, fallbackChains: { "anthropic/*": ["openai/*"] }, ...over });
const fields = (over: Partial<PresetFields> = {}): PresetFields => ({ model: "default", thinking: "default", roleModels: {}, fallbackChains: {}, ...over });

describe("applying presets", () => {
  test("absent members are the host's; the maps are copies of the saved ones", () => {
    const p = preset({ roleModels: { task: ` ${LUNA}:medium `, empty: " " } });
    const f = presetFields(p);
    expect(f).toEqual({ model: "default", thinking: "default", roleModels: { task: `${LUNA}:medium` }, fallbackChains: { "anthropic/*": ["openai/*"] } });
    f.roleModels.smol = LUNA;
    f.fallbackChains["anthropic/*"]?.push("google/*");
    expect(p.roleModels).toEqual({ task: ` ${LUNA}:medium `, empty: " " });
    expect(p.fallbackChains).toEqual({ "anthropic/*": ["openai/*"] });
    expect(presetFields(preset({ model: OPUS, thinking: "max" }))).toMatchObject({ model: OPUS, thinking: "max" });
  });

  test("a preset clears the template and keeps plan mode and decide for me", () => {
    const options = { templateId: "tpl-careful-reviewer", model: OPUS, thinking: "high" as const, plan: true, roleModels: { smol: LUNA }, autoAnswer: policy };
    expect(withPreset(options, presetFields(preset({ model: LUNA })))).toEqual({
      templateId: null,
      model: LUNA,
      thinking: "default",
      plan: true,
      roleModels: { task: `${LUNA}:medium` },
      fallbackChains: { "anthropic/*": ["openai/*"] },
      autoAnswer: policy,
    });
    // A form without templates gets no templateId.
    expect("templateId" in withPreset({ model: OPUS, thinking: "default" as const, plan: false }, presetFields(preset()))).toBe(false);
  });

  test("Reset all: the host's model, thinking, roles, chains and decide for me; plan mode stays", () => {
    const options = { templateId: "tpl-fast-fixer", model: LUNA, thinking: "low" as const, plan: true, roleModels: { smol: LUNA }, fallbackChains: { default: [] }, autoAnswer: policy };
    const reset = withPreset(options, resetPatch());
    expect(reset).toMatchObject({ templateId: null, model: "default", thinking: "default", plan: true, roleModels: {}, fallbackChains: {} });
    expect(reset.autoAnswer).toBeUndefined();
    // Stored as JSON (Dispatch's options), the policy is gone rather than kept by a merge.
    expect(JSON.parse(JSON.stringify(reset))).not.toHaveProperty("autoAnswer");
    expect(isHostDefaults(resetPatch())).toBe(true);
  });

  test("host defaults: anything of its own counts, an empty chain (no fallbacks) included", () => {
    expect(isHostDefaults(fields())).toBe(true);
    expect(isHostDefaults(fields({ thinking: "high" }))).toBe(false);
    expect(isHostDefaults(fields({ fallbackChains: { default: [] } }))).toBe(false);
    expect(isHostDefaults(fields({ roleModels: { smol: " " } }))).toBe(true);
    expect(isHostDefaults({ ...fields(), autoAnswer: policy })).toBe(false);
  });

  test("the matching preset: same fields in any key order, the first of equal ones", () => {
    const a = preset({ id: "a", roleModels: { task: `${LUNA}:medium`, smol: LUNA } });
    const b = preset({ id: "b", name: "Same again", roleModels: { smol: LUNA, task: `${LUNA}:medium` } });
    const f = fields({ roleModels: { smol: LUNA, task: `${LUNA}:medium` }, fallbackChains: { "anthropic/*": ["openai/*"] } });
    expect(matchingPreset([a, b], f)?.id).toBe("a");
    expect(matchingPreset([a, b], { ...f, thinking: "high" })).toBeUndefined();
    // Chain order is the order omp tries them in.
    expect(matchingPreset([preset({ fallbackChains: { default: ["a/b", "c/d"] } })], fields({ roleModels: { task: `${LUNA}:medium` }, fallbackChains: { default: ["c/d", "a/b"] } }))).toBeUndefined();
  });
});

describe("saving presets", () => {
  test("a new preset leaves the host's model and thinking out and cleans its maps", () => {
    const p = newPreset("mp-x", "  Opus\n everywhere ", fields({ model: OPUS, roleModels: { smol: ` ${OPUS}:high`, blank: "" }, fallbackChains: { " default ": [" a/b ", ""] } }));
    expect(p).toEqual({ id: "mp-x", name: "Opus everywhere", model: OPUS, roleModels: { smol: `${OPUS}:high` }, fallbackChains: { default: ["a/b"] } });
    expect("thinking" in p).toBe(false);
  });

  test("names: required, bounded, unique ignoring case and spacing, except the renamed preset itself", () => {
    const list = [preset({ id: "a", name: "Opus  everywhere" })];
    expect(presetNameProblem("  ", list)).toBe("Give it a name");
    expect(presetNameProblem("opus everywhere", list)).toBe("A preset with that name exists");
    expect(presetNameProblem("opus everywhere", list, "a")).toBeNull();
    expect(presetNameProblem("x".repeat(MAX_PRESET_NAME), list)).toBeNull();
    expect(presetNameProblem("x".repeat(MAX_PRESET_NAME + 1), list)).toBe(`At most ${MAX_PRESET_NAME} characters`);
    expect(cleanPresetName(" a \t b ")).toBe("a b");
  });

  test("ids are tf-client's kind: mp- and base36", () => {
    expect(newPresetId(1_700_000_000_000, () => 0.5)).toMatch(/^mp-[a-z0-9]+-[a-z0-9]+$/);
    expect(newPresetId(1, () => 0)).toBe("mp-1-0");
  });

  test("list edits: upsert in place, rename, remove, undo a removal at its place", () => {
    const a = preset({ id: "a", name: "A" });
    const b = preset({ id: "b", name: "B" });
    const c = preset({ id: "c", name: "C" });
    expect(upsertPreset([a, b], c).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(upsertPreset([a, b], { ...a, name: "A2" }).map((p) => p.name)).toEqual(["A2", "B"]);
    expect(renamePreset([a, b], "b", "  New  name ")[1]?.name).toBe("New name");
    const without = removePreset([a, b, c], "b");
    expect(without.map((p) => p.id)).toEqual(["a", "c"]);
    expect(restorePreset(without, b, 1).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(restorePreset([a, b], b, 0).map((p) => p.id)).toEqual(["a", "b"]);
    expect(restorePreset([], b, 5).map((p) => p.id)).toEqual(["b"]);
  });

  test("a suggested name says what it runs and is never taken", () => {
    const opus = oneModelEverywhere(fields(), OPUS, "max", ["smol", "task"]);
    expect(suggestPresetName(opus, models, [])).toBe("opus-5 everywhere");
    expect(suggestPresetName(opus, models, [preset({ name: "Opus-5 everywhere" }), preset({ id: "b", name: "opus-5 everywhere 2" })])).toBe("opus-5 everywhere 3");
    expect(suggestPresetName(fields({ model: LUNA, thinking: "low" }), models, [])).toBe("luna low");
    expect(suggestPresetName(fields({ roleModels: { task: LUNA } }), models, [])).toBe("Own roles");
    expect(suggestPresetName(fields({ model: "acme/x".padEnd(80, "x") }), [], []).length).toBeLessThanOrEqual(MAX_PRESET_NAME);
  });
});

describe("showing presets", () => {
  test("summary: main model, level, roles and chains; host defaults when empty", () => {
    expect(presetSummary(presetFields(preset({ model: OPUS, thinking: "max" })), models)).toBe("opus-5 · max · 1 role · 1 fallback chain");
    expect(presetSummary(fields({ thinking: "high" }), models)).toBe("default model · high");
    expect(presetSummary(fields(), models)).toBe("host defaults");
  });

  test("roles grouped by what they run, biggest group first", () => {
    expect(roleGroups({ task: `${LUNA}:medium`, smol: `${OPUS}:high`, slow: `${OPUS}:high` }, models)).toEqual([
      { roles: ["smol", "slow"], model: "opus-5 · high" },
      { roles: ["task"], model: "luna · medium" },
    ]);
  });
});

describe("one model for every role", () => {
  test("omp's chat roles and the host's and launch's custom ones; never default or the model kinds", () => {
    const roles = everyRole(["default", "smol", "designer", "image", "judge", "bad name"], { reviewer: LUNA, web: LUNA });
    expect(roles).toContain("smol");
    expect(roles).toContain("task");
    expect(roles).toContain("advisor");
    expect(roles.slice(-2)).toEqual(["designer", "reviewer"]);
    for (const no of ["default", "image", "judge", "web", "speech", "dictation", "bad name"]) expect(roles).not.toContain(no);
    expect(new Set(roles).size).toBe(roles.length);
  });

  test("the main model and every role run it; model kinds and chains stay; an own default goes", () => {
    const before = fields({ model: LUNA, roleModels: { default: LUNA, image: "openai/gpt-image-2", smol: LUNA }, fallbackChains: { default: ["openai/*"] } });
    const after = oneModelEverywhere(before, OPUS, "max", ["smol", "task", "default"]);
    expect(after).toEqual({ model: OPUS, thinking: "max", roleModels: { image: "openai/gpt-image-2", smol: `${OPUS}:max`, task: `${OPUS}:max` }, fallbackChains: { default: ["openai/*"] } });
    expect(everywhereModel(after)).toBeUndefined(); // the image role runs another model
    expect(everywhereModel(oneModelEverywhere(fields(), OPUS, undefined, ["smol"]))).toBe(OPUS);
    expect(oneModelEverywhere(fields(), OPUS, undefined, ["smol"])).toMatchObject({ thinking: "default", roleModels: { smol: OPUS } });
  });
});

describe("a running session's roles", () => {
  test("its own Default is the main model, both ways", () => {
    const f = sessionFields({ default: `${OPUS}:max`, smol: LUNA }, { default: [] });
    expect(f).toEqual({ model: OPUS, thinking: "max", roleModels: { smol: LUNA }, fallbackChains: { default: [] } });
    expect(sessionMaps(f)).toEqual({ roles: { default: `${OPUS}:max`, smol: LUNA }, chains: { default: [] } });
    expect(sessionFields({}, {})).toEqual(fields());
    expect(sessionMaps(fields())).toEqual({ roles: {}, chains: {} });
  });

  test("a level without a model goes on the host's default; an own default role wins over the main model", () => {
    expect(sessionMaps(fields({ thinking: "low" }), `${OPUS}:high`).roles).toEqual({ default: `${OPUS}:low` });
    expect(sessionMaps(fields({ thinking: "low" })).roles).toEqual({});
    expect(sessionMaps(fields({ model: LUNA, roleModels: { default: `${OPUS}:high`, task: LUNA } })).roles).toEqual({ default: `${OPUS}:high`, task: LUNA });
  });

  test("a saved preset matches the session it was applied to", () => {
    const p = newPreset("mp-s", "Opus everywhere", oneModelEverywhere(fields(), OPUS, "max", ["smol", "task"]));
    const { roles, chains } = sessionMaps(presetFields(p));
    expect(matchingPreset([p], sessionFields(roles, chains))?.id).toBe("mp-s");
  });
});
