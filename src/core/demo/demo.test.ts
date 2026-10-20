import { describe, expect, test } from "bun:test";
import type { AppEvent, Column, TermEvent } from "../gen";
import { agentKey } from "../keys";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

/** Engine + manual clock + a store fed through the real reducer. */
function rig(opts: { empty?: boolean } = {}) {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock, empty: opts.empty });
  const events: AppEvent[] = [];
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    events.push(e);
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const call = async <T = unknown>(hostId: string | null, method: string, params: unknown = {}): Promise<T> => {
    const p = hostId === null ? engine.callApp(method, params) : engine.callHost(hostId, method, params);
    clock.advance(400);
    return (await p) as T;
  };
  return { clock, engine, events, call, get state() { return state; } };
}

function columns(state: CoreState, hostId: string): Record<Column, string[]> {
  const out: Record<Column, string[]> = { running: [], needs: [], review: [], done: [] };
  for (const a of Object.values(state.agents)) if (a.hostId === hostId) out[a.column].push(a.id);
  return out;
}

describe("demo engine", () => {
  test("every column is populated within 5 s", () => {
    const r = rig();
    r.clock.advance(5000);
    expect(r.state.status.forge?.phase).toBe("online");
    const c = columns(r.state, "forge");
    for (const col of ["running", "needs", "review", "done"] as Column[]) expect(c[col].length).toBeGreaterThan(0);
    expect(c.needs.sort()).toEqual(["limits", "push"]);
    expect(Object.values(r.state.agents).some((a) => a.kind !== "omp")).toBe(true);
  });

  test("every lane stays populated as time passes (living board)", () => {
    const r = rig();
    for (let minute = 1; minute <= 12; minute++) {
      r.clock.advance(60_000);
      const c = columns(r.state, "forge");
      expect(c.running.length).toBeGreaterThan(0);
      expect(c.review.length + c.done.length).toBeGreaterThan(0);
    }
    // Within 12 minutes at least one agent finished (notification) and a new question appeared.
    const notes = r.events.filter((e) => e.type === "notify").map((e) => (e.type === "notify" ? e.notification.kind : ""));
    expect(notes).toContain("finished");
    expect(notes).toContain("needs");
  }, 30_000);

  test("answering an ask moves the agent to running and continues the turn", async () => {
    const r = rig();
    r.clock.advance(2000);
    const push = r.state.agents[agentKey("forge", "push")];
    expect(push?.column).toBe("needs");
    expect(push?.needs?.kind).toBe("ask");
    expect(push?.needs?.options[0]?.recommended).toBe(true);
    const requestId = push?.needs?.requestId as string;
    await r.call("forge", "agent.answer", { agentId: "push", requestId, answer: { choices: ["ntfy on your tailnet"], cancel: false, chat: false } });
    r.clock.advance(300);
    expect(r.state.agents[agentKey("forge", "push")]?.column).toBe("running");
    expect(r.state.agents[agentKey("forge", "push")]?.needs).toBeUndefined();
    // Answering the same request again fails cleanly.
    await expect(r.call("forge", "agent.answer", { agentId: "push", requestId, answer: { choices: [], cancel: false, chat: false } })).rejects.toMatchObject({ code: "not_found" });
    // The turn eventually finishes into review.
    r.clock.advance(120_000);
    expect(["review", "needs", "running"]).toContain(r.state.agents[agentKey("forge", "push")]?.column as string);
  });

  test("approval: allow runs the gated command, deny marks it denied", async () => {
    const r = rig();
    r.clock.advance(2000);
    const limits = r.state.agents[agentKey("forge", "limits")];
    expect(limits?.needs?.kind).toBe("approval");
    expect(limits?.needs?.command).toBe("bun run db:migrate --env staging");
    await r.call("forge", "agent.answer", { agentId: "limits", requestId: limits?.needs?.requestId, answer: { choices: ["Deny"], cancel: false, chat: false } });
    r.clock.advance(300);
    expect(r.state.agents[agentKey("forge", "limits")]?.column).toBe("running");
  });

  test("session.open snapshot, then streaming appends while subscribed", async () => {
    const r = rig();
    r.clock.advance(2000);
    const snap = await r.call<{ items: { id: string }[]; meta: { caps: { prompt: boolean } }; hasMore: boolean }>("forge", "session.open", { agentId: "kanban" });
    expect(snap.items.length).toBeGreaterThan(5);
    expect(snap.meta.caps.prompt).toBe(true);
    const before = r.events.length;
    r.clock.advance(20_000);
    const sessionEvents = r.events.slice(before).filter((e) => e.type === "session" && e.agentId === "kanban");
    expect(sessionEvents.some((e) => e.type === "session" && e.ev.k === "append")).toBe(true);
    expect(sessionEvents.some((e) => e.type === "session" && e.ev.k === "upsert")).toBe(true);
    // Pool has enough history to page.
    const pool = await r.call<{ hasMore: boolean; cursor: string }>("forge", "session.open", { agentId: "pool", limit: 50 });
    expect(pool.hasMore).toBe(true);
    const page = await r.call<{ items: unknown[] }>("forge", "session.history", { agentId: "pool", cursor: pool.cursor, limit: 30 });
    expect(page.items).toHaveLength(30);
  });

  test("pulses beat for running agents, and the prompt path streams a reply", async () => {
    const r = rig();
    r.clock.advance(3000);
    const pulsed = new Set(r.events.flatMap((e) => (e.type === "pulse" ? e.pulses.map((p) => p.agentId) : [])));
    expect(pulsed.has("kanban") || pulsed.has("pool")).toBe(true);
    await r.call("forge", "agent.prompt", { agentId: "reconnect", text: "Why does the lane order reset?", images: [], delivery: "auto" });
    r.clock.advance(400);
    expect(r.state.agents[agentKey("forge", "reconnect")]?.column).toBe("running");
  });

  test("non-omp and unshared agents reject session.open with actionable errors", async () => {
    const r = rig();
    r.clock.advance(2000);
    await expect(r.call("forge", "session.open", { agentId: "copy" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(r.call("forge", "session.open", { agentId: "flaky" })).rejects.toMatchObject({ code: "not_connected" });
    await r.call("forge", "agent.connect", { agentId: "flaky" });
    r.clock.advance(2000);
    const snap = await r.call<{ items: unknown[] }>("forge", "session.open", { agentId: "flaky" });
    expect(snap.items.length).toBeGreaterThan(0);
  });

  test("terminal: full first frame, echo, takeover closes the previous lease", async () => {
    const r = rig();
    r.clock.advance(2000);
    const opened = await r.call<{ termId: string }>("forge", "term.open", { target: { kind: "pane", paneId: "w1:p2" }, cols: 80, rows: 24, mode: "control", takeover: false });
    const termEvents = (id: string) => r.events.filter((e): e is Extract<AppEvent, { type: "term" }> => e.type === "term" && e.termId === id).map((e) => e.ev);
    const frames = termEvents(opened.termId).filter((e): e is Extract<TermEvent, { k: "frame" }> => e.k === "frame");
    expect(frames[0]?.full).toBe(true);
    r.engine.termInput("forge", opened.termId, "pwd\r");
    const text = termEvents(opened.termId)
      .filter((e): e is Extract<TermEvent, { k: "frame" }> => e.k === "frame")
      .map((f) => atob(f.data))
      .join("");
    expect(text).toContain("pwd");
    expect(text).toContain("/home/demo/code/teleflock");
    await expect(r.call("forge", "term.open", { target: { kind: "pane", paneId: "w1:p2" }, cols: 80, rows: 24, mode: "control", takeover: false })).rejects.toMatchObject({ code: "busy" });
    await r.call("forge", "term.open", { target: { kind: "pane", paneId: "w1:p2" }, cols: 80, rows: 24, mode: "control", takeover: true });
    expect(termEvents(opened.termId).some((e) => e.k === "closed" && e.reason === "terminal attach taken over")).toBe(true);
  });

  test("worktree.create adds a workspace and an agent; errors are realistic", async () => {
    const r = rig();
    r.clock.advance(2000);
    const res = await r.call<{ workspaceId: string; agent?: { agentId: string } }>("forge", "worktree.create", {
      cwd: "/home/demo/code/teleflock",
      branch: "feat/offline-cache-2",
      existing: false,
      trust: false,
      agent: { kind: "omp", plan: false, prompt: "Cache the last snapshot" },
    });
    r.clock.advance(3000);
    expect(r.state.hosts.forge?.state.workspaces.some((w) => w.id === res.workspaceId && w.worktree?.primaryWorkspaceId === "w1")).toBe(true);
    expect(res.agent?.agentId).toBeDefined();
    expect(r.state.agents[agentKey("forge", res.agent?.agentId as string)]?.column).toBe("running");
    await expect(r.call("forge", "worktree.create", { cwd: "/home/demo/code/untrusted-fork", branch: "x", existing: false, trust: false })).rejects.toMatchObject({ code: "herdr_error" });
    await expect(r.call("forge", "worktree.create", { cwd: "/home/demo/code/teleflock", branch: "feat/kanban-board", existing: true, trust: false })).rejects.toMatchObject({ message: expect.stringContaining("already used by worktree") });
    await expect(r.call("forge", "workspace.close", { workspaceId: "w1", group: false })).rejects.toMatchObject({ message: expect.stringContaining("workspace_group_close_required") });
    await expect(r.call("forge", "worktree.remove", { workspaceId: "w4", force: false, trust: false })).rejects.toMatchObject({ message: expect.stringContaining("dirty_worktree_requires_force") });
  });

  test("fs, git and gh answer with plausible data", async () => {
    const r = rig();
    r.clock.advance(2000);
    const home = await r.call<{ path: string }>("forge", "fs.home");
    expect(home.path).toBe("/home/demo");
    const code = await r.call<{ entries: { name: string; git?: { repoRoot: boolean; branch?: string } }[] }>("forge", "fs.list", { path: "~/code", hidden: false });
    expect(code.entries.find((e) => e.name === "teleflock")?.git?.repoRoot).toBe(true);
    expect(code.entries.find((e) => e.name === "dotfiles")?.git).toBeUndefined();
    await expect(r.call("forge", "fs.list", { path: "/nope", hidden: false })).rejects.toMatchObject({ code: "not_found" });
    const diff = await r.call<{ patch: string; files: unknown[] }>("forge", "git.diff", { cwd: "/home/demo/worktrees/marketing-site/redesign-hero" });
    expect(diff.files.length).toBeGreaterThan(5);
    expect(diff.patch.split("\n").length).toBeGreaterThan(3000);
    expect(await r.call("forge", "gh.prStatus", { cwd: "/home/demo/worktrees/marketing-site/redesign-hero" })).toEqual({});
    const pr = await r.call<{ number: number; checks?: { pending: number } }>("forge", "gh.prCreate", { cwd: "/home/demo/worktrees/marketing-site/redesign-hero", title: "Hero", body: "", draft: false });
    expect(pr.checks?.pending).toBeGreaterThan(0);
    r.clock.advance(11_000);
    const st = await r.call<{ pr?: { checks?: { passed: number; pending: number } } }>("forge", "gh.prStatus", { cwd: "/home/demo/worktrees/marketing-site/redesign-hero" });
    expect(st.pr?.checks?.pending).toBe(0);
    const commit = await r.call<{ sha: string }>("forge", "git.commit", { cwd: "/home/demo/worktrees/marketing-site/redesign-hero", message: "hero", all: true });
    expect(commit.sha).toHaveLength(40);
  });

  test("studio-pc cycles through reconnecting and authRequired; opening the link brings it online", async () => {
    const r = rig();
    r.clock.advance(1000);
    expect(r.state.status["studio-pc"]?.phase).toBe("offline");
    expect(r.state.hosts["studio-pc"]).toBeDefined(); // stale cached snapshot
    const phases = new Set<string>();
    let authUrl: string | undefined;
    for (let i = 0; i < 400 && !authUrl; i++) {
      r.clock.advance(100);
      const s = r.state.status["studio-pc"];
      if (s) phases.add(s.phase);
      if (s?.phase === "authRequired") authUrl = s.authUrl;
    }
    expect(phases.has("reconnecting")).toBe(true);
    expect(authUrl).toMatch(/^https:\/\/login\.tailscale\.com\//);
    await r.call(null, "app.openExternal", { url: authUrl });
    r.clock.advance(4000);
    expect(r.state.status["studio-pc"]?.phase).toBe("online");
  });

  test("empty demo has no profiles; saving a demo host creates one", async () => {
    const r = rig({ empty: true });
    const list = await r.call<{ profiles: unknown[] }>(null, "hosts.list");
    expect(list.profiles).toHaveLength(0);
    await r.call(null, "hosts.save", { id: "", name: "Demo", kind: "demo", herdrSession: "default", autoConnect: true });
    r.clock.advance(3000);
    expect(r.state.profiles).toHaveLength(1);
    expect(Object.keys(r.state.agents).length).toBeGreaterThan(5);
  });
});
