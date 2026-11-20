import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "@/core/gen";
import { lastMessage, messageKind, nearestMessage, readingRows, stepMessage } from "./lastMessage";

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

/** Ids and kinds of a transcript, the way the steppers read them. */
const list = (rows: TranscriptItem[]) => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { ids: rows.map((r) => r.id), kindOf: (id: string) => messageKind(byId.get(id)) };
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

describe("the previous and next message from a row", () => {
  // 0 u1 · 1 t1 · 2 x1 · 3 a1 · 4 u2 · 5 x2 · 6 x3 · 7 n1 · 8 a2 · 9 x4 · 10 a3 · 11 u3 · 12 x5
  const { ids, kindOf } = list([
    prompt("u1"),
    thinking("t1"),
    tool("x1"),
    text("a1"),
    prompt("u2"),
    tool("x2"),
    tool("x3"),
    notice("n1"),
    text("a2"),
    tool("x4"),
    text("a3"),
    prompt("u3"),
    tool("x5"),
  ]);
  const near = (anchor: number, dir: "older" | "newer", kind?: "assistant" | "user") => nearestMessage(ids, kindOf, anchor, dir, kind)?.id ?? null;

  test("by kind, over the tool calls, thinking and notices between", () => {
    // from the second tool call of u2's turn
    expect(near(6, "older", "assistant")).toBe("a1");
    expect(near(6, "older", "user")).toBe("u2");
    expect(near(6, "newer", "assistant")).toBe("a2");
    expect(near(6, "newer", "user")).toBe("u3");
  });

  test("the anchor row itself is left out: from a message, the one before or after it", () => {
    expect(near(8, "older", "assistant")).toBe("a1");
    expect(near(8, "newer", "assistant")).toBe("a3");
    expect(near(4, "older", "user")).toBe("u1");
    expect(near(4, "newer", "user")).toBe("u3");
  });

  test("of either kind without one", () => {
    expect(near(6, "older")).toBe("u2");
    expect(near(6, "newer")).toBe("a2");
    expect(near(10, "newer")).toBe("u3");
  });

  test("none past the edges", () => {
    // nothing older than the first prompt, nothing of the agent's before its first text
    expect(near(0, "older")).toBeNull();
    expect(near(2, "older", "assistant")).toBeNull();
    // nothing of the agent's after its last text, nothing at all after the last prompt
    expect(near(11, "newer", "assistant")).toBeNull();
    expect(near(11, "newer")).toBeNull();
    expect(nearestMessage([], kindOf, 0, "older")).toBeNull();
  });

  test("from past either end: the newest from the bottom, the oldest from the top", () => {
    expect(near(ids.length, "older", "assistant")).toBe("a3");
    expect(near(ids.length, "older", "user")).toBe("u3");
    expect(near(-1, "newer", "assistant")).toBe("a1");
    expect(near(-1, "newer", "user")).toBe("u1");
    // anchors far outside count as the ends
    expect(near(99, "older", "user")).toBe("u3");
    expect(near(-7, "newer")).toBe("u1");
  });

  test("system turns and failed attempts are no stops", () => {
    const rows = list([prompt("u1"), text("a1"), prompt("s1", { synthetic: true }), text("e1", { text: "", error: "429" }), tool("x1"), text("a2")]);
    expect(nearestMessage(rows.ids, rows.kindOf, 5, "older")?.id).toBe("a1");
    expect(nearestMessage(rows.ids, rows.kindOf, 1, "newer")?.id).toBe("a2");
    expect(nearestMessage(rows.ids, rows.kindOf, 5, "older", "user")?.id).toBe("u1");
  });
});

