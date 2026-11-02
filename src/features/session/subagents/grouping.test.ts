import { describe, expect, test } from "bun:test";
import type { Subagent, SubagentStatus } from "@/core/gen";
import { completedSummary, groupSubagents, opensByDefault, outcomeOf, rollupParts, type SubagentNode, tallySubagents, treeOrder } from "./grouping";

const sub = (id: string, status: SubagentStatus, endedAt?: number, parentId?: string, startedAt = 1000): Subagent => ({ id, name: id, status, startedAt, endedAt, parentId });
const ids = (l: SubagentNode[]) => l.map((n) => n.sub.id);
const rollup = (n: SubagentNode | undefined) => (n ? rollupParts(n.below).map((p) => p.text).join(" · ") : "");

describe("groupSubagents: one level", () => {
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
    expect(g.completedTally).toEqual({ running: 0, failed: 0, done: 2, aborted: 1 });
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

describe("groupSubagents: the tree", () => {
  // DialogLab (done) → DialogLab.Ui (done) → DialogLab.Ui.Shots (failed): a failed grandchild under a done parent.
  const nested = [
    sub("Docs", "done", 4000),
    sub("DialogLab", "done", 9000),
    sub("DialogLab.Ui", "done", 8000, "DialogLab"),
    sub("DialogLab.Ui.Shots", "failed", 7000, "DialogLab.Ui"),
    sub("DialogLab.Ui.Copy", "done", 6000, "DialogLab.Ui"),
    sub("DialogLab.Api", "running", undefined, "DialogLab"),
    sub("Scout", "running"),
  ];

  test("children hang under their parent at every depth, with the parent's name taken off their label", () => {
    const g = groupSubagents(nested);
    const lab = g.nodes.get("DialogLab");
    expect(ids(lab?.children ?? [])).toEqual(["DialogLab.Api", "DialogLab.Ui"]);
    const ui = g.nodes.get("DialogLab.Ui");
    expect(ui?.parent?.sub.id).toBe("DialogLab");
    expect(ids(ui?.children ?? [])).toEqual(["DialogLab.Ui.Shots", "DialogLab.Ui.Copy"]);
    expect([lab?.label, ui?.label, g.nodes.get("DialogLab.Ui.Shots")?.label]).toEqual(["DialogLab", "Ui", "Shots"]);
    expect(g.nodes.get("DialogLab.Ui.Shots")?.children).toEqual([]);
  });

  test("a finished parent with anything running or failed below stays in the active part, each level ordered like the top", () => {
    const g = groupSubagents(nested);
    // Scout and DialogLab both count as running (DialogLab.Api runs); roster order between them.
    expect(ids(g.active)).toEqual(["DialogLab", "Scout"]);
    expect(ids(g.completed)).toEqual(["Docs"]);
    const g2 = groupSubagents(nested.map((s) => (s.id === "DialogLab.Api" ? { ...s, status: "done" as const, endedAt: 9500 } : s)));
    expect(ids(g2.active)).toEqual(["Scout", "DialogLab"]);
    expect(ids(g2.nodes.get("DialogLab")?.children ?? [])).toEqual(["DialogLab.Ui", "DialogLab.Api"]);
  });

  test("roll-ups count everything below a subagent; the header counts are totals at every depth", () => {
    const g = groupSubagents(nested);
    expect(rollup(g.nodes.get("DialogLab"))).toBe("4 subagents · 1 running · 1 failed");
    expect(rollup(g.nodes.get("DialogLab.Ui"))).toBe("2 subagents · 1 failed");
    expect(g.nodes.get("DialogLab.Ui")?.below).toEqual({ running: 0, failed: 1, done: 1, aborted: 0 });
    expect(g).toMatchObject({ running: 2, failed: 1, done: 4, aborted: 0 });
    expect(tallySubagents(nested)).toEqual({ running: 2, failed: 1, done: 4, aborted: 0 });
    expect(rollupParts({ running: 0, failed: 0, done: 1, aborted: 0 })).toEqual([{ text: "1 subagent" }]);
  });

  test("the completed group counts the agents it holds at every depth", () => {
    const g = groupSubagents([sub("A", "done", 5000), sub("A.B", "done", 4000, "A"), sub("A.B.C", "aborted", 3000, "A.B"), sub("D", "running")]);
    expect(ids(g.completed)).toEqual(["A"]);
    expect(g.completedTally).toEqual({ running: 0, failed: 0, done: 2, aborted: 1 });
    expect(completedSummary(g.completedTally)).toBe("2 done · 1 stopped");
  });

  test("finished branches are ordered by when the last agent in them ended", () => {
    const g = groupSubagents([sub("Early", "done", 1000), sub("Early.Late", "done", 9000, "Early"), sub("Mid", "done", 5000)]);
    expect(ids(g.completed)).toEqual(["Early", "Mid"]);
  });

  test("a branch is open while anything below it runs or failed", () => {
    const g = groupSubagents(nested);
    expect(opensByDefault(g.nodes.get("DialogLab") as SubagentNode)).toBe(true);
    expect(opensByDefault(g.nodes.get("DialogLab.Ui") as SubagentNode)).toBe(true);
    const done = groupSubagents([sub("A", "done", 3), sub("A.B", "done", 2, "A")]);
    expect(opensByDefault(done.nodes.get("A") as SubagentNode)).toBe(false);
  });

  test("without parentId the dotted id names the parent (omp's naming): A.B.C under A.B", () => {
    const g = groupSubagents([sub("A", "running"), sub("A.B", "running"), sub("A.B.C", "failed", 5)]);
    expect(ids(g.active)).toEqual(["A"]);
    expect(g.nodes.get("A.B.C")?.parent?.sub.id).toBe("A.B");
    expect(g.nodes.get("A.B")?.parent?.sub.id).toBe("A");
  });

  test("parentIds older hosts sent (Main, a tool call id) fall back to the dotted id", () => {
    const g = groupSubagents([sub("A", "running", undefined, "Main"), sub("A.B", "running", undefined, "call_7f2a|fc_0b41"), sub("C", "done", 4, "Main")]);
    expect(ids(g.active)).toEqual(["A"]);
    expect(g.nodes.get("A.B")?.parent?.sub.id).toBe("A");
    expect(g.nodes.get("A.B")?.orphanOf).toBeUndefined();
    expect(ids(g.completed)).toEqual(["C"]);
  });

  test("an orphan whose parent the roster lacks sits at the top level and says where it came from", () => {
    const g = groupSubagents([sub("Gone.Child", "running"), sub("Lone", "done", 3, "Gone")]);
    expect(ids(g.active)).toEqual(["Gone.Child"]);
    expect(g.nodes.get("Gone.Child")?.orphanOf).toBe("Gone");
    expect(g.nodes.get("Gone.Child")?.label).toBe("Gone.Child");
    expect(g.nodes.get("Lone")?.orphanOf).toBeUndefined();
  });

  test("a parent loop (malformed data) still lists every subagent once", () => {
    const g = groupSubagents([sub("A", "running", undefined, "B"), sub("B", "running", undefined, "A"), sub("C", "done", 1, "C")]);
    expect(treeOrder(g).map((s) => s.id).sort()).toEqual(["A", "B", "C"]);
    expect(g.active.length + g.completed.length).toBe(2);
  });

  test("treeOrder lists each subagent's own right after it, folded or not: the viewer's [ / ]", () => {
    const g = groupSubagents(nested);
    expect(treeOrder(g).map((s) => s.id)).toEqual(["DialogLab", "DialogLab.Api", "DialogLab.Ui", "DialogLab.Ui.Shots", "DialogLab.Ui.Copy", "Scout", "Docs"]);
  });

  test("a deep chain builds without recursion limits", () => {
    const chain = Array.from({ length: 5000 }, (_, i) => sub(`n${i}`, i === 4999 ? "failed" : "done", i, i > 0 ? `n${i - 1}` : undefined));
    const g = groupSubagents(chain);
    expect(ids(g.active)).toEqual(["n0"]);
    expect(g.nodes.get("n0")?.below.failed).toBe(1);
    expect(treeOrder(g)).toHaveLength(5000);
  });
});

describe("completedSummary", () => {
  test("lists only the non-zero counts", () => {
    expect(completedSummary({ done: 3, aborted: 0 })).toBe("3 done");
    expect(completedSummary({ done: 2, aborted: 1 })).toBe("2 done · 1 stopped");
    expect(completedSummary({ done: 0, aborted: 2 })).toBe("2 stopped");
  });
});
