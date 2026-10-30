import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./gen";
import { lastTurnRetryable } from "./retryable";

const user = (): TranscriptItem => ({ kind: "user", id: "u", at: 1, text: "go", images: [], steering: false, synthetic: false });
const say = (extra: Record<string, unknown> = {}): TranscriptItem => ({ kind: "assistant", id: "a", at: 2, text: "ok", streaming: false, stopReason: "stop", ...extra }) as TranscriptItem;
const tool = (status: string): TranscriptItem => ({ kind: "tool", id: `t-${status}`, at: 3, callId: "c", tool: "bash", title: "ls", args: {}, status, truncated: false }) as TranscriptItem;
const think = (): TranscriptItem => ({ kind: "thinking", id: "th", at: 2, text: "hm", streaming: false, redacted: false });
const notice = (): TranscriptItem => ({ kind: "notice", id: "n", at: 4, level: "warn", text: "Interrupted by user" });
const mode = (): TranscriptItem => ({ kind: "mode", id: "m", at: 4, text: "Model switched" });
const compaction = (): TranscriptItem => ({ kind: "compaction", id: "c", at: 4, summary: "…" });
const retryable = (rows: TranscriptItem[]) => lastTurnRetryable(rows.length, (i) => rows[i]);

describe("lastTurnRetryable", () => {
  test("a turn that ended normally, or nothing loaded, has nothing to retry", () => {
    expect(retryable([])).toBe(false);
    expect(retryable([user(), say()])).toBe(false);
    expect(retryable([user(), say({ stopReason: "length" })])).toBe(false);
    expect(retryable([user(), tool("error"), say()])).toBe(false);
  });

  test("an assistant row that failed or was stopped: text row, error row, an abort's reason", () => {
    expect(retryable([user(), say({ text: "", stopReason: "error", error: "529 Overloaded" })])).toBe(true);
    expect(retryable([user(), say({ stopReason: "aborted" })])).toBe(true);
    expect(retryable([user(), say({ stopReason: undefined, error: "Request timed out" })])).toBe(true);
  });

  test("rows that aren't the conversation don't hide the failure", () => {
    expect(retryable([user(), say({ stopReason: "aborted" }), notice(), mode(), compaction()])).toBe(true);
  });

  test("a run that stopped in its tools, parallel ones included; never past a newer reply", () => {
    expect(retryable([user(), tool("aborted")])).toBe(true);
    expect(retryable([user(), think(), tool("aborted"), tool("ok"), notice()])).toBe(true);
    expect(retryable([user(), say({ stopReason: "toolUse" }), tool("error")])).toBe(true);
    expect(retryable([user(), tool("ok")])).toBe(false);
    expect(retryable([user(), tool("denied")])).toBe(false);
  });

  test("a thinking or user row at the end tells nothing (a new prompt, or a quiet abort)", () => {
    expect(retryable([user(), say({ stopReason: "aborted" }), user()])).toBe(false);
    expect(retryable([user(), think(), notice()])).toBe(false);
  });
});