describe("where the list is read", () => {
  // Row tops as the virtualiser lays them out (16 px padding, 12 px gaps).
  const rows = [16, 80, 200, 260, 900, 1000].map((start) => ({ start }));

  test("rows above and below the spot", () => {
    // the spot falls inside the row starting at 260
    expect(readingRows(rows, 500, 24)).toEqual({ above: 3, below: 4 });
  });

  test("a row at the spot (where a jump put it) is neither", () => {
    expect(readingRows(rows, 200, 24)).toEqual({ above: 1, below: 3 });
    // within the tolerance either way
    expect(readingRows(rows, 220, 24)).toEqual({ above: 1, below: 3 });
    expect(readingRows(rows, 180, 24)).toEqual({ above: 1, below: 3 });
    // just past it, the row is above
    expect(readingRows(rows, 225, 24)).toEqual({ above: 2, below: 3 });
  });

  test("at the ends", () => {
    expect(readingRows(rows, 0, 24)).toEqual({ above: -1, below: 1 });
    expect(readingRows(rows, 5000, 24)).toEqual({ above: 5, below: 6 });
    expect(readingRows([], 300, 24)).toEqual({ above: -1, below: 0 });
  });
});

describe("a step from where the list is read", () => {
  // 0 u1 · 1 a1 · 2 x1 · 3 x2 · 4 u2 · 5 x3 · 6 a2 · 7 x4 · 8 a3
  const { ids, kindOf } = list([prompt("u1"), text("a1"), tool("x1"), tool("x2"), prompt("u2"), tool("x3"), text("a2"), tool("x4"), text("a3")]);
  const step = (at: { above: number; below: number }, dir: "older" | "newer", kind: "assistant" | "user") => stepMessage(ids, kindOf, at, dir, kind)?.id ?? null;

  test("reading inside a message, a step back goes to its start", () => {
    // the top of the view is inside a2 (the row above the spot)
    expect(step({ above: 6, below: 7 }, "older", "assistant")).toBe("a2");
    expect(step({ above: 6, below: 7 }, "newer", "assistant")).toBe("a3");
  });

  test("a message at the spot is passed over both ways", () => {
    // a2 sits at the spot (the last step put it there)
    expect(step({ above: 5, below: 7 }, "older", "assistant")).toBe("a1");
    expect(step({ above: 5, below: 7 }, "newer", "assistant")).toBe("a3");
    expect(step({ above: 5, below: 7 }, "older", "user")).toBe("u2");
    expect(step({ above: 5, below: 7 }, "newer", "user")).toBeNull();
  });

  test("reading tool calls between turns", () => {
    // x1 at the spot
    expect(step({ above: 1, below: 3 }, "older", "assistant")).toBe("a1");
    expect(step({ above: 1, below: 3 }, "older", "user")).toBe("u1");
    expect(step({ above: 1, below: 3 }, "newer", "user")).toBe("u2");
    expect(step({ above: 1, below: 3 }, "newer", "assistant")).toBe("a2");
  });

  test("none past the edges", () => {
    // the first prompt at the spot: nothing older of either kind
    expect(step({ above: -1, below: 1 }, "older", "user")).toBeNull();
    expect(step({ above: -1, below: 1 }, "older", "assistant")).toBeNull();
    // the last text at the spot: nothing newer
    expect(step({ above: 7, below: 9 }, "newer", "assistant")).toBeNull();
    expect(step({ above: 7, below: 9 }, "older", "assistant")).toBe("a2");
  });

  test("walking back and forth through the agent's messages visits each in turn", () => {
    // each step puts its message at the spot, which the next step starts from
    const at = (id: string) => ({ above: ids.indexOf(id) - 1, below: ids.indexOf(id) + 1 });
    const back: string[] = [];
    for (let id: string | null = "a3"; id; id = step(at(id), "older", "assistant")) back.push(id);
    expect(back).toEqual(["a3", "a2", "a1"]);
    const on: string[] = [];
    for (let id: string | null = "a1"; id; id = step(at(id), "newer", "assistant")) on.push(id);
    expect(on).toEqual(["a1", "a2", "a3"]);
  });
});
