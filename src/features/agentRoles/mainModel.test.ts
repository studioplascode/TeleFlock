import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/core/gen";
import { hostTakesRoleModel, mainRoles, mainSelector, roleOf, thinkingChoices } from "./mainModel";

const opus: ModelInfo = { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", thinking: ["off", "low", "medium", "high", "xhigh", "max"] };
const luna: ModelInfo = { provider: "openai-codex", id: "gpt-6-luna", thinking: ["off", "minimal", "low", "medium", "high"] };
const roles = [
  { role: "default", model: "anthropic/claude-opus-5-5:high" },
  { role: "smol", model: "openai-codex/gpt-6-luna:low" },
  { role: "slow", model: "anthropic/claude-opus-5-5:max" },
  { role: "image", model: "google/imagen-5" },
];

describe("main model", () => {
  test("the roles a launch can start on: the agent's own over the host's, never default or a kind role", () => {
    expect(mainRoles(roles).map((r) => r.role)).toEqual(["smol", "slow"]);
    expect(mainRoles(roles, { slow: "openai-codex/gpt-6-luna:high", reviewer: "anthropic/claude-opus-5-5" })).toEqual([
      { role: "smol", model: "openai-codex/gpt-6-luna:low" },
      { role: "slow", model: "openai-codex/gpt-6-luna:high" },
      { role: "reviewer", model: "anthropic/claude-opus-5-5" },
    ]);
  });

  test("what a choice runs: the default role, a role's binding (the agent's own first), or the model", () => {
    expect(roleOf("@slow")).toBe("slow");
    expect(roleOf("@")).toBeNull();
    expect(roleOf("anthropic/claude-opus-5-5")).toBeNull();
    expect(mainSelector("default", roles)).toBe("anthropic/claude-opus-5-5:high");
    expect(mainSelector("@smol", roles)).toBe("openai-codex/gpt-6-luna:low");
    expect(mainSelector("@smol", roles, { smol: "anthropic/claude-opus-5-5" })).toBe("anthropic/claude-opus-5-5");
    expect(mainSelector("@nope", roles)).toBeUndefined();
    expect(mainSelector("openai-codex/gpt-6-luna", roles)).toBe("openai-codex/gpt-6-luna");
  });

  test("the host default and roles offer their model's levels, max and auto included", () => {
    expect(thinkingChoices([opus, luna], mainSelector("default", roles))).toEqual(["off", "low", "medium", "high", "xhigh", "max", "auto"]);
    expect(thinkingChoices([opus, luna], mainSelector("@smol", roles))).toEqual(["off", "minimal", "low", "medium", "high", "auto"]);
    // Not known (catalog not loaded, a role not bound, efforts not listed): every level.
    expect(thinkingChoices([], "anthropic/claude-opus-5-5")).toContain("max");
    expect(thinkingChoices([opus], undefined)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
    expect(thinkingChoices([{ ...opus, thinking: ["off"] }], "anthropic/claude-opus-5-5")).toContain("max");
  });

  test("a daemon starts agents on roles from 0.9.6; an unknown version doesn't count", () => {
    expect(hostTakesRoleModel({ hostdVersion: "0.9.6" })).toBe(true);
    expect(hostTakesRoleModel({ hostdVersion: "1.0.0" })).toBe(true);
    expect(hostTakesRoleModel({ hostdVersion: "0.9.5" })).toBe(false);
    expect(hostTakesRoleModel(undefined)).toBe(false);
  });
});
