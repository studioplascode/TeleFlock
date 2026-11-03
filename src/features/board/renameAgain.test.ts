import { afterEach, describe, expect, test } from "bun:test";
import type { AgentView, AiOutcome } from "@/core";
import { apiError } from "@/core/errors";
import type { Agent, SessionDigest, TranscriptItem } from "@/core/gen";
import { useToastStore } from "@/design";
import { agentRenameInput, canRenameAgain, canRetitle, type Io, planRename, renameAgain, undoRename } from "./renameAgain";

const KEY = "h::reconnect";

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "reconnect",
    hostId: "h",
    key: KEY,
    name: "reconnect",
    kind: "omp",
    paneId: "p1",
    tabId: "t1",
    workspaceId: "w1",
    state: "working",
    stateSince: 0,
    column: "running",
    archived: false,
    turns: 3,
    title: "Fix reconnect backoff",
    branch: "fix/reconnect",
    live: { streaming: false, thinking: false },
    omp: { bridge: true, link: "live" },
    ...over,
  } as unknown as AgentView;
}

const user = (text: string, synthetic = false) => ({ kind: "user", id: `u${text}`, at: 0, text, images: [], steering: false, synthetic }) as unknown as TranscriptItem;
const said = (text: string) => ({ kind: "assistant", id: `a${text}`, at: 0, text, streaming: false }) as unknown as TranscriptItem;
const tool = (name: string, title: string, intent?: string) => ({ kind: "tool", id: `t${title}`, at: 0, callId: title, tool: name, title, intent, args: {}, status: "ok", truncated: false }) as unknown as TranscriptItem;

describe("what the tiny model is told", () => {
  test("the latest substantive task, the last reply, the last tool calls, the live facts", () => {
    const rows = [
      user("Fix the reconnect backoff so it caps at 30 seconds"),
      said("Capped the backoff."),
      user("Now write the migration for the sessions table"),
      synthetic(),
      user("yes"),
      said("Starting with the schema."),
      ...Array.from({ length: 10 }, (_, i) => tool("bash", `bun test ${i}`)),
      tool("edit", "edit src/db/sessions.ts", "add the sessions table"),
    ];
    function synthetic() {
      return user("todo reminder: finish the checklist now please", true);
    }
    const input = agentRenameInput(agent({ live: { streaming: false, thinking: false, tool: { name: "edit", label: "edit src/db/sessions.ts", startedAt: 0 }, line: "Starting with the schema." } }), rows);
    expect(input).toMatchObject({ name: "reconnect", title: "Fix reconnect backoff", branch: "fix/reconnect", task: "Now write the migration for the sessions table", reply: "Starting with the schema." });
    expect(input.tools).toHaveLength(8);
    expect(input.tools?.[0]).toBe("bash: bun test 3");
    expect(input.tools?.at(-1)).toBe("edit: add the sessions table");
    expect(input.line).toBe("edit src/db/sessions.ts · Starting with the schema.");
    expect(input.recap).toBeUndefined();
  });

  test("a session that was never opened still has its live facts; an idle agent's recap counts, a running one's does not", () => {
    const recap = { text: "Schema done; migration next", at: 0 };
    const idle = agentRenameInput(agent({ column: "review", live: { streaming: false, thinking: false, line: "Schema done." }, omp: { bridge: true, link: "live", recap } as Agent["omp"] }), []);
    expect(idle).toEqual({ name: "reconnect", title: "Fix reconnect backoff", branch: "fix/reconnect", line: "Schema done.", recap: "Schema done; migration next" });
    const running = agentRenameInput(agent({ omp: { bridge: true, link: "live", recap } as Agent["omp"] }), []);
    expect(running.recap).toBeUndefined();
  });

  test("only a short prompt so far: it is the task", () => {
    expect(agentRenameInput(agent(), [user("fix it")]).task).toBe("fix it");
  });

  test("with the host's digest the whole session stands in for the latest task; the goal and where it works come along", () => {
    const digest: SessionDigest = { prompts: [{ n: 1, text: "Build Bloomworks M0, a city-builder slice on Windows" }], promptCount: 1, summaries: [], todos: [], subagents: [], subagentCount: 0 };
    const omp = { bridge: true, link: "live", goal: { objective: " Ship Bloomworks M0 ", status: "active" } } as Agent["omp"];
    const input = agentRenameInput(agent({ repo: "bloomworks", cwd: "/w/bloomworks", omp }), [user("Update hud.rs to show the population counter")], digest);
    expect(input).toMatchObject({ repo: "bloomworks", cwd: "/w/bloomworks", goal: "Ship Bloomworks M0", digest });
    expect(input.task).toBeUndefined();
    // an older host gave none: the transcript's latest task, as before
    expect(agentRenameInput(agent({ omp }), [user("Update hud.rs to show the population counter")], null).task).toBe("Update hud.rs to show the population counter");
  });
});

