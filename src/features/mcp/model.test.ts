import { describe, expect, test } from "bun:test";
import type { McpList, McpRegistryInput, McpServer, McpServerDraft, McpTestResult, Workspace } from "@/core/gen";
import {
  applyRegistryInputs,
  applyTemplateInput,
  definedIn,
  draftFromForm,
  emptyForm,
  endpointKey,
  endpointKind,
  errorField,
  fieldMessage,
  findSame,
  formEndpoint,
  formFromDraft,
  joinArgs,
  kvRow,
  lastGoodCheck,
  looksSecret,
  nameError,
  projectFolders,
  registryConfig,
  reloadNote,
  type RowTest,
  rowState,
  SECRET_MASK,
  setArgAt,
  shadowedBy,
  shareList,
  splitArgs,
  summarize,
  uniqueName,
  withConfigArg,
} from "./model";
import { MCP_TEMPLATES } from "./templates";

const http = (url: string, extra: Partial<McpServerDraft> = {}): McpServerDraft => ({ transport: "http", url, args: [], env: [], headers: [], ...extra });

function server(name: string, extra: Partial<McpServer> = {}): McpServer {
  return { name, origin: "user", server: http(`https://${name}.dev/mcp`), enabled: true, signedIn: false, shadowed: false, status: "connected", tools: [], extra: [], ...extra };
}

describe("argument line", () => {
  test("round-trips any argument list (spaces, quotes, JSON, newlines, the mask, empty)", () => {
    const cases: string[][] = [
      ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/My Folder", "/tmp"],
      ["--config", JSON.stringify({ apiKey: "a b", n: 1 }), "it's", 'say "hi"'],
      ["multi\nline", "tab\there", "back\\slash", "$HOME", ""],
      [`--token=${SECRET_MASK}`, SECRET_MASK, "C:\\Users\\me"],
    ];
    for (const args of cases) expect(splitArgs(joinArgs(args))).toEqual({ args });
  });

  test("reads what people type like a shell", () => {
    expect(splitArgs(`-y pkg "My Folder" 'a b' c\\ d`).args).toEqual(["-y", "pkg", "My Folder", "a b", "c d"]);
    expect(splitArgs(`--config '{"x":1}'`).args).toEqual(["--config", '{"x":1}']);
    // A Windows path survives: a backslash escapes only spaces, quotes, $ and itself.
    expect(splitArgs(String.raw`C:\Users\me`).args).toEqual([String.raw`C:\Users\me`]);
    expect(splitArgs(`"unclosed`).error).toContain('"');
    expect(splitArgs(`  `).args).toEqual([]);
  });

  test("an argument is set in place or appended; --config is replaced or added", () => {
    expect(setArgAt("-y pkg", 2, "/home/me/x y")).toBe("-y pkg '/home/me/x y'");
    expect(setArgAt("-y pkg /old", 2, "/new")).toBe("-y pkg /new");
    expect(withConfigArg(["run", "x", "--config", "{}"], '{"a":1}')).toEqual(["run", "x", "--config", '{"a":1}']);
    expect(withConfigArg(["run", "x"], "{}")).toEqual(["run", "x", "--config", "{}"]);
    expect(withConfigArg(["run", "--config"], "{}")).toEqual(["run", "--config", "{}"]);
  });
});

describe("registry inputs", () => {
  const inputs: McpRegistryInput[] = [
    { key: "token", label: "Token", kind: "string", required: true, choices: [], secret: true },
    { key: "readOnly", label: "Read-only", kind: "boolean", required: false, defaultValue: "true", choices: [], secret: false },
    { key: "topK", label: "Results", kind: "number", required: false, choices: [], secret: false },
    { key: "note", label: "Note", kind: "string", required: false, choices: [], secret: false },
  ];

  test("values are typed per kind; blank optional ones are left out", () => {
    expect(registryConfig(inputs, { token: "t0k", readOnly: "false", topK: "8", note: "  " })).toEqual({ token: "t0k", readOnly: false, topK: 8 });
  });

  test("a local entry's form carries them as the --config JSON", () => {
    const form = formFromDraft({ transport: "stdio", command: "bunx", args: ["-y", "@smithery/cli", "run", "@x/y", "--config", "{}"], env: [], headers: [] }, "y", "user");
    const next = applyRegistryInputs(form, inputs, { token: "a b", readOnly: "true", topK: "3" });
    const { args } = splitArgs(next.argsText);
    expect(args.slice(0, 5)).toEqual(["-y", "@smithery/cli", "run", "@x/y", "--config"]);
    expect(JSON.parse(args[5] ?? "")).toEqual({ token: "a b", readOnly: true, topK: 3 });
  });
});

