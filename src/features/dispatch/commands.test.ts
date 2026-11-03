import { describe, expect, test } from "bun:test";
import type { CommandInfo } from "@/core/gen";
import { slashPopupAt } from "@/features/session/composer/slash";
import { firstCommand, NEW_AGENT_OFFER, type NewAgentCommands } from "./commands";

const review: CommandInfo = { name: "review", description: "Review the current diff", source: "prompt" };
const notes: CommandInfo = { name: "skill:release-notes", description: "Draft release notes", source: "skill" };
/** Nothing known beyond omp's builtins (no skills list, no live session in the folder). */
const none: NewAgentCommands = { commands: [], skills: false, session: false };
/** The folder's skills and a live session's prompt templates and extension commands. */
const known: NewAgentCommands = { commands: [review, notes], skills: true, session: true };

describe("a Dispatch message that is a command", () => {
  test("runs in its new agent as typed; a command that picks the mode replaces the Plan option", () => {
    expect(firstCommand("/plan add a settings page", none)).toEqual({ ok: true, command: { line: "/plan add a settings page", replacesPlan: true } });
    expect(firstCommand("  /goal set ship the release ", none)).toEqual({ ok: true, command: { line: "/goal set ship the release", replacesPlan: true } });
    expect(firstCommand("/vibe build the landing page", none)).toMatchObject({ ok: true, command: { replacesPlan: true } });
    expect(firstCommand("/fast on", none)).toEqual({ ok: true, command: { line: "/fast on", replacesPlan: false } });
    expect(firstCommand("/loop 3 fix the flaky tests", none)).toMatchObject({ ok: true, command: { replacesPlan: false } });
    // TeleFlock's `/model <id>` switches the model, which omp's TUI calls `/switch`.
    expect(firstCommand("/model openai/gpt-5:high", none)).toEqual({ ok: true, command: { line: "/switch openai/gpt-5:high", replacesPlan: false } });
  });

  test("skills, prompt templates and extension commands go as typed when the folder has them", () => {
    expect(firstCommand("/review the auth module", known)).toEqual({ ok: true, command: { line: "/review the auth module", replacesPlan: false } });
    expect(firstCommand("/skill:release-notes", known)).toMatchObject({ ok: true });
    // A skill missing from the folder's list is refused; without the list any skill goes (the host checks it).
    expect(firstCommand("/skill:nope", known)).toMatchObject({ ok: false });
    expect(firstCommand("/skill:nope", none)).toMatchObject({ ok: true, command: { line: "/skill:nope" } });
    // Unknown names never go, whatever is known of the folder.
    expect(firstCommand("/reveiw it", known)).toMatchObject({ ok: false });
    expect(firstCommand("/reveiw it", none)).toMatchObject({ ok: false });
  });

  test("what makes no sense as a brand-new agent's first message is refused, saying why", () => {
    const refused = [
      // works on what a session already has
      "/compact",
      "/retry",
      "/fork pane",
      "/btw why is this slow?",
      "/goal pause",
      // leaves or replaces the session
      "/new",
      "/resume 0199",
      "/exit",
      // acts on a running turn, or on omp for every agent
      "/queue then deploy",
      "/logout anthropic",
      // shows only in omp's TUI
      "/usage",
      "/context",
      "/settings",
      "/goal",
      "/effort",
      "/model",
      "/model roles",
      // TeleFlock controls of a running agent
      "/stop",
      "/terminal",
    ];
    for (const cmd of refused) {
      const r = firstCommand(cmd, known);
      expect(r.ok ? cmd : null).toBeNull();
      if (!r.ok) expect(r.description).toBeTruthy();
    }
    // Arguments a command needs; one line.
    expect(firstCommand("/force", none)).toMatchObject({ ok: false });
    expect(firstCommand("/plan add a settings page\nwith a dark mode toggle", none)).toMatchObject({ ok: false });
  });
});

describe("the Dispatch palette", () => {
  const offered = (value: string, custom: CommandInfo[] = []): string[] => {
    const popup = slashPopupAt(value, value.length, custom, NEW_AGENT_OFFER)?.popup;
    if (!popup) return [];
    return popup.kind === "slash" ? popup.items.map((c) => c.name) : popup.items.map((s) => s.name);
  };

  test("offers what a new agent can run, and the folder's own commands", () => {
    const all = offered("/", [review, notes]);
    for (const n of ["plan", "goal", "vibe", "loop", "fast", "switch", "model", "effort", "review", "skill:release-notes"]) expect(all).toContain(n);
    for (const n of ["compact", "new", "resume", "exit", "queue", "usage", "settings", "stop", "terminal", "copy", "jobs", "logout"]) expect(all).not.toContain(n);
  });

  test("offers only the argument choices a new agent can take", () => {
    // A goal is set, never paused or shown; fast mode is switched, its status isn't shown; `/model roles` opens a hub.
    expect(offered("/goal ")).toEqual(["set"]);
    expect(offered("/fast ")).toEqual(["on", "ultra", "off"]);
    expect(offered("/model ")).toEqual([]);
  });

  test("everything it offers runs in a new agent, bare or with the arguments it asks for", () => {
    const args: Record<string, string> = { goal: "set ship it", switch: "openai/gpt-5", model: "openai/gpt-5", effort: "high", seance: "0199", modelpreset: "switch fast", session: "pin work" };
    for (const name of offered("/", [review, notes])) {
      const bare = firstCommand(`/${name}`, known);
      const r = bare.ok ? bare : firstCommand(`/${name} ${args[name] ?? "add a settings page"}`, known);
      expect(r.ok ? null : name).toBeNull();
    }
  });
});
