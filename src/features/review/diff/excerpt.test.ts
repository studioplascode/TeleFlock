import { describe, expect, test } from "bun:test";
import { fileList, patchExcerpt } from "./excerpt";

const file = (path: string, hunks: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
const hunk = (n: number, body: string) => `@@ -${n},1 +${n},1 @@\n-old\n+${body}\n`;

describe("patchExcerpt", () => {
  const a = file("a.ts", [hunk(1, "x".repeat(40)), hunk(9, "y".repeat(40))]);
  const b = file("b.ts", [hunk(1, "z".repeat(40))]);

  test("returns a patch that fits unchanged", () => {
    expect(patchExcerpt(a + b, 10_000)).toBe(a + b);
  });

  test("cuts at a file boundary and marks the cut", () => {
    const out = patchExcerpt(a + b, a.length + 30);
    expect(out.startsWith(a)).toBe(true);
    expect(out).not.toContain("b.ts");
    expect(out).toContain("diff truncated");
    expect(out.length).toBeLessThanOrEqual(a.length + 30);
  });

  test("cuts inside the first file at a hunk boundary", () => {
    const out = patchExcerpt(a + b, a.length - 10);
    expect(out).toContain("x".repeat(40));
    expect(out).not.toContain("y".repeat(40));
    expect(out.length).toBeLessThanOrEqual(a.length - 10);
  });

  test("keeps only the requested paths", () => {
    expect(patchExcerpt(a + b, 10_000, new Set(["b.ts"]))).toBe(b);
  });
});

test("fileList prints status letter, path and counts", () => {
  expect(
    fileList([
      { path: "src/a.ts", added: 3, removed: 1, status: "modified" },
      { path: "src/new.ts", oldPath: "src/old.ts", added: 0, removed: 0, status: "renamed" },
    ]),
  ).toBe("M src/a.ts (+3 -1)\nR src/old.ts → src/new.ts (+0 -0)");
});
