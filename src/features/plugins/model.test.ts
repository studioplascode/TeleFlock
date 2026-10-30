import { describe, expect, test } from "bun:test";
import type { Agent, CatalogPlugin, MarketplacePlugin, PackagePlugin, PluginList, RegistrySkill, SkillInfo, SkillList } from "@/core/gen";
import {
  changesLine,
  errorLine,
  filterCatalog,
  firstAdded,
  groupSkills,
  hitInstalled,
  installedScopes,
  isoMs,
  latestOutsideRange,
  mergeReload,
  parseScriptListing,
  pendingUpdates,
  pluginKey,
  pluginRef,
  pluginUpdate,
  registryKey,
  registryNeed,
  rowKeys,
  runningSessions,
  sharePluginList,
  shareSkillList,
  skillGroup,
  skillKey,
  skillSource,
  sourceKind,
  specError,
  specKind,
  updatesText,
  urlHost,
} from "./model";

function skill(name: string, provider: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return { name, description: `${name} skill`, path: `/h/${provider}/${name}/SKILL.md`, provider, providerName: provider, level: "user", enabled: true, hidden: false, ...extra };
}

function reg(id: string, extra: Partial<RegistrySkill> = {}): RegistrySkill {
  return { id, scope: "user", range: "^1.0.0", version: "1.0.0", stored: true, yanked: false, ...extra };
}

function list(skills: SkillInfo[], registry: RegistrySkill[] = []): SkillList {
  return { skills, registry, warnings: [], registryUrl: "https://skills.omp.sh" };
}

function pkg(name: string, extra: Partial<PackagePlugin> = {}): PackagePlugin {
  return { name, version: "1.0.0", enabled: true, path: `/h/.omp/plugins/node_modules/${name}`, linked: false, provides: [], features: [], ...extra };
}

function mkt(name: string, extra: Partial<MarketplacePlugin> = {}): MarketplacePlugin {
  return { id: `${name}@official`, name, marketplace: "official", scope: "user", version: "1.0.0", enabled: true, shadowed: false, provides: [], ...extra };
}

function plugins(extra: Partial<PluginList> = {}): PluginList {
  return { packages: [], marketplace: [], marketplaces: [], warnings: [], ...extra };
}

