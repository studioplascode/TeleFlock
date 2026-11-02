import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "@/core/gen";
import { isSessionInternalPath, repoFiles } from "./changedFiles";

const file = (path: string, added = 1, removed = 0): ChangedFile => ({ path, added, removed, status: "modified" });

describe("changed files", () => {
  test("omp-internal paths are not repository files", () => {
    for (const p of ["local://PLAN.md", "local://reports/scan.md", "artifact://12", "agent://Pinger", "/root/.omp/agent/sessions/-repo/2026_ab/local/PLAN.md", "C:\\Temp\\omp-local\\s1\\a.md"]) expect(isSessionInternalPath(p)).toBe(true);
    for (const p of ["src/main.rs", "/repo/docs/local/notes.md", "docs/local://x", "/repo/.omp/rules/a.md", "local.md"]) expect(isSessionInternalPath(p)).toBe(false);
  });

  test("the list keeps real files with their counts, in order", () => {
    const files = [file("src/a.ts", 5, 2), file("local://PLAN.md", 40), file("README.md", 3, 1), file("local://reports/x.md", 9)];
    const kept = repoFiles(files);
    expect(kept.map((f) => f.path)).toEqual(["src/a.ts", "README.md"]);
    expect(kept.reduce((s, f) => s + f.added, 0)).toBe(8);
    expect(repoFiles([file("a")])).toEqual([file("a")]);
  });
});
