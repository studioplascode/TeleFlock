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
});
