import { describe, expect, test } from "bun:test";
import { CHAT_REPO, CHATS_NEED_UPDATE } from "@/core/chats";
import type { Agent, ConnStatus, HostProfile, HostState } from "@/core/gen";
import { planSend } from "./send";
import { threadKey } from "./store";

const CHATS = "/home/a/.teleflock/chats";
const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
const memory = { threads: {}, remotes: {}, bases: {}, legacyBases: {} };
const img = { mime: "image/png", data: "iVBORw0KGgo=", preview: "data:image/png;base64,iVBORw0KGgo=" };

const profile = (id: string, group?: string): HostProfile => ({ id, name: id.toUpperCase(), kind: "tailscaleSsh", herdrSession: "default", autoConnect: true, ...(group ? { group } : {}) });
const online = (...ids: string[]): Record<string, ConnStatus> => Object.fromEntries(ids.map((id) => [id, { phase: "online", since: 0, attempt: 0 } as ConnStatus]));
const running = (host: string, n: number): Agent[] => Array.from({ length: n }, (_, i) => ({ id: `${host}-${i}`, name: `${host}-agent-${i}`, column: "running" }) as Agent);

/** A host's state: its daemon starts chats unless `chats: false`; `version: null` = not known. */
function state(p: { chats?: boolean; version?: string | null; agents?: Agent[] } = {}): HostState {
  return {
    info: { home: "/home/a", ...(p.version === null ? {} : { hostdVersion: p.version ?? "0.8.0" }), ...(p.chats === false ? {} : { chats: CHATS }) },
    agents: p.agents ?? [],
    workspaces: [],
  } as unknown as HostState;
}

describe("planSend: chats", () => {
  test("a single host takes a chat only when its daemon starts chats", () => {
    const w = {
      profiles: [profile("new"), profile("old"), profile("gone")],
      status: online("new", "old"),
      states: { new: state({ agents: running("new", 1) }), old: state({ chats: false, version: "0.7.0" }) },
      dispatch: memory,
    };
    const req = { target: "new", repo: CHAT_REPO, prompt: "Which hiking boots for the Alps?", images: [], options };
    const plan = planSend(w, req);
    if (!plan.ok) throw new Error(plan.title);
    expect(plan.hostId).toBe("new");
    // Named against the host's agents; no branch list, base or worktree.
    expect(plan.args).toMatchObject({ key: threadKey("new", CHAT_REPO), hostId: "new", repo: CHAT_REPO, taken: ["new-agent-0"] });
    expect([plan.args.base, plan.args.baseLabel, plan.args.resolveBase]).toEqual([undefined, undefined, undefined]);
    // A daemon from before chats: refused with the update words.
    expect(planSend(w, { ...req, target: "old" })).toEqual({ ok: false, title: CHATS_NEED_UPDATE.title, description: CHATS_NEED_UPDATE.hint });
    // Never heard from: whether it starts chats isn't known.
    expect(planSend(w, { ...req, target: "gone" })).toEqual({ ok: false, title: "GONE is offline" });
  });

  test("Auto sends a chat to the least busy online host of the group that starts chats", () => {
    const profiles = ["p1", "p2", "p3", "p4"].map((id) => profile(id, "pool"));
    const states = {
      p1: state({ agents: running("p1", 2) }),
      // Idle, but its daemon predates chats.
      p2: state({ chats: false, version: "0.7.0" }),
      // Starts chats, idle, offline.
      p3: state(),
      p4: state({ agents: running("p4", 1) }),
    };
    const req = { target: "auto:pool", repo: CHAT_REPO, prompt: "Plan a week in Lisbon", images: [], options };
    const plan = planSend({ profiles, status: online("p1", "p2", "p4"), states, dispatch: memory }, req);
    if (!plan.ok) throw new Error(plan.title);
    expect([plan.hostId, plan.args.key, plan.args.repo]).toEqual(["p4", threadKey("auto:pool", CHAT_REPO), CHAT_REPO]);
    // Weighed against the group's other hosts that start chats only.
    expect(plan.args.placed).toBe("least busy of 3: 1 running (P1: 2 running)");
    // Only the host from before chats is online.
    expect(planSend({ profiles, status: online("p2"), states, dispatch: memory }, req)).toEqual({ ok: false, title: "No host of pool that starts chats is online", description: "P1, P3, P4" });
    // No host of the group starts chats.
    const old = ["o1", "o2"].map((id) => profile(id, "old"));
    expect(planSend({ profiles: old, status: online("o1", "o2"), states: { o1: state({ chats: false }), o2: state({ chats: false }) }, dispatch: memory }, { ...req, target: "auto:old" })).toEqual({
      ok: false,
      title: "No host of old can start chats yet",
      description: "Update TeleFlock's daemon on O1, O2 (Hosts → Update), then try again",
    });
  });

  test("Auto leaves hosts that can't take images out of a chat with images", () => {
    const profiles = ["p1", "p5"].map((id) => profile(id, "pool"));
    // p5 is idle, but its daemon's version isn't known: images need 0.5.
    const states = { p1: state({ agents: running("p1", 2) }), p5: state({ version: null }) };
    const w = { profiles, status: online("p1", "p5"), states, dispatch: memory };
    const req = { target: "auto:pool", repo: CHAT_REPO, prompt: "What is in this photo?", images: [], options };
    expect(planSend(w, req)).toMatchObject({ ok: true, hostId: "p5" });
    expect(planSend(w, { ...req, images: [img] })).toMatchObject({ ok: true, hostId: "p1" });
    expect(planSend({ ...w, states: { ...states, p1: state({ version: null }) } }, { ...req, images: [img] })).toMatchObject({
      ok: false,
      title: "No host of pool that starts chats can take images yet",
    });
  });
});

