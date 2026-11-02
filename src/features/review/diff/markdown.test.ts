import { describe, expect, test } from "bun:test";
import { addedLines, estimateChunkHeight, isMarkdownPath, markdownChunks, oldText } from "./markdown";
import { parsePatch } from "./parse";

describe("markdown files", () => {
  test("which paths get a Rendered view", () => {
    for (const p of ["README.md", "docs/a.MD", "notes.markdown", "docs/page.mdx"]) expect(isMarkdownPath(p)).toBe(true);
    for (const p of ["a.mdc", "md", "src/md.ts", "README.md.bak", "docs/mdx"]) expect(isMarkdownPath(p)).toBe(false);
  });

  test("old text of a deleted file and the added lines of an edit come from the patch", () => {
    const deleted = parsePatch("diff --git a/n.md b/n.md\ndeleted file mode 100644\n--- a/n.md\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-# Notes\n-\n-gone\n")[0]!;
    expect(oldText(deleted)).toBe("# Notes\n\ngone\n");
    const edited = parsePatch("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -2,3 +2,4 @@\n ctx\n-old\n+new\n+newer\n ctx2\n")[0]!;
    expect([...addedLines(edited)]).toEqual([3, 4]);
    expect(addedLines(deleted).size).toBe(0);
  });
});

describe("markdown chunks", () => {
  const doc = ["# Title", "", "intro", "", "```md", "", "# not a heading", "", "```", "", "- a", "- b", "", "last"].join("\n");

  test("blocks are cut at blank lines, never inside a code fence", () => {
    const chunks = markdownChunks(doc, new Set());
    expect(chunks).toHaveLength(1); // nothing changed: one chunk, blank lines kept
    expect(chunks[0]!.text).toBe(doc);
    const marked = markdownChunks(doc, new Set([7])); // a line inside the fence
    expect(marked.map((c) => [c.line, c.changed])).toEqual([
      [1, false],
      [5, true],
      [11, false],
    ]);
    expect(marked[1]!.text).toBe("```md\n\n# not a heading\n\n```");
  });

  test("consecutive blocks with the same state share a chunk; chunks tile the document in order", () => {
    const chunks = markdownChunks(doc, new Set([1, 3, 12]));
    expect(chunks.map((c) => [c.line, c.changed])).toEqual([
      [1, true],
      [5, false],
      [11, true],
      [14, false],
    ]);
    expect(chunks.map((c) => c.text).join("\n\n").replace(/\n{3,}/g, "\n\n")).toBe(doc.replace(/\n{3,}/g, "\n\n"));
  });

  test("a front-matter header is one block; CRLF and a missing final newline are fine", () => {
    const chunks = markdownChunks("---\r\ntitle: x\r\n\r\nstill: yaml\r\n---\r\n\r\nbody\r\n", new Set([7]));
    expect(chunks.map((c) => [c.line, c.changed, c.text])).toEqual([
      [1, false, "---\ntitle: x\n\nstill: yaml\n---"],
      [7, true, "body"],
    ]);
    expect(markdownChunks("", new Set())).toEqual([]);
  });

  test("a long document is cut in linear time", () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `## Section ${i}\n\ntext ${i}\n`).join("\n");
    const t = performance.now();
    const chunks = markdownChunks(big, new Set([5, 9_001, 100_001]));
    expect(performance.now() - t).toBeLessThan(500);
    expect(chunks.filter((c) => c.changed)).toHaveLength(3);
    expect(estimateChunkHeight(chunks[0]!)).toBeGreaterThan(30);
  });
});
