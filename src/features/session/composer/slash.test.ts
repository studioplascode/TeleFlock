import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "@/core/gen";
import { OMP_COMMAND_NAMES } from "@/core/ompCommands";
import { findCommand, isSlashDraft, matchCommands, matchSubs, parseSlash, pickFromTranscript, SLASH_COMMANDS, slashPopupAt, spliceSlash } from "./slash";

describe("slash catalog", () => {
  test("covers exactly the builtins hostd accepts", async () => {
    const rust = await (await fetch(new URL("../../../../crates/tf-hostd/src/inject.rs", import.meta.url))).text();
    const block = /pub const CATALOG: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
    const hostd = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    expect(hostd.size).toBeGreaterThan(80);
    expect([...OMP_COMMAND_NAMES].sort()).toEqual([...hostd].sort());
  });

  test("every builtin is reachable from the palette", () => {
    const listed = new Set(matchCommands("").flatMap((c) => [c.name, ...(c.aliases ?? []).map((a) => a.replace(/:$/, ""))]));
    for (const n of OMP_COMMAND_NAMES) expect(listed.has(n)).toBe(true);
  });

  test("a command is what the user typed: a pasted token or a leading space makes it text", () => {
    expect(isSlashDraft("/jobs kill all")).toBe(true);
    expect(isSlashDraft("\n/jobs")).toBe(true);
    // The draft still holds `[Paste #1 +40 lines]`, whose text may start with "/usr/lib…".
    expect(isSlashDraft("[Paste #1 +40 lines]")).toBe(false);
    expect(isSlashDraft(" /etc/hosts is a file")).toBe(false);
    expect(isSlashDraft("what is /etc/hosts")).toBe(false);
  });

  test("parses like omp (whitespace or colon, skill prefix kept)", () => {
    expect(parseSlash("/jobs kill all")).toEqual({ name: "jobs", args: "kill all" });
    expect(parseSlash("/force:bash ls")).toEqual({ name: "force", args: "bash ls" });
    expect(parseSlash("/skill:review now")).toEqual({ name: "skill:review", args: "now" });
    expect(parseSlash("/")).toBeNull();
  });

  test("routes each form to a native control, omp, or the terminal", () => {
    const mode = (name: string, args = "") => findCommand(name)?.modeFor(args);
    expect(mode("tree")).toBe("native");
    expect(mode("rewind")).toBe("native");
    expect(mode("model")).toBe("native");
    expect(mode("model", "roles")).toBe("terminal");
    expect(mode("fast", "on")).toBe("native");
    expect(mode("fast", "status")).toBe("report");
    expect(mode("goal", "show")).toBe("report");
    expect(mode("compact", "remote focus")).toBe("direct");
    expect(mode("resume")).toBe("terminal");
    expect(mode("resume", "0199")).toBe("direct");
    expect(mode("jobs")).toBe("report");
    expect(mode("jobs", "kill all")).toBe("direct");
    expect(mode("settings")).toBe("terminal");
    expect(mode("todo")).toBe("native");
    expect(mode("todo", "append Ship it")).toBe("direct");
    expect(mode("todo", "edit")).toBe("terminal");
    expect(findCommand("delete")?.confirm).toBeTruthy();
    expect(findCommand("queue")?.needsArgs).toBe(true);
  });

  test("custom commands and skills come from the session", () => {
    const custom = [{ name: "review", description: "Review", source: "prompt" }];
    expect(findCommand("review", custom)?.source).toBe("prompt");
    expect(findCommand("review")).toBeUndefined();
    expect(findCommand("skill:x")?.source).toBe("skill");
    expect(matchCommands("rev", custom).some((c) => c.name === "review")).toBe(true);
  });

  test("subcommands filter by prefix", () => {
    const jobs = SLASH_COMMANDS.find((c) => c.name === "jobs");
    expect(jobs && matchSubs(jobs, "k").map((s) => s.name)).toEqual(["kill"]);
  });

  test("the palette follows the draft: commands, then a command's argument choices", () => {
    expect(slashPopupAt("/pl", 3)).toMatchObject({ popup: { kind: "slash" }, sel: 0 });
    // Choices start unselected (Enter sends `/fast` as typed) until one is typed.
    expect(slashPopupAt("/fast ", 6)).toMatchObject({ popup: { kind: "sub" }, sel: -1 });
    expect(slashPopupAt("/fast o", 7)).toMatchObject({ popup: { kind: "sub", items: [{ name: "on" }, { name: "off" }] }, sel: 0 });
    // No choice matches: nothing shows, and no other popup takes over.
    expect(slashPopupAt("/fast zz", 8)).toEqual({ popup: null, sel: 0 });
    // Past the first argument, on a later line, mid-text: other popups (files) may apply.
    expect(slashPopupAt("/plan add @src", 14)).toBeUndefined();
    expect(slashPopupAt("/plan\n/pl", 9)).toBeUndefined();
    expect(slashPopupAt("/fast\n", 6)).toBeUndefined();
    expect(slashPopupAt("fix /pl", 7)).toBeUndefined();
    // Typed in front of a written task, more lines below: the palette opens all the same.
    expect(slashPopupAt("/plfix the login bug\nsteps below", 3)).toMatchObject({ popup: { kind: "slash" }, sel: 0 });
    // An offer narrows both lists.
    const offer = { command: (c: { name: string }) => c.name === "fast", sub: (_: unknown, s: { name: string }) => s.name !== "status" };
    expect(slashPopupAt("/", 1, [], offer)?.popup?.items.map((c) => c.name)).toEqual(["fast"]);
    expect(slashPopupAt("/fast s", 7, [], offer)).toEqual({ popup: null, sel: 0 });
  });

  test("a pick replaces only the command typed before the caret: the text after it stays", () => {
    // `/pl` typed at the start of a written task, with or without a space before the task.
    expect(spliceSlash("/plfix the login bug", 3, "/plan ")).toEqual({ text: "/plan fix the login bug", caret: 6 });
    expect(spliceSlash("/pl fix the login bug", 3, "/plan ")).toEqual({ text: "/plan fix the login bug", caret: 6 });
    // The first line of a longer task: the other lines stay as they are.
    expect(spliceSlash("/plfix the login bug\n\n- sign in twice\n- see auth.ts", 3, "/plan ")).toEqual({ text: "/plan fix the login bug\n\n- sign in twice\n- see auth.ts", caret: 6 });
    expect(spliceSlash("/pl\nfix it", 3, "/plan ")).toEqual({ text: "/plan \nfix it", caret: 6 });
    // An argument choice replaces the command and the argument begun.
    expect(spliceSlash("/goal sefix the flaky test\nthen ship", 8, "/goal set ")).toEqual({ text: "/goal set fix the flaky test\nthen ship", caret: 10 });
    expect(spliceSlash("/fast o now", 7, "/fast on")).toEqual({ text: "/fast on now", caret: 8 });
    // `/skill:` goes on with the skill's name (no space), then the skill takes its place.
    expect(spliceSlash("/skfix the diff", 3, "/skill:")).toEqual({ text: "/skill:fix the diff", caret: 7 });
    expect(spliceSlash("/skill:refix the diff", 9, "/skill:review ")).toEqual({ text: "/skill:review fix the diff", caret: 14 });
  });

  test("copy/open pick from the loaded transcript", () => {
    const items = [
      { kind: "user", id: "u", at: 1, text: "see https://example.com/a.", images: [], steering: false, synthetic: false },
      { kind: "assistant", id: "a", at: 2, text: "Run:\n```sh\nbun test\n```\ndone", streaming: false },
      { kind: "tool", id: "t", at: 3, callId: "c", tool: "bash", title: "ls", args: {}, status: "done", truncated: false, view: { type: "bash", command: "ls -la", output: "", background: false, timedOut: false } },
    ] as TranscriptItem[];
    expect(pickFromTranscript(items, "code")).toBe("bun test");
    expect(pickFromTranscript(items, "cmd")).toBe("ls -la");
    expect(pickFromTranscript(items, "link")).toBe("https://example.com/a");
    expect(pickFromTranscript(items, "text")).toContain("Run:");
  });
});
