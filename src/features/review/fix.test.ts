import { describe, expect, test } from "bun:test";
import type { Agent, PrInfo } from "@/core/gen";
import { type FixRun, fixBlocker, fixOffer, fixPhase, prNext, rebaseOnto, rebasePrompt, START_GRACE_MS, worktreeAgent } from "./fix";

const pr = (p: Partial<PrInfo> = {}): PrInfo => ({ number: 7, url: "u", title: "t", state: "OPEN", draft: false, mergeable: true, checks: { passed: 5, failed: 0, pending: 0 }, ...p });

function agent(id: string, p: Partial<Agent> = {}): Agent {
  return {
    id, name: id, kind: "omp", paneId: "p", tabId: "t", workspaceId: "w1", state: "idle", stateSince: 0, column: "review", archived: false, turns: 1, title: "",
    omp: { link: "live", bridge: true, fast: false, mode: "normal", queue: { steering: [], followUp: [] } },
    live: { streaming: false, thinking: false }, ...p,
  };
}

const run = (p: Partial<FixRun> = {}): FixRun => ({ kind: "green", agentKey: "h::a", agentName: "a", step: "sent", at: 0, sentAt: 0, ...p });

describe("ship: make it green / rebase", () => {
  test("what an open pull request needs", () => {
    expect(fixOffer(pr({ checks: { passed: 3, failed: 2, pending: 0 } }))).toEqual({ green: true, rebase: undefined });
    expect(fixOffer(pr({ mergeable: false }))).toEqual({ green: false, rebase: "conflicts" });
    expect(fixOffer(pr({ mergeState: "BEHIND" }))).toEqual({ green: false, rebase: "behind" });
    expect(fixOffer(pr({ state: "MERGED", checks: { passed: 0, failed: 2, pending: 0 } }))).toEqual({ green: false });
    expect(prNext(pr({ checks: { passed: 3, failed: 2, pending: 0 } }))).toBe("Make #7 green");
    expect(prNext(pr({ checks: { passed: 3, failed: 2, pending: 1 } }))).toBe("#7 checks running");
    expect(prNext(pr({ mergeable: false }))).toBe("Rebase #7");
    expect(prNext(pr())).toBe("Merge #7");
    expect(rebaseOnto(pr({ baseRef: "develop" }), "main")).toBe("origin/develop");
    expect(rebaseOnto(undefined, undefined)).toBe("origin/main");
    expect(rebasePrompt("origin/main", "conflicts")).toContain("git fetch origin main");
    expect(rebasePrompt("origin/main", "behind")).toContain("--force-with-lease");
  });

  test("the worktree's agent: live in the workspace (idle first), else the latest parked one in its checkout", () => {
    const ws = { id: "w1", cwd: "/r", worktree: { path: "/wt/x", branch: "x", repoRoot: "/r", main: false, locked: false, prunable: false } } as never;
    const busy = agent("busy", { column: "running", stateSince: 9 });
    const idle = agent("idle", { stateSince: 1 });
    expect(worktreeAgent([busy, idle], ws)?.id).toBe("idle");
    const old = agent("old", { workspaceId: "", cwd: "/wt/x", parked: { at: 1, sessionFile: "/s1" } });
    const recent = agent("recent", { workspaceId: "", cwd: "/elsewhere", parked: { at: 5, sessionFile: "/s2", worktree: { path: "/wt/x", repoRoot: "/r" } } });
    expect(worktreeAgent([old, recent, agent("other", { workspaceId: "w2" })], ws)?.id).toBe("recent");
    expect(worktreeAgent([agent("plain", { kind: "claude" })], ws)).toBeUndefined();
    expect(fixBlocker(busy, "green")).toContain("working");
    expect(fixBlocker(agent("nb", { omp: { link: "live", bridge: false, fast: false, mode: "normal", queue: { steering: [], followUp: [] } } }), "green")).toContain("bridge");
    expect(fixBlocker(old, "green")).toBeUndefined();
    expect(fixBlocker(undefined, "rebase")).toBeDefined();
  });

  test("progress follows the agent, then the pull request", () => {
    const failing = pr({ checks: { passed: 3, failed: 2, pending: 0 } });
    expect(fixPhase(run({ step: "resuming" }), undefined, failing, 0)).toBe("resuming");
    expect(fixPhase(run(), agent("a", { column: "running" }), failing, 1)).toBe("working");
    expect(fixPhase(run(), agent("a", { column: "needs" }), failing, 1)).toBe("needsYou");
    expect(fixPhase(run(), agent("a"), failing, 1)).toBe("starting");
    expect(fixPhase(run(), agent("a"), failing, START_GRACE_MS + 1)).toBe("stopped");
    expect(fixPhase(run({ worked: true }), agent("a"), failing, 1)).toBe("stopped");
    expect(fixPhase(run({ worked: true }), agent("a"), pr({ checks: { passed: 3, failed: 0, pending: 2 } }), 1)).toBe("checksRunning");
    expect(fixPhase(run({ worked: true }), agent("a"), pr(), 1)).toBe("done");
    const rebase = run({ kind: "rebase", worked: true });
    expect(fixPhase(rebase, agent("a"), pr({ mergeable: undefined }), 1)).toBe("recheck");
    expect(fixPhase(rebase, agent("a"), pr({ mergeable: false }), 1)).toBe("stopped");
    expect(fixPhase(rebase, agent("a"), pr({ mergeState: "CLEAN" }), 1)).toBe("done");
    expect(fixPhase(rebase, agent("a"), pr({ state: "MERGED" }), 1)).toBe("done");
  });
});