describe("skills", () => {
  test("groups by where a skill comes from; unknown providers are other tools", () => {
    expect(skillGroup(skill("a", "native"))).toBe("omp");
    expect(skillGroup(skill("a", "omp-managed"))).toBe("omp");
    expect(skillGroup(skill("a", "custom"))).toBe("omp");
    expect(skillGroup(skill("a", "claude-plugins"))).toBe("plugins");
    expect(skillGroup(skill("a", "omp-plugins"))).toBe("plugins");
    expect(skillGroup(skill("a", "agent-plugins"))).toBe("plugins");
    expect(skillGroup(skill("a", "skillshare"))).toBe("registry");
    expect(skillGroup(skill("a", "claude", { registryId: "@x/a" }))).toBe("registry");
    expect(skillGroup(skill("a", "claude"))).toBe("other");
    expect(skillGroup(skill("a", "some-future-tool"))).toBe("other");
  });

  test("registry installs carry the skill they unpack to; one missing from the store has none", () => {
    const changelog = skill("changelog", "skillshare", { registryId: "@acme/changelog" });
    const g = groupSkills(list([skill("pdf", "claude"), changelog, skill("mine", "native")], [reg("@acme/changelog"), reg("@tools/shot", { stored: false })]));
    expect(g.registry.map((i) => [i.key, i.skill?.name])).toEqual([
      ["reg:user:@acme/changelog", "changelog"],
      ["reg:user:@tools/shot", undefined],
    ]);
    // The registry skill isn't listed twice.
    expect(g.other.map((i) => i.skill?.name)).toEqual(["pdf"]);
    expect(g.omp.map((i) => i.skill?.name)).toEqual(["mine"]);
  });

  test("the same package for the user and the project: each install gets the skill of its level", () => {
    const user = skill("x", "skillshare", { registryId: "@a/x", level: "user", path: "/u/x" });
    const project = skill("x", "skillshare", { registryId: "@a/x", level: "project", path: "/p/x" });
    const g = groupSkills(list([user, project], [reg("@a/x"), reg("@a/x", { scope: "project" })]));
    expect(g.registry.map((i) => i.skill?.path)).toEqual(["/u/x", "/p/x"]);
  });

  test("order: the project's own skills first, plugin skills by plugin, other tools by tool", () => {
    const g = groupSkills(
      list([
        skill("b", "native"),
        skill("a", "native", { level: "project" }),
        skill("z", "claude-plugins", { plugin: "beta" }),
        skill("y", "claude-plugins", { plugin: "alpha" }),
        skill("k", "codex", { providerName: "OpenAI Codex" }),
        skill("j", "claude", { providerName: "Claude Code" }),
      ]),
    );
    expect(g.omp.map((i) => i.skill?.name)).toEqual(["a", "b"]);
    expect(g.plugins.map((i) => i.skill?.name)).toEqual(["y", "z"]);
    expect(g.other.map((i) => i.skill?.name)).toEqual(["j", "k"]);
  });

  test("source chips name the tool or plugin, not omp's own folders", () => {
    expect(skillSource(skill("a", "native"))).toBeNull();
    expect(skillSource(skill("a", "skillshare"))).toBeNull();
    expect(skillSource(skill("a", "omp-managed"))).toBe("Auto-learned");
    expect(skillSource(skill("a", "claude", { providerName: "Claude Code" }))).toBe("Claude Code");
    expect(skillSource(skill("a", "claude-plugins", { plugin: "frontend-design", providerName: "Claude Code Marketplace" }))).toBe("frontend-design");
    expect(skillSource(skill("a", "agents", { providerName: "Agent Dirs (.agent/.agents)" }))).toBe(".agents folder");
  });

  test("what a registry install needs: restore, an update within range, or nothing", () => {
    expect(registryNeed(reg("@a/b", { stored: false }))).toBe("restore");
    expect(registryNeed(reg("@a/b", { version: undefined }))).toBe("restore");
    expect(registryNeed(reg("@a/b", { update: "1.1.0" }))).toBe("update");
    expect(registryNeed(reg("@a/b", { update: "1.0.0" }))).toBeNull();
    expect(registryNeed(reg("@a/b"))).toBeNull();
    expect(latestOutsideRange(reg("@a/b", { update: "1.3.0", latest: "2.0.0" }))).toBe("2.0.0");
    expect(latestOutsideRange(reg("@a/b", { update: "1.3.0", latest: "1.3.0" }))).toBeNull();
    expect(latestOutsideRange(reg("@a/b", { latest: "1.0.0" }))).toBeNull();
  });
});

describe("plugins", () => {
  test("keys and refs: packages by name, marketplace installs by id and scope", () => {
    expect(pluginKey(pkg("omp-git-tools"))).toBe("pkg:omp-git-tools");
    expect(pluginKey(mkt("code-review"))).toBe("mkt:user:code-review@official");
    expect(pluginKey(mkt("code-review", { scope: "project" }))).toBe("mkt:project:code-review@official");
    expect(pluginRef(pkg("omp-git-tools"))).toEqual({ id: "omp-git-tools" });
    expect(pluginRef(mkt("code-review", { scope: "project" }))).toEqual({ id: "code-review@official", scope: "project" });
  });

  test("updates: marketplace plugins with a newer catalog version, registry skills with one in range", () => {
    expect(pluginUpdate(mkt("a", { update: "1.1.0" }))).toBe("1.1.0");
    expect(pluginUpdate(mkt("a", { update: "1.0.0" }))).toBeNull();
    expect(pluginUpdate(pkg("a"))).toBeNull();
    const u = pendingUpdates(list([], [reg("@a/x", { update: "1.2.0" }), reg("@a/y", { stored: false }), reg("@a/z")]), plugins({ marketplace: [mkt("a", { update: "2.0.0" }), mkt("b")] }));
    expect(u.skills.map((r) => r.id)).toEqual(["@a/x"]);
    expect(u.plugins.map((p) => p.id)).toEqual(["a@official"]);
    expect(u.total).toBe(2);
    expect(updatesText(u)).toBe("1 skill update and 1 plugin update");
    expect(updatesText({ skills: [], plugins: [] })).toBeNull();
    expect(pendingUpdates(undefined, undefined).total).toBe(0);
  });
});

