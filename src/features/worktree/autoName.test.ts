import { describe, expect, test } from "bun:test";
import { autoBranchName } from "./autoName";

describe("autoBranchName", () => {
  const none = new Set<string>();

  test("uses the suggestion when git accepts it", () => {
    expect(autoBranchName("offline-cache", "Add offline caching to the client", none)).toEqual({ name: "offline-cache", ai: true });
  });

  test("falls back to the task's words without a usable suggestion", () => {
    expect(autoBranchName(null, "Add offline caching to the client", none)).toEqual({ name: "offline-caching-client", ai: false });
    expect(autoBranchName("  ", "Add offline caching to the client", none)).toEqual({ name: "offline-caching-client", ai: false });
    expect(autoBranchName("has space..", "Fix the login bug", none)).toEqual({ name: "fix-login-bug", ai: false });
  });

  test("dedupes against existing branches", () => {
    const taken = new Set(["offline-cache", "offline-cache-2", "fix-login-bug"]);
    expect(autoBranchName("offline-cache", "x", taken)).toEqual({ name: "offline-cache-3", ai: true });
    expect(autoBranchName(null, "Fix the login bug", taken)).toEqual({ name: "fix-login-bug-2", ai: false });
  });
});
