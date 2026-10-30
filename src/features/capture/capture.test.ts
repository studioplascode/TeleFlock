import { describe, expect, test } from "bun:test";
import type { AgentView } from "@/core";
import type { HostProfile, HostState } from "@/core/gen";
import { prefillPlace } from "./prefill";
import { acceleratorCaps, appClash, chordToAccelerator, parseAccelerator, sameAccelerator, systemClash } from "./shortcut";
import { buildSnapshot } from "./snapshot";
import { composeShared, githubRef, mergeDraftText } from "./task";

const profile = (id: string, group?: string): HostProfile => ({ id, name: id.toUpperCase(), kind: "tailscaleSsh", herdrSession: "default", autoConnect: true, ...(group ? { group } : {}) });

function state(workspaces: { id: string; root: string; remote?: string }[] = []): HostState {
  return {
    info: { home: "/home/a", hostdVersion: "0.7.0" },
    agents: [],
    workspaces: workspaces.map((w) => ({ id: w.id, label: w.id, cwd: w.root, repo: { root: w.root, name: w.root.split("/").pop() ?? w.root, branch: "main", ...(w.remote ? { remoteUrl: w.remote } : {}) } })),
  } as unknown as HostState;
}

describe("task text from a share", () => {
  test("GitHub issue and pull request links name their repository", () => {
    expect(githubRef("see https://github.com/Studio/TeleFlock/issues/42 please")).toEqual({ repo: "github.com/studio/teleflock", kind: "issue", number: 42 });
    expect(githubRef("https://www.github.com/o/r.git/pull/7")).toEqual({ repo: "github.com/o/r", kind: "pull", number: 7 });
    expect(githubRef("https://github.com/o/r")).toBeNull();
  });

  test("the subject leads, never twice", () => {
    expect(composeShared({ subject: "Crash on start · Issue #12 · o/r · GitHub", text: "https://github.com/o/r/issues/12" })).toEqual({
      text: "Crash on start · Issue #12 · o/r\nhttps://github.com/o/r/issues/12",
      repo: "github.com/o/r",
    });
    expect(composeShared({ subject: "Bug", text: "Bug: the list jumps" })).toEqual({ text: "Bug: the list jumps" });
    expect(composeShared({ subject: "Notes", text: "line one\nline two" }).text).toBe("Notes\n\nline one\nline two");
  });

  test("a bare issue link gets a line naming it", () => {
    expect(composeShared({ text: "https://github.com/o/r/pull/3" })).toEqual({ text: "GitHub pull request o/r#3\nhttps://github.com/o/r/pull/3", repo: "github.com/o/r" });
    expect(composeShared({ text: "  just text " })).toEqual({ text: "just text" });
    expect(composeShared({})).toEqual({ text: "" });
  });

  test("drafts keep what they had, without repeating a task", () => {
    expect(mergeDraftText("", " Fix it ")).toBe("Fix it");
    expect(mergeDraftText("Earlier idea\n", "Fix it")).toBe("Earlier idea\n\nFix it");
    expect(mergeDraftText("Earlier idea\n\nFix it", "Fix it")).toBe("Earlier idea\n\nFix it");
    expect(mergeDraftText("keep", "  ")).toBe("keep");
  });
});

