import { describe, expect, test } from "bun:test";
import type { Agent, McpReload, PluginCatalog, PluginList, PluginsChanged, SkillList, SkillSearchResult, SkillsChanged } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { DemoPlugins, type PluginsHostEnv } from "./plugins";

const HOME = "/home/demo";
const REPO = `${HOME}/code/teleflock`;

/** The host's agents as `/reload-plugins` sees them: only live omp sessions count. */
function agent(id: string, cwd: string, state: string, link: string, extra: Record<string, unknown> = {}): Agent {
  return { id, name: id, kind: "omp", state, cwd, omp: { link }, ...extra } as unknown as Agent;
}

const AGENTS: Agent[] = [
  agent("in-repo", REPO, "idle", "live"),
  agent("in-repo-busy", `${REPO}/crates`, "working", "live"),
  agent("elsewhere-old", `${HOME}/code/other`, "idle", "stale"),
  agent("claude", REPO, "idle", "live", { kind: "claude" }),
  agent("parked", REPO, "idle", "live", { parked: { at: 0 } }),
];

const EVERY_SESSION: McpReload = { reloaded: 1, queued: 1, restartNeeded: 1, errors: [] };
const REPO_SESSIONS: McpReload = { reloaded: 1, queued: 1, restartNeeded: 0, errors: [] };
const NONE: McpReload = { reloaded: 0, queued: 0, restartNeeded: 0, errors: [] };

/** A forge-like demo host on a manual clock; `knob` plays `?demo&plugins=…`. */
function rig(knob: PluginsHostEnv["knob"] = null) {
  const clock = new ManualClock();
  const plugins = new DemoPlugins({ supported: true, clock, home: HOME, agents: () => AGENTS, ompVersion: () => "18.13.3", knob });
  /** Calls a method and moves the clock past hostd's time for it; a refused call rejects. */
  const call = async <T,>(method: string, params: Record<string, unknown> = {}, ms = 6000): Promise<T> => {
    let answer: Promise<T>;
    try {
      answer = Promise.resolve(plugins.call(method, params) as T | Promise<T>);
    } catch (e) {
      answer = Promise.reject(e);
    }
    clock.advance(ms);
    return answer;
  };
  return { clock, call };
}

const names = (list: SkillList) => list.skills.map((s) => s.name);
const skill = (list: SkillList, name: string) => list.skills.find((s) => s.name === name);
const registry = (list: SkillList, id: string) => list.registry.find((r) => r.id === id);
const market = (list: PluginList, id: string, scope = "user") => list.marketplace.find((m) => m.id === id && m.scope === scope);