describe("scripts consent", () => {
  test("parses omp's listing of the files a version ships", () => {
    const message = "@labs/pdf-tools@0.3.0 ships scripts:\n  scripts/extract.py (executable)\n  scripts/readme.txt\n  bin/pdfinfo-lite (executable)";
    expect(parseScriptListing(message)).toEqual([
      {
        title: "@labs/pdf-tools@0.3.0 ships scripts",
        files: [
          { path: "scripts/extract.py", executable: true },
          { path: "scripts/readme.txt", executable: false },
          { path: "bin/pdfinfo-lite", executable: true },
        ],
      },
    ]);
  });

  test("several listings, files without a title line, plain text", () => {
    expect(parseScriptListing("@a/b@1.0.0 ships scripts:\n  x.sh (executable)\n@c/d@2.0.0 ships scripts:\n  y.py").map((l) => [l.title, l.files.length])).toEqual([
      ["@a/b@1.0.0 ships scripts", 1],
      ["@c/d@2.0.0 ships scripts", 1],
    ]);
    expect(parseScriptListing("  lonely.sh")).toEqual([{ title: "", files: [{ path: "lonely.sh", executable: false }] }]);
    expect(parseScriptListing("refused")).toEqual([{ title: "refused", files: [] }]);
    expect(parseScriptListing("")).toEqual([]);
  });
});

describe("install inputs", () => {
  test("spec kinds the way plugins.install reads them", () => {
    const known = ["official"];
    expect(specKind("code-review@official", known)).toBe("marketplace");
    expect(specKind("code-review@unknown", known)).toBe("npm");
    expect(specKind("omp-lsp-extras")).toBe("npm");
    expect(specKind("@scope/pkg@1.2")).toBe("npm");
    expect(specKind("pkg[search,web]")).toBe("npm");
    expect(specKind("github:user/repo")).toBe("git");
    expect(specKind("https://github.com/user/repo#v1")).toBe("git");
    expect(specKind("git@github.com:user/repo.git")).toBe("git");
    expect(specKind("~/code/my-plugin")).toBe("folder");
    expect(specKind("/srv/plugins/x")).toBe("folder");
    expect(specKind("./local")).toBe("folder");
    expect(specKind("C:\\plugins\\x")).toBe("folder");
    expect(specKind("")).toBeNull();
    expect(specKind("not a spec!")).toBeNull();
    expect(specError("two words")).toBe("Package names and git sources have no spaces");
    expect(specError("~/My Plugins/x")).toBeNull();
    expect(specError("pkg")).toBeNull();
  });

  test("marketplace sources", () => {
    expect(sourceKind("anthropics/claude-plugins-official")).toBe("github");
    expect(sourceKind("https://git.acme.dev/omp/marketplace.git")).toBe("git");
    expect(sourceKind("https://example.com/marketplace.json")).toBe("url");
    expect(sourceKind("~/code/marketplace")).toBe("local");
    expect(sourceKind("just-a-word")).toBeNull();
    expect(sourceKind(" ")).toBeNull();
  });
});

describe("catalogs and search", () => {
  const cat = (name: string, extra: Partial<CatalogPlugin> = {}): CatalogPlugin => ({ id: `${name}@official`, name, marketplace: "official", keywords: [], provides: [], installed: [], ...extra });

  test("filters by every word in name, description, keywords, category and author; by marketplace", () => {
    const all = [cat("code-review", { description: "Review a pull request", keywords: ["pr"] }), cat("hookify", { category: "productivity" }), cat("deploy-guard", { marketplace: "acme", author: "Acme team" })];
    expect(filterCatalog(all, "").map((p) => p.name)).toEqual(["code-review", "hookify", "deploy-guard"]);
    expect(filterCatalog(all, "review PR").map((p) => p.name)).toEqual(["code-review"]);
    expect(filterCatalog(all, "acme").map((p) => p.name)).toEqual(["deploy-guard"]);
    expect(filterCatalog(all, "", "acme").map((p) => p.name)).toEqual(["deploy-guard"]);
    expect(filterCatalog(all, "productivity", "acme")).toEqual([]);
  });

  test("installed marks come from the plugin list when there is one", () => {
    const p = cat("code-review", { installed: ["user"] });
    expect(installedScopes(p)).toEqual(["user"]);
    expect(installedScopes(p, plugins())).toEqual([]);
    expect(installedScopes(p, plugins({ marketplace: [mkt("code-review", { scope: "project" }), mkt("code-review")] }))).toEqual(["user", "project"]);
    const hit = { id: "@a/x", installed: "user" as const };
    expect(hitInstalled(hit)).toBe("user");
    expect(hitInstalled(hit, list([], []))).toBeUndefined();
    expect(hitInstalled(hit, list([], [reg("@a/x"), reg("@a/x", { scope: "project" })]))).toBe("project");
  });

  test("registry host, ISO times", () => {
    expect(urlHost("https://skills.omp.sh/")).toBe("skills.omp.sh");
    expect(urlHost("not a url")).toBe("not a url");
    expect(isoMs("2026-10-20T14:30:00.000Z")).toBe(Date.UTC(2026, 9, 20, 14, 30));
    expect(isoMs("nonsense")).toBeUndefined();
    expect(isoMs(undefined)).toBeUndefined();
  });
});

