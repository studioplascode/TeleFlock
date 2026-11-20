import { describe, expect, test } from "bun:test";
import type { AgentView, HostEntry } from "@/core";
import { coreStore } from "@/core/store/store";
import { cardsLeaveSentence, cardsLeaving } from "./workspaceActions";

const CHECKOUT = "/home/demo/.herdr/worktrees/teleflock/fix-reconnect";

function card(id: string, over: Partial<AgentView> = {}, hostId = "h"): AgentView {
  return {
    id,
    hostId,
    key: `${hostId}::${id}`,
    name: id,
    kind: "omp",
    paneId: "",
    tabId: "",
    workspaceId: "",
    state: "idle",
    stateSince: 0,
    column: "done",
    archived: true,
    turns: 1,
    title: id,
    live: { streaming: false, thinking: false },
    parked: { at: 0, sessionFile: `/s/${id}.jsonl` },
    ...over,
  } as unknown as AgentView;
}

/** The board shows `agents`, host `h` runs tf-hostd `version` (undefined: not known yet). */
function withBoard<T>(version: string | undefined, agents: AgentView[], run: () => T): T {
  const before = coreStore.getState();
  const host = { rev: 1, state: { info: version === undefined ? {} : { hostdVersion: version }, agents: [], workspaces: [] } } as unknown as HostEntry;
  coreStore.setState({ hosts: { ...before.hosts, h: host }, agents: Object.fromEntries(agents.map((a) => [a.key, a])) });
  try {
    return run();
  } finally {
    coreStore.setState({ hosts: before.hosts, agents: before.agents });
  }
}

describe("the cards a removed worktree takes off the board", () => {
  const board = [
    card("gobump", { parked: { at: 0, sessionFile: "/s/g.jsonl", worktree: { path: CHECKOUT, repoRoot: "/home/demo/code/teleflock" } } }),
    // no worktree recorded: its folder is inside the checkout (Linux reports a deleted cwd with a suffix)
    card("inside", { cwd: `${CHECKOUT}/src (deleted)` }),
    card("sibling", { cwd: `${CHECKOUT}-2` }),
    card("moving", { cwd: CHECKOUT, parked: { at: 0, sessionFile: "/s/m.jsonl", moved: { state: "moving", moveId: "mv", to: "b", at: 1 } } }),
    card("moved", { cwd: CHECKOUT, parked: { at: 0, sessionFile: "/s/d.jsonl", moved: { state: "moved", moveId: "mv", to: "b", at: 1 } } }),
    card("ended", { cwd: CHECKOUT, column: "review", archived: false, parked: { at: 0, sessionFile: "/s/e.jsonl", ended: { at: 1, cause: "herdrStopped", reason: "herdr stopped", turn: "idle" } } }),
    card("fixer", { parked: undefined, workspaceId: "w9", column: "review", archived: false, cwd: CHECKOUT }),
    card("elsewhere", { cwd: CHECKOUT }, "other"),
  ];
  const names = (t: { workspaceId?: string; path: string }) => cardsLeaving("h", t).map((a) => a.name);

  test("tf-hostd 0.9.6 drops the parked Done cards that ran in it, and the agents in the workspace that closes", () => {
    withBoard("0.9.6", board, () => {
      expect(names({ path: CHECKOUT })).toEqual(["gobump", "inside", "moved"]);
      expect(names({ workspaceId: "w9", path: CHECKOUT }).sort()).toEqual(["fixer", "gobump", "inside", "moved"]);
    });
    withBoard("1.0.0", board, () => expect(names({ path: CHECKOUT })).toHaveLength(3));
  });

  test("an older tf-hostd, or one whose version is not known yet, keeps every card", () => {
    withBoard("0.9.5", board, () => expect(names({ workspaceId: "w9", path: CHECKOUT })).toEqual([]));
    withBoard(undefined, board, () => expect(names({ workspaceId: "w9", path: CHECKOUT })).toEqual([]));
  });

  test("the confirm names them, and Past sessions only for omp agents", () => {
    expect(cardsLeaveSentence([])).toBeNull();
    expect(cardsLeaveSentence([card("gobump")])).toBe("gobump's card leaves the board; the conversation stays in Past sessions.");
    expect(cardsLeaveSentence([card("gobump"), card("fixer")])).toBe("The cards of gobump and fixer leave the board; their conversations stay in Past sessions.");
    expect(cardsLeaveSentence([card("gobump"), card("cc", { kind: "claude" })])).toBe("The cards of gobump and cc leave the board.");
  });
});