describe("templates", () => {
  test("names are valid and unique; inputs point at real places", () => {
    const ids = new Set<string>();
    for (const t of MCP_TEMPLATES) {
      expect(nameError(t.name)).toBeNull();
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      const draft = t.server;
      if (draft.transport === "stdio") expect(draft.command).toBeTruthy();
      else expect(draft.url?.startsWith("https://")).toBe(true);
    }
  });

  test("the folder input becomes an argument (with ~ expanded) and blank removes it", () => {
    const fs = MCP_TEMPLATES.find((t) => t.id === "filesystem");
    const input = fs?.inputs?.[0];
    if (!fs || !input) throw new Error("filesystem template");
    const form = formFromDraft(fs.server, fs.name, "user");
    const set = applyTemplateInput(form, input, "~/My Code", "/home/me");
    expect(splitArgs(set.argsText).args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/home/me/My Code"]);
    expect(splitArgs(applyTemplateInput(set, input, "", "/home/me").argsText).args).toHaveLength(2);
  });

  test("the GitHub token becomes a bearer header", () => {
    const gh = MCP_TEMPLATES.find((t) => t.id === "github");
    const input = gh?.inputs?.[0];
    if (!gh || !input) throw new Error("github template");
    const form = applyTemplateInput(formFromDraft(gh.server, gh.name, "user"), input, "github_pat_123", undefined);
    expect(form.headers).toHaveLength(1);
    expect(draftFromForm(form).draft?.headers).toEqual([{ key: "Authorization", value: "Bearer github_pat_123", secret: true }]);
  });
});

describe("editor form ⇄ draft", () => {
  const stored: McpServerDraft = {
    transport: "http",
    url: `https://mcp.example.com/mcp?api_key=${SECRET_MASK}`,
    args: [],
    env: [],
    headers: [
      { key: "Authorization", value: SECRET_MASK, secret: true },
      { key: "X-Team", value: "core", secret: false },
    ],
    timeoutMs: 60_000,
    oauth: { clientId: "abc", clientSecret: SECRET_MASK, callbackPort: 4100 },
  };

  test("untouched stored secrets travel back as the mask; typed ones replace them", () => {
    const form = formFromDraft(stored, "docs", "user");
    expect(form.headers[0]).toMatchObject({ key: "Authorization", value: "", stored: true, secret: true });
    expect(form.oauth).toMatchObject({ clientSecret: "", clientSecretStored: true });
    expect(draftFromForm(form).draft).toEqual(stored);
    const typed = { ...form, headers: form.headers.map((h, i) => (i === 0 ? { ...h, value: "Bearer new" } : h)) };
    expect(draftFromForm(typed).draft?.headers[0]?.value).toBe("Bearer new");
  });

  test("only the chosen transport's fields go out; empty rows are dropped", () => {
    const f = { ...emptyForm("user"), name: "x", transport: "stdio" as const, command: "npx", argsText: "-y pkg", url: "https://left.over", env: [kvRow({ key: "A", value: "1" }), kvRow()] };
    expect(draftFromForm(f).draft).toEqual({ transport: "stdio", command: "npx", args: ["-y", "pkg"], cwd: undefined, env: [{ key: "A", value: "1", secret: false }], headers: [] });
  });

  test("problems are reported per field", () => {
    const f = { ...emptyForm("user"), name: "bad  name", transport: "http" as const, url: "ftp://x", headers: [kvRow({ key: "Bad Header", value: "1" })], timeoutMs: "1.5" };
    const { draft, errors } = draftFromForm(f);
    expect(draft).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(["headers", "name", "timeout", "url"]);
    expect(draftFromForm({ ...emptyForm("user"), name: "x" }).errors.command).toBeTruthy();
  });

  test("new keys that look secret default to secret", () => {
    expect(looksSecret("GITHUB_TOKEN") && looksSecret("Authorization") && looksSecret("api-key") && looksSecret("DB_PASSWORD")).toBe(true);
    expect(looksSecret("DATABASE_URL") || looksSecret("X-Team")).toBe(false);
    expect(kvRow({ key: "OPENAI_API_KEY", value: "x" }).secret).toBe(true);
  });
});

describe("host errors", () => {
  test("hostd's field prefixes pick the field; omp's wording too", () => {
    expect(errorField("name: “docs” is already used in /home/me/.omp/agent/mcp.json")).toBe("name");
    expect(errorField("headers: `Bad Header` is not a valid header name")).toBe("headers");
    expect(errorField("oauth.clientSecret: enter the client secret again")).toBe("oauth");
    expect(errorField("arguments: enter the hidden value of argument 3 again")).toBe("args");
    // `cwd:` is the page's project folder, not a form field.
    expect(errorField("cwd: the project folder is needed for a project server")).toBeNull();
    expect(errorField("constructor: x")).toBeNull();
    expect(errorField('Server "url-tool": stdio server requires "command" field')).toBe("command");
    expect(fieldMessage("env: enter the value of `TOKEN` again")).toBe("Enter the value of `TOKEN` again");
  });
});

describe("the same server twice", () => {
  const stdio = (command: string, args: string[], extra: Partial<McpServerDraft> = {}): McpServerDraft => ({ transport: "stdio", command, args, env: [], headers: [], ...extra });

  test("URLs match whatever the case of scheme and host, default port, trailing slash and credentials", () => {
    const base = endpointKey(http("https://mcp.context7.com/mcp"));
    for (const url of ["HTTPS://MCP.Context7.com/mcp/", "https://mcp.context7.com:443/mcp", `https://mcp.context7.com/mcp?api_key=${SECRET_MASK}`, "https://mcp.context7.com/mcp?token=abc#x", "  https://user:pw@mcp.context7.com/mcp  "]) {
      expect(endpointKey(http(url))).toBe(base);
    }
    expect(endpointKey(http("https://mcp.context7.com/mcp", { transport: "sse" }))).toBe(base);
    // Another path, scheme, host or plain query is another server.
    for (const url of ["https://mcp.context7.com/sse", "http://mcp.context7.com/mcp", "https://mcp.context7.com/mcp?login", "https://context7.com/mcp"]) {
      expect(endpointKey(http(url))).not.toBe(base);
    }
    expect(endpointKey(http(""))).toBeNull();
  });

  test("a package matches however its runner starts it; versions and runner flags don't count", () => {
    const memory = endpointKey(stdio("npx", ["@modelcontextprotocol/server-memory"]));
    expect(memory).toBe("npm @modelcontextprotocol/server-memory");
    const npm: [string, string[]][] = [
      ["npx", ["-y", "@modelcontextprotocol/server-memory@2.0.0"]],
      ["/usr/local/bin/npx", ["--yes", "@modelcontextprotocol/server-memory@latest", "--extra"]],
      ["npx.cmd", ["-y", "@modelcontextprotocol/server-memory"]],
      ["bunx", ["@modelcontextprotocol/server-memory"]],
      ["pnpm", ["dlx", "@modelcontextprotocol/server-memory"]],
      ["npm", ["exec", "--", "@modelcontextprotocol/server-memory"]],
      ["npx", ["-p", "@modelcontextprotocol/server-memory", "mcp-server-memory"]],
    ];
    for (const [cmd, args] of npm) expect(endpointKey(stdio(cmd, args))).toBe(memory);
    const fetch = endpointKey(stdio("uvx", ["mcp-server-fetch"]));
    expect(fetch).toBe("pypi mcp-server-fetch");
    const pypi: [string, string[]][] = [
      ["uvx", ["mcp-server-fetch==2026.10.24"]],
      ["uvx", ["Mcp_Server.Fetch@latest"]],
      ["uvx", ["--python", "3.12", "mcp-server-fetch[socks]"]],
      ["uvx", ["--from", "mcp-server-fetch", "mcp-server-fetch-cli"]],
      ["uv", ["tool", "run", "mcp-server-fetch"]],
      ["pipx", ["run", "--spec", "mcp-server-fetch==1.0", "fetch"]],
    ];
    for (const [cmd, args] of pypi) expect(endpointKey(stdio(cmd, args))).toBe(fetch);
    // An npm and a PyPI package of one name are different programs.
    expect(endpointKey(stdio("npx", ["mcp-server-fetch"]))).not.toBe(fetch);
  });

  test("Smithery servers match by id; other commands by their whole line and folder", () => {
    const smithery = (id: string, config = "{}") => stdio("bunx", ["-y", "@smithery/cli", "run", id, "--config", config]);
    expect(endpointKey(smithery("@upstash/context7-mcp"))).toBe(endpointKey(smithery("@upstash/context7-mcp", `{"apiKey":"${SECRET_MASK}"}`)));
    expect(endpointKey(smithery("@upstash/context7-mcp"))).not.toBe(endpointKey(smithery("@other/server")));
    const docs = stdio("bun", ["run", "scripts/docs-mcp.ts"], { cwd: "/h/code/x" });
    expect(endpointKey(docs)).toBe(endpointKey(stdio("/usr/bin/bun", ["run", "scripts/docs-mcp.ts"], { cwd: "/h/code/x" })));
    expect(endpointKey(docs)).not.toBe(endpointKey({ ...docs, cwd: "/h/code/y" }));
    expect(endpointKey(docs)).not.toBe(endpointKey({ ...docs, args: ["run", "scripts/other.ts"] }));
    expect(endpointKey(stdio("  ", []))).toBeNull();
    expect([endpointKind(docs), endpointKind(smithery("x")), endpointKind(http("https://x.dev"))]).toEqual(["command", "package", "URL"]);
  });

  test("findSame lists the one sessions load first and never the server being edited", () => {
    const own = server("context7", { server: http("https://mcp.context7.com/mcp") });
    const cursor = server("context7", {
      origin: "imported",
      sourceLabel: "Cursor",
      shadowed: true,
      server: http("https://mcp.context7.com/mcp", { headers: [{ key: "CONTEXT7_API_KEY", value: SECRET_MASK, secret: true }] }),
    });
    const list = [cursor, server("docs"), own];
    const c7 = MCP_TEMPLATES.find((t) => t.id === "context7");
    const fsTemplate = MCP_TEMPLATES.find((t) => t.id === "filesystem");
    if (!c7 || !fsTemplate) throw new Error("templates");
    expect(findSame(c7.server, list)).toEqual([own, cursor]);
    expect(findSame(own.server, list, "user:context7")).toEqual([cursor]);
    expect(findSame(http("https://elsewhere.dev/mcp"), list)).toEqual([]);
    // A template without its inputs still finds the server set up from it.
    const fs = server("filesystem", { server: stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/h/code", "/h/notes"]) });
    expect(findSame(fsTemplate.server, [fs])).toEqual([fs]);
    expect([definedIn(own), definedIn(cursor), definedIn({ origin: "project" })]).toEqual(["omp's config", "Cursor", "this project's config"]);
  });
});

describe("the same server, from the editor's form", () => {
  test("a half-filled form is enough to spot one", () => {
    const own = server("context7", { server: http("https://mcp.context7.com/mcp") });
    const memory = server("memory", { server: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: [], headers: [] } });
    expect(findSame(formEndpoint({ ...emptyForm("user"), transport: "http", url: "https://mcp.context7.com/mcp/" }), [own, memory])).toEqual([own]);
    expect(findSame(formEndpoint({ ...emptyForm("user"), command: "bunx", argsText: "@modelcontextprotocol/server-memory@2" }), [own, memory])).toEqual([memory]);
    expect(findSame(formEndpoint(emptyForm("user")), [own, memory])).toEqual([]);
  });
});

describe("a row after its test", () => {
  const result = (status: McpTestResult["status"], extra: Partial<McpTestResult> = {}): McpTestResult => ({ status, tools: [], ms: 200, ...extra });

  test("a test newer than the last check shows its outcome and time; a check that ends later wins again", () => {
    const pg = server("postgres", { status: "failed", error: "spawn uvx ENOENT", checkedAt: 1000 });
    const failed: RowTest = { result: result("failed", { error: "spawn uvx ENOENT" }), at: 5000, since: 1000 };
    expect(rowState(pg, failed)).toEqual({ status: "failed", error: "spawn uvx ENOENT", tools: [], serverInfo: undefined, checkedAt: 5000, tested: true });
    const tools = [{ name: "query" }];
    expect(rowState(pg, { result: result("connected", { tools, serverInfo: { name: "pg" } }), at: 5000, since: 1000 })).toMatchObject({ status: "connected", error: undefined, tools, serverInfo: { name: "pg" }, checkedAt: 5000, tested: true });
    expect(rowState({ ...pg, checkedAt: 6000 }, failed)).toMatchObject({ checkedAt: 6000, tested: false });
    expect(rowState(pg, { startedAt: 4000, since: 1000 }).tested).toBe(false);
    // Never checked: the test is the first word on it.
    expect(rowState(server("new", { status: "unknown" }), { result: result("needsAuth", { error: "401" }), at: 5000 })).toMatchObject({ status: "needsAuth", error: "401", checkedAt: 5000, tested: true });
  });

  test("off, skipped, hidden and checking rows keep their state", () => {
    const t: RowTest = { result: result("connected"), at: 5000 };
    for (const s of [server("a", { status: "disabled", enabled: false }), server("b", { status: "skipped" }), server("c", { status: "checking" }), server("d", { shadowed: true, status: "unknown" })]) {
      expect(rowState(s, t)).toMatchObject({ status: s.status, tested: false });
    }
  });

  test("the last good check is the newest status of any server", () => {
    expect(lastGoodCheck([server("a", { checkedAt: 10 }), server("b"), server("c", { checkedAt: 30 })])).toBe(30);
    expect(lastGoodCheck([server("a"), server("b")])).toBeUndefined();
  });
});

describe("list helpers", () => {
  test("reload notes say what reached running sessions, worded for the change, and nothing when nothing did", () => {
    const r = { reloaded: 2, queued: 1, restartNeeded: 1, errors: [] };
    expect(reloadNote(r, "add")).toBe("applied to 2 running sessions · 1 more when it finishes its turn · restart 1 session to use it");
    expect(reloadNote(r, "change")).toBe("applied to 2 running sessions · 1 more when it finishes its turn · restart 1 session to pick it up");
    expect(reloadNote(r, "remove")).toBe("dropped by 2 running sessions · 1 more when it finishes its turn · 1 session keeps it until restarted");
    expect(reloadNote({ reloaded: 0, queued: 2, restartNeeded: 2, errors: [] }, "add")).toBe("2 busy sessions pick it up when they finish their turns · restart 2 sessions to use it");
    expect(reloadNote({ reloaded: 0, queued: 1, restartNeeded: 0, errors: [] }, "change")).toBe("1 busy session picks it up when it finishes its turn");
    expect(reloadNote({ reloaded: 0, queued: 1, restartNeeded: 2, errors: [] }, "remove")).toBe("1 busy session drops it when it finishes its turn · 2 sessions keep it until restarted");
    expect(reloadNote({ reloaded: 0, queued: 0, restartNeeded: 0, errors: [] }, "remove")).toBeNull();
  });

  test("unchanged servers keep their objects across answers (memoized rows skip rendering)", () => {
    const a = server("a");
    const b = server("b");
    const prev = { userPath: "/u", servers: [a, b], check: { running: false }, liveSessions: 0, fileErrors: [] } satisfies McpList;
    const same = shareList(prev, structuredClone(prev));
    expect(same.servers).toBe(prev.servers);
    const changed = shareList(prev, { ...structuredClone(prev), servers: [structuredClone(a), { ...structuredClone(b), status: "failed" }] });
    expect(changed.servers[0]).toBe(a);
    expect(changed.servers[1]).not.toBe(b);
  });

  test("a shadowed server names the one that hides it", () => {
    const own = server("context7");
    const cursor = server("context7", { origin: "imported", sourceLabel: "Cursor", shadowed: true });
    expect(shadowedBy(cursor, [own, cursor])).toBe("Hidden by omp's “context7”");
    expect(shadowedBy(own, [own, cursor])).toBeNull();
  });

  test("project folders: repository roots once, in board order, without home", () => {
    const ws = (id: string, cwd: string, order: number, root?: string): Workspace => ({ id, label: id, cwd, order, tabs: [], rollup: "idle", ...(root ? { repo: { root, name: root } } : {}) });
    const folders = projectFolders([ws("b", "/h/wt/x", 2, "/h/code/x"), ws("a", "/h/code/x", 1, "/h/code/x"), ws("c", "/h/notes", 3), ws("d", "/h", 0)], "/h");
    expect(folders).toEqual([
      { path: "/h/code/x", label: "x", hint: "~/code/x" },
      { path: "/h/notes", label: "notes", hint: "~/notes" },
    ]);
  });

  test("summaries, names", () => {
    expect(summarize({ transport: "stdio", command: "npx", args: ["-y", "a b"], env: [], headers: [] })).toBe("npx -y 'a b'");
    expect(summarize(http("https://mcp.context7.com/mcp/?x=1"))).toBe("mcp.context7.com/mcp");
    expect(uniqueName("github", ["github", "github-2"])).toBe("github-3");
    expect(nameError("ok name:1")).toBeNull();
    expect(nameError("double  space")).toBeTruthy();
    expect(nameError("x".repeat(101))).toBeTruthy();
  });
});
