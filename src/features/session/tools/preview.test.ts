import { describe, expect, test } from "bun:test";
import type { FileDiff } from "@/core/gen";
import { hasRichMarkdown, newFileContent, previewOf } from "./preview";

const created = (path: string, lines: string[], count = lines.length): FileDiff => ({
  path,
  patch: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
  added: lines.length,
  removed: 0,
  status: "added",
});

describe("newFileContent", () => {
  test("the added lines of a creating hunk, blank lines included", () => {
    expect(newFileContent(created("a.svg", ["<svg>", "", "</svg>"]).patch)).toBe("<svg>\n\n</svg>");
    expect(newFileContent("@@ -0,0 +1 @@\n+one\n")).toBe("one");
  });

  test("an edit's patch, a truncated write and a second hunk are not the file", () => {
    expect(newFileContent("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")).toBeUndefined();
    expect(newFileContent(created("a.svg", ["x", "y"], 40).patch)).toBeUndefined();
    expect(newFileContent("@@ -0,0 +1,1 @@\n+a\n@@ -9,1 +10,1 @@\n+b\n")).toBeUndefined();
    expect(newFileContent("")).toBeUndefined();
  });
});

describe("previewOf", () => {
  test("svg and mermaid files preview, with their content when the call carries it", () => {
    expect(previewOf(created("docs/logo.svg", ["<svg/>"]))).toEqual({ kind: "svg", content: "<svg/>" });
    expect(previewOf(created("flow.mmd", ["graph TD", "A-->B"]))).toEqual({ kind: "mermaid", content: "graph TD\nA-->B" });
    const edit: FileDiff = { path: "logo.svg", patch: "@@ -1,2 +1,2 @@\n <svg>\n-<a/>\n+<b/>\n", added: 1, removed: 1, status: "modified" };
    expect(previewOf(edit)).toEqual({ kind: "svg", content: undefined });
  });

  test("markdown previews only when it has a diagram or a formula", () => {
    expect(previewOf(created("README.md", ["# Hi", "", "```mermaid", "graph TD", "```"]))?.kind).toBe("markdown");
    expect(previewOf(created("README.md", ["# Hi", "", "plain text with `code`"]))).toBeUndefined();
    expect(previewOf(created("a.md", ["$$", "x", "$$"]))?.kind).toBe("markdown");
    const edit: FileDiff = { path: "a.md", patch: "@@ -1,3 +1,6 @@\n # T\n+```mermaid\n+graph TD\n+```\n x\n", added: 3, removed: 0, status: "modified" };
    expect(previewOf(edit)).toEqual({ kind: "markdown", content: undefined });
  });

  test("other files and deleted files don't preview", () => {
    expect(previewOf(created("a.ts", ["x"]))).toBeUndefined();
    expect(previewOf({ ...created("a.svg", ["<svg/>"]), status: "deleted" })).toBeUndefined();
  });
});

describe("hasRichMarkdown", () => {
  test("fences and display math, in text or in a patch", () => {
    expect(hasRichMarkdown("x\n```mermaid\ngraph\n```")).toBe(true);
    expect(hasRichMarkdown("+```svg\n+<svg/>")).toBe(true);
    expect(hasRichMarkdown("```ts\nconst a = 1\n```")).toBe(false);
    expect(hasRichMarkdown("costs $5 and $10")).toBe(false);
  });
});
