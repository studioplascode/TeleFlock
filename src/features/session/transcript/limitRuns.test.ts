import { describe, expect, test } from "bun:test";
import type { AssistantItem, RetryWait, TranscriptItem, UserItem } from "@/core/gen";
import { foldLimitRuns, limitErrorOf, limitKind, limitSignature, retryNoticeText } from "./limitRuns";

const RATE = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}} retry-after-ms=324000';

const failed = (id: string, at: number, error = RATE, over: Partial<AssistantItem> = {}): TranscriptItem =>
  ({ kind: "assistant", id, at, text: "", streaming: false, error, errorStatus: 429, ...over }) as unknown as TranscriptItem;
const system = (id: string, at: number): TranscriptItem => ({ kind: "user", id, at, text: "<system-notice>job done</system-notice>", synthetic: true }) as unknown as UserItem as TranscriptItem;
const prompt = (id: string, at: number): TranscriptItem => ({ kind: "user", id, at, text: "go on", synthetic: false }) as unknown as TranscriptItem;
const answer = (id: string, at: number): TranscriptItem => ({ kind: "assistant", id, at, text: "done", streaming: false }) as unknown as TranscriptItem;

const fold = (items: TranscriptItem[]) => foldLimitRuns(items.map((i) => i.id), items);

describe("limit error kinds", () => {
  test("by omp's text and status", () => {
    expect(limitKind(RATE, 429)).toBe("rateLimit");
    expect(limitKind("429 Too Many Requests")).toBe("rateLimit");
    expect(limitKind("You have hit your usage limit", 429)).toBe("usageLimit");
    expect(limitKind("Codex is at capacity (code=turn_rate_limit_exceeded)")).toBe("overloaded");
    expect(limitKind("overloaded_error", 529)).toBe("overloaded");
    expect(limitKind("request 14290 failed")).toBeNull();
    expect(limitKind("400 invalid_request_error", 400)).toBeNull();
  });

  test("only an error row without text counts", () => {
    expect(limitErrorOf(failed("a1.e", 1))).toBe("rateLimit");
    expect(limitErrorOf(failed("a1.e", 1, RATE, { text: "Let me" }))).toBeNull();
    expect(limitErrorOf(failed("a1.e", 1, "400 bad request", { errorStatus: 400 }))).toBeNull();
    expect(limitErrorOf(answer("a2", 2))).toBeNull();
    expect(limitErrorOf(system("u1", 1))).toBeNull();
  });
});

describe("the fold's signature", () => {
  test("changes when a row turns into an error in place, not for other edits", () => {
    const ids = ["p", "a", "s"];
    const byId = (a: TranscriptItem) => ({ p: prompt("p", 1), a, s: system("s", 3) });
    const streaming = limitSignature(ids, byId(answer("a", 2)));
    expect(streaming).toBe("..S");
    // Same id, now the failed attempt.
    expect(limitSignature(ids, byId(failed("a", 2)))).toBe(".ES");
    // More text on a normal row doesn't matter to the fold.
    expect(limitSignature(ids, byId({ ...answer("a", 2), text: "done, and more" } as TranscriptItem))).toBe(streaming);
  });
});

describe("folding consecutive limit errors", () => {
  test("four errors with a system turn after each fold into one row; the last system turn stays", () => {
    const items = [prompt("p", 1), failed("e1", 10), system("s1", 11), failed("e2", 20), system("s2", 21), failed("e3", 30), system("s3", 31), failed("e4", 40), system("s4", 41)];
    const f = fold(items);
    expect(f.ids).toEqual(["p", "e1", "s4"]);
    expect(f.items.map((i) => i?.id)).toEqual(["p", "e1", "s4"]);
    expect([...f.runs.keys()]).toEqual(["e1"]);
    expect(f.runs.get("e1")).toEqual({ leader: "e1", members: ["e1", "s1", "e2", "s2", "e3", "s3", "e4"], errors: 4, from: 10, to: 40, kind: "rateLimit" });
  });

  test("a lone error, or errors split by a real turn, stay rows", () => {
    expect(fold([prompt("p", 1), failed("e1", 2), system("s1", 3)]).ids).toEqual(["p", "e1", "s1"]);
    const f = fold([failed("e1", 1), answer("a", 2), failed("e2", 3)]);
    expect(f.ids).toEqual(["e1", "a", "e2"]);
    expect(f.runs.size).toBe(0);
    // a user prompt between two errors splits them too
    expect(fold([failed("e1", 1), prompt("p", 2), failed("e2", 3)]).runs.size).toBe(0);
  });

  test("separate runs fold separately, adjacent errors need no system turn", () => {
    const f = fold([failed("e1", 1), failed("e2", 2), answer("a", 3), failed("e3", 4), system("s", 5), failed("e4", 6)]);
    expect(f.ids).toEqual(["e1", "a", "e3"]);
    expect(f.runs.get("e1")?.members).toEqual(["e1", "e2"]);
    expect(f.runs.get("e3")?.members).toEqual(["e3", "s", "e4"]);
  });

  test("a run takes the kind of its last error", () => {
    const f = fold([failed("e1", 1), failed("e2", 2, "You hit your usage limit")]);
    expect(f.runs.get("e1")?.kind).toBe("usageLimit");
  });
});

describe("retry notice countdown", () => {
  const T = 1_000_000;
  const wait: RetryWait = { kind: "rateLimit", attempt: 0, maxAttempts: 10, since: T, retryAt: T + 294_000, error: RATE };
  const text = "Retrying (0/10) in 294.0s: 429 rate limit";

  test("counts down while that retry is the one omp waits for", () => {
    expect(retryNoticeText(text, wait, T)).toBe("Retrying (0/10) in 4:54: 429 rate limit");
    expect(retryNoticeText(text, wait, T + 100_000)).toBe("Retrying (0/10) in 3:14: 429 rate limit");
    expect(retryNoticeText(text, wait, T + 294_000)).toBe("Retrying (0/10) now: 429 rate limit");
  });

  test("anything else reads as omp wrote it", () => {
    expect(retryNoticeText(text, undefined, T)).toBe(text);
    expect(retryNoticeText(text, { ...wait, attempt: 1 }, T)).toBe(text);
    expect(retryNoticeText("Recovered after 2 retries", wait, T)).toBe("Recovered after 2 retries");
    expect(retryNoticeText("Retrying (0/10) in 294.0s: line one\nline two", wait, T)).toBe("Retrying (0/10) in 4:54: line one\nline two");
  });
});
