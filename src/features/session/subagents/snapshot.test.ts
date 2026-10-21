import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "@/core/gen";
import { mergeSnapshot } from "./snapshot";

const tool = (id: string, status: "running" | "ok" = "ok"): TranscriptItem => ({ kind: "tool", id, at: 1, callId: id, tool: "read", title: "a.go", args: { path: "a.go" }, status, truncated: false });
const say = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, at: 2, text, streaming: false });

describe("mergeSnapshot", () => {
  test("first page builds ids and rows", () => {
    const s = mergeSnapshot(null, [tool("t1"), say("a1", "hi")]);
    expect(s.ids).toEqual(["t1", "a1"]);
    expect(s.byId.get("a1")?.kind).toBe("assistant");
  });

  test("an identical refetch returns the previous snapshot itself", () => {
    const prev = mergeSnapshot(null, [tool("t1"), say("a1", "hi")]);
    expect(mergeSnapshot(prev, [tool("t1"), say("a1", "hi")])).toBe(prev);
  });

  test("a changed row is replaced, the others and the id list keep their identity", () => {
    const prev = mergeSnapshot(null, [tool("t1"), tool("t2", "running")]);
    const next = mergeSnapshot(prev, [tool("t1"), tool("t2", "ok")]);
    expect(next).not.toBe(prev);
    expect(next.ids).toBe(prev.ids);
    expect(next.byId.get("t1")).toBe(prev.byId.get("t1") as TranscriptItem);
    expect(next.byId.get("t2")).not.toBe(prev.byId.get("t2") as TranscriptItem);
  });

  test("appended rows produce a new id list and keep existing rows", () => {
    const prev = mergeSnapshot(null, [tool("t1")]);
    const next = mergeSnapshot(prev, [tool("t1"), say("a1", "done")]);
    expect(next.ids).toEqual(["t1", "a1"]);
    expect(next.byId.get("t1")).toBe(prev.byId.get("t1") as TranscriptItem);
  });

  test("a reordered page is a new id list", () => {
    const prev = mergeSnapshot(null, [tool("t1"), tool("t2")]);
    expect(mergeSnapshot(prev, [tool("t2"), tool("t1")]).ids).toEqual(["t2", "t1"]);
  });
});
