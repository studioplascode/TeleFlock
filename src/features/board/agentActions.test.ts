import { describe, expect, test } from "bun:test";
import { type AgentView, core } from "@/core";
import { coreStore } from "@/core/store/store";
import { useToastStore } from "@/design";
import { agentWorktree, archiveWithUndo, canReview } from "./agentActions";

const CHECKOUT = "/home/demo/.herdr/worktrees/teleflock/fix-reconnect";

function parkedAgent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "fix-reconnect",
    hostId: "h",
    key: "h::fix-reconnect",
    name: "fix-reconnect",
    kind: "omp",
    paneId: "",
    tabId: "",
    workspaceId: "gone",
    state: "idle",
    stateSince: 0,
    column: "done",
    archived: true,
    turns: 4,
    title: "Fix reconnect backoff",
    branch: "fix/reconnect",
    live: { streaming: false, thinking: false },
    parked: { at: 0, sessionFile: "/s.jsonl", worktree: { path: CHECKOUT, repoRoot: "/home/demo/code/teleflock" } },
    ...over,
  } as unknown as AgentView;
}

describe("what a chat offers", () => {
  test("Review needs a repository and something to look at, and never comes to a chat", () => {
    expect(canReview({ repo: "teleflock", turns: 2 })).toBe(true);
    expect(canReview({ repo: "teleflock", turns: 0, diff: { files: 1 } })).toBe(true);
    expect(canReview({ repo: "teleflock", turns: 0 })).toBe(false);
    expect(canReview({ turns: 3, diff: { files: 2 } })).toBe(false);
    expect(canReview({ repo: "teleflock", turns: 3, diff: { files: 2 }, chat: true })).toBe(false);
  });

  test("a chat has no worktree to remove, even when its card remembers a checkout", () => {
    expect(agentWorktree(parkedAgent())).toMatchObject({ path: CHECKOUT, branch: "fix/reconnect", label: "fix-reconnect" });
    expect(agentWorktree(parkedAgent({ chat: true }))).toBeNull();
  });
});

describe("toasts", () => {
  test("Mark done names the card, not herdr's agent id (a terminal id)", async () => {
    const key = "h::term_65f3eb1dbbf071";
    const agents = coreStore.getState().agents;
    coreStore.setState({ agents: { ...agents, [key]: parkedAgent({ id: "term_65f3eb1dbbf071", key, name: "what-the-tallest", column: "review", archived: false, parked: undefined }) } });
    const realHost = core.host;
    const calls: string[] = [];
    core.host = (hostId) => ({
      call: (method, params) => {
        calls.push(`${hostId} ${method} ${JSON.stringify(params)}`);
        return Promise.resolve({} as never);
      },
    });
    try {
      expect(await archiveWithUndo([key])).toEqual([key]);
      // The host still gets the agent id; only what the person reads changes.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^h agent\.archive \{"agentId":"term_65f3eb1dbbf071"/);
      expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Marked what-the-tallest done");
    } finally {
      core.host = realHost;
      coreStore.setState({ agents });
    }
  });
});