describe("which parts change", () => {
  const current = { name: "reconnect", title: "Fix reconnect backoff" };
  test("only what differs", () => {
    expect(planRename(current, { name: "sessions-migration", title: "Write the sessions migration" }, true)).toEqual({
      name: { from: "reconnect", to: "sessions-migration" },
      title: { from: "Fix reconnect backoff", to: "Write the sessions migration" },
    });
    expect(planRename(current, { name: "reconnect", title: "Write the sessions migration" }, true)).toEqual({ title: { from: "Fix reconnect backoff", to: "Write the sessions migration" } });
    expect(planRename(current, { name: "reconnect", title: " Fix reconnect backoff " }, true)).toEqual({});
    expect(planRename(current, { name: null, title: null }, true)).toEqual({});
  });
  test("no title where the session can't be retitled", () => {
    expect(planRename(current, { name: "sessions-migration", title: "Write the sessions migration" }, false)).toEqual({ name: { from: "reconnect", to: "sessions-migration" } });
  });
  test("no title for a session that has none: omp can't clear a title, so Undo couldn't take it back", () => {
    expect(planRename({ name: "reconnect", title: "" }, { name: "sessions-migration", title: "Write the sessions migration" }, true)).toEqual({ name: { from: "reconnect", to: "sessions-migration" } });
    expect(planRename({ name: "reconnect", title: "  " }, { name: "reconnect", title: "Write the sessions migration" }, true)).toEqual({});
  });
  test("omp takes a title through its bridge, or when idle (the host types /rename)", () => {
    expect(canRetitle(agent())).toBe(true);
    expect(canRetitle(agent({ omp: { bridge: false, link: "live" } as Agent["omp"] }))).toBe(false);
    expect(canRetitle(agent({ column: "review", omp: { bridge: false, link: "live" } as Agent["omp"] }))).toBe(true);
    expect(canRetitle(agent({ omp: undefined, kind: "claude" }))).toBe(false);
  });
  test("offered for an agent with a pane past its first prompt", () => {
    expect(canRenameAgain(agent())).toBe(true);
    expect(canRenameAgain(agent({ paneId: "" }))).toBe(false);
    expect(canRenameAgain(agent({ parked: {} as Agent["parked"] }))).toBe(false);
    expect(canRenameAgain(agent({ column: "review", turns: 0, title: "" }))).toBe(false);
    expect(canRenameAgain(undefined)).toBe(false);
  });
});

/** The host's digest of the agent's session in the rig. */
const DIGEST: SessionDigest = {
  prompts: [
    { n: 1, text: "Fix the reconnect backoff so it caps at 30 seconds" },
    { n: 2, text: "Now write the migration for the sessions table" },
  ],
  promptCount: 2,
  summaries: [],
  todos: [{ name: "Sessions", tasks: [{ content: "Migration", status: "inProgress" }] }],
  subagents: [],
  subagentCount: 0,
};

