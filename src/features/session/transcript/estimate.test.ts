import { describe, expect, test } from "bun:test";
import type { ToolItem, TranscriptItem } from "@/core/gen";
import { estimateRowHeight, initialScrollOffset, wrappedLines } from "./estimate";

const tool = (over: Partial<ToolItem>): TranscriptItem => ({ kind: "tool", id: "t", at: 0, callId: "c", tool: "read", title: "x", args: {}, status: "ok", truncated: false, ...over });
const user = (text: string): TranscriptItem => ({ kind: "user", id: "u", at: 0, text, images: [], steering: false, synthetic: false });
const said = (text: string): TranscriptItem => ({ kind: "assistant", id: "a", at: 0, text, streaming: false });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("wrappedLines", () => {
  test("counts hard breaks and wraps long lines", () => {
    expect(wrappedLines("", 10)).toBe(1);
    expect(wrappedLines("short", 10)).toBe(1);
    expect(wrappedLines("x".repeat(25), 10)).toBe(3);
    expect(wrappedLines("a\nb\nc", 10)).toBe(3);
  });
});

describe("estimateRowHeight", () => {
  test("collapsed tool calls are one line, far below an open one", () => {
    const read = estimateRowHeight(tool({ tool: "read", view: { type: "read", path: "a.ts", lines: 80 } }), false);
    const grep = estimateRowHeight(tool({ tool: "grep", view: { type: "search", query: "x", matches: 3, files: 2, hits: [] } }), false);
    expect(read).toBe(38);
    expect(grep).toBe(38);
    const bash = estimateRowHeight(tool({ tool: "bash", view: { type: "bash", command: "go test", output: lines(20), background: false, timedOut: false } }), false);
    expect(bash).toBeGreaterThan(300);
  });

  test("output panes stop growing at their cap", () => {
    const bash = (n: number) =>
      estimateRowHeight(tool({ id: `b${n}`, tool: "bash", view: { type: "bash", command: "x", output: lines(n), background: false, timedOut: false } }), false);
    expect(bash(5)).toBeLessThan(bash(12));
    expect(bash(100)).toBe(bash(1000));
  });

  test("a view still arriving (no output yet) is estimated, not thrown on", () => {
    const partial = tool({ tool: "bash", status: "running", view: { type: "bash" } as never });
    expect(estimateRowHeight(partial, false)).toBeGreaterThan(38);
    expect(estimateRowHeight({ kind: "assistant", id: "s", at: 0, streaming: true } as never, false)).toBeGreaterThan(0);
  });

  test("a failed call opens on its error", () => {
    const ok = estimateRowHeight(tool({ tool: "read" }), false);
    const failed = estimateRowHeight(tool({ id: "f", tool: "read", status: "error", error: "ENOENT: no such file" }), false);
    expect(failed).toBeGreaterThan(ok);
  });

  test("text rows grow with their text, faster on a phone", () => {
    const short = estimateRowHeight(user("hi"), false);
    const long = estimateRowHeight(user("word ".repeat(80)), false);
    expect(long).toBeGreaterThan(short);
    const text = said("word ".repeat(120));
    expect(estimateRowHeight(text, true)).toBeGreaterThan(estimateRowHeight(said("word ".repeat(120)), false));
  });

  test("a Mermaid or SVG fence is a picture of fixed height, not a code block of its lines", () => {
    const body = lines(40);
    const asCode = estimateRowHeight(said("```ts\n" + body + "\n```"), false);
    const asDiagram = estimateRowHeight(said("```mermaid\n" + body + "\n```"), false);
    expect(asDiagram).toBeLessThan(asCode);
    expect(estimateRowHeight(said("```mermaid\n" + body + "\n```"), false)).toBe(estimateRowHeight(said("```svg\n" + body + "\n```"), false));
  });

  test("an edited item is estimated again (cache follows the item object)", () => {
    const first = said("one line");
    const grown = { ...first, text: lines(30) } as TranscriptItem;
    expect(estimateRowHeight(grown, false)).toBeGreaterThan(estimateRowHeight(first, false));
  });

  test("a quick command the user ran is its card under a one-line header", () => {
    const view = { type: "bash", command: "git status", output: lines(4), background: false, timedOut: false } as const;
    const model = estimateRowHeight(tool({ id: "m", tool: "bash", view }), false);
    expect(estimateRowHeight(tool({ id: "x1", tool: "bash", view, userRun: { python: false, excluded: true } }), false)).toBe(model + 28);
    expect(estimateRowHeight(tool({ id: "x1", tool: "bash", view, userRun: { python: false, excluded: true } }), true)).toBe(estimateRowHeight(tool({ id: "m", tool: "bash", view }), true) + 18);
  });

  test("an eval call opens on its code, folded past 16 lines (20 with the slack), then its output", () => {
    const evalCall = (code: string, output?: string) => tool({ tool: "eval", args: { language: "py", code }, output });
    const short = estimateRowHeight(evalCall(lines(3)), false);
    expect(short).toBeGreaterThan(38 + 3 * 19);
    expect(estimateRowHeight(evalCall(lines(12)), false)).toBeGreaterThan(short);
    expect(estimateRowHeight(evalCall(lines(30)), false)).toBe(estimateRowHeight(evalCall(lines(300)), false));
    expect(estimateRowHeight(evalCall(lines(3), lines(5)), false)).toBeGreaterThan(short);
    // several cells: a card each
    const two = tool({ tool: "eval", args: { cells: [{ code: lines(3) }, { language: "js", code: lines(3) }] } });
    expect(estimateRowHeight(two, false)).toBeGreaterThan(short + 3 * 19);
  });

  test("a bash command the header cuts off adds its code card, on a phone from a shorter command", () => {
    const bash = (command: string) => tool({ tool: "bash", view: { type: "bash", command, output: "ok", background: false, timedOut: false } });
    const long = `rg -n "needle" ${"src/features/".repeat(4)}`;
    expect(estimateRowHeight(bash(long), true)).toBeGreaterThan(estimateRowHeight(bash("ls"), true) + 50);
    expect(estimateRowHeight(bash(long), false)).toBe(estimateRowHeight(bash("ls"), false));
    expect(estimateRowHeight(bash(`cd x\n${long}`), false)).toBeGreaterThan(estimateRowHeight(bash("ls"), false) + 50);
  });
});

describe("initialScrollOffset", () => {
  test("a transcript shorter than the viewport starts at the top; a longer one at its bottom", () => {
    expect(initialScrollOffset(520, 892)).toBe(0);
    expect(initialScrollOffset(5000, 892)).toBe(4108);
  });
});
