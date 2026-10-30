import { describe, expect, test } from "bun:test";
import type { Agent, IdleRecap } from "@/core/gen";
import { currentRecap, restingLine } from "./recap";

const RECAP: IdleRecap = { text: "Tests pass; PR body drafted; waiting on your call about the migration.", at: 1_800_000_000_000 };

function agent(column: Agent["column"], recap: IdleRecap | undefined, line: string | undefined): Pick<Agent, "column" | "omp" | "live"> {
  return {
    column,
    omp: { link: "live", bridge: true, fast: false, mode: "normal", queue: { steering: [], followUp: [] }, ...(recap ? { recap } : {}) },
    live: { streaming: false, thinking: false, ...(line ? { line } : {}) },
  };
}

describe("idle recap line", () => {
  test("idle cards show omp's recap instead of the last line", () => {
    expect(restingLine(agent("review", RECAP, "All green."))).toEqual({ text: RECAP.text, recap: RECAP });
    expect(restingLine(agent("done", RECAP, undefined))).toEqual({ text: RECAP.text, recap: RECAP });
  });

  test("no recap: the last assistant line, else nothing", () => {
    expect(restingLine(agent("review", undefined, "All green."))).toEqual({ text: "All green." });
    expect(restingLine(agent("done", undefined, undefined))).toBeNull();
    expect(restingLine({ column: "review", live: { streaming: false, thinking: false, line: "Plain agent." } })).toEqual({ text: "Plain agent." });
  });

  test("a working or waiting agent never shows a recap", () => {
    expect(currentRecap(agent("running", RECAP, "Editing src/app.ts"))).toBeUndefined();
    expect(currentRecap(agent("needs", RECAP, undefined))).toBeUndefined();
    expect(restingLine(agent("running", RECAP, "Editing src/app.ts"))).toEqual({ text: "Editing src/app.ts" });
    expect(currentRecap(agent("review", RECAP, undefined))).toBe(RECAP);
  });
});
