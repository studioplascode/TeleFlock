import { describe, expect, test } from "bun:test";
import { CONFIRM_OPTIONS, needsOptions, optionAnswer, otherAnswer, skipOffered } from "./answers";

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

  test("an agent's browser request offers Deny only where this device can't allow it (a phone, a core without the browser)", () => {
    const options = ["session", "turn", "deny"].map((id) => ({ id, label: id, recommended: false, tone: "neutral" as const }));
    const ask = { kind: "confirm" as const, options, browser: true };
    expect(needsOptions(ask, true).map((o) => o.id)).toEqual(["session", "turn", "deny"]);
    expect(needsOptions(ask, false).map((o) => o.id)).toEqual(["deny"]);
    // Other questions keep their options either way.
    expect(needsOptions({ kind: "confirm", options }, false)).toBe(options);
  });
});

describe("skipOffered", () => {
  test("Skip cancels the dialog, which omp reads as Deny / No: not offered where those are options", () => {
    expect(skipOffered("approval")).toBe(false);
    expect(skipOffered("confirm")).toBe(false);
    expect(skipOffered("planReview")).toBe(false);
  });

  test("asks and inputs keep it", () => {
    expect(skipOffered("ask")).toBe(true);
    expect(skipOffered("input")).toBe(true);
  });
});
