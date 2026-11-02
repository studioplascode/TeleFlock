import { describe, expect, test } from "bun:test";
import type { ActivityPage, AppEvent, IdleShells, IdleShellsCloseResult } from "../gen";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { DemoIdleShells } from "./idleShells";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  const events: AppEvent[] = [];
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    events.push(e);
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const call = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
  clock.advance(3000);
  return {
    clock,
    events,
    call,
    get idle(): IdleShells | undefined {
      return state.hosts.forge?.state.info.idleShells;
    },
    get state() {
      return state;
    },
  };
}

const refs = (idle: IdleShells | undefined) => (idle?.shells ?? []).map(({ paneId, terminalId }) => ({ paneId, terminalId }));

describe("demo idle shells", () => {
  test("forge starts with three idle shells, longest idle first; studio-pc's tf-hostd predates them", () => {
    const r = rig();
    expect(r.idle).toMatchObject({ auto: false, minutes: 1440 });
    expect(r.idle?.shells.map((s) => s.workspace)).toEqual(["~", "notes", "dotfiles"]);
    const workspaces = r.state.hosts.forge?.state.workspaces ?? [];
    for (const s of r.idle?.shells ?? []) {
      // a zsh at its prompt, its workspace's only pane, on the board
      expect(s).toMatchObject({ shell: "zsh", closesWorkspace: true });
      expect(workspaces.find((w) => w.id === s.workspaceId)?.tabs.flatMap((t) => t.panes.map((p) => p.id))).toEqual([s.paneId]);
    }
    expect(r.clock.now() - (r.idle?.shells[0]?.idleSince ?? r.clock.now())).toBeGreaterThan(3 * 86_400_000);
    expect(r.idle?.shells.find((s) => s.workspace === "dotfiles")).toMatchObject({ cwd: "/home/demo/code/dotfiles", lastCommand: "git pull --rebase" });
    expect(r.state.hosts["studio-pc"]?.state.info.idleShells).toBeUndefined();
    const old = new DemoIdleShells({ supported: () => false, now: () => 0, after: () => {}, state: () => ({}) as never, viewed: () => false, closePane: () => {}, publish: () => {}, activity: () => {}, notify: () => {} });
    expect(old.status()).toBeUndefined();
    expect(() => old.call("cleanup.idleShellsSet", { auto: true })).toThrow(/unknown method/);
  });

  test("the threshold is checked and published; a longer one lists fewer shells", async () => {
    const r = rig();
    const set = await r.call<IdleShells>("cleanup.idleShellsSet", { minutes: 2880 });
    expect(set.shells.map((s) => s.workspace)).toEqual(["~"]);
    expect(r.idle).toMatchObject({ auto: false, minutes: 2880 });
    expect(r.idle?.shells).toHaveLength(1);
    for (const minutes of [0, 43_201, 1.5]) await expect(r.call("cleanup.idleShellsSet", { minutes })).rejects.toMatchObject({ code: "invalid_params" });
    expect(r.idle?.minutes).toBe(2880);
  });

  test("a shell left alone for the threshold shows up at the next minute's check", async () => {
    const r = rig();
    await r.call("cleanup.idleShellsSet", { minutes: 2 });
    const { workspaceId } = await r.call<{ workspaceId: string }>("workspace.create", { cwd: "/home/demo/Downloads" });
    expect(r.idle?.shells.some((s) => s.workspaceId === workspaceId)).toBe(false);
    r.clock.advance(4 * 60_000);
    expect(r.idle?.shells.filter((s) => s.workspaceId === workspaceId).map((s) => s.closesWorkspace)).toEqual([false, false]);
  });

  test("closing checks each shell again: one a terminal shows stays open, the others go with their workspaces", async () => {
    const r = rig();
    const before = r.idle;
    const notes = before?.shells.find((s) => s.workspace === "notes");
    await r.call("term.open", { target: { kind: "pane", paneId: notes?.paneId }, mode: "control", cols: 100, rows: 30 });
    const out = await r.call<IdleShellsCloseResult>("cleanup.idleShellsClose", { shells: refs(before) });
    expect(out.closed).toHaveLength(2);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0]).toMatchObject({ paneId: notes?.paneId, error: { code: "busy", message: "A terminal shows it" } });
    // in use: no longer idle
    expect(out.idle.shells).toEqual([]);
    expect(r.idle?.shells).toEqual([]);
    const labels = r.state.hosts.forge?.state.workspaces.map((w) => w.label);
    expect(labels).toContain("notes");
    expect(labels).not.toContain("~");
    expect(labels).not.toContain("dotfiles");
    const page = await r.call<ActivityPage>("host.activity", { limit: 10 });
    const logged = page.events.filter((e) => e.kind === "shellClosed");
    expect(logged.map((e) => [e.agentId, e.agentName, e.title, e.detail])).toEqual([
      ["", "dotfiles", "Closed idle shell zsh", "~/code/dotfiles · idle 26 h"],
      ["", "~", "Closed idle shell zsh", "~ · idle 3 days"],
    ]);
    // a pane already gone, or one that shows another terminal by now, is reported and left alone
    const again = await r.call<IdleShellsCloseResult>("cleanup.idleShellsClose", { shells: [...refs(before).slice(0, 1), { paneId: notes?.paneId, terminalId: "term-other" }] });
    expect(again.closed).toEqual([]);
    expect(again.kept.map((k) => k.error.code)).toEqual(["not_found", "busy"]);
  });

  test("closing by itself: switched on, tf-hostd closes the listed shells, logs each and notifies once", async () => {
    const r = rig();
    const shells = r.idle?.shells.length;
    await r.call("cleanup.idleShellsSet", { auto: true });
    expect(r.idle?.shells).toHaveLength(shells ?? 0);
    r.clock.advance(3000);
    expect(r.idle?.shells).toEqual([]);
    expect(r.idle?.lastClosed).toMatchObject({ at: r.clock.now() - 400, count: 3, workspaces: ["~", "notes", "dotfiles"] });
    expect(r.state.hosts.forge?.state.workspaces.some((w) => ["~", "notes", "dotfiles"].includes(w.label))).toBe(false);
    const notes = r.events.flatMap((e) => (e.type === "notify" && e.notification.title.includes("idle shell") ? [e.notification] : []));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "info", agentId: "", title: "Closed 3 idle shells", body: "~, notes and dotfiles: no input or output for 24 h" });
    const page = await r.call<ActivityPage>("host.activity", { limit: 10 });
    const logged = page.events.filter((e) => e.kind === "shellClosed");
    expect(logged).toHaveLength(3);
    expect(logged.every((e) => e.detail?.endsWith("· automatically after 24 h idle"))).toBe(true);
  });
});