describe("where a prefilled task lands", () => {
  const profiles = [profile("h1", "pool"), profile("h2", "pool"), profile("h3")];
  const states = {
    h1: state([{ id: "w1", root: "/src/app" }]),
    h2: state([{ id: "w2", root: "/code/tf", remote: "git@github.com:Studio/TeleFlock.git" }]),
    h3: state([{ id: "w3", root: "/work/tf", remote: "https://github.com/studio/teleflock" }]),
  };
  const base = { profiles, states, remotes: {} };

  test("Dispatch's current target and its last repo", () => {
    expect(prefillPlace({ ...base, lastHost: "h1", lastRepo: { h1: "/src/app" } })).toEqual({ target: "h1", repo: "/src/app" });
    // No repo picked yet on that target: it waits for one.
    expect(prefillPlace({ ...base, lastHost: "h3", lastRepo: {} })).toEqual({ target: "h3", repo: null });
    // Nothing remembered: the first host.
    expect(prefillPlace({ ...base, lastHost: null, lastRepo: {} })).toEqual({ target: "h1", repo: null });
  });

  test("a shared issue goes to a clone of its repository", () => {
    // The current host has one.
    expect(prefillPlace({ ...base, lastHost: "h3", lastRepo: { h3: "/other" } }, "github.com/studio/teleflock")).toEqual({ target: "h3", repo: "/work/tf" });
    // It doesn't: the first host that has one.
    expect(prefillPlace({ ...base, lastHost: "h1", lastRepo: { h1: "/src/app" } }, "github.com/studio/teleflock")).toEqual({ target: "h2", repo: "/code/tf" });
    // An Auto group with a clone keeps the task in the group, keyed by the repository.
    expect(prefillPlace({ ...base, lastHost: "auto:pool", lastRepo: {} }, "github.com/studio/teleflock")).toEqual({ target: "auto:pool", repo: "github.com/studio/teleflock" });
    // Learned remotes count too (a workspace that is gone now).
    expect(prefillPlace({ ...base, remotes: { "h1\u0000/old/tf": "github.com/o/x" }, lastHost: "h3", lastRepo: { h3: "/work/tf" } }, "github.com/o/x")).toEqual({ target: "h1", repo: "/old/tf" });
    // Nobody has it: the usual place.
    expect(prefillPlace({ ...base, lastHost: "h1", lastRepo: { h1: "/src/app" } }, "github.com/nobody/none")).toEqual({ target: "h1", repo: "/src/app" });
  });
});

describe("Quick capture's picture", () => {
  const profiles = [profile("h1"), profile("h2")];
  const states = { h1: state([{ id: "w1", root: "/src/app" }]), h2: state() };
  const needs = (key: string, extra: Partial<NonNullable<AgentView["needs"]>>): AgentView =>
    ({
      key,
      hostId: key.split("::")[0],
      id: key.split("::")[1],
      name: key.split("::")[1],
      repo: "app",
      column: "needs",
      needs: { kind: "ask", requestId: `r-${key}`, since: 1, title: "Question", question: "Which store?", options: [], multi: false, allowOther: true, allowChat: false, answerable: true, ...extra },
    }) as unknown as AgentView;
  const world = (over: Partial<Parameters<typeof buildSnapshot>[0]> = {}) =>
    buildSnapshot({
      profiles,
      states,
      status: { h1: { phase: "online" }, h2: { phase: "offline" } } as never,
      dispatch: { threads: {}, remotes: {}, bases: {}, legacyBases: {} },
      loaded: true,
      lastHost: "h1",
      lastRepo: { h1: "/src/app" },
      inbox: [],
      ...over,
    });

  test("Enter's target is Dispatch's, offline ones say so", () => {
    const s = world();
    expect(s.target).toEqual({ target: "h1", repo: "/src/app", repoName: "app", where: "H1" });
    expect(s.blocked).toBeNull();
    expect(s.recents[0]).toEqual(s.target as NonNullable<typeof s.target>);
    expect(world({ lastHost: "h2", lastRepo: { h2: "/x/tf" } }).target?.blocked).toBe("H2 is offline");
    expect(world({ lastRepo: {} })).toMatchObject({ target: null, blocked: "Pick a repository in Dispatch first" });
    expect(world({ profiles: [], states: {} })).toMatchObject({ target: null, blocked: "Add a host first" });
  });

  test("threads dispatched to are offered, newest first", () => {
    const threads = { "h2\u0000/x/tf": [{ createdAt: 50 }], "h1\u0000/src/app": [{ createdAt: 10 }], "gone\u0000/y": [{ createdAt: 99 }] } as never;
    const s = world({ dispatch: { threads, remotes: {}, bases: {}, legacyBases: {} } });
    expect(s.recents.map((r) => `${r.target}:${r.repo}`)).toEqual(["h1:/src/app", "h2:/x/tf"]);
  });

  test("questions: single choice answers by number, the rest go to TeleFlock", () => {
    const opts = [
      { id: "a", label: "SQLite", recommended: true, tone: "primary" as const },
      { id: "b", label: "Postgres", recommended: false, tone: "neutral" as const },
    ];
    const s = world({
      inbox: [needs("h1::one", { options: opts }), needs("h1::two", { options: opts, multi: true }), needs("h1::three", { options: [] }), needs("h1::four", { answerable: false, options: opts }), needs("h1::five", { kind: "confirm", options: [] })],
    });
    expect(s.needs).toBe(5);
    expect(s.questions.map((q) => [q.agent, q.quick, q.why ?? null])).toEqual([
      ["one", true, null],
      ["two", false, "Pick the answers in TeleFlock"],
      ["three", false, "Type the answer in TeleFlock"],
      ["four", false, "Answer it in the terminal"],
      ["five", true, null],
    ]);
    // A bare confirm gets Confirm / Cancel.
    expect(s.questions[4]?.options.map((o) => o.label)).toEqual(["Confirm", "Cancel"]);
    expect(s.questions[0]).toMatchObject({ word: "Question", where: "H1 · app", requestId: "r-h1::one" });
  });
});

