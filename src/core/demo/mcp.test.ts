import { describe, expect, test } from "bun:test";
import { CoreError } from "../errors";
import type { AuthFlow, McpChanged, McpList, McpReload, McpSearchResult, McpServer, McpTestResult } from "../gen";
import { DemoAuthFlows } from "./auth";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { DemoMcp, DEMO_SECRET_MASK as MASK } from "./mcp";

const HOME = "/home/demo";
const REPO = `${HOME}/code/teleflock`;

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  engine.subscribe(() => {});
  clock.advance(5000);
  /** Calls a host method and moves the demo clock `ms` (enough for latency, checks and tests). */
  const call = async <T,>(method: string, params: unknown = {}, ms = 400, hostId = "forge"): Promise<T> => {
    const p = engine.callHost(hostId, method, params);
    clock.advance(ms);
    return (await p) as T;
  };
  /** The list once the check that a change or a first read started has finished. */
  const settled = (params: Record<string, unknown> = {}) => call<McpList>("mcp.list", { ...params, waitMs: 20_000 }, 2000);
  return { clock, call, settled };
}

function byName(list: McpList, name: string, origin?: McpServer["origin"]): McpServer {
  const s = list.servers.find((x) => x.name === name && (!origin || x.origin === origin));
  if (!s) throw new Error(`no ${name} in ${list.servers.map((x) => `${x.origin}:${x.name}`).join(", ")}`);
  return s;
}

