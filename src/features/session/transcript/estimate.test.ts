import { describe, expect, test } from "bun:test";
import type { ToolItem, TranscriptItem } from "@/core/gen";
import { estimateRowHeight, wrappedLines } from "./estimate";

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

  test("an edited item is estimated again (cache follows the item object)", () => {
    const first = said("one line");
    const grown = { ...first, text: lines(30) } as TranscriptItem;
    expect(estimateRowHeight(grown, false)).toBeGreaterThan(estimateRowHeight(first, false));
  });
});
