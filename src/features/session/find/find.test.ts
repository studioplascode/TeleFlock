import { describe, expect, test } from "bun:test";
import type { ToolItem, TranscriptItem } from "@/core/gen";
import { countIn, fold, needleOf, offsetsIn } from "./match";
import { keep, matchRows, newest, ordinal, resolveTarget, step, totalOf } from "./model";
import { rowCount, rowTexts } from "./rowText";
import { closeFind, dropFind, findState, openFind, useFindStore } from "./store";

const n = (q: string, cs = false) => needleOf(q, cs) as NonNullable<ReturnType<typeof needleOf>>;
const tool = (over: Partial<ToolItem>): TranscriptItem => ({ kind: "tool", id: "t:1", at: 1, callId: "1", tool: "bash", title: "cargo test", args: {}, status: "ok", truncated: false, ...over });
const user = (id: string, text: string, at = 0): TranscriptItem => ({ kind: "user", id, at, text, images: [], steering: false, synthetic: false });

describe("match", () => {
  test("folds one code point for one and counts without overlap", () => {
    expect(fold("ÄBC")).toBe("äbc");
    expect(fold("İx")).toBe("İx");
    expect(countIn("aaaa aAa", n("aa"))).toBe(3);
    expect(countIn("aaaa aAa", n("aa", true))).toBe(2);
    expect(offsetsIn("Foo foo FOO", n("foo"))).toEqual([0, 4, 8]);
    expect(countIn("xxxxxx", n("x"), 4)).toBe(4);
    expect(needleOf("   ", false)).toBeNull();
  });
});

describe("rowText", () => {
  test("tool rows count what their cards show, output escapes stripped", () => {
    const bash = tool({ view: { type: "bash", command: "cargo test", output: "thread 'x' \x1b[31mpanicked\x1b[0m\nPANIC again", exitCode: 101, background: false, timedOut: false }, output: "panic" });
    expect(rowCount(bash, n("panic"))).toBe(2);
    const generic = tool({ view: undefined, tool: "grep", title: "grep", args: { pattern: "panic!", path: "src" }, output: "no PANIC here?" });
    expect(rowCount(generic, n("panic"))).toBe(2);
    expect(rowCount(generic, n('"path": "src"'))).toBe(1);
    // The header of a bash card is the command, not the title; the tool's name is never searched.
    expect(rowCount(tool({ title: "Run the tests", view: { type: "bash", command: "bun test", output: "", background: false, timedOut: false } }), n("run the"))).toBe(0);
    expect(rowCount(generic, n("grep"))).toBe(1);
  });

  test("thinking, errors, refusals and notices", () => {
    expect(rowCount({ kind: "thinking", id: "a1.0", at: 0, text: "maybe a panic", streaming: false, redacted: false }, n("panic"))).toBe(1);
    expect(rowCount({ kind: "thinking", id: "a1.1", at: 0, text: "panic", streaming: false, redacted: true }, n("panic"))).toBe(0);
    const refused: TranscriptItem = { kind: "assistant", id: "a2.e", at: 0, text: "", streaming: false, error: "Refusal (cyber)", refusal: { kind: "refusal", category: "cyber", explanation: "A Cyber thing" } };
    expect(rowCount(refused, n("cyber"))).toBe(3);
    expect(rowCount(refused, n("cyber", true))).toBe(2);
    expect(rowTexts({ kind: "notice", id: "n1", at: 0, level: "warn", text: "Retrying", source: "retry" })).toEqual(["Retrying", "retry"]);
  });

  test("a partial view (still arriving) is read, not thrown on", () => {
    expect(rowCount(tool({ status: "running", view: { type: "bash" } as never }), n("x"))).toBe(0);
  });
});

describe("model", () => {
  const ids = ["u1", "u2", "u3"];
  const items: Record<string, TranscriptItem> = { u1: user("u1", "needle needle", 10), u2: user("u2", "hay", 20), u3: user("u3", "a needle", 30) };

  test("loaded rows count here; the host's hits fill in the rows not loaded", () => {
    const remote = { key: "0needle", hits: [{ id: "old", index: 0, count: 2 }, { id: "u1", index: 5, count: 9 }], rows: 9, truncated: false };
    const rows = matchRows(ids, items, n("needle"), remote);
    expect(rows.map((r) => [r.id, r.count, r.loaded])).toEqual([
      ["old", 2, false],
      ["u1", 2, true],
      ["u3", 1, true],
    ]);
    expect(totalOf(rows)).toBe(5);
  });

  test("Enter walks up from the newest, wrapping; Shift+Enter walks down", () => {
    const rows = matchRows(ids, items, n("needle"), null);
    const first = newest(rows);
    expect(first).toEqual({ id: "u3", n: 0 });
    expect(ordinal(rows, first)).toBe(1);
    const up1 = step(rows, first, "older");
    expect(up1).toEqual({ id: "u1", n: 1 });
    expect(ordinal(rows, up1)).toBe(2);
    const up2 = step(rows, up1, "older");
    expect(up2).toEqual({ id: "u1", n: 0 });
    expect(ordinal(rows, up2)).toBe(3);
    expect(step(rows, up2, "older")).toEqual({ id: "u3", n: 0 });
    expect(step(rows, first, "newer")).toEqual({ id: "u1", n: 0 });
  });

  test("open at match lands on the row, else the first match from that time", () => {
    const rows = matchRows(ids, items, n("needle"), null);
    expect(resolveTarget(rows, { rowId: "u1" })).toEqual({ id: "u1", n: 0 });
    expect(resolveTarget(rows, { rowId: "gone", at: 25 })).toEqual({ id: "u3", n: 0 });
    expect(resolveTarget(rows, { rowId: "gone" })).toBeNull();
  });

  test("the current match survives new rows and falls to the next one when its row stops matching", () => {
    const rows = matchRows(ids, items, n("needle"), null);
    expect(keep(rows, { id: "u1", n: 1 }, ids)).toEqual({ id: "u1", n: 1 });
    const edited = { ...items, u1: user("u1", "hay now", 10) };
    const after = matchRows(ids, edited, n("needle"), null);
    expect(keep(after, { id: "u1", n: 1 }, ids)).toEqual({ id: "u3", n: 0 });
  });
});

describe("store", () => {
  test("closing keeps the host's answer to the query but forgets a failed search; a new query starts fresh", () => {
    const scope = "test::store";
    openFind(scope, { query: "needle", target: { rowId: "u1" } });
    expect(findState(scope)).toMatchObject({ open: true, query: "needle", target: { rowId: "u1" }, remoteStatus: "idle" });
    useFindStore.getState().patch(scope, { remote: { key: "0needle", hits: [], rows: 3, truncated: false }, remoteStatus: "error", active: { id: "u1", n: 0 } });
    closeFind(scope);
    expect(findState(scope)).toMatchObject({ open: false, query: "needle", active: null, target: undefined, remoteStatus: "idle", remote: { key: "0needle" } });
    openFind(scope, { query: "other" });
    expect(findState(scope)).toMatchObject({ open: true, query: "other", active: null, remote: null, remoteStatus: "idle" });
    dropFind(scope);
    expect(useFindStore.getState().scopes[scope]).toBeUndefined();
  });
});
