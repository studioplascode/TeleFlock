import { describe, expect, test } from "bun:test";
import type { AutoAnswer } from "@/core/gen";
import { initialAgentDraft, toAgentSpec } from "./AgentFields";

const own: AutoAnswer = { enabled: true, afterSecs: 600, onlyWhenNoApp: true };
const draft = (autoAnswer?: AutoAnswer) => ({ ...initialAgentDraft(undefined), name: "api", prompt: "Fix the login test", ...(autoAnswer ? { autoAnswer } : {}) });

describe("toAgentSpec: decide for me", () => {
  test("a new draft follows the host default", () => {
    expect(initialAgentDraft(undefined).autoAnswer).toBeUndefined();
  });

  test("the agent's own policy goes to a host with decide for me", () => {
    expect(toAgentSpec(draft(own), true)).toMatchObject({ kind: "omp", name: "api", prompt: "Fix the login test", autoAnswer: own });
    // Off is a policy of its own: it wins over a host default that is on.
    const off = { ...own, enabled: false };
    expect(toAgentSpec(draft(off), true).autoAnswer).toEqual(off);
    // A wait the host would refuse is brought within 1 min – 24 h.
    expect(toAgentSpec(draft({ ...own, afterSecs: 5 }), true).autoAnswer?.afterSecs).toBe(60);
  });

  test("the host default sends nothing", () => {
    expect("autoAnswer" in toAgentSpec(draft(), true)).toBe(false);
  });

  test("a host without decide for me never gets the field", () => {
    const spec = toAgentSpec(draft(own), false);
    expect("autoAnswer" in spec).toBe(false);
    expect(spec).toMatchObject({ kind: "omp", name: "api", plan: false });
  });
});