/** A host with one agent that renames like herdr/omp do: the list changes with every successful call. */
function rig(answer: AiOutcome<{ name: string | null; title: string | null }>, over: Partial<AgentView> = {}, digest: () => Promise<SessionDigest> = async () => DIGEST) {
  let agents: AgentView[] = [agent(over), agent({ id: "docs", key: "h::docs", name: "docs" })];
  const calls: string[] = [];
  const digests: string[] = [];
  const asked: { taken: readonly string[]; input: Parameters<Io["suggest"]>[1] }[] = [];
  const edit = (patch: Partial<AgentView>) => {
    agents = agents.map((a) => (a.key === KEY ? { ...a, ...patch } : a));
  };
  const io: Io = {
    agents: () => agents,
    transcript: () => [user("Now write the migration for the sessions table")],
    digest: async (_h, agentId) => {
      digests.push(agentId);
      return digest();
    },
    renameHandle: async (_h, _id, name) => {
      calls.push(`handle ${name}`);
      if (name === "clash") throw Object.assign(new Error("name taken"), { code: "herdr_error" });
      edit({ name });
    },
    renameTitle: async (_h, _id, title) => {
      calls.push(`title ${title}`);
      edit({ title });
    },
    suggest: async (_h, input, taken) => {
      asked.push({ taken, input });
      return answer;
    },
  };
  return { io, calls, digests, asked, edit, now: () => agents.find((a) => a.key === KEY)! };
}

const toasts = () => useToastStore.getState().toasts.filter((t) => t.open);
const last = () => toasts().at(-1);

afterEach(() => useToastStore.setState({ toasts: [] }));

