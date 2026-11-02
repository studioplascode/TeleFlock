import { describe, expect, test } from "bun:test";
import { chatsUnsupported } from "../chats";
import type { AppEvent, ChatDeletion, ChatFolders, PastSessions, SessionSnapshot, Started } from "../gen";
import { agentKey } from "../keys";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { CHATS } from "./chats";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { PARK_GRACE_MS } from "./parking";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  const events: AppEvent[] = [];
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    events.push(e);
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const call = async <T = unknown>(method: string, params: unknown = {}, hostId = "forge"): Promise<T> => {
    const p = engine.callHost(hostId, method, params);
    clock.advance(400);
    return (await p) as T;
  };
  clock.advance(3000);
  return {
    clock,
    engine,
    call,
    get state() {
      return state;
    },
    /** forge's Chats workspace, while one is open. */
    chatsWs() {
      return state.hosts.forge?.state.workspaces.find((w) => w.cwd === CHATS);
    },
  };
}

const key = (id: string) => agentKey("forge", id);
const SPEC = { kind: "omp", plan: false };
const chat = (spec: Record<string, unknown>) => ({ target: { kind: "chat" }, spec: { ...SPEC, ...spec } });

describe("demo chats", () => {
  test("forge starts chats; studio-pc plays a daemon from before them", async () => {
    const r = rig();
    expect(r.state.hosts.forge?.state.info.chats).toBe(CHATS);
    expect(r.state.hosts["studio-pc"]?.state.info.chats).toBeUndefined();
    let fingerprint: string | undefined;
    for (let i = 0; i < 400 && !fingerprint; i++) {
      r.clock.advance(100);
      fingerprint = r.state.status["studio-pc"]?.hostKey?.fingerprint;
    }
    await r.engine.callApp("hosts.trustKey", { hostId: "studio-pc", fingerprint });
    r.clock.advance(2000);
    expect(r.state.status["studio-pc"]?.phase).toBe("online");
    // what an app tells apart as "update the host" (`@/core/chats`)
    const refused = await r.call("agent.start", chat({ prompt: "Hi" }), "studio-pc").catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "invalid_params" });
    expect(chatsUnsupported(refused)).toBe(true);
    const unknown = await r.call("chat.list", {}, "studio-pc").catch((e: unknown) => e);
    expect(unknown).toMatchObject({ code: "unknown_method" });
    expect(chatsUnsupported(unknown)).toBe(true);
  });

  test("a chat runs in its own new folder, in a new tab of the one Chats workspace, with no repository", async () => {
    const r = rig();
    const seeded = r.chatsWs();
    expect([seeded?.label, seeded?.repo]).toEqual(["Chats", undefined]);
    const first = await r.call<Started>("agent.start", chat({ prompt: "Plan a weekend in Porto with good coffee" }));
    r.clock.advance(300);
    const a = r.state.agents[key(first.agentId as string)];
    expect(a).toMatchObject({ chat: true, name: "plan-a-weekend-in-porto-with", title: "Plan a weekend in Porto with good coffee", workspaceId: seeded?.id });
    expect([a?.repo, a?.branch, a?.diff]).toEqual([undefined, undefined, undefined]);
    expect(a?.cwd).toMatch(new RegExp(`^${CHATS}/plan-a-weekend-in-porto-with-[a-z0-9]{6}$`));
    const tab = r.chatsWs()?.tabs.find((t) => t.id === a?.tabId);
    expect(tab?.label).toBe("plan-a-weekend-in-porto-with");
    expect(tab?.panes.map((p) => [p.id, p.cwd, p.agentId])).toEqual([[first.paneId, a?.cwd, first.agentId]]);

    // as tf-hostd names them: the same prompt again gets a name of its own; a name asked for is kept while it is a
    // valid herdr name no agent has, else one is made from it; no name and no prompt: `chat`
    const again = await r.call<Started>("agent.start", chat({ prompt: "Plan a weekend in Porto with good coffee" }));
    const named = await r.call<Started>("agent.start", chat({ name: "coffee" }));
    const taken = await r.call<Started>("agent.start", chat({ name: "coffee" }));
    const odd = await r.call<Started>("agent.start", chat({ name: "Not A Name" }));
    const bare = await r.call<Started>("agent.start", chat({}));
    r.clock.advance(300);
    const names = [again, named, taken, odd, bare].map((s) => r.state.agents[key(s.agentId as string)]?.name);
    expect(names).toEqual(["plan-a-weekend-in-porto-with-2", "coffee", "coffee-2", "not-a-name", "chat"]);
    expect(r.state.agents[key(named.agentId as string)]).toMatchObject({ title: "coffee", chat: true });
    expect(new Set([first, again, named, taken, odd, bare].map((s) => s.workspaceId))).toEqual(new Set([seeded?.id]));
    const tabs = r.chatsWs()?.tabs ?? [];
    expect(tabs.slice(1).map((t) => t.label)).toEqual(["plan-a-weekend-in-porto-with", ...names]);
    expect(new Set(tabs.map((t) => t.id)).size).toBe(tabs.length);
    expect(new Set(tabs.flatMap((t) => t.panes.map((p) => p.cwd))).size).toBe(tabs.length);

    // checked like any start, before anything is made
    await expect(r.call("agent.start", chat({ prompt: "x", autoAnswer: { enabled: true, afterSecs: 5, onlyWhenNoApp: false } }))).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("agent.start", chat({ prompt: "x", roleModels: { smol: "nope" } }))).rejects.toMatchObject({ code: "invalid_params" });
    r.clock.advance(300);
    expect(r.chatsWs()?.tabs).toHaveLength(tabs.length);
    expect((await r.call<ChatFolders>("chat.list")).chats.filter((c) => c.folder.startsWith(`${CHATS}/x-`))).toHaveLength(0);
  });

  test("the Chats workspace goes with its last tab and comes back for the next chat", async () => {
    const r = rig();
    const before = r.chatsWs();
    // the seeded done chat is parked: lisbon's is the only tab
    expect(before?.tabs.map((t) => t.label)).toEqual(["lisbon"]);
    await r.call("chat.delete", { agentId: "lisbon" });
    r.clock.advance(300);
    expect(r.chatsWs()).toBeUndefined();
    const a = await r.call<Started>("agent.start", chat({ prompt: "Hello there" }));
    const b = await r.call<Started>("agent.start", chat({ prompt: "Another question" }));
    r.clock.advance(300);
    const ws = r.chatsWs();
    expect(ws).toMatchObject({ label: "Chats" });
    expect(ws?.id).not.toBe(before?.id);
    expect([a.workspaceId, b.workspaceId]).toEqual([ws?.id, ws?.id]);
    expect(ws?.tabs.map((t) => t.panes[0]?.agentId)).toEqual([a.agentId, b.agentId]);
  });

  test("the first prompt gets a conversational reply: a web search at most, no edits, tests or commits", async () => {
    const r = rig();
    const s = await r.call<Started>("agent.start", chat({ prompt: "What's the best time of year to visit Kyoto?" }));
    r.clock.advance(2000);
    expect(r.state.agents[key(s.agentId as string)]?.column).toBe("running");
    r.clock.advance(20_000);
    const a = r.state.agents[key(s.agentId as string)];
    expect([a?.column, a?.state, a?.diff, a?.title]).toEqual(["review", "done", undefined, "What's the best time of year to visit Kyoto?"]);
    const snap = await r.call<SessionSnapshot>("session.open", { agentId: s.agentId });
    expect(snap.items.flatMap((i) => (i.kind === "tool" ? [i.tool] : []))).toEqual(["web_search"]);
    expect(snap.items.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["What's the best time of year to visit Kyoto?"]);
    expect(snap.items.some((i) => i.kind === "assistant" && i.text.length > 100)).toBe(true);
    // a follow-up is a conversation too
    await r.call("agent.prompt", { agentId: s.agentId, text: "Thanks! Make it shorter", images: [], delivery: "auto" });
    r.clock.advance(20_000);
    const after = await r.call<SessionSnapshot>("session.open", { agentId: s.agentId });
    expect(after.items.flatMap((i) => (i.kind === "tool" ? [i.tool] : []))).toEqual(["web_search"]);
    expect(r.state.agents[key(s.agentId as string)]?.column).toBe("review");
  });

  test("Mark done parks a chat; resuming opens it in a new Chats tab at its folder, still a chat", async () => {
    const r = rig();
    const folder = r.state.agents[key("lisbon")]?.cwd;
    await r.call("agent.archive", { agentId: "lisbon", archived: true, close: true });
    r.clock.advance(PARK_GRACE_MS + 400);
    expect(r.state.agents[key("lisbon")]?.parked).toBeDefined();
    expect(r.chatsWs()).toBeUndefined();
    const started = await r.call<Started>("agent.resume", { agentId: "lisbon" });
    r.clock.advance(300);
    const back = r.state.agents[key(started.agentId as string)];
    expect(back).toMatchObject({ chat: true, cwd: folder, workspaceId: r.chatsWs()?.id });
    expect(back?.parked).toBeUndefined();
    expect(r.chatsWs()?.tabs.find((t) => t.id === back?.tabId)?.panes[0]).toMatchObject({ id: started.paneId, cwd: folder, agentId: started.agentId });
    expect((await r.call<ChatFolders>("chat.list")).chats.find((c) => c.folder === folder)?.agentId).toBe(started.agentId);
    // the seeded done chat comes back the same way, next to it
    const pc = await r.call<Started>("agent.resume", { agentId: "postcodes" });
    r.clock.advance(300);
    expect(r.state.agents[key(pc.agentId as string)]).toMatchObject({ chat: true, workspaceId: r.chatsWs()?.id });
    expect(r.chatsWs()?.tabs.map((t) => t.label)).toEqual(["lisbon", "postcodes"]);
  });

  test("chat.list: every folder, newest first, with the card that uses it and what keeps it", async () => {
    const r = rig();
    const list = await r.call<ChatFolders>("chat.list");
    expect(list.dir).toBe(CHATS);
    expect(list.chats.map((c) => [c.folder.slice(CHATS.length + 1), c.agentId, c.title, c.kept, c.keptCount])).toEqual([
      ["lisbon-k3x9q2", "lisbon", "Three relaxed days in Lisbon", ["itinerary.md"], 1],
      ["postcodes-4hz8wq", "postcodes", "Regex for UK postcodes", [], 0],
      ["birthday-party-q2w9n4", undefined, "birthday-party-q2w9n4", [], 0],
      ["dinner-ideas-8f2k1p", undefined, "dinner-ideas-8f2k1p", ["recipes.md"], 1],
    ]);
    // omp's own `.omp/` counts toward the size but never keeps a folder
    expect(list.chats.map((c) => c.bytes > 0)).toEqual([true, false, true, true]);
    expect(r.state.agents[key("postcodes")]?.parked).toBeDefined();
  });

  test("chat.delete: a dry run changes nothing; deleting forgets the card and removes the folder unless something keeps it", async () => {
    const r = rig();
    const folder = r.state.agents[key("lisbon")]?.cwd as string;
    const dry = await r.call<ChatDeletion>("chat.delete", { agentId: "lisbon", dryRun: true });
    expect(dry).toEqual({ folder, kept: ["itinerary.md"], keptCount: 1, removed: false, working: false });
    r.clock.advance(300);
    expect(r.state.agents[key("lisbon")]).toBeDefined();
    expect(r.state.hosts.forge?.state.info.pruned).toBeUndefined();

    // by its folder: the chat in it goes too
    expect(await r.call<ChatDeletion>("chat.delete", { folder })).toEqual(dry);
    r.clock.advance(300);
    expect(r.state.agents[key("lisbon")]).toBeUndefined();
    expect(r.state.hosts.forge?.state.info.pruned).toEqual([{ agentId: "lisbon", sessionId: expect.any(String), at: expect.any(Number) }]);
    // the folder stays for the file in it, with no card now; TeleFlock leaves it alone
    const left = (await r.call<ChatFolders>("chat.list")).chats.find((c) => c.folder === folder);
    expect(left).toMatchObject({ title: "lisbon-k3x9q2", kept: ["itinerary.md"], keptCount: 1 });
    expect(left?.agentId).toBeUndefined();
    expect(await r.call<ChatDeletion>("chat.delete", { folder })).toEqual({ folder, kept: ["itinerary.md"], keptCount: 1, removed: false, working: false });
    // omp's session stays: Past sessions resumes it into its folder, as a chat
    const past = (await r.call<PastSessions>("host.sessions", { cwd: CHATS })).sessions.find((s) => s.cwd === folder);
    expect(past).toMatchObject({ live: false, title: "Three relaxed days in Lisbon" });
    const resumed = await r.call<Started>("host.resume", { sessionFile: past?.file, target: { kind: "cwd", cwd: folder, label: null } });
    r.clock.advance(300);
    expect(r.state.agents[key(resumed.agentId as string)]).toMatchObject({ chat: true, cwd: folder, workspaceId: r.chatsWs()?.id, title: "Three relaxed days in Lisbon" });

    // a parked chat whose folder is empty: the folder goes with it; resuming its session there makes it again, empty
    const pcFolder = r.state.agents[key("postcodes")]?.cwd as string;
    expect(await r.call<ChatDeletion>("chat.delete", { agentId: "postcodes" })).toEqual({ folder: pcFolder, kept: [], keptCount: 0, removed: true, working: false });
    expect((await r.call<ChatFolders>("chat.list")).chats.some((c) => c.folder === pcFolder)).toBe(false);
    const pcPast = (await r.call<PastSessions>("host.sessions", { cwd: pcFolder })).sessions[0];
    const again = await r.call<Started>("host.resume", { sessionFile: pcPast?.file, target: { kind: "cwd", cwd: pcFolder, label: null } });
    r.clock.advance(300);
    expect(r.state.agents[key(again.agentId as string)]).toMatchObject({ chat: true, cwd: pcFolder });

    // a folder without a card that holds only omp's plan goes by folder; one that is gone already holds nothing
    const orphan = `${CHATS}/birthday-party-q2w9n4`;
    expect(await r.call<ChatDeletion>("chat.delete", { folder: orphan, dryRun: true })).toEqual({ folder: orphan, kept: [], keptCount: 0, removed: false, working: false });
    expect(await r.call<ChatDeletion>("chat.delete", { folder: `${orphan}/` })).toEqual({ folder: orphan, kept: [], keptCount: 0, removed: true, working: false });
    expect(await r.call<ChatDeletion>("chat.delete", { folder: orphan })).toEqual({ folder: orphan, kept: [], keptCount: 0, removed: false, working: false });
    r.clock.advance(300);
    const list = (await r.call<ChatFolders>("chat.list")).chats;
    expect(list.map((c) => [c.folder.slice(CHATS.length + 1), c.agentId])).toEqual([
      ["postcodes-4hz8wq", again.agentId],
      ["lisbon-k3x9q2", resumed.agentId],
      ["dinner-ideas-8f2k1p", undefined],
    ]);
    expect(list[0]).toMatchObject({ kept: [], keptCount: 0, bytes: 0 });
    expect(r.state.hosts.forge?.state.info.pruned?.map((p) => p.agentId)).toEqual(["postcodes", "lisbon"]);
    expect(r.state.agents[key("postcodes")]).toBeUndefined();
  });

  test("deleting a working chat stops it and closes its tab; the name is free again, never its id", async () => {
    const r = rig();
    await r.call<Started>("agent.start", chat({ name: "kyoto", prompt: "Compare ryokans in Kyoto for a family of four" }));
    r.clock.advance(2000);
    const kyoto = r.state.agents[key("kyoto")];
    const folder = kyoto?.cwd;
    const tabId = kyoto?.tabId;
    expect(await r.call<ChatDeletion>("chat.delete", { agentId: "kyoto", dryRun: true })).toEqual({ folder, kept: [], keptCount: 0, removed: false, working: true });
    expect(r.state.agents[key("kyoto")]?.column).toBe("running");
    expect(await r.call<ChatDeletion>("chat.delete", { agentId: "kyoto" })).toEqual({ folder, kept: [], keptCount: 0, removed: true, working: true });
    r.clock.advance(300);
    expect(r.state.agents[key("kyoto")]).toBeUndefined();
    expect(r.chatsWs()?.tabs.some((t) => t.id === tabId)).toBe(false);
    // apps drop what they keep for a pruned id, so a new chat by that name gets another one
    const next = await r.call<Started>("agent.start", chat({ name: "kyoto" }));
    r.clock.advance(300);
    expect(next.agentId).not.toBe("kyoto");
    expect(r.state.agents[key(next.agentId as string)]).toMatchObject({ name: "kyoto", chat: true });
  });

  test("another card working in a chat's folder keeps it: the delete says who", async () => {
    const r = rig();
    await r.call<Started>("agent.start", chat({ name: "kyoto", prompt: "Compare ryokans in Kyoto for a family of four" }));
    r.clock.advance(2000);
    const folder = r.state.agents[key("kyoto")]?.cwd as string;
    // A second agent started in that folder (a tab of the Chats workspace): a chat too.
    const second = await r.call<Started>("agent.start", { target: { kind: "cwd", cwd: folder, label: null }, spec: { ...SPEC, name: "second", prompt: "Check the onsen hours" } });
    r.clock.advance(2000);
    const title = r.state.agents[key(second.agentId as string)]?.title;
    expect(r.state.agents[key(second.agentId as string)]).toMatchObject({ chat: true, cwd: folder });
    expect(await r.call<ChatDeletion>("chat.delete", { agentId: "kyoto", dryRun: true })).toMatchObject({ folder, removed: false, sharedWith: title });
    expect(await r.call<ChatDeletion>("chat.delete", { agentId: "kyoto" })).toMatchObject({ folder, removed: false, sharedWith: title });
    r.clock.advance(300);
    expect(r.state.agents[key("kyoto")]).toBeUndefined();
    // The second one goes with the folder.
    expect(await r.call<ChatDeletion>("chat.delete", { agentId: second.agentId })).toEqual({ folder, kept: [], keptCount: 0, removed: true, working: true });
  });

  test("chat.delete refuses what isn't a chat or a chat folder", async () => {
    const r = rig();
    const lisbon = r.state.agents[key("lisbon")]?.cwd;
    await expect(r.call("chat.delete", { agentId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(r.call("chat.delete", { agentId: "kanban" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("chat.delete", { agentId: "lisbon", folder: `${CHATS}/dinner-ideas-8f2k1p` })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("chat.delete", { folder: "/home/demo/code/teleflock" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("chat.delete", { folder: `${lisbon}/.omp` })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("chat.delete", { folder: CHATS })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("chat.delete", {})).rejects.toMatchObject({ code: "invalid_params" });
    r.clock.advance(300);
    expect([r.state.agents[key("kanban")]?.id, r.state.agents[key("lisbon")]?.id]).toEqual(["kanban", "lisbon"]);
    expect(r.state.hosts.forge?.state.info.pruned).toBeUndefined();
  });
});
