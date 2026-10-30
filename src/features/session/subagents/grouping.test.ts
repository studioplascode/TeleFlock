import { describe, expect, test } from "bun:test";
import type { Subagent, SubagentStatus } from "@/core/gen";
import { completedSummary, groupSubagents, outcomeOf } from "./grouping";

const sub = (id: string, status: SubagentStatus, endedAt?: number, startedAt = 1000): Subagent => ({ id, name: id, status, startedAt, endedAt });
const ids = (l: Subagent[]) => l.map((s) => s.id);

describe("groupSubagents", () => {
  test("running first, then failed; done and aborted collapse into completed, newest end first", () => {
    const g = groupSubagents([
      sub("old", "done", 2000),
      sub("bad", "failed", 2500),
      sub("live1", "running"),
      sub("new", "done", 9000),
      sub("killed", "aborted", 5000),
      sub("live2", "running"),
    ]);
    expect(ids(g.active)).toEqual(["live1", "live2", "bad"]);
    expect(ids(g.completed)).toEqual(["new", "killed", "old"]);
    expect(g).toMatchObject({ running: 2, failed: 1, done: 2, aborted: 1 });
  });

  test("parked reads as done, in the completed group", () => {
    expect(outcomeOf("parked")).toBe("done");
    const g = groupSubagents([sub("a", "parked", 3000), sub("b", "done", 4000)]);
    expect(ids(g.completed)).toEqual(["b", "a"]);
    expect(g.done).toBe(2);
    expect(g.active).toEqual([]);
  });

  test("ties and missing end times keep roster order", () => {
    const g = groupSubagents([sub("a", "done"), sub("b", "done"), sub("c", "done")]);
    expect(ids(g.completed)).toEqual(["a", "b", "c"]);
  });

  test("an empty roster has nothing in either group", () => {
    expect(groupSubagents([])).toMatchObject({ active: [], completed: [], running: 0, failed: 0 });
  });
});

describe("completedSummary", () => {
  test("lists only the non-zero counts", () => {
    expect(completedSummary({ done: 3, aborted: 0 })).toBe("3 done");
    expect(completedSummary({ done: 2, aborted: 1 })).toBe("2 done · 1 stopped");
    expect(completedSummary({ done: 0, aborted: 2 })).toBe("2 stopped");
  });
});
