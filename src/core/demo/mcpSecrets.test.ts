import { describe, expect, test } from "bun:test";
import { CoreError } from "../errors";
import type { McpChanged, McpList } from "../gen";
import { DemoAuthFlows } from "./auth";
import { ManualClock } from "./clock";
import { DemoMcp, DEMO_SECRET_MASK as MASK } from "./mcp";

const HOME = "/home/demo";

function demo(folderExists?: (path: string) => boolean): DemoMcp {
  const clock = new ManualClock();
  return new DemoMcp({ supported: true, clock, home: HOME, agents: () => [], auth: new DemoAuthFlows(clock, () => false), ompVersion: () => "18.13.2", knob: null, folderExists });
}

describe("demo mcp: hostd's secrets and folders", () => {
  test("secrets in plain arguments are listed masked and kept on save", () => {
    const d = demo();
    const args = ["postgresql://app:hunter2@db/app", "--header", "Authorization: Bearer sk-live-1", "Bearer tok-3", "-e", "GITHUB_TOKEN=ghp_4", "--header=X-Api-Key:k-2"];
    const server = { transport: "stdio", command: "npx", args, env: [], headers: [] };
    const saved = d.call("mcp.save", { scope: "user", name: "pg", server }) as McpChanged;
    const shown = saved.list.servers.find((s) => s.name === "pg")?.server.args ?? [];
    expect(shown).toEqual([`postgresql://app:${MASK}@db/app`, "--header", `Authorization: Bearer ${MASK}`, `Bearer ${MASK}`, "-e", `GITHUB_TOKEN=${MASK}`, `--header=X-Api-Key:${MASK}`]);
    expect(JSON.stringify(shown)).not.toMatch(/hunter2|sk-live|tok-3|ghp_4|k-2/);
    // Saved back as listed, with the address edited: the hidden values stay.
    const edited = [...shown];
    edited[0] = `postgresql://app:${MASK}@db2/app`;
    d.call("mcp.save", { scope: "user", name: "pg", previousName: "pg", server: { ...server, args: edited } });
    const relisted = (d.call("mcp.list", {}) as McpList).servers.find((s) => s.name === "pg")?.server.args;
    expect(relisted?.[0]).toBe(`postgresql://app:${MASK}@db2/app`);
    expect(() => d.call("mcp.save", { scope: "user", name: "pg", previousName: "pg", server: { ...server, args: [`X-Other: Bearer ${MASK}`] } })).toThrow();
  });

  test("a project folder that is gone answers not_found", () => {
    const d = demo((p) => p !== `${HOME}/code/gone`);
    let code = "";
    try {
      d.call("mcp.list", { cwd: `${HOME}/code/gone` });
    } catch (e) {
      code = e instanceof CoreError ? e.code : String(e);
    }
    expect(code).toBe("not_found");
    expect((d.call("mcp.list", {}) as McpList).cwd).toBeUndefined();
  });
});
