import { describe, expect, test } from "bun:test";
import { IDLE_GRACE_MS, type PendingSend, queueKey, reconcileQueue } from "./queue";

const send = (text: string, over: Partial<PendingSend> = {}): PendingSend => ({ id: 1, text, kind: "steer", at: 0, before: [], sending: false, seen: false, ...over });
const empty = { steering: [], followUp: [] };

describe("queued message echo", () => {
  test("shows at once, then hands over to the host's chip under the same key", () => {
    const p = send("fix the test", { sending: true });
    const first = reconcileQueue([p], empty, [], true, 10);
    expect(first.chips).toEqual([{ id: "steer:fix the test#1", text: "fix the test", kind: "steer", pending: true, sending: true }]);
    expect(first.keep).toEqual([p]);
    const listed = reconcileQueue([p], { steering: ["fix the test"], followUp: [] }, [], true, 20);
    expect(listed.chips).toEqual([{ id: "steer:fix the test#1", text: "fix the test", kind: "steer", pending: false, sending: false }]);
    expect(listed.keep).toEqual([{ ...p, seen: true }]);
    // Gone from the host's queue after being listed: delivered or pulled back.
    expect(reconcileQueue(listed.keep, empty, [], true, 30)).toEqual({ chips: [], keep: [] });
  });

  test("drops when a new user row with its text lands, not an old one", () => {
    const p = send("again", { before: ["u1"] });
    expect(reconcileQueue([p], empty, [{ id: "u1", text: "again" }], true, 10).keep).toEqual([p]);
    expect(reconcileQueue([p], empty, [{ id: "u1", text: "again" }, { id: "u2", text: "again" }], true, 10).keep).toEqual([]);
    // One landed row resolves one of two identical sends.
    const twice = [p, { ...p, id: 2 }];
    expect(reconcileQueue(twice, empty, [{ id: "u2", text: "again" }], true, 10).keep).toEqual([{ ...p, id: 2 }]);
  });

  test("matches the host's flattened chip text and keeps follow-ups after steers", () => {
    const f = send("a\nb", { kind: "follow" });
    const s = send("now", { id: 2 });
    const { chips } = reconcileQueue([f, s], { steering: ["first"], followUp: ["later"] }, [], true, 10);
    expect(chips.map((c) => [c.kind, c.text, c.pending])).toEqual([
      ["steer", "first", false],
      ["steer", "now", true],
      ["follow", "later", false],
      ["follow", "a\nb", true],
    ]);
    expect(reconcileQueue([f], { steering: [], followUp: ["a ↵ b"] }, [], true, 10).chips.map((c) => c.pending)).toEqual([false]);
    expect(queueKey(" a ↵ b\n")).toBe("a b");
  });

  test("an unlisted echo expires once the agent is idle, never while the call is in flight", () => {
    const p = send("late", { at: 0 });
    expect(reconcileQueue([p], empty, [], false, IDLE_GRACE_MS - 1).keep).toEqual([p]);
    expect(reconcileQueue([p], empty, [], true, IDLE_GRACE_MS + 1).keep).toEqual([p]);
    expect(reconcileQueue([p], empty, [], false, IDLE_GRACE_MS + 1).keep).toEqual([]);
    expect(reconcileQueue([{ ...p, sending: true }], empty, [], false, IDLE_GRACE_MS + 1).keep).toHaveLength(1);
  });

  test("a delivered steer leaves the strip with its row, though the host still lists it", () => {
    // The user's case: both steers landed, the host's queue (lagging the transcript) still listed
    // them, and their chips stood there, while pulling one back found nothing.
    const a = send("only play the city builder", { seen: true });
    const b = send("don't build anything yet", { id: 2, seen: true });
    const lagging = { steering: ["only play the city builder", "don't build anything yet"], followUp: [] };
    const rows = [
      { id: "u7", text: "only play the city builder" },
      { id: "u8", text: "don't build anything yet" },
    ];
    const landed = reconcileQueue([a, b], lagging, rows, true, 10);
    expect(landed.chips).toEqual([]);
    expect(landed.keep).toEqual([
      { ...a, landed: "u7" },
      { ...b, landed: "u8" },
    ]);
    // Still lagging a second later: still hidden, and the rows count once.
    expect(reconcileQueue(landed.keep, lagging, rows, true, 1010)).toEqual({ chips: [], keep: landed.keep });
    // The host caught up: nothing is left.
    expect(reconcileQueue(landed.keep, empty, rows, true, 2010)).toEqual({ chips: [], keep: [] });
  });

  test("a landed send hides only the oldest listing of its text, never a newer identical one", () => {
    const old = send("continue", { seen: true, landed: "u1" });
    const again = send("continue", { id: 2, sending: true, before: ["u1"] });
    const both = { steering: ["continue", "continue"], followUp: [] };
    const r = reconcileQueue([old, again], both, [{ id: "u1", text: "continue" }], true, 10);
    expect(r.chips.map((c) => [c.text, c.pending])).toEqual([["continue", false]]);
    expect(r.keep).toEqual([old, { ...again, seen: true }]);
    // The host dropped the delivered one: the queued one keeps its chip, the landed send goes.
    const one = reconcileQueue(r.keep, { steering: ["continue"], followUp: [] }, [{ id: "u1", text: "continue" }], true, 20);
    expect(one.chips.map((c) => c.text)).toEqual(["continue"]);
    expect(one.keep).toEqual([{ ...again, seen: true }]);
  });
});
