import { describe, expect, test } from "bun:test";
import type { BranchList } from "@/core/gen";
import { baseOptions, baseParam, fetchPreview, shownBase } from "./base";

const branches: BranchList["branches"] = [
  { name: "main", current: true, remote: false, upstream: "origin/main" },
  { name: "feat/x", current: false, remote: false },
  { name: "origin/main", current: false, remote: true },
  { name: "origin/HEAD", current: false, remote: true },
];
const host: BranchList = { branches, defaultBranch: "main", defaultBase: "origin/main" };
/** A hostd before 0.5.0: no `defaultBase`. */
const older: BranchList = { branches, defaultBranch: "main" };

describe("worktree base", () => {
  test("untouched: shows the default base and leaves the choice to hostd", () => {
    expect(shownBase(host, "")).toBe("origin/main");
    expect(baseParam(host, "")).toBeUndefined();
  });

  test("explicit picks are sent as they are, local main and HEAD included", () => {
    for (const pick of ["main", "HEAD", "feat/x", "origin/main"]) {
      expect(shownBase(host, pick)).toBe(pick);
      expect(baseParam(host, pick)).toBe(pick);
    }
  });

  test("older hosts get what the select shows", () => {
    expect(shownBase(older, "")).toBe("main");
    expect(baseParam(older, "")).toBe("main");
    // no default branch / branches not listed: HEAD, sent explicitly (absent means the default base on new hosts)
    expect(baseParam({ branches: [] }, "")).toBe("HEAD");
    expect(baseParam(undefined, "")).toBe("HEAD");
  });

  test("options: default base, local default, others, HEAD", () => {
    expect(baseOptions(host).map((o) => o.value)).toEqual(["origin/main", "main", "feat/x", "HEAD"]);
    expect(baseOptions(older).map((o) => o.value)).toEqual(["main", "feat/x", "origin/main", "HEAD"]);
  });

  test("preview fetches remote bases only", () => {
    expect(fetchPreview(host, "origin/main")?.argv).toEqual(["git", "fetch", "origin", "main"]);
    expect(fetchPreview(host, "main")).toBeNull();
    expect(fetchPreview(host, "HEAD")).toBeNull();
  });
});