describe("changes", () => {
  test("omp's lines: three, then how many more", () => {
    expect(changesLine([])).toBeUndefined();
    expect(changesLine(["  ", "+ @a/b@1.0.0"])).toBe("+ @a/b@1.0.0");
    expect(changesLine(["a", "b", "c", "d", "e"])).toBe("a · b · c · +2 more");
  });

  test("reload outcomes of several changes add up to the most sessions reached per kind", () => {
    const a = { reloaded: 2, queued: 0, restartNeeded: 1, errors: ["x"] };
    expect(mergeReload(undefined, a)).toBe(a);
    expect(mergeReload(a, { reloaded: 1, queued: 1, restartNeeded: 0, errors: ["y"] })).toEqual({ reloaded: 2, queued: 1, restartNeeded: 1, errors: ["x", "y"] });
  });

  test("the row an install added", () => {
    const before = rowKeys(list([skill("a", "native")]), plugins({ packages: [pkg("x")] }));
    const after = rowKeys(list([skill("a", "native")], [reg("@a/new", { stored: false })]), plugins({ packages: [pkg("x"), pkg("y")] }));
    expect(firstAdded(before, after)).toBe(registryKey(reg("@a/new")));
    expect(firstAdded(after, after)).toBeUndefined();
    expect(skillKey(skill("a", "native"))).toBe("skill:/h/native/a/SKILL.md");
  });

  test("running sessions a change reaches: omp agents not parked, in the folder for a project", () => {
    const agent = (cwd: string, extra: Partial<Agent> = {}) => ({ kind: "omp", parked: undefined, omp: { link: "live" }, cwd, ...extra }) as unknown as Agent;
    const agents = [agent("/code/a"), agent("/code/a/sub"), agent("/code/b"), agent("/code/a", { kind: "claude" } as Partial<Agent>), agent("/code/a", { omp: undefined })];
    expect(runningSessions(agents)).toBe(3);
    expect(runningSessions(agents, "/code/a")).toBe(2);
    expect(runningSessions(undefined)).toBe(0);
  });

  test("errors read as one line", () => {
    expect(errorLine({ message: "omp failed", hint: "Update omp" })).toBe("omp failed — Update omp");
    expect(errorLine({ message: "omp failed" })).toBe("omp failed");
  });
});

describe("sharing for memoized rows", () => {
  test("unchanged rows keep their objects; a changed one is new", () => {
    const prev = list([skill("a", "native"), skill("b", "claude")], [reg("@a/x")]);
    const same = shareSkillList(prev, structuredClone(prev));
    expect(same.skills).toBe(prev.skills);
    expect(same.registry).toBe(prev.registry);
    const next = structuredClone(prev);
    (next.skills[1] as SkillInfo).enabled = false;
    const changed = shareSkillList(prev, next);
    expect(changed.skills).not.toBe(prev.skills);
    expect(changed.skills[0]).toBe(prev.skills[0]);
    expect(changed.skills[1]).not.toBe(prev.skills[1]);
    expect(changed.registry).toBe(prev.registry);

    const pp = plugins({ packages: [pkg("x")], marketplace: [mkt("a")] });
    const pn = structuredClone(pp);
    (pn.marketplace[0] as MarketplacePlugin).update = "1.1.0";
    const shared = sharePluginList(pp, pn);
    expect(shared.packages).toBe(pp.packages);
    expect(shared.marketplace).not.toBe(pp.marketplace);
  });
});
