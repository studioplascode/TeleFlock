import { describe, expect, test } from "bun:test";
import type { Subagent } from "@/core/gen";
import { withRoster } from "./roster";

const sub = (id: string, status: Subagent["status"], extra: Partial<Subagent> = {}): Subagent => ({ id, name: id, status, ...extra });

describe("withRoster", () => {
  test("a background task card follows its subagents to their end", () => {
    // omp 18.13: the task call returned with every subagent still running; the roster saw them finish.
    const card = [sub("PongOne", "running", { description: "Reply with exactly `pong-1`." }), sub("PongTwo", "running")];
    const roster = [
      sub("PongOne", "done", { line: "pong-1", tokens: 7036, startedAt: 1, endedAt: 2001 }),
      sub("PongTwo", "failed", { description: "Reply with `pong-2`." }),
    ];
    const out = withRoster(card, roster);
    expect(out.map((a) => a.status)).toEqual(["done", "failed"]);
    expect(out[0]).toMatchObject({ line: "pong-1", tokens: 7036, endedAt: 2001, description: "Reply with exactly `pong-1`." });
    expect(out[1]?.description).toBe("Reply with `pong-2`.");
  });

  test("finished and unknown agents keep the card's record", () => {
    const card = [sub("Done", "done", { line: "final" }), sub("Gone", "running")];
    // A later subagent reusing the id runs again; one the roster no longer lists stays as the card has it.
    const out = withRoster(card, [sub("Done", "running", { line: "revived" })]);
    expect(out).toBe(card);
    expect(withRoster(card, [])).toBe(card);
    expect(withRoster(card, undefined)).toBe(card);
  });

  test("a still running agent takes the roster's fresher progress", () => {
    const card = [sub("Slow", "running", { line: "starting" })];
    const out = withRoster(card, [sub("Slow", "running", { line: "editing src/a.ts", completionPct: 40 })]);
    expect(out[0]).toMatchObject({ status: "running", line: "editing src/a.ts", completionPct: 40 });
  });
});