describe("demo mcp", () => {
  test("first list starts a check: checking until it ends, then each server's outcome", async () => {
    const r = rig();
    const first = await r.call<McpList>("mcp.list");
    expect(first.check.running).toBe(true);
    expect(first.userPath).toBe(`${HOME}/.omp/agent/mcp.json`);
    expect(byName(first, "context7", "user").status).toBe("checking");
    expect(byName(first, "linear").status).toBe("disabled");
    expect(byName(first, "playwright").status).toBe("skipped");

    // The long-poll answers when the check ends (~1.2 s), not after the whole waitMs.
    const t0 = r.clock.now();
    const list = await r.settled();
    expect(list.check.running).toBe(false);
    expect(list.check.finishedAt).toBeLessThanOrEqual(t0 + 1300);
    expect(byName(list, "context7", "user")).toMatchObject({ status: "connected", serverInfo: { name: "Context7" } });
    expect(byName(list, "context7", "user").tools.map((t) => t.name)).toEqual(["resolve-library-id", "query-docs"]);
    expect(byName(list, "filesystem").tools.length).toBe(14);
    expect(byName(list, "github")).toMatchObject({ status: "needsAuth", signedIn: false });
    expect(byName(list, "postgres").status).toBe("failed");
    expect(byName(list, "postgres").error).toContain("spawn uvx ENOENT");
    expect(byName(list, "sentry")).toMatchObject({ status: "connected", signedIn: true });
    expect(byName(list, "sequential-thinking").status).toBe("pending");
    // omp's own context7 wins over Cursor's.
    expect(byName(list, "context7", "imported")).toMatchObject({ shadowed: true, sourceLabel: "Cursor" });
    expect(byName(list, "playwright").note).toContain("browser");
    expect(list.liveSessions).toBeGreaterThan(0);

    // Results stay while fresh: a plain list doesn't check again.
    expect((await r.call<McpList>("mcp.list")).check.running).toBe(false);
  });

  test("refresh checks again and keeps earlier results visible while it runs", async () => {
    const r = rig();
    await r.call("mcp.list");
    await r.settled();
    const running = await r.call<McpList>("mcp.list", { refresh: true });
    expect(running.check.running).toBe(true);
    expect(byName(running, "context7", "user").status).toBe("connected");
    // A short waitMs answers while the check still runs.
    const early = await r.call<McpList>("mcp.list", { waitMs: 300 }, 350);
    expect(early.check.running).toBe(true);
    const done = await r.settled();
    expect(done.check.running).toBe(false);
    // The package finished downloading during the first start.
    expect(byName(done, "sequential-thinking").status).toBe("connected");
  });

  test("secrets are masked; the mask sent back keeps the stored value; a mask with nothing behind it is refused", async () => {
    const r = rig();
    const list = await r.settled();
    const pg = byName(list, "postgres");
    expect(pg.server.env).toEqual([
      { key: "DATABASE_URI", value: "postgresql://app@localhost:5432/app", secret: false },
      { key: "PGPASSWORD", value: MASK, secret: true },
    ]);
    expect(byName(list, "github").server.oauth).toMatchObject({ clientId: "Ov23liTf7Demo4Flock", clientSecret: MASK });

    // A working token saved, then the listed (masked) definition saved back with another change.
    const token = { key: "Authorization", value: "Bearer github_pat_11ABCDEFG0123456789", secret: true };
    const saved = await r.call<McpChanged>("mcp.save", { scope: "user", name: "gh", server: { transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: [token] } });
    const listed = byName(saved.list, "gh");
    expect(listed.server.headers[0]?.value).toBe(MASK);
    await r.call<McpChanged>("mcp.save", { scope: "user", name: "gh", previousName: "gh", server: { ...listed.server, timeoutMs: 45_000 } });
    const test = await r.call<McpTestResult>("mcp.test", { name: "gh", scope: "user" }, 3000);
    expect(test.status).toBe("connected");

    // An unsaved draft is tested with the stored secrets filled in for the masks.
    const draftTest = await r.call<McpTestResult>("mcp.test", { name: "gh", scope: "user", server: { ...listed.server, url: "https://api.githubcopilot.com/mcp/" } }, 3000);
    expect(draftTest.status).toBe("connected");

    // Without a stored value the mask means nothing.
    await expect(r.call("mcp.save", { scope: "user", name: "fresh", server: { transport: "http", url: "https://mcp.notion.com/mcp", headers: [{ key: "X-Api-Key", value: MASK, secret: true }] } })).rejects.toMatchObject({
      code: "invalid_params",
    });

    // Secret flags and JSON config keys in arguments are masked too, and kept on save.
    const args = ["-y", "@smithery/cli", "run", "@smithery-ai/brave-search", "--config", JSON.stringify({ braveApiKey: "BSA-real-key-123" }), "--api-key=abc123", "--token", "t0k3n"];
    const brave = await r.call<McpChanged>("mcp.save", { scope: "user", name: "brave", server: { transport: "stdio", command: "bunx", args } });
    const shown = byName(brave.list, "brave").server.args;
    expect(shown.slice(5)).toEqual([JSON.stringify({ braveApiKey: MASK }), `--api-key=${MASK}`, "--token", MASK]);
    await r.call("mcp.save", { scope: "user", name: "brave", previousName: "brave", server: byName(brave.list, "brave").server });
    expect((await r.call<McpTestResult>("mcp.test", { name: "brave", scope: "user" }, 3000)).status).toBe("connected");
  });

  test("add, duplicate, rename and remove follow omp's file rules", async () => {
    const r = rig();
    const docs = { transport: "http", url: "https://docs.mcp.cloudflare.com/mcp" };
    const added = await r.call<McpChanged>("mcp.save", { scope: "user", name: "cf-docs", server: docs });
    expect(byName(added.list, "cf-docs")).toMatchObject({ origin: "user", enabled: true, status: "checking" });
    expect(added.list.check.running).toBe(true);
    await expect(r.call("mcp.save", { scope: "user", name: "cf-docs", server: docs })).rejects.toMatchObject({ code: "already_exists" });
    await expect(r.call("mcp.save", { scope: "user", name: "context7", previousName: "cf-docs", server: docs })).rejects.toMatchObject({ code: "already_exists" });
    await expect(r.call("mcp.save", { scope: "user", name: "x", previousName: "nope", server: docs })).rejects.toMatchObject({ code: "not_found" });

    await r.call("mcp.setEnabled", { name: "cf-docs", scope: "user", enabled: false });
    const renamed = await r.call<McpChanged>("mcp.save", { scope: "user", name: "cloudflare-docs", previousName: "cf-docs", server: docs });
    expect(renamed.list.servers.some((s) => s.name === "cf-docs")).toBe(false);
    // Renaming keeps the server's on/off state.
    expect(byName(renamed.list, "cloudflare-docs").enabled).toBe(false);
    // The file order is kept: the renamed server is still the last user server.
    expect(renamed.list.servers.filter((s) => s.origin === "user").at(-1)?.name).toBe("cloudflare-docs");

    const removed = await r.call<McpChanged>("mcp.remove", { name: "cloudflare-docs", scope: "user" });
    expect(removed.list.servers.some((s) => s.name === "cloudflare-docs")).toBe(false);
    // Only omp's own files can lose a server: an imported one isn't in them.
    await expect(r.call("mcp.remove", { name: "linear" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("validation messages name the field", async () => {
    const r = rig();
    /** The host's refusal of a save. */
    const bad = async (params: Record<string, unknown>): Promise<CoreError> => {
      try {
        await r.call("mcp.save", { scope: "user", ...params });
      } catch (e) {
        if (e instanceof CoreError) return e;
        throw e;
      }
      throw new Error("saved");
    };
    const spaced = await bad({ name: "two  spaces", server: { transport: "http", url: "https://x.dev/mcp" } });
    expect(spaced.code).toBe("invalid_params");
    expect(spaced.message).toMatch(/^name:/);
    expect((await bad({ name: "a".repeat(101), server: { transport: "http", url: "https://x.dev/mcp" } })).message).toBe("name: at most 100 characters");
    expect((await bad({ name: "tool", server: { transport: "stdio", args: [] } })).message).toMatch(/^command:/);
    expect((await bad({ name: "tool", server: { transport: "sse" } })).message).toMatch(/^url:/);
    expect((await bad({ name: "tool", server: { transport: "http", url: "ftp://x.dev" } })).message).toBe("url: an http:// or https:// address");
    expect((await bad({ name: "tool", server: { transport: "http", url: "https://x.dev", headers: [{ key: "Bad Header", value: "1" }] } })).message).toMatch(/^headers:/);
    expect((await bad({ name: "tool", server: { transport: "stdio", command: "x", env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] } })).message).toBe("env: `A` is set twice");
    expect((await bad({ name: "tool", server: { transport: "http", url: "https://x.dev", oauth: { callbackPort: 0 } } })).message).toMatch(/^oauth\.callbackPort:/);
    expect((await bad({ scope: "project", name: "tool", server: { transport: "http", url: "https://x.dev" } })).message).toMatch(/^cwd:/);
  });

  test("imported servers switch through omp's user-level lists", async () => {
    const r = rig();
    await r.settled();
    const on = await r.call<McpChanged>("mcp.setEnabled", { name: "linear", enabled: true });
    expect(byName(on.list, "linear")).toMatchObject({ origin: "imported", enabled: true, status: "checking" });
    expect(on.reload.reloaded + on.reload.queued + on.reload.restartNeeded).toBeGreaterThan(0);
    const after = await r.settled();
    expect(byName(after, "linear")).toMatchObject({ status: "needsAuth", sourceLabel: "Claude Code" });
    const off = await r.call<McpChanged>("mcp.setEnabled", { name: "linear", enabled: false });
    expect(byName(off.list, "linear")).toMatchObject({ enabled: false, status: "disabled" });
  });

  test("a project folder lists its servers first and they shadow user servers of the same name", async () => {
    const r = rig();
    const project = await r.settled({ cwd: REPO });
    expect(project.projectPath).toBe(`${REPO}/.omp/mcp.json`);
    expect(project.servers[0]).toMatchObject({ name: "teleflock-docs", origin: "project", status: "connected" });
    expect((await r.settled()).servers.some((s) => s.name === "teleflock-docs")).toBe(false);

    const shadow = await r.call<McpChanged>("mcp.save", { scope: "project", cwd: REPO, name: "context7", server: { transport: "http", url: "https://mcp.context7.com/mcp" } });
    expect(byName(shadow.list, "context7", "project").shadowed).toBe(false);
    expect(byName(shadow.list, "context7", "user").shadowed).toBe(true);
    expect(byName(await r.settled(), "context7", "user").shadowed).toBe(false);
    // Only the folder's sessions reload for a project change.
    const all = await r.call<McpReload>("mcp.reload");
    const sum = (x: McpReload) => x.reloaded + x.queued + x.restartNeeded;
    expect(sum(shadow.reload)).toBeLessThanOrEqual(sum(all));
  });

  test("search filters the registry; stdio entries carry their inputs and a --config argument", async () => {
    const r = rig();
    const gh = await r.call<McpSearchResult>("mcp.search", { query: "github" }, 2500);
    const entry = gh.entries.find((e) => e.id === "@smithery-ai/github");
    expect(entry).toBeDefined();
    expect(entry?.remote).toBe(false);
    expect(entry?.server.args).toContain("--config");
    expect(entry?.inputs.find((i) => i.secret)).toMatchObject({ key: "githubPersonalAccessToken", required: true });
    const top = await r.call<McpSearchResult>("mcp.search", { query: "s", limit: 3 }, 2500);
    expect(top.entries.map((e) => e.useCount)).toEqual([...top.entries.map((e) => e.useCount)].sort((a, b) => b - a));
    expect(top.entries).toHaveLength(3);
    expect((await r.call<McpSearchResult>("mcp.search", { query: "zzzz-nothing" }, 2500)).entries).toEqual([]);
    // Like hostd: a blank query finds nothing, the limit is clamped to 1–30.
    expect((await r.call<McpSearchResult>("mcp.search", { query: "  " })).entries).toEqual([]);
    expect((await r.call<McpSearchResult>("mcp.search", { query: "s", limit: 0 }, 2500)).entries).toHaveLength(1);
    // A registry server missing a required input fails its test.
    const draft = entry?.server;
    expect((await r.call<McpTestResult>("mcp.test", { name: "github-smithery", server: draft }, 3000)).error).toContain("githubPersonalAccessToken");
  });

  test("OAuth sign-in through the host's auth flows, then sign out", async () => {
    const r = rig();
    await r.settled();
    const started = await r.call<AuthFlow>("mcp.authStart", { name: "github", scope: "user" });
    expect(started).toMatchObject({ kind: "mcp", subject: "github" });
    const again = await r.call<AuthFlow>("mcp.authStart", { name: "github", scope: "user" });
    expect(again.flowId).toBe(started.flowId);
    const waiting = await r.call<AuthFlow>("auth.wait", { flowId: started.flowId });
    expect(waiting).toMatchObject({ state: "waiting", callbackPort: 3000, paste: "fallback" });
    expect(waiting.url).toContain("client_id=Ov23liTf7Demo4Flock");
    await expect(r.call("auth.submit", { flowId: started.flowId, text: "http://localhost:3000/callback?error=denied" })).rejects.toMatchObject({ code: "invalid_params" });
    await r.call("auth.submit", { flowId: started.flowId, text: "http://localhost:3000/callback?code=abc123&state=x" }, 1000);
    expect((await r.call<AuthFlow>("auth.wait", { flowId: started.flowId })).state).toBe("done");
    const signed = await r.settled();
    expect(byName(signed, "github")).toMatchObject({ signedIn: true, status: "connected" });
    expect(byName(signed, "github").tools.length).toBeGreaterThan(5);

    const out = await r.call<McpChanged>("mcp.signOut", { name: "github", scope: "user" });
    expect(byName(out.list, "github").signedIn).toBe(false);
    expect(byName(await r.settled(), "github").status).toBe("needsAuth");
    // hostd signs in only omp's own HTTP servers that are on.
    await expect(r.call("mcp.authStart", { name: "filesystem", scope: "user" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("mcp.authStart", { name: "linear" })).rejects.toMatchObject({ code: "not_found" });
    await r.call("mcp.setEnabled", { name: "sentry", scope: "user", enabled: false });
    await expect(r.call("mcp.authStart", { name: "sentry", scope: "user" })).rejects.toMatchObject({ code: "invalid_params", hint: "Switch it on first." });
  });

  test("a host whose tf-hostd predates MCP servers answers unknown_method", () => {
    const clock = new ManualClock();
    const old = new DemoMcp({ supported: false, clock, home: HOME, agents: () => [], auth: new DemoAuthFlows(clock, () => false), ompVersion: () => "18.13.2", knob: null });
    let code = "";
    try {
      old.call("mcp.list", {});
    } catch (e) {
      if (e instanceof CoreError) code = e.code;
    }
    expect(code).toBe("unknown_method");
  });
});
