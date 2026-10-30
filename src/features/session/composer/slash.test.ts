import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "@/core/gen";
import { OMP_COMMAND_NAMES } from "@/core/ompCommands";
import { findCommand, isSlashDraft, matchCommands, matchSubs, parseSlash, pickFromTranscript, SLASH_COMMANDS } from "./slash";

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
