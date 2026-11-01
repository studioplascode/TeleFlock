import { describe, expect, test } from "bun:test";
import type { ForwardRule } from "@/core/gen";
import { agentInstruction, buildSnippets, olderThan, pathLine, shadowedTools, statusLook } from "./model";

const rule = (over: Partial<ForwardRule> = {}): ForwardRule => ({
  id: "r1",
  fromHost: "dev",
  toHost: "laptop",
  name: "laptop",
  enabled: true,
  shell: true,
  tools: [],
  ports: [],
  ...over,
});
const hosts = { fromName: "dev box", toName: "laptop", fromWindows: false };

describe("snippets", () => {
  test("a shell rule offers the command, the interactive shell, and tf-forward's PATH line or full path", () => {
    const s = buildSnippets(rule(), hosts);
    expect(s.run).toBe("tf-forward laptop -- <command>");
    expect(s.shell).toBe("tf-forward laptop");
    // A shell started by hand needs the directory for tf-forward itself, not only for tools.
    expect(s.pathLine).toBe('export PATH="$HOME/.teleflock/forward/bin:$PATH"');
    expect(s.tfForwardPath).toBe("~/.teleflock/forward/bin/tf-forward");
    expect(s.ports).toEqual([]);
    expect(buildSnippets(rule(), { ...hosts, fromWindows: true })).toMatchObject({ pathLine: pathLine(true), tfForwardPath: null });
  });

  test("tools need the shim directory on PATH of a shell started by hand, in the from-host's dialect", () => {
    const r = rule({ shell: false, tools: ["agent-browser"] });
    expect(buildSnippets(r, hosts)).toMatchObject({ run: null, shell: null, pathLine: 'export PATH="$HOME/.teleflock/forward/bin:$PATH"', tfForwardPath: null });
    expect(buildSnippets(r, { ...hosts, fromWindows: true }).pathLine).toBe(pathLine(true));
    expect(pathLine(true)).toBe('set "PATH=%USERPROFILE%\\.teleflock\\forward\\bin;%PATH%"');
  });

  test("a rule with only ports needs nothing on PATH", () => {
    expect(buildSnippets(rule({ shell: false, ports: [{ listen: 3000, target: 3000 }] }), hosts)).toMatchObject({ pathLine: null, tfForwardPath: null });
  });

  test("a port is explained both ways and exemplified with agent-browser for a browser rule or a DevTools port", () => {
    const withTool = buildSnippets(rule({ tools: ["agent-browser"], ports: [{ listen: 9333, target: 9222 }] }), hosts).ports[0];
    expect(withTool?.meaning).toBe("127.0.0.1:9333 on dev box reaches 127.0.0.1:9222 on laptop");
    expect(withTool?.example).toBe("agent-browser --cdp 9333");
    expect(buildSnippets(rule({ ports: [{ listen: 9222, target: 9222 }] }), hosts).ports[0]?.example).toBe("agent-browser --cdp 9222");
    expect(buildSnippets(rule({ ports: [{ listen: 3000, target: 3000 }] }), hosts).ports[0]?.example).toBe("curl http://127.0.0.1:3000");
  });
});

describe("agent instruction", () => {
  // omp's bash tool runs commands with the PATH ~/.bashrc leaves (its shell snapshot): an rc that sets PATH
  // outright drops the shim directory the bridge put first, so a Unix agent is told the paths, which hold
  // whatever PATH says.
  test("names only what the rule offers, by path on a Unix from-host", () => {
    expect(agentInstruction(rule(), hosts)).toBe(
      "Run commands on my laptop with `~/.teleflock/forward/bin/tf-forward laptop -- <command>`; `~/.teleflock/forward/bin/tf-forward laptop` alone opens a shell there.",
    );
    const full = agentInstruction(rule({ tools: ["agent-browser", "adb"], ports: [{ listen: 9222, target: 9222 }] }), hosts);
    expect(full).toContain(
      "`agent-browser`, `adb` already run on my laptop when called by their usual name; if your shell cannot find them, they are in `~/.teleflock/forward/bin/`.",
    );
    expect(full).toContain("The browser there is headed");
    expect(full).toContain("127.0.0.1:9222 here is 127.0.0.1:9222 on laptop.");
  });

  test("a rule without a shell never promises tf-forward", () => {
    expect(agentInstruction(rule({ shell: false, tools: ["adb"] }), hosts)).toBe(
      "`adb` already runs on my laptop when called by its usual name; if your shell cannot find it, it is `~/.teleflock/forward/bin/adb`.",
    );
  });

  test("a Windows from-host keeps the plain names: omp reads no rc there", () => {
    const windows = { ...hosts, fromWindows: true };
    expect(agentInstruction(rule(), windows)).toBe("Run commands on my laptop with `tf-forward laptop -- <command>`; `tf-forward laptop` alone opens a shell there.");
    expect(agentInstruction(rule({ shell: false, tools: ["adb"] }), windows)).toBe("`adb` already runs on my laptop when called by its usual name.");
  });
});

describe("older hosts", () => {
  test("compares major.minor.patch", () => {
    expect(olderThan("0.7.0", "0.8.0")).toBe(true);
    expect(olderThan("0.7.12", "0.8.0")).toBe(true);
    expect(olderThan("0.8.0", "0.8.0")).toBe(false);
    expect(olderThan("0.10.0", "0.8.0")).toBe(false);
    expect(olderThan("0.8.0-rc.1", "0.8.0")).toBe(false);
    expect(olderThan(undefined, "0.8.0")).toBe(false);
    expect(olderThan("dev", "0.8.0")).toBe(false);
  });
});

describe("status", () => {
  test("a rule the core has not reported on reads as waiting", () => {
    expect(statusLook(undefined).label).toBe("Waiting");
    expect(statusLook({ id: "r1", state: "unsupported", portErrors: [] }).label).toBe("Update needed");
  });
});

describe("shadowed programs", () => {
  test("names the tools that would replace a program the agent itself calls", () => {
    expect(shadowedTools(["agent-browser", "git", "adb", "Python3", "npx"])).toEqual(["git", "Python3", "npx"]);
    expect(shadowedTools(["agent-browser"])).toEqual([]);
  });
});
