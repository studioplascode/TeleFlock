import { describe, expect, test } from "bun:test";
import { CHAT_REPO, CHATS_NEED_UPDATE } from "@/core/chats";
import type { Agent, ConnStatus, HostProfile, HostState } from "@/core/gen";
import { planSend } from "./send";
import { threadKey } from "./store";

const CHATS = "/home/a/.teleflock/chats";
const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
const memory = { threads: {}, remotes: {}, bases: {}, legacyBases: {}, inPlace: {}, folders: {} };
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

describe("planSend: goal mode and model roles", () => {
  const w = {
    profiles: [profile("new"), profile("mid"), profile("old")],
    status: online("new", "mid", "old"),
    states: { new: state({ version: "0.9.6" }), mid: state({ version: "0.9.1" }), old: state({ version: "0.9.0" }) },
    dispatch: memory,
  };
  const req = { target: "new", repo: "/home/a/app", prompt: "fix the flaky test", images: [], options };

  test("goal mode needs a daemon that runs commands; a message that is a command starts no goal", () => {
    const goal = { ...options, goal: true };
    expect(planSend(w, { ...req, target: "mid", options: goal })).toMatchObject({ ok: true, hostId: "mid" });
    expect(planSend(w, { ...req, target: "old", options: goal })).toMatchObject({ ok: false, title: "OLD can't start agents in goal mode yet" });
    expect(planSend(w, { ...req, target: "old" })).toMatchObject({ ok: true });
  });

  test("a role as the main model goes only to a daemon that starts agents on roles", () => {
    const slow = { ...options, model: "@slow" };
    expect(planSend(w, { ...req, options: slow })).toMatchObject({ ok: true, hostId: "new", args: { options: slow } });
    const refused = planSend(w, { ...req, target: "mid", options: slow });
    expect(refused).toMatchObject({ ok: false, title: "MID can't start agents on the @slow role yet" });
    expect(refused.ok ? "" : refused.description).toContain("0.9.6");
    // Auto leaves such hosts out of the pick.
    const pool = { ...w, profiles: ["new", "mid"].map((id) => profile(id, "pool")), states: { new: state({ version: "0.9.6", agents: running("new", 3) }), mid: state({ version: "0.9.1" }) } };
    expect(planSend(pool, { ...req, target: "auto:pool", repo: CHAT_REPO, options: slow })).toMatchObject({ ok: true, hostId: "new" });
    expect(planSend(pool, { ...req, target: "auto:pool", repo: CHAT_REPO, options })).toMatchObject({ ok: true, hostId: "mid" });
  });
});

describe("planSend: in this folder", () => {
  const branches = { branches: [{ name: "main", current: true, remote: false }, { name: "origin/fix-ci", current: false, remote: true }], defaultBranch: "main", defaultBase: "origin/main" };

  test("a thread in place starts its agent in the repository or folder itself: no base, no branch names, deduped against the host's agents", () => {
    const w = (inPlace: Record<string, true>, folders: Record<string, true> = {}) => ({
      profiles: [profile("h")],
      status: online("h"),
      states: { h: state({ agents: running("h", 1) }) },
      dispatch: { ...memory, inPlace, folders },
    });
    const req = { target: "h", repo: "/home/a/app", prompt: "Fix the README typos", images: [], options, branches, baseHint: { shown: "origin/main" } };
    const key = threadKey("h", "/home/a/app");
    const plan = planSend(w({ [key]: true }), req);
    if (!plan.ok) throw new Error(plan.title);
    expect(plan.args).toMatchObject({ key, hostId: "h", repo: "/home/a/app", inPlace: true, taken: ["h-agent-0"] });
    expect([plan.args.base, plan.args.baseLabel, plan.args.resolveBase]).toEqual([undefined, undefined, undefined]);
    // New worktrees, the default: from the base, named past the repository's branches too.
    const worktree = planSend(w({}), req);
    if (!worktree.ok) throw new Error(worktree.title);
    expect(worktree.args.inPlace).toBeUndefined();
    // New worktrees, named past the repository's branches, a remote-only one's local name included.
    expect(worktree.args).toMatchObject({ baseLabel: "origin/main", taken: ["main", "origin/fix-ci", "fix-ci", "h-agent-0"] });
    // A folder that is no repository: always in place.
    const notes = threadKey("h", "/home/a/notes");
    expect(planSend(w({}, { [notes]: true }), { ...req, repo: "/home/a/notes" })).toMatchObject({ ok: true, args: { key: notes, repo: "/home/a/notes", inPlace: true } });
  });

  test("Auto in place: the least busy host's own checkout of the repository", () => {
    const profiles = ["p1", "p2"].map((id) => profile(id, "pool"));
    const ws = (root: string) => ({ id: "w1", label: "app", cwd: root, repo: { root, name: "app" }, tabs: [], rollup: "idle", order: 0 });
    const states = { p1: { ...state({ agents: running("p1", 2) }), workspaces: [ws("/home/a/app")] }, p2: { ...state(), workspaces: [ws("/srv/app")] } } as unknown as Record<string, HostState>;
    const remotes = { "p1\u0000/home/a/app": "github.com/acme/app", "p2\u0000/srv/app": "github.com/acme/app" };
    const key = threadKey("auto:pool", "github.com/acme/app");
    const plan = planSend({ profiles, status: online("p1", "p2"), states, dispatch: { ...memory, remotes, inPlace: { [key]: true } } }, { target: "auto:pool", repo: "github.com/acme/app", prompt: "Fix the README typos", images: [], options });
    expect(plan).toMatchObject({ ok: true, hostId: "p2", args: { key, hostId: "p2", repo: "/srv/app", inPlace: true } });
  });
});
