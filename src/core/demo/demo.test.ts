import { describe, expect, test } from "bun:test";
import type { AppEvent, Column, SessionSnapshot, TermEvent } from "../gen";
import { agentKey } from "../keys";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

/** Engine + manual clock + a store fed through the real reducer. */
function rig(opts: { empty?: boolean; long?: number } = {}) {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock, empty: opts.empty, longTranscript: opts.long });
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

  test("btw: history, streamed answer, follow-up on the same conversation, cancel", async () => {
    const r = rig();
    r.clock.advance(2000);
    const snapshot = await r.call<SessionSnapshot>("forge", "session.open", { agentId: "kanban" });
    const from = r.events.length;
    // The session as a client that opened it sees it (the rig's store tracks no open sessions).
    const btwOf = (id: string) => {
      const open: CoreEvent = { type: "session", hostId: "forge", agentId: "kanban", ev: { k: "reset", snapshot } };
      const s = reduceEvents(initialCoreState("demo"), [open, ...(r.events.slice(from) as CoreEvent[])]).state;
      return s.sessions[agentKey("forge", "kanban")]?.btw[id]?.turns;
    };
    type History = { threads: { btwId: string; turns: { question: string; status: string }[] }[] };
    // One conversation was asked earlier in omp's TUI.
    const before = await r.call<History>("forge", "agent.btwHistory", { agentId: "kanban" });
    expect(before.threads).toHaveLength(1);
    const asked = await r.call<{ btwId: string; turn: number }>("forge", "agent.btw", { agentId: "kanban", question: "Where is the store?" });
    expect(asked.turn).toBe(0);
    // One side question at a time, like omp.
    await expect(r.call("forge", "agent.btw", { agentId: "kanban", question: "Another?" })).rejects.toMatchObject({ code: "busy" });
    r.clock.advance(10_000);
    const first = btwOf(asked.btwId)?.[0];
    expect(first).toMatchObject({ question: "Where is the store?", done: true });
    expect(first?.text).toContain("Quick side answer");
    const follow = await r.call<{ btwId: string; turn: number }>("forge", "agent.btw", { agentId: "kanban", question: "And its tests?", btwId: asked.btwId });
    expect(follow).toEqual({ btwId: asked.btwId, turn: 1 });
    await r.call("forge", "agent.btwCancel", { agentId: "kanban", btwId: asked.btwId });
    const second = btwOf(asked.btwId)?.[1];
    expect(second).toMatchObject({ question: "And its tests?", done: true });
    expect(second?.text).toContain("⚠ cancelled");
    const after = await r.call<History>("forge", "agent.btwHistory", { agentId: "kanban" });
    expect(after.threads.map((t) => t.turns.map((x) => x.status))).toEqual([["complete"], ["complete", "cancelled"]]);
  });

  test("a steer is queued until the next step boundary, then lands as a steering row", async () => {
    const r = rig();
    r.clock.advance(2000);
    const key = agentKey("forge", "kanban");
    expect(r.state.agents[key]?.column).toBe("running");
    await r.call("forge", "session.open", { agentId: "kanban" });
    const before = r.events.length;
    await r.call("forge", "agent.prompt", { agentId: "kanban", text: "Keep the lane order stable", images: [], delivery: "auto" });
    const landed = () =>
      r.events
        .slice(before)
        .some((e) => e.type === "session" && e.agentId === "kanban" && e.ev.k === "upsert" && e.ev.item.kind === "user" && e.ev.item.text === "Keep the lane order stable" && e.ev.item.steering);
    expect(r.state.agents[key]?.omp?.queue.steering).toEqual(["Keep the lane order stable"]);
    expect(landed()).toBe(false);
    r.clock.advance(15_000);
    expect(r.state.agents[key]?.omp?.queue.steering).toEqual([]);
    expect(landed()).toBe(true);
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

  test("fresh idle agent: zero turns, no repo/diff, stays Ready until prompted", async () => {
    const r = rig();
    r.clock.advance(5 * 60_000);
    const a = r.state.agents[agentKey("forge", "scratch")];
    expect(a).toMatchObject({ column: "review", state: "idle", turns: 0, title: "", cwd: "/home/demo/scratch" });
    expect(a?.repo).toBeUndefined();
    expect(a?.branch).toBeUndefined();
    expect(a?.diff).toBeUndefined();
    expect(a?.omp?.link).toBe("live");
    expect(r.state.hosts.forge?.state.workspaces.find((w) => w.id === a?.workspaceId)?.repo).toBeUndefined();
    const snap = await r.call<{ items: unknown[] }>("forge", "session.open", { agentId: "scratch" });
    expect(snap.items).toHaveLength(0);
    await r.call("forge", "agent.prompt", { agentId: "scratch", text: "Sketch a CLI for tailing herdr events", images: [], delivery: "auto" });
    r.clock.advance(300);
    expect(r.state.agents[agentKey("forge", "scratch")]).toMatchObject({ column: "running", title: "Sketch a CLI for tailing herdr events" });
  });

  test("long-transcript knob adds N rows of every kind to pool, pageable via session.history", async () => {
    const base = rig();
    base.clock.advance(2000);
    const normal = await base.call<{ items: unknown[]; cursor?: string }>("forge", "session.open", { agentId: "pool", limit: 1 });
    const r = rig({ long: 2000 });
    r.clock.advance(2000);
    type Item = { kind: string; view?: { type: string } };
    const first = await r.call<{ items: Item[]; hasMore: boolean; cursor?: string }>("forge", "session.open", { agentId: "pool", limit: 200 });
    expect(first.hasMore).toBe(true);
    expect(Number(first.cursor) + 200).toBe(Number(normal.cursor) + 1 + 2000);
    const all: Item[] = [...first.items];
    let cursor = first.cursor;
    while (cursor) {
      const page = await r.call<{ items: Item[]; cursor?: string }>("forge", "session.history", { agentId: "pool", cursor, limit: 500 });
      all.unshift(...page.items);
      cursor = page.cursor;
    }
    const kinds = new Set(all.map((i) => i.kind));
    for (const k of ["user", "assistant", "thinking", "tool", "notice", "mode", "compaction"]) expect(kinds.has(k)).toBe(true);
    const views = new Set(all.flatMap((i) => (i.kind === "tool" ? [i.view?.type ?? "none"] : [])));
    for (const v of ["bash", "read", "search", "diff", "todo", "task", "web", "image", "ask", "markdown", "none"]) expect(views.has(v)).toBe(true);
  });

  test("commit-message prompts answer with one ```text block and go idle without dialogs", async () => {
    const r = rig();
    r.clock.advance(2000);
    await r.call("forge", "agent.prompt", { agentId: "hero", text: "Write a git commit message for the current uncommitted changes. Reply with only the message.", images: [], delivery: "auto" });
    r.clock.advance(30_000);
    const hero = r.state.agents[agentKey("forge", "hero")];
    expect(hero?.column).toBe("review");
    expect(hero?.title).toBe("New hero with an animated flock illustration");
    const snap = await r.call<{ items: { kind: string; text?: string }[]; ui?: unknown }>("forge", "session.open", { agentId: "hero" });
    expect(snap.ui).toBeUndefined();
    const last = [...snap.items].reverse().find((i) => i.kind === "assistant");
    expect(last?.text).toMatch(/```text\nfeat\(hero\): new hero with an animated flock illustration\n\n- /);
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

  test("terminal: a bracketed paste (uploaded files' paths) reaches the demo shell as its text", async () => {
    const r = rig();
    r.clock.advance(2000);
    const opened = await r.call<{ termId: string }>("forge", "term.open", { target: { kind: "pane", paneId: "w1:p2" }, cols: 80, rows: 24, mode: "control", takeover: false });
    r.engine.termInput("forge", opened.termId, "\x1b[200~/home/demo/.teleflock/uploads/2026-10-27/image.png\x1b[201~");
    const text = r.events
      .filter((e): e is Extract<AppEvent, { type: "term" }> => e.type === "term" && e.termId === opened.termId)
      .map((e) => e.ev)
      .filter((e): e is Extract<TermEvent, { k: "frame" }> => e.k === "frame")
      .map((f) => atob(f.data))
      .join("");
    expect(text).toContain("/home/demo/.teleflock/uploads/2026-10-27/image.png");
    expect(text).not.toContain("200~");
  });

  test("shells: seeded panes report processes; attaching never creates a pane; Ctrl+C returns to zsh", async () => {
    const r = rig();
    r.clock.advance(2000);
    const panes = () => (r.state.hosts.forge?.state.workspaces ?? []).flatMap((w) => w.tabs.flatMap((t) => t.panes));
    const shells = panes().filter((p) => !p.agentId);
    for (const proc of ["zsh", "bun", "tail", "htop", "python3"]) expect(shells.some((p) => p.process === proc)).toBe(true);
    expect(panes().filter((p) => p.agentId).every((p) => !!p.process)).toBe(true);
    const dev = shells.find((p) => p.process === "bun");
    const before = panes().length;
    const opened = await r.call<{ termId: string; paneId: string }>("forge", "term.open", { target: { kind: "pane", paneId: dev?.id }, cols: 80, rows: 24, mode: "control", takeover: false });
    r.clock.advance(100);
    expect(opened.paneId).toBe(dev?.id as string);
    expect(panes().length).toBe(before);
    const text = () =>
      r.events
        .filter((e): e is Extract<AppEvent, { type: "term" }> => e.type === "term" && e.termId === opened.termId)
        .map((e) => e.ev)
        .filter((e): e is Extract<TermEvent, { k: "frame" }> => e.k === "frame")
        .map((f) => atob(f.data))
        .join("");
    expect(text()).toContain("http://localhost:5173/");
    r.engine.termInput("forge", opened.termId, "\x03");
    r.clock.advance(500);
    expect(text()).toContain("^C");
    expect(panes().find((p) => p.id === dev?.id)?.process).toBe("zsh");
  });

  test("worktree.create adds a workspace and an agent; errors are realistic", async () => {
    const r = rig();
    r.clock.advance(2000);
    const res = await r.call<{ workspaceId: string; agent?: { agentId: string } }>("forge", "worktree.create", {
      cwd: "/home/demo/code/teleflock",
      branch: "feat/offline-cache-2",
      existing: false,
      trust: false,
      agent: { kind: "omp", name: "offline-cache", plan: false, prompt: "Cache the last snapshot" },
    });
    // Fresh until omp is ready and the prompt is submitted (Dispatch shows "Starting agent").
    expect(r.state.agents[agentKey("forge", res.agent?.agentId as string)]).toMatchObject({ name: "offline-cache", state: "idle", turns: 0 });
    r.clock.advance(3000);
    expect(r.state.hosts.forge?.state.workspaces.some((w) => w.id === res.workspaceId && w.worktree?.primaryWorkspaceId === "w1")).toBe(true);
    expect(res.agent?.agentId).toBeDefined();
    expect(r.state.agents[agentKey("forge", res.agent?.agentId as string)]).toMatchObject({ column: "running", title: "Cache the last snapshot" });
    await expect(r.call("forge", "worktree.create", { cwd: "/home/demo/code/untrusted-fork", branch: "x", existing: false, trust: false })).rejects.toMatchObject({ code: "herdr_error" });
    const trusted = await r.call<{ path: string }>("forge", "worktree.create", { cwd: "/home/demo/code/untrusted-fork", branch: "x", existing: false, trust: true });
    expect(trusted.path).toBe("/home/demo/.herdr/worktrees/untrusted-fork/x");
    await expect(r.call("forge", "worktree.create", { cwd: "/home/demo/code/teleflock", branch: "feat/kanban-board", existing: true, trust: false })).rejects.toMatchObject({ message: expect.stringContaining("already used by worktree") });
    await expect(r.call("forge", "workspace.close", { workspaceId: "w1", group: false })).rejects.toMatchObject({ message: expect.stringContaining("workspace_group_close_required") });
    await expect(r.call("forge", "worktree.remove", { workspaceId: "w4", force: false, trust: false })).rejects.toMatchObject({ message: expect.stringContaining("dirty_worktree_requires_force") });
  });

  test("a Done agent's merged PR: gh.prStatus says MERGED, worktree.remove takes the worktree and its card; foreign repos need trust", async () => {
    const r = rig();
    r.clock.advance(2000);
    const ws = r.state.hosts.forge?.state.workspaces.find((w) => w.id === "w13");
    expect(ws?.worktree?.branch).toBe("chore/go-1.25");
    expect(r.state.agents[agentKey("forge", "gobump")]).toMatchObject({ column: "done", workspaceId: "w13" });
    const st = await r.call<{ pr?: { number: number; state: string } }>("forge", "gh.prStatus", { cwd: ws?.worktree?.path });
    expect(st.pr).toMatchObject({ number: 91, state: "MERGED" });
    await r.call("forge", "worktree.remove", { workspaceId: "w13", force: false, trust: false });
    r.clock.advance(1000);
    expect(r.state.agents[agentKey("forge", "gobump")]).toBeUndefined();
    expect(r.state.hosts.forge?.state.workspaces.some((w) => w.id === "w13")).toBe(false);

    const fork = await r.call<{ workspaceId: string }>("forge", "worktree.create", { cwd: "/home/demo/code/untrusted-fork", branch: "y", existing: false, trust: true });
    await expect(r.call("forge", "worktree.remove", { workspaceId: fork.workspaceId, force: false, trust: false })).rejects.toMatchObject({ message: expect.stringContaining("dubious ownership") });
    await r.call("forge", "worktree.remove", { workspaceId: fork.workspaceId, force: false, trust: true });
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
    const diff = await r.call<{ patch: string; files: unknown[] }>("forge", "git.diff", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero" });
    expect(diff.files.length).toBeGreaterThan(5);
    expect(diff.patch.split("\n").length).toBeGreaterThan(3000);
    expect(await r.call("forge", "gh.prStatus", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero" })).toEqual({});
    const pr = await r.call<{ number: number; checks?: { pending: number } }>("forge", "gh.prCreate", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero", title: "Hero", body: "", draft: false });
    expect(pr.checks?.pending).toBeGreaterThan(0);
    r.clock.advance(11_000);
    const st = await r.call<{ pr?: { checks?: { passed: number; pending: number } } }>("forge", "gh.prStatus", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero" });
    expect(st.pr?.checks?.pending).toBe(0);
    const commit = await r.call<{ sha: string }>("forge", "git.commit", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero", message: "hero", all: true });
    expect(commit.sha).toHaveLength(40);
    // Committed work stays in the branch diff; only the working tree is clean.
    const status = await r.call<{ files: unknown[] }>("forge", "git.status", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero" });
    expect(status.files).toHaveLength(0);
    const after = await r.call<{ files: unknown[] }>("forge", "git.diff", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero" });
    expect(after.files.length).toBe(diff.files.length);
    await expect(r.call("forge", "git.commit", { cwd: "/home/demo/.herdr/worktrees/marketing-site/redesign-hero", message: "again", all: true })).rejects.toMatchObject({ code: "git_error" });
  });

  test("studio-pc cycles through reconnecting, hostKey and authRequired; opening the link brings it online", async () => {
    const r = rig();
    r.clock.advance(1000);
    expect(r.state.status["studio-pc"]?.phase).toBe("offline");
    expect(r.state.hosts["studio-pc"]).toBeDefined(); // stale cached snapshot
    const phases = new Set<string>();
    let authUrl: string | undefined;
    for (let i = 0; i < 1200 && !authUrl; i++) {
      r.clock.advance(100);
      const s = r.state.status["studio-pc"];
      if (s) phases.add(s.phase);
      if (s?.phase === "authRequired") authUrl = s.authUrl;
    }
    expect(phases.has("reconnecting")).toBe(true);
    expect(phases.has("hostKey")).toBe(true);
    expect(authUrl).toMatch(/^https:\/\/login\.tailscale\.com\//);
    await r.call(null, "app.openExternal", { url: authUrl });
    r.clock.advance(4000);
    expect(r.state.status["studio-pc"]?.phase).toBe("online");
  });

  test("studio-pc asks to verify its host key; trusting the fingerprint brings it online", async () => {
    const r = rig();
    let key: { address: string; algorithm: string; fingerprint: string } | undefined;
    for (let i = 0; i < 400 && !key; i++) {
      r.clock.advance(100);
      key = r.state.status["studio-pc"]?.hostKey;
    }
    expect(r.state.status["studio-pc"]?.phase).toBe("hostKey");
    expect(key?.algorithm).toBe("ssh-ed25519");
    expect(key?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await expect(r.call(null, "hosts.trustKey", { hostId: "studio-pc", fingerprint: "SHA256:wrong" })).rejects.toMatchObject({ code: "invalid_params" });
    await r.call(null, "hosts.trustKey", { hostId: "studio-pc", fingerprint: key!.fingerprint });
    r.clock.advance(2000);
    expect(r.state.status["studio-pc"]?.phase).toBe("online");
  });

  test("tab.rename / pane.close / tab.close patch the board; last pane closes the workspace", async () => {
    const r = rig();
    r.clock.advance(2000);
    const ws = () => r.state.hosts.forge?.state.workspaces.find((w) => w.id === "w4");
    await r.call("forge", "tab.rename", { tabId: "w4:t1", label: "board work" });
    r.clock.advance(300);
    expect(ws()?.tabs[0]?.label).toBe("board work");
    await r.call("forge", "pane.close", { paneId: "w4:p2" });
    r.clock.advance(300);
    expect(ws()?.tabs[0]?.panes.map((p) => p.id)).toEqual(["w4:p1"]);
    expect(r.state.agents[agentKey("forge", "kanban")]).toBeDefined();
    await r.call("forge", "tab.close", { tabId: "w4:t1" });
    r.clock.advance(300);
    expect(ws()).toBeUndefined();
    expect(r.state.agents[agentKey("forge", "kanban")]).toBeUndefined();
    // Primary with linked worktrees refuses to lose its last pane.
    await expect(r.call("forge", "pane.close", { paneId: "w3:p1" })).rejects.toMatchObject({ message: expect.stringContaining("workspace_group_close_required") });
    // A refused tab close (the primary's only tab) leaves its pane and agent untouched.
    await expect(r.call("forge", "tab.close", { tabId: "w3:t1" })).rejects.toMatchObject({ message: expect.stringContaining("workspace_group_close_required") });
    r.clock.advance(300);
    expect(r.state.hosts.forge?.state.workspaces.find((w) => w.id === "w3")?.tabs[0]?.panes.map((p) => p.id)).toEqual(["w3:p1"]);
    expect(r.state.agents[agentKey("forge", "copy")]).toBeDefined();
    await expect(r.call("forge", "tab.close", { tabId: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("settings seed three templates and no muted agents; settings.set persists", async () => {
    const r = rig();
    const s = await r.call<{ templates: { name: string }[]; mutedAgents: string[] }>(null, "settings.get");
    expect(s.templates.map((t) => t.name)).toEqual(["Careful reviewer", "Fast fixer", "Explorer"]);
    expect(s.mutedAgents).toEqual([]);
    const saved = await r.call<{ mutedAgents: string[] }>(null, "settings.set", { ...s, mutedAgents: ["forge::push"] });
    expect(saved.mutedAgents).toEqual(["forge::push"]);
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

  test("SSH hosts with password / key sign-in: secrets are dropped, only their presence is reported", async () => {
    const r = rig({ empty: true });
    const host = { id: "lan", name: "lan", kind: "tailscaleSsh", address: "10.0.0.5", user: "me", herdrSession: "default", autoConnect: false };
    await expect(r.call(null, "hosts.save", { ...host, auth: "password" })).rejects.toMatchObject({ code: "invalid_params" });
    const saved = await r.call<Record<string, unknown>>(null, "hosts.save", { ...host, auth: "password", secrets: { password: "hunter2" } });
    expect(saved).not.toHaveProperty("secrets");
    expect(JSON.stringify(r.events)).not.toContain("hunter2");
    expect(await r.call(null, "hosts.secretStatus", { hostId: "lan" })).toEqual({ password: true, privateKey: false, passphrase: false });
    // Editing keeps the password; switching to a key file keeps only the passphrase given with it.
    await r.call(null, "hosts.save", { ...host, name: "lan 2", auth: "password" });
    expect(await r.call(null, "hosts.secretStatus", { hostId: "lan" })).toMatchObject({ password: true });
    await r.call(null, "hosts.save", { ...host, auth: "key", keyPath: "~/.ssh/id_ed25519", secrets: { passphrase: "pp" } });
    expect(await r.call(null, "hosts.secretStatus", { hostId: "lan" })).toEqual({ password: false, privateKey: false, passphrase: true });
    await r.call(null, "hosts.remove", { hostId: "lan" });
    await expect(r.call(null, "hosts.secretStatus", { hostId: "lan" })).rejects.toMatchObject({ code: "not_found" });
  });
});
