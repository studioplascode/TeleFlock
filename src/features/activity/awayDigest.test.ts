import { describe, expect, test } from "bun:test";
import { awayDigest } from "./awayDigest";

const none = { finished: 0, asked: 0, needsNow: 0, decided: 0, spent: null };

describe("awayDigest", () => {
  test("nothing worth a toast: none", () => {
    expect(awayDigest(none)).toBeNull();
    expect(awayDigest({ ...none, spent: 0.001 })).toBeNull();
  });

  test("questions decided for you are a reason on their own, and lead to their review", () => {
    expect(awayDigest({ ...none, decided: 1 })).toEqual({ parts: ["finished 0", "needs you 0", "decided 1 question for you"], status: "review", action: "review" });
    expect(awayDigest({ ...none, finished: 2, decided: 3, spent: 1.2 })).toEqual({
      parts: ["finished 2", "needs you 0", "decided 3 questions for you", "spent $1.20"],
      status: "review",
      action: "review",
    });
  });

  test("what needs you comes first", () => {
    expect(awayDigest({ ...none, needsNow: 1, decided: 2 })).toMatchObject({ status: "needs-you", action: "answer" });
    expect(awayDigest({ ...none, finished: 1 })).toEqual({ parts: ["finished 1", "needs you 0"], status: "review", action: "activity" });
    expect(awayDigest({ ...none, asked: 1, spent: 0.5 })).toEqual({ parts: ["finished 0", "needs you 0", "spent $0.50"], status: "running", action: "activity" });
  });
});
