import { describe, expect, test } from "bun:test";
import type { DispatchEntry } from "@/features/dispatch/store";
import { resolveAgent } from "@/features/dispatch/thread";
import type { HostState, Started, WorktreeCreated } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

/** The demo host forge, two seconds in; each call gets 400 ms of demo time to answer. */
function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  engine.subscribe(() => {});
  clock.advance(2000);
  const call = async <T,>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
  return { call };
}

const ROOT = "/home/demo/code/teleflock";
const NOTES = "/home/demo/notes";
const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
const entry = (p: Partial<DispatchEntry>): DispatchEntry => ({ id: "e1", prompt: "x", createdAt: 1, branch: "", name: "x", options, phase: "started", ...p });
const spec = (name: string, prompt: string) => ({ kind: "omp", name, plan: false, prompt });

describe("Dispatch on the demo host", () => {
  test("in place: agent.start opens a workspace in the repository or folder itself, and the entry links its agent there only", async () => {
    const r = rig();
    const repoTask = await r.call<Started>("agent.start", { target: { kind: "cwd", cwd: ROOT, label: "fix-readme" }, spec: spec("fix-readme", "Fix the typos in the README") });
    const folderTask = await r.call<Started>("agent.start", { target: { kind: "cwd", cwd: NOTES, label: "tidy-notes" }, spec: spec("tidy-notes", "Tidy up my notes") });
    const st = await r.call<HostState>("state.get");
    const ws = st.workspaces.find((w) => w.id === repoTask.workspaceId);
    expect([ws?.label, ws?.cwd, ws?.repo?.root, ws?.worktree]).toEqual(["fix-readme", ROOT, ROOT, undefined]);
    expect(st.workspaces.find((w) => w.id === folderTask.workspaceId)?.repo).toBeUndefined();

    const scope = (repo: string) => ({ repo, workspaces: st.workspaces });
    // By the id the host answered with, else (the answer lost) by its name, in its own folder.
    expect(resolveAgent(entry({ name: "fix-readme", inPlace: true, agentId: repoTask.agentId, workspaceId: repoTask.workspaceId }), st.agents, scope(ROOT))?.id).toBe(repoTask.agentId);
    expect(resolveAgent(entry({ name: "fix-readme", inPlace: true, phase: "unknown" }), st.agents, scope(ROOT))?.id).toBe(repoTask.agentId);
    expect(resolveAgent(entry({ name: "tidy-notes", inPlace: true, phase: "unknown" }), st.agents, scope(NOTES))?.id).toBe(folderTask.agentId);
    // Never in another folder, and a worktree entry of that name isn't it either.
    expect(resolveAgent(entry({ name: "fix-readme", inPlace: true, phase: "unknown" }), st.agents, scope(NOTES))).toBeUndefined();
    expect(resolveAgent(entry({ name: "fix-readme", branch: "fix-readme", phase: "unknown" }), st.agents, scope(ROOT))).toBeUndefined();

    // A retry while that agent comes up keeps its name: herdr refuses a second agent under it.
    await expect(r.call("agent.start", { target: { kind: "cwd", cwd: ROOT, label: "fix-readme" }, spec: spec("fix-readme", "Fix the typos in the README") })).rejects.toMatchObject({
      code: "herdr_error",
    });
    expect((await r.call<HostState>("state.get")).agents.filter((a) => a.name === "fix-readme").length).toBe(1);
  });

  test("a worktree task's branch is its name, and a legacy dispatch/ worktree still links", async () => {
    const r = rig();
    const created = await r.call<WorktreeCreated>("worktree.create", { cwd: ROOT, branch: "offline-cache", label: "offline-cache", existing: false, trust: false, agent: spec("offline-cache", "Cache the last snapshot") });
    const legacy = await r.call<WorktreeCreated>("worktree.create", { cwd: ROOT, branch: "dispatch/old-task", label: "old-task", existing: false, trust: false, agent: spec("old-task", "An older task") });
    expect(created.branch).toBe("offline-cache");
    const st = await r.call<HostState>("state.get");
    const scope = { repo: ROOT, workspaces: st.workspaces };
    expect(resolveAgent(entry({ name: "offline-cache", branch: "offline-cache", phase: "unknown" }), st.agents, scope)?.id).toBe(created.agent?.agentId);
    expect(resolveAgent(entry({ name: "old-task", branch: "dispatch/old-task", phase: "unknown" }), st.agents, scope)?.id).toBe(legacy.agent?.agentId);
    // An in-place entry of that name runs in the checkout itself, not in its worktree.
    expect(resolveAgent(entry({ name: "offline-cache", inPlace: true, phase: "unknown" }), st.agents, scope)).toBeUndefined();
  });
});
