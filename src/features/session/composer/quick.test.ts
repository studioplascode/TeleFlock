import { describe, expect, test } from "bun:test";
import type { Capabilities, TranscriptItem, UserRun } from "@/core/gen";
import { MAX_RUN_MS, type PendingRun, pendingRuns, quickUnavailable, quickWhat, runRowsOf } from "./quick";

test("the cue's words", () => {
  expect(quickWhat({ python: false, excluded: false })).toEqual({ kind: "Shell command", output: "output goes to the agent" });
  expect(quickWhat({ python: true, excluded: true })).toEqual({ kind: "Python", output: "output not added to the context" });
});

describe("sessions that can't run them say why", () => {
  const caps = (extra: Partial<Capabilities>) => ({ bridge: true, shell: false, ...extra }) as Capabilities;
  test("a bridge without `shell` needs a restart; no bridge needs one in the session", () => {
    expect(quickUnavailable(caps({ shell: true }))).toBeNull();
    expect(quickUnavailable(caps({}))?.hint).toContain("Restart the agent");
    expect(quickUnavailable(caps({ bridge: false }))?.hint).toContain("start the agent from TeleFlock");
    expect(quickUnavailable(undefined)).not.toBeNull();
  });
});

const run = (body: string, extra: Partial<PendingRun> = {}): PendingRun => ({ id: 1, prefix: "!", python: false, excluded: false, body, at: 1_000, before: [], sending: false, ...extra });
const row = (id: string, command: string, userRun: UserRun | null = { python: false, excluded: false }): TranscriptItem => ({
  kind: "tool",
  id,
  at: 1,
  callId: id,
  tool: "bash",
  title: command,
  args: null,
  status: "ok",
  truncated: false,
  view: { type: "bash", command, output: "", background: false, timedOut: false },
  ...(userRun ? { userRun } : {}),
});

describe("a run waits for its row", () => {
  const key = "!c\0ls";
  test("a row of the same command the run did not see before is its own", () => {
    expect(pendingRuns([run("ls", { before: ["x1"] })], [{ id: "x1", key }], 2_000)).toHaveLength(1);
    expect(pendingRuns([run("ls", { before: ["x1"] })], [{ id: "x1", key }, { id: "x2", key }], 2_000)).toEqual([]);
    // One row each, oldest run first.
    const two = [run("ls", { id: 1 }), run("ls", { id: 2 })];
    expect(pendingRuns(two, [{ id: "x2", key }], 2_000).map((p) => p.id)).toEqual([2]);
    // The excluded run of the same command, or Python with that text, is another command.
    expect(pendingRuns([run("ls", { excluded: true, prefix: "!!" })], [{ id: "x2", key }], 2_000)).toHaveLength(1);
  });

  test("a run whose row never comes goes after a while", () => {
    expect(pendingRuns([run("sleep 9")], [], 1_000 + MAX_RUN_MS - 1)).toHaveLength(1);
    expect(pendingRuns([run("sleep 9")], [], 1_000 + MAX_RUN_MS)).toEqual([]);
  });

  test("the baseline lists the loaded rows of the same command only", () => {
    const items = [row("x1", "ls"), row("x2", "ls", { python: false, excluded: true }), row("t:1", "ls", null), row("x3", "ls -la")];
    expect(runRowsOf(items, { python: false, excluded: false, body: "ls" })).toEqual(["x1"]);
    expect(runRowsOf(items, { python: false, excluded: true, body: "ls" })).toEqual(["x2"]);
  });
});