describe("Name it again", () => {
  test("renames handle and title, offers Undo, and Undo puts both back", async () => {
    const r = rig({ ok: true, value: { name: "sessions-migration", title: "Write the sessions migration" } });
    await renameAgain(KEY, r.io);
    expect(r.calls).toEqual(["handle sessions-migration", "title Write the sessions migration"]);
    // the model is told the whole session the host digested, and the other agents' names, never its own
    expect(r.digests).toEqual(["reconnect"]);
    expect(r.asked[0]?.input.digest).toEqual(DIGEST);
    expect(r.asked[0]?.taken).toEqual(["docs"]);
    expect(last()).toMatchObject({ title: "✨ reconnect → sessions-migration", description: "Title: Write the sessions migration", status: "done", action: { label: "Undo" } });
    // the waiting toast is gone
    expect(toasts().filter((t) => t.status === "running")).toHaveLength(0);

    await undoRename(KEY, { name: { from: "reconnect", to: "sessions-migration" }, title: { from: "Fix reconnect backoff", to: "Write the sessions migration" } }, r.io);
    expect(r.calls.slice(2)).toEqual(["handle reconnect", "title Fix reconnect backoff"]);
    expect([r.now().name, r.now().title]).toEqual(["reconnect", "Fix reconnect backoff"]);
  });

  test("a host before 0.9.1 (no session.digest) still names it, from the latest task as before", async () => {
    const r = rig({ ok: true, value: { name: "sessions-migration", title: "Write the sessions migration" } }, {}, async () => {
      throw apiError("unknown_method", "unknown method `session.digest`");
    });
    await renameAgain(KEY, r.io);
    expect(r.asked[0]?.input).toMatchObject({ name: "reconnect", task: "Now write the migration for the sessions table" });
    expect(r.asked[0]?.input.digest).toBeUndefined();
    expect(r.calls).toEqual(["handle sessions-migration", "title Write the sessions migration"]);
  });

  test("an agent other than omp has no session to digest: the host is not asked", async () => {
    const r = rig({ ok: true, value: { name: "copy-tweaks", title: null } }, { kind: "claude", omp: undefined });
    await renameAgain(KEY, r.io);
    expect(r.digests).toEqual([]);
    expect(r.calls).toEqual(["handle copy-tweaks"]);
  });

  test("a part the model found still fitting is left alone; both fitting says so and calls nothing", async () => {
    const part = rig({ ok: true, value: { name: "reconnect", title: "Write the sessions migration" } });
    await renameAgain(KEY, part.io);
    expect(part.calls).toEqual(["title Write the sessions migration"]);
    expect(last()?.title).toBe("✨ Retitled reconnect");

    const same = rig({ ok: true, value: { name: "reconnect", title: "Fix reconnect backoff" } });
    await renameAgain(KEY, same.io);
    expect(same.calls).toEqual([]);
    expect(last()).toMatchObject({ title: "reconnect still fits", status: "idle" });
  });

  test("an agent that can't be retitled (no bridge, mid-turn) only changes its name", async () => {
    const r = rig({ ok: true, value: { name: "sessions-migration", title: "Write the sessions migration" } }, { omp: { bridge: false, link: "live" } as Agent["omp"] });
    await renameAgain(KEY, r.io);
    expect(r.calls).toEqual(["handle sessions-migration"]);
  });

  test("a model failure is explained and nothing changes", async () => {
    const r = rig({ ok: false, failure: { why: "unavailable", message: "omp has no `tiny` model role on this host", hint: "Assign omp's tiny model role" } });
    await renameAgain(KEY, r.io);
    expect(r.calls).toEqual([]);
    expect(last()).toMatchObject({ title: "omp has no `tiny` model role on this host", description: "Assign omp's tiny model role", status: "error" });
    expect(toasts().filter((t) => t.status === "running")).toHaveLength(0);
  });

  test("a refused handle (name taken in herdr) stops before the title and says so", async () => {
    const r = rig({ ok: true, value: { name: "clash", title: "Write the sessions migration" } });
    await renameAgain(KEY, r.io);
    expect(r.calls).toEqual(["handle clash"]);
    expect(last()).toMatchObject({ title: "Couldn't rename it", status: "error" });
    expect(r.now().title).toBe("Fix reconnect backoff");
  });

  test("a second click while it thinks does nothing; a closed pane meanwhile is respected", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig({ ok: true, value: { name: "sessions-migration", title: "Write the sessions migration" } });
    const slow: Io = { ...r.io, suggest: async (...a: Parameters<Io["suggest"]>) => (await gate, r.io.suggest(...a)) };
    const first = renameAgain(KEY, slow);
    await renameAgain(KEY, slow);
    expect(r.asked).toHaveLength(0);
    r.edit({ paneId: "" });
    release();
    await first;
    expect(r.asked).toHaveLength(1);
    expect(r.calls).toEqual([]);
  });

  test("a name or title given while the model thought stays: the answer, made for the old names, is dropped and says so", async () => {
    for (const meanwhile of [{ name: "by-hand" }, { title: "Typed by hand" }]) {
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      const r = rig({ ok: true, value: { name: "sessions-migration", title: "Write the sessions migration" } });
      const slow: Io = { ...r.io, suggest: async (...a: Parameters<Io["suggest"]>) => (await gate, r.io.suggest(...a)) };
      const run = renameAgain(KEY, slow);
      r.edit(meanwhile);
      release();
      await run;
      expect(r.calls).toEqual([]);
      expect(r.now()).toMatchObject(meanwhile);
      expect(last()).toMatchObject({ title: `${r.now().name} was renamed meanwhile`, status: "idle" });
    }
  });
});

describe("Undo", () => {
  test("leaves a part alone that was renamed again since", async () => {
    const r = rig({ ok: true, value: { name: "x", title: "y" } });
    r.edit({ name: "by-hand", title: "Write the sessions migration" });
    await undoRename(KEY, { name: { from: "reconnect", to: "sessions-migration" }, title: { from: "Fix reconnect backoff", to: "Write the sessions migration" } }, r.io);
    expect(r.calls).toEqual(["title Fix reconnect backoff"]);
    expect(r.now().name).toBe("by-hand");
  });

  test("nothing left to undo says so", async () => {
    const r = rig({ ok: true, value: { name: "x", title: "y" } });
    r.edit({ name: "by-hand" });
    await undoRename(KEY, { name: { from: "reconnect", to: "sessions-migration" } }, r.io);
    expect(r.calls).toEqual([]);
    expect(last()).toMatchObject({ title: "by-hand was renamed again since", description: "Nothing to undo" });
  });
});
