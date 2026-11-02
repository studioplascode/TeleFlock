import { describe, expect, test } from "bun:test";
import type { AgentEnded, ChatDeletion, ChatFolder, Parked } from "@/core/gen";
import { chatCardState, chatRowAction, chatsSection, deleteSummary, folderDelete, inChatsDir, keptFolder, keptOf } from "./model";

const HOME = "/home/demo";
const DIR = `${HOME}/.teleflock/chats`;
const FOLDER = `${DIR}/plan-trip-ab12cd`;

function deletion(p: Partial<ChatDeletion> = {}): ChatDeletion {
  return { folder: FOLDER, kept: [], keptCount: 0, removed: false, working: false, ...p };
}

function folder(p: Partial<ChatFolder> = {}): ChatFolder {
  return { folder: FOLDER, title: "Plan the Lisbon trip", kept: [], keptCount: 0, bytes: 4096, ...p };
}

const parked = (p: Partial<Parked> = {}): Parked => ({ at: 0, sessionFile: "/s.jsonl", ...p });
const ended = { at: 0, reason: "the host restarted" } as unknown as AgentEnded;

describe("deleting a chat", () => {
  test("a folder holding nothing but omp's own files goes with the chat", () => {
    expect(deleteSummary(deletion(), HOME)).toEqual({ folder: "~/.teleflock/chats/plan-trip-ab12cd", folderGoes: true, kept: [], more: 0, working: false });
  });

  test("anything someone made keeps the folder: the names the host listed and how many more", () => {
    const kept = Array.from({ length: 20 }, (_, i) => `draft-${i}.md`);
    expect(deleteSummary(deletion({ kept, keptCount: 23, working: true }), HOME)).toMatchObject({ folderGoes: false, kept, more: 3, working: true });
    expect(deleteSummary(deletion({ kept: ["itinerary.md"], keptCount: 1 }))).toMatchObject({ folder: FOLDER, folderGoes: false, more: 0 });
  });

  test("another card working in the folder keeps it, empty or not", () => {
    expect(deleteSummary(deletion({ sharedWith: "Second opinion" }), HOME)).toMatchObject({ folderGoes: false, sharedWith: "Second opinion", kept: [], more: 0 });
  });

  test("the result names the folder only when it stayed", () => {
    expect(keptFolder(deletion({ removed: true }), HOME)).toBeNull();
    expect(keptFolder(deletion({ kept: ["itinerary.md"], keptCount: 1 }), HOME)).toBe("~/.teleflock/chats/plan-trip-ab12cd");
  });
});

describe("chat folders on the Cleanup page", () => {
  test("a folder with a card is deleted through its agent, whatever it holds", () => {
    expect(chatRowAction(folder({ agentId: "plan-trip" }))).toEqual({ kind: "agent", agentId: "plan-trip" });
    expect(chatRowAction(folder({ agentId: "plan-trip", kept: ["itinerary.md"], keptCount: 1 }))).toEqual({ kind: "agent", agentId: "plan-trip" });
  });

  test("a folder no card uses goes by itself only while nothing of anyone's is in it", () => {
    expect(chatRowAction(folder())).toEqual({ kind: "folder", folder: FOLDER });
    expect(chatRowAction(folder({ kept: ["itinerary.md"], keptCount: 1 }))).toEqual({ kind: "none" });
  });

  test("a row names a few kept entries and counts the rest", () => {
    expect(keptOf(folder({ kept: ["a.md", "b.md", "c.md", "d.md"], keptCount: 30 }), 3)).toEqual({ names: ["a.md", "b.md", "c.md"], more: 27 });
    expect(keptOf(folder({ kept: ["a.md"], keptCount: 1 }), 3)).toEqual({ names: ["a.md"], more: 0 });
    expect(keptOf(folder())).toEqual({ names: [], more: 0 });
  });

  test("a folder delete goes ahead only while no agent works there: one resumed since the list was read is not stopped unasked", () => {
    expect(folderDelete(deleteSummary(deletion(), HOME))).toBe("confirm");
    expect(folderDelete(deleteSummary(deletion({ kept: ["itinerary.md"], keptCount: 1 }), HOME))).toBe("nothing");
    // the host would delete the agent with the folder; the confirm for a folder says nothing about one
    expect(folderDelete(deleteSummary(deletion({ working: true }), HOME))).toBe("inUse");
    expect(folderDelete(deleteSummary(deletion({ working: true, kept: ["itinerary.md"], keptCount: 1 }), HOME))).toBe("inUse");
  });

  test("its card's state comes from the board", () => {
    expect(chatCardState(undefined)).toBe("none");
    expect(chatCardState({ column: "running" })).toBe("running");
    expect(chatCardState({ column: "needs" })).toBe("needs");
    expect(chatCardState({ column: "review" })).toBe("idle");
    expect(chatCardState({ column: "review", parked: parked({ ended }) })).toBe("ended");
    expect(chatCardState({ column: "done", parked: parked() })).toBe("done");
    expect(chatCardState({ column: "done", parked: parked({ ended }) })).toBe("done");
  });

  test("the section lists where the host starts chats, asks for an update where another host does, else stays away", () => {
    expect(chatsSection({ hostTakes: true, anyHostTakes: true, outdated: false })).toBe("list");
    expect(chatsSection({ hostTakes: true, anyHostTakes: true, outdated: true })).toBe("update");
    expect(chatsSection({ hostTakes: false, anyHostTakes: true, outdated: false })).toBe("update");
    expect(chatsSection({ hostTakes: false, anyHostTakes: false, outdated: false })).toBe("hidden");
  });
});

describe("chat workspaces", () => {
  test("a folder under the host's chats folder is a chat's; a sibling with a longer name is not", () => {
    expect(inChatsDir(FOLDER, DIR)).toBe(true);
    expect(inChatsDir(DIR, `${DIR}/`)).toBe(true);
    expect(inChatsDir(`${HOME}/.teleflock/chats-old/x`, DIR)).toBe(false);
    expect(inChatsDir(`${HOME}/code/teleflock`, DIR)).toBe(false);
    expect(inChatsDir("C:\\Users\\me\\.teleflock\\chats\\plan-ab12cd", "C:\\Users\\me\\.teleflock\\chats")).toBe(true);
    // a daemon before chats has no chats folder
    expect(inChatsDir(FOLDER, undefined)).toBe(false);
  });
});
