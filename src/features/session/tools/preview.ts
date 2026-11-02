import type { FileDiff } from "@/core/gen";
import { previewKind } from "../markdown/svg";

/**
 * The whole new file when `patch` is the single hunk that creates it (omp's write tool, an edit
 * `create`): `@@ -0,0 +1,N @@` followed by exactly N added lines. A patch of an edit, a truncated
 * write or anything with context returns undefined: the file isn't in it.
 */
export function newFileContent(patch: string): string | undefined {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  const head = at < 0 ? null : /^@@ -0,0 \+1(?:,(\d+))? @@/.exec(lines[at]!);
  if (!head) return undefined;
  const added: string[] = [];
  const body = lines.slice(at + 1);
  while (body.length && body[body.length - 1] === "") body.pop();
  for (const l of body) {
    if (l.startsWith("+")) added.push(l.slice(1));
    else if (!l.startsWith("\\")) return undefined;
  }
  return added.length === Number(head[1] ?? 1) ? added.join("\n") : undefined;
}

/** Markdown worth rendering: it has a diagram, an SVG or a formula. Matches patch text too (leading `+`/space). */
export function hasRichMarkdown(text: string): boolean {
  return /^[+ ]{0,4} {0,3}(?:`{3,}|~{3,})\s*(?:mermaid|mmd|svg|math)\b/im.test(text) || /^[+ ]{0,4} {0,3}(?:\$\$|\\\[)/m.test(text);
}

/** What the tool card can render for this file: an SVG, a Mermaid file, or Markdown with diagrams or math in it. */
export function previewOf(file: FileDiff): { kind: "svg" | "mermaid" | "markdown"; content?: string } | undefined {
  const kind = previewKind(file.path);
  if (!kind || file.status === "deleted") return undefined;
  const content = newFileContent(file.patch);
  if (kind === "markdown" && !hasRichMarkdown(content ?? file.patch)) return undefined;
  return { kind, content };
}