describe("the system-wide shortcut", () => {
  const chord = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

  test("recording a key press", () => {
    expect(chordToAccelerator(chord("Space", { ctrlKey: true, altKey: true }), "linux")).toEqual({ accelerator: "Ctrl+Alt+Space" });
    expect(chordToAccelerator(chord("KeyK", { metaKey: true, shiftKey: true }), "macos")).toEqual({ accelerator: "Shift+Cmd+K" });
    expect(chordToAccelerator(chord("KeyK", { metaKey: true }), "windows")).toEqual({ accelerator: "Super+K" });
    expect(chordToAccelerator(chord("F13"), "linux")).toEqual({ accelerator: "F13" });
    expect(chordToAccelerator(chord("ShiftLeft", { shiftKey: true }), "linux")).toBeNull();
    expect(chordToAccelerator(chord("KeyA", { shiftKey: true }), "linux")).toHaveProperty("error");
    expect(chordToAccelerator(chord("KeyA"), "linux")).toHaveProperty("error");
    expect(chordToAccelerator(chord("Escape", { ctrlKey: true }), "linux")).toHaveProperty("error");
    expect(chordToAccelerator(chord("IntlBackslash", { ctrlKey: true }), "linux")).toHaveProperty("error");
  });

  test("spellings of one combination are the same", () => {
    expect(sameAccelerator("ctrl+alt+space", "Control+Option+Space", "linux")).toBe(true);
    expect(sameAccelerator("CmdOrCtrl+K", "Ctrl+KeyK", "linux")).toBe(true);
    expect(sameAccelerator("CmdOrCtrl+K", "Cmd+K", "macos")).toBe(true);
    expect(sameAccelerator("Ctrl+K", "Ctrl+Shift+K", "linux")).toBe(false);
    expect(parseAccelerator("Ctrl+", "linux")).toBeNull();
    expect(parseAccelerator("K+Ctrl", "linux")).toBeNull();
  });

  test("key caps", () => {
    expect(acceleratorCaps("Ctrl+Alt+Space", "linux")).toEqual(["Ctrl", "Alt", "Space"]);
    expect(acceleratorCaps("Cmd+Shift+Space", "macos")).toEqual(["⇧", "⌘", "Space"]);
    expect(acceleratorCaps("Super+Backquote", "windows")).toEqual(["Win", "`"]);
    expect(acceleratorCaps("Ctrl+F5", "linux")).toEqual(["Ctrl", "F5"]);
  });

  test("clashes with TeleFlock's own keys and the desktop's", () => {
    const sheet = [
      { keys: ["Ctrl", "K"], label: "Command palette" },
      { keys: ["J"], label: "Next card" },
    ];
    expect(appClash("Ctrl+K", sheet, "linux")).toBe("Command palette");
    expect(appClash("Cmd+K", sheet, "macos")).toBe("Command palette");
    expect(appClash("Ctrl+Alt+Space", sheet, "linux")).toBeNull();
    expect(appClash("Ctrl+J", sheet, "linux")).toBeNull();
    expect(systemClash("Alt+Space", "windows")).toBe("opens the window menu");
    expect(systemClash("Cmd+Space", "macos")).toBe("opens Spotlight");
    expect(systemClash("ctrl+alt+t", "linux")).toBe("opens a terminal on Ubuntu");
    expect(systemClash("Ctrl+Alt+Space", "linux")).toBeNull();
  });
});
