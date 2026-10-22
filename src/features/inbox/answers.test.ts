import { describe, expect, test } from "bun:test";
import { CONFIRM_OPTIONS, needsOptions, optionAnswer, otherAnswer } from "./answers";

describe("answer payloads", () => {
  test("Other sends its text without choices (the host ignores text next to choices)", () => {
    expect(otherAnswer("  use the staging DB instead ")).toEqual({ choices: [], text: "use the staging DB instead", cancel: false });
  });

  test("options send their id; the synthetic confirm pair maps to confirm / cancel", () => {
    expect(optionAnswer("Allow once")).toEqual({ choices: ["Allow once"], cancel: false });
    const [confirm, cancel] = needsOptions({ kind: "confirm", options: [] });
    expect(optionAnswer(confirm?.id ?? "")).toEqual({ choices: [], cancel: false });
    expect(optionAnswer(cancel?.id ?? "")).toEqual({ choices: [], cancel: true });
  });

  test("only an option-less confirm gets Confirm / Cancel", () => {
    expect(needsOptions({ kind: "confirm", options: [] })).toBe(CONFIRM_OPTIONS);
    expect(needsOptions({ kind: "input", options: [] })).toEqual([]);
    const own = [{ id: "Yes", label: "Yes", recommended: true, tone: "primary" as const }];
    expect(needsOptions({ kind: "confirm", options: own })).toBe(own);
  });
});