describe("demo skills", () => {
  test("lists every provider's skills, switched-off ones included, and the registry installs", async () => {
    const r = rig();
    const list = await r.call<SkillList>("skills.list");
    expect(names(list).sort()).toEqual(
      ["changelog", "commit-style", "flaky-tests", "frontend-design", "pdf", "release-notes", "review-checklist", "sql-review", "web-research", "xlsx"].sort(),
    );
    expect(new Set(list.skills.map((s) => s.provider))).toEqual(new Set(["native", "omp-managed", "claude", "codex", "agents", "skillshare", "claude-plugins"]));
    expect(skill(list, "xlsx")?.enabled).toBe(false);
    expect(skill(list, "commit-style")?.hidden).toBe(true);
    expect(skill(list, "changelog")).toMatchObject({ provider: "skillshare", registryId: "@acme/changelog", level: "user" });
    expect(skill(list, "frontend-design")).toMatchObject({ provider: "claude-plugins", plugin: "frontend-design" });
    // Missing from omp's store: listed as an install, but no session loads its skill.
    expect(registry(list, "@tools/screenshot")).toMatchObject({ stored: false, version: "0.9.0" });
    expect(skill(list, "screenshot")).toBeUndefined();
    expect(list.registry.map((x) => x.scope)).toEqual(["user", "user", "user"]);
    expect([list.registryUrl, list.cwd, list.updatesCheckedAt, list.ompVersion, list.warnings.length]).toEqual(["https://skills.omp.sh", undefined, undefined, "18.13.3", 1]);

    // A project adds its own skills and registry installs; the home folder is the user level.
    const project = await r.call<SkillList>("skills.list", { cwd: `${REPO}/` });
    expect(project.cwd).toBe(REPO);
    expect(skill(project, "tf-proto")?.level).toBe("project");
    expect(registry(project, "@teleflock/release-checklist")?.scope).toBe("project");
    expect((await r.call<SkillList>("skills.list", { cwd: HOME })).cwd).toBeUndefined();
    await expect(r.call("skills.list", { cwd: "code/teleflock" })).rejects.toMatchObject({ code: "invalid_params" });
  });

  test("an update check is kept for the folder and merged into later lists until the version changes", async () => {
    const r = rig();
    const checked = await r.call<SkillList>("skills.list", { updates: true });
    expect(checked.updatesCheckedAt).toBe(r.clock.now() - 6000 + 2700);
    expect(registry(checked, "@acme/changelog")).toMatchObject({ update: "1.3.0", latest: "2.0.0", description: "Write a changelog entry from the commits since the last tag" });
    expect(registry(checked, "@oh-my-pi/review-checklist")).toMatchObject({ update: undefined, latest: "0.4.1" });

    const plain = await r.call<SkillList>("skills.list");
    expect(plain.updatesCheckedAt).toBe(checked.updatesCheckedAt);
    expect(registry(plain, "@acme/changelog")?.update).toBe("1.3.0");

    const updated = await r.call<SkillsChanged>("skills.update", { id: "@acme/changelog", scope: "user" });
    expect(updated.changes).toEqual(["@acme/changelog 1.2.0 → 1.3.0"]);
    expect(updated.reload).toEqual(EVERY_SESSION);
    // The check was about 1.2.0: nothing carries over to 1.3.0.
    const after = registry(updated.list, "@acme/changelog");
    expect([after?.version, after?.update, after?.latest]).toEqual(["1.3.0", undefined, undefined]);

    // A project's private package can't be asked about.
    const project = await r.call<SkillList>("skills.list", { cwd: REPO, updates: true });
    expect(registry(project, "@teleflock/release-checklist")?.updateError).toBe("@teleflock/release-checklist was not found in the registry");
  });

  test("a version that ships scripts needs consent: install and restore retry with allowScripts", async () => {
    const r = rig();
    await expect(r.call("skills.install", { spec: "@labs/pdf-tools", scope: "user" })).rejects.toMatchObject({
      code: "scripts_need_consent",
      message: "@labs/pdf-tools@0.3.0 ships scripts:\n  scripts/extract.py (executable)\n  scripts/merge.sh (executable)\n  bin/pdfinfo-lite (executable)",
    });
    const installed = await r.call<SkillsChanged>("skills.install", { spec: "@labs/pdf-tools", scope: "user", allowScripts: true });
    expect(installed.changes).toEqual(["+ @labs/pdf-tools@0.3.0"]);
    expect(registry(installed.list, "@labs/pdf-tools")).toMatchObject({ range: "^0.3.0", version: "0.3.0", stored: true });
    expect(skill(installed.list, "pdf-tools")?.enabled).toBe(true);

    // "Restore" of an install missing from the store is an update, with the same consent.
    await expect(r.call("skills.update", { id: "@tools/screenshot", scope: "user" })).rejects.toMatchObject({ code: "scripts_need_consent" });
    const restored = await r.call<SkillsChanged>("skills.update", { id: "@tools/screenshot", scope: "user", allowScripts: true });
    expect(restored.changes).toEqual(["restored @tools/screenshot@0.9.0"]);
    expect(registry(restored.list, "@tools/screenshot")?.stored).toBe(true);
    expect(names(restored.list)).toContain("screenshot");
  });

  test("installs, removals and switches: scopes, errors, and what reaches running sessions", async () => {
    const r = rig();
    const plain = await r.call<SkillsChanged>("skills.install", { spec: "@docs/mermaid-diagrams", scope: "user" });
    expect([plain.changes, plain.reload]).toEqual([["+ @docs/mermaid-diagrams@1.1.0"], EVERY_SESSION]);
    const project = await r.call<SkillsChanged>("skills.install", { spec: "@writing/plain-english", scope: "project", cwd: REPO });
    expect(project.reload).toEqual(REPO_SESSIONS);
    expect(registry(project.list, "@writing/plain-english")?.scope).toBe("project");

    await expect(r.call("skills.install", { spec: "@docs/mermaid-diagrams" })).rejects.toMatchObject({ code: "invalid_params", message: "scope: user or project" });
    await expect(r.call("skills.install", { spec: "@docs/mermaid-diagrams", scope: "project" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("skills.install", { spec: "mermaid", scope: "user" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("skills.install", { spec: "@nobody/missing", scope: "user" })).rejects.toMatchObject({ code: "omp_error", message: "@nobody/missing was not found in the registry" });

    const removed = await r.call<SkillsChanged>("skills.remove", { id: "@docs/mermaid-diagrams", scope: "user" });
    expect(removed.changes).toEqual(["- @docs/mermaid-diagrams@1.1.0"]);
    expect(registry(removed.list, "@docs/mermaid-diagrams")).toBeUndefined();
    await expect(r.call("skills.remove", { id: "@docs/mermaid-diagrams", scope: "user" })).rejects.toMatchObject({ code: "not_found" });

    // omp applies switches to running sessions itself: no reload, a note.
    const on = await r.call<SkillsChanged>("skills.setEnabled", { name: "xlsx", enabled: true });
    expect([on.reload, typeof on.note]).toEqual([NONE, "string"]);
    expect(skill(on.list, "xlsx")?.enabled).toBe(true);
    await expect(r.call("skills.setEnabled", { name: "nope", enabled: false })).rejects.toMatchObject({ code: "not_found" });
  });

  test("registry search: relevance, downloads and recency, pages, installed marks", async () => {
    const r = rig();
    const ids = (s: SkillSearchResult) => s.hits.map((h) => h.id);
    const relevance = await r.call<SkillSearchResult>("skills.search", { query: "docs" });
    expect(ids(relevance)).toEqual(["@docs/mermaid-diagrams", "@writing/plain-english", "@oh-my-pi/review-checklist"]);
    expect(relevance.hits.find((h) => h.id === "@oh-my-pi/review-checklist")?.installed).toBe("user");
    expect(ids(await r.call<SkillSearchResult>("skills.search", { query: "docs", sort: "downloads" }))).toEqual([
      "@oh-my-pi/review-checklist",
      "@docs/mermaid-diagrams",
      "@writing/plain-english",
    ]);
    expect(ids(await r.call<SkillSearchResult>("skills.search", { query: "docs", sort: "recent" }))[0]).toBe("@oh-my-pi/review-checklist");
    // Private packages never show up.
    expect(ids(await r.call<SkillSearchResult>("skills.search", { query: "release" }))).not.toContain("@teleflock/release-checklist");

    const first = await r.call<SkillSearchResult>("skills.search", { query: "e" });
    const second = await r.call<SkillSearchResult>("skills.search", { query: "e", page: 2 });
    expect([first.perPage, first.hits.length, first.total]).toEqual([6, 6, first.hits.length + second.hits.length]);
    await expect(r.call("skills.search", { query: " " })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("demo plugins", () => {
  test("packages, marketplace plugins (an update, a shadowed one) and marketplaces", async () => {
    const r = rig();
    const list = await r.call<PluginList>("plugins.list");
    expect(list.packages.map((p) => [p.name, p.enabled, p.linked])).toEqual([
      ["omp-git-tools", true, false],
      ["omp-plugins", true, true],
      ["omp-notify-desktop", false, false],
    ]);
    expect(list.packages[0]?.features.length).toBe(3);
    expect(market(list, "code-review@claude-plugins-official")?.update).toBe("1.1.0");
    expect(market(list, "release-train@acme-tools")?.enabled).toBe(false);
    expect(list.marketplace.every((m) => m.scope === "user" && !m.shadowed)).toBe(true);
    expect(list.marketplaces.map((m) => [m.name, m.plugins])).toEqual([
      ["claude-plugins-official", 12],
      ["acme-tools", 4],
    ]);

    // In the project its own commit-commands wins over the user's.
    const project = await r.call<PluginList>("plugins.list", { cwd: REPO });
    expect(project.marketplace[0]).toMatchObject({ id: "commit-commands@claude-plugins-official", scope: "project", shadowed: false });
    expect(market(project, "commit-commands@claude-plugins-official")?.shadowed).toBe(true);

    const catalog = await r.call<PluginCatalog>("plugins.discover", { cwd: REPO });
    expect(catalog.plugins.find((c) => c.id === "commit-commands@claude-plugins-official")?.installed).toEqual(["user", "project"]);
    expect(catalog.plugins.find((c) => c.id === "hookify@claude-plugins-official")?.installed).toEqual([]);
    expect((await r.call<PluginCatalog>("plugins.discover", { marketplace: "acme-tools" })).plugins.map((c) => c.marketplace)).toEqual(Array(4).fill("acme-tools"));
    await expect(r.call("plugins.discover", { marketplace: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("installs from a marketplace, npm, git and a folder; package code needs a restart", async () => {
    const r = rig();
    const project = await r.call<PluginsChanged>("plugins.install", { spec: "hookify@claude-plugins-official", scope: "project", cwd: REPO });
    expect([project.changes, project.reload, project.note]).toEqual([["+ hookify@claude-plugins-official 0.9.0 (project)"], REPO_SESSIONS, undefined]);
    expect(market(project.list, "hookify@claude-plugins-official", "project")?.version).toBe("0.9.0");
    await expect(r.call("plugins.install", { spec: "hookify@claude-plugins-official", scope: "project", cwd: REPO })).rejects.toMatchObject({ code: "omp_error" });
    expect((await r.call<PluginsChanged>("plugins.install", { spec: "hookify@claude-plugins-official", scope: "project", cwd: REPO, force: true })).changes).toHaveLength(1);
    await expect(r.call("plugins.install", { spec: "nothing@claude-plugins-official" })).rejects.toMatchObject({ code: "omp_error", message: 'Plugin "nothing" not found in marketplace "claude-plugins-official"' });

    const npm = await r.call<PluginsChanged>("plugins.install", { spec: "omp-theme-pack" });
    expect([npm.changes, npm.reload]).toEqual([["+ omp-theme-pack@0.8.1"], EVERY_SESSION]);
    expect(npm.note).toContain("restart");
    await expect(r.call("plugins.install", { spec: "omp-unknown" })).rejects.toMatchObject({ code: "omp_error" });
    const git = await r.call<PluginsChanged>("plugins.install", { spec: "github:me/omp-tools#main" });
    expect(git.list.packages.find((p) => p.name === "omp-tools")?.description).toBe("Installed from github:me/omp-tools#main");
    const folder = await r.call<PluginsChanged>("plugins.install", { spec: "~/code/my-plugin/" });
    expect(folder.list.packages.find((p) => p.name === "my-plugin")).toMatchObject({ linked: true, path: `${HOME}/code/my-plugin`, enabled: true });
    await expect(r.call("plugins.install", { spec: "not a spec!" })).rejects.toMatchObject({ code: "invalid_params" });
  });

  test("switches, removals, upgrades and marketplace changes", async () => {
    const r = rig();
    const on = await r.call<PluginsChanged>("plugins.setEnabled", { id: "release-train@acme-tools", enabled: true });
    expect([on.changes, on.reload]).toEqual([["Enabled release-train@acme-tools"], EVERY_SESSION]);
    // Its skill comes with it.
    expect(names(await r.call<SkillList>("skills.list"))).toContain("release-train");
    const pkgOff = await r.call<PluginsChanged>("plugins.setEnabled", { id: "omp-git-tools", enabled: false });
    expect(pkgOff.list.packages.find((p) => p.name === "omp-git-tools")?.enabled).toBe(false);
    expect(pkgOff.note).toContain("restart");
    // Installed in both scopes there: which one must be said.
    await expect(r.call("plugins.setEnabled", { id: "commit-commands@claude-plugins-official", enabled: false, cwd: REPO })).rejects.toMatchObject({ code: "invalid_params" });
    expect((await r.call<PluginsChanged>("plugins.setEnabled", { id: "commit-commands@claude-plugins-official", enabled: false, scope: "project", cwd: REPO })).reload).toEqual(REPO_SESSIONS);

    // Refreshing the catalogs publishes security-guidance 1.0.1; upgrading all takes both updates.
    const refreshed = await r.call<PluginsChanged>("plugins.marketplaceUpdate", {});
    expect([refreshed.changes, refreshed.reload]).toEqual([["Updated claude-plugins-official", "Updated acme-tools"], NONE]);
    expect(market(refreshed.list, "security-guidance@claude-plugins-official")?.update).toBe("1.0.1");
    const all = await r.call<PluginsChanged>("plugins.upgrade", {});
    expect(all.changes).toEqual(["code-review@claude-plugins-official 1.0.0 → 1.1.0", "security-guidance@claude-plugins-official 1.0.0 → 1.0.1"]);
    expect(all.reload).toEqual(EVERY_SESSION);
    expect(all.list.marketplace.some((m) => m.update)).toBe(false);
    expect((await r.call<PluginsChanged>("plugins.upgrade", {})).reload).toEqual(NONE);

    const pkg = await r.call<PluginsChanged>("plugins.upgrade", { id: "omp-git-tools" });
    expect(pkg.changes).toEqual(["omp-git-tools 2.1.0 → 2.2.0"]);
    expect((await r.call<PluginsChanged>("plugins.upgrade", { id: "omp-git-tools" })).changes).toEqual(["omp-git-tools is up to date"]);
    await expect(r.call("plugins.upgrade", { id: "omp-plugins" })).rejects.toMatchObject({ code: "invalid_params" });

    const removed = await r.call<PluginsChanged>("plugins.remove", { id: "frontend-design@claude-plugins-official" });
    expect(removed.changes).toEqual(["- frontend-design@claude-plugins-official 1.0.0"]);
    expect(names(await r.call<SkillList>("skills.list"))).not.toContain("frontend-design");
    await expect(r.call("plugins.remove", { id: "frontend-design@claude-plugins-official" })).rejects.toMatchObject({ code: "not_found" });

    const added = await r.call<PluginsChanged>("plugins.marketplaceAdd", { source: "obra/superpowers-marketplace" });
    expect([added.changes, added.reload]).toEqual([["Added marketplace superpowers-marketplace (2 plugins)"], NONE]);
    await expect(r.call("plugins.marketplaceAdd", { source: "obra/superpowers-marketplace" })).rejects.toMatchObject({ code: "omp_error" });
    await expect(r.call("plugins.marketplaceAdd", { source: "nobody/nothing" })).rejects.toMatchObject({ code: "omp_error" });
    const gone = await r.call<PluginsChanged>("plugins.marketplaceRemove", { name: "acme-tools" });
    expect(gone.list.marketplaces.map((m) => m.name)).toEqual(["claude-plugins-official", "superpowers-marketplace"]);

    expect(await r.call<McpReload>("plugins.reload", { cwd: REPO })).toEqual(REPO_SESSIONS);
    expect(await r.call<McpReload>("plugins.reload", {})).toEqual(EVERY_SESSION);
  });
});

describe("demo knobs and hosts", () => {
  test("plugins=empty: nothing installed, no marketplaces, an empty registry", async () => {
    const r = rig("empty");
    const skills = await r.call<SkillList>("skills.list", { updates: true });
    expect([skills.skills, skills.registry]).toEqual([[], []]);
    const plugins = await r.call<PluginList>("plugins.list");
    expect([plugins.packages, plugins.marketplace, plugins.marketplaces]).toEqual([[], [], []]);
    expect(await r.call<SkillSearchResult>("skills.search", { query: "pdf" })).toMatchObject({ total: 0, hits: [], registryUrl: "https://skills.omp.sh" });
  });

  test("plugins=error: both lists fail the way hostd reports it", async () => {
    const r = rig("error");
    await expect(r.call("skills.list")).rejects.toMatchObject({ code: "omp_error" });
    await expect(r.call("plugins.list")).rejects.toMatchObject({ code: "io_error", hint: "Check the file's owner and permissions on the host." });
  });

  test("forge answers through the demo engine; studio-pc's tf-hostd predates the page", async () => {
    const clock = new ManualClock();
    const engine = new DemoEngine({ mode: "backend", clock });
    engine.subscribe(() => {});
    clock.advance(5000);
    const answer = engine.callHost("forge", "skills.list", {});
    clock.advance(4000);
    expect(((await answer) as SkillList).skills.length).toBeGreaterThan(5);
    const old = new DemoPlugins({ supported: false, clock, home: HOME, agents: () => [], ompVersion: () => undefined, knob: null });
    expect(() => old.call("plugins.list", {})).toThrow("Unknown method plugins.list");
  });
});
