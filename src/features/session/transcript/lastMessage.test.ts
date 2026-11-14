import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "@/core/gen";
import { lastMessage } from "./lastMessage";

const prompt = (id: string, over: object = {}) => ({ kind: "user", id, at: 1, text: "go on", images: [], steering: false, synthetic: false, ...over }) as TranscriptItem;
const text = (id: string, over: object = {}) => ({ kind: "assistant", id, at: 2, text: "Done: the pool is in.", streaming: false, ...over }) as TranscriptItem;
const tool = (id: string) => ({ kind: "tool", id, at: 3, callId: id, tool: "bash", title: "go test ./...", args: {}, status: "ok", truncated: false }) as unknown as TranscriptItem;
const thinking = (id: string) => ({ kind: "thinking", id, at: 3, text: "Checking the pool.", streaming: false, redacted: false }) as unknown as TranscriptItem;
const notice = (id: string) => ({ kind: "notice", id, at: 4, level: "info", text: "Model changed" }) as TranscriptItem;
const compaction = (id: string) => ({ kind: "compaction", id, at: 5, summary: "Earlier work." }) as unknown as TranscriptItem;

const pick = (rows: TranscriptItem[]) => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return lastMessage(
    rows.map((r) => r.id),
    (id) => byId.get(id),
  );
};

describe("the last message", () => {
  test("the user's prompt when it is the newest", () => {
    expect(pick([prompt("u1"), text("a1"), prompt("u2")])).toEqual({ id: "u2", kind: "user" });
    // a steer is the user's too
    expect(pick([prompt("u1"), text("a1"), prompt("u2", { steering: true })])).toEqual({ id: "u2", kind: "user" });
  });

  test("the agent's text when it is the newest", () => {
    expect(pick([prompt("u1"), thinking("t1"), text("a1")])).toEqual({ id: "a1", kind: "assistant" });
  });

  test("tool calls, thinking, notices and compactions after both are passed over", () => {
    expect(pick([prompt("u1"), text("a1"), thinking("t2"), tool("x1"), tool("x2"), notice("n1"), compaction("c1")])).toEqual({ id: "a1", kind: "assistant" });
    // a prompt under a wall of tool calls
    expect(pick([text("a0"), prompt("u1"), thinking("t1"), ...Array.from({ length: 40 }, (_, i) => tool(`x${i}`))])).toEqual({ id: "u1", kind: "user" });
  });

  test("none without a message", () => {
    expect(pick([])).toBeNull();
    expect(pick([thinking("t1"), tool("x1"), notice("n1")])).toBeNull();
    // omp's system turns (todo reminders, async results) are not the user's
    expect(pick([tool("x1"), prompt("s1", { synthetic: true, text: "<system-notice>job done</system-notice>" })])).toBeNull();
  });

  test("a streaming text row once it has text", () => {
    expect(pick([prompt("u1"), tool("x1"), text("a2", { streaming: true, text: "Here is" })])).toEqual({ id: "a2", kind: "assistant" });
    // just started, nothing streamed yet: the prompt it answers
    expect(pick([prompt("u1"), tool("x1"), text("a2", { streaming: true, text: "" })])).toEqual({ id: "u1", kind: "user" });
  });

  test("an attempt that only failed is no message; text that ended in an error is", () => {
    const limit = text("a2", { text: "", error: "429 rate_limit_error", errorStatus: 429 });
    expect(pick([prompt("u1"), text("a1"), limit])).toEqual({ id: "a1", kind: "assistant" });
    expect(pick([prompt("u1"), text("a2", { text: "Let me", error: "stream reset" })])).toEqual({ id: "a2", kind: "assistant" });
    expect(pick([prompt("u1"), text("a2", { text: " \n " })])).toEqual({ id: "u1", kind: "user" });
  });
});