describe("planSend: commands", () => {
  const command = { line: "/plan add a settings page", replacesPlan: true };

  test("a command goes only to a daemon that runs commands in new agents", () => {
    const w = {
      profiles: [profile("new"), profile("old"), profile("unknown")],
      status: online("new", "old", "unknown"),
      states: { new: state({ version: "0.9.1" }), old: state({ version: "0.9.0" }), unknown: state({ version: null }) },
      dispatch: memory,
    };
    const req = { target: "new", repo: "/home/a/app", prompt: command.line, images: [], options, command };
    expect(planSend(w, req)).toMatchObject({ ok: true, hostId: "new", args: { command, prompt: command.line } });
    // Older daemons would drop the command and start the agent idle; an unknown one may be older.
    expect(planSend(w, { ...req, target: "old" })).toMatchObject({ ok: false });
    expect(planSend(w, { ...req, target: "unknown" })).toMatchObject({ ok: false });
    // The same words as text go anywhere.
    expect(planSend(w, { ...req, target: "old", command: undefined })).toMatchObject({ ok: true, hostId: "old" });
    // Chats run commands the same way.
    expect(planSend(w, { ...req, repo: CHAT_REPO })).toMatchObject({ ok: true, args: { command } });
    expect(planSend(w, { ...req, repo: CHAT_REPO, target: "old" })).toMatchObject({ ok: false });
  });

  test("Auto sends a command to the least busy host of the group that runs it", () => {
    const profiles = ["p1", "p2"].map((id) => profile(id, "pool"));
    // p2 is idle but its daemon predates commands; p1 is busy.
    const states = { p1: state({ version: "0.9.1", agents: running("p1", 2) }), p2: state({ version: "0.9.0" }) };
    const w = { profiles, status: online("p1", "p2"), states, dispatch: memory };
    const req = { target: "auto:pool", repo: CHAT_REPO, prompt: command.line, images: [], options };
    expect(planSend(w, req)).toMatchObject({ ok: true, hostId: "p2" });
    expect(planSend(w, { ...req, command })).toMatchObject({ ok: true, hostId: "p1", args: { command } });
    expect(planSend({ ...w, states: { ...states, p1: state({ version: "0.9.0" }) } }, { ...req, command })).toMatchObject({ ok: false });
    expect(planSend({ ...w, status: online("p2") }, { ...req, command })).toMatchObject({ ok: false });
  });
});
