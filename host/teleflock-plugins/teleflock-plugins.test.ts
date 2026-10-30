import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	catalogRow,
	packageRow,
	disabledSkillNames,
	packumentOf,
	readInstalls,
	registryIdOf,
	resolveRange,
	searchHit,
	skillRow,
	updateInfo,
} from "./teleflock-plugins";

const packument = packumentOf({
	description: "PDF tools",
	distTags: { latest: "2.0.0", next: "3.0.0-beta.1" },
	versions: {
		"1.0.0": {},
		"1.2.0": { deprecated: "use 2.x" },
		"1.3.0": { yanked: true },
		"2.0.0": {},
		"3.0.0-beta.1": {},
	},
});

describe("registry versions (omp's resolveSkillVersion)", () => {
	test("ranges take the highest non-yanked match, tags and exact versions resolve directly", () => {
		expect(resolveRange(packument, "^1.0.0")).toBe("1.2.0");
		expect(resolveRange(packument, "latest")).toBe("2.0.0");
		expect(resolveRange(packument, "next")).toBe("3.0.0-beta.1");
		expect(resolveRange(packument, "1.3.0")).toBe("1.3.0");
		expect(resolveRange(packument, "^9.0.0")).toBeUndefined();
	});

	test("an update is the newer version within the range; notices are the installed version's", () => {
		const info = updateInfo({ id: "@alice/pdf", scope: "user", range: "^1.0.0", version: "1.2.0", stored: true }, packument);
		expect(info).toMatchObject({ update: undefined, latest: "2.0.0", deprecated: "use 2.x", yanked: false });
		const older = updateInfo({ id: "@alice/pdf", scope: "user", range: "^1.0.0", version: "1.0.0", stored: true }, packument);
		expect(older.update).toBe("1.2.0");
	});

	test("a packument that isn't one is refused", () => {
		expect(() => packumentOf([])).toThrow();
	});
});

describe("registry installs", () => {
	test("skills.json + skills.lock.json, stored only with the locked integrity in the store", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-plugins-"));
		const store = path.join(dir, "store");
		fs.writeFileSync(path.join(dir, "skills.json"), JSON.stringify({ skills: { "@alice/pdf": "^1.0.0", "@bob/new": "latest", "not-an-id": "1" } }));
		fs.writeFileSync(
			path.join(dir, "skills.lock.json"),
			JSON.stringify({ version: 1, skills: { "@alice/pdf": { version: "1.2.0", integrity: "sha512-x", resolved: "" }, "@carol/old": { version: "../../x", integrity: "y" } } }),
		);
		fs.mkdirSync(path.join(store, "@alice/pdf", "1.2.0"), { recursive: true });
		fs.writeFileSync(path.join(store, "@alice/pdf", "1.2.0", ".skillshare-integrity"), "sha512-x\n");
		const warnings: string[] = [];
		const rows = readInstalls(dir, "user", store, warnings);
		expect(rows.map(r => [r.id, r.range, r.version, r.stored])).toEqual([
			["@alice/pdf", "^1.0.0", "1.2.0", true],
			["@bob/new", "latest", undefined, false],
			// A lock version that isn't exact semver never becomes a store path.
			["@carol/old", undefined, undefined, false],
		]);
		expect(warnings).toEqual([]);
		fs.writeFileSync(path.join(dir, "skills.json"), "{oops");
		readInstalls(dir, "user", store, warnings);
		expect(warnings[0]).toContain("skills.json");
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("rows", () => {
	test("skills: switched off by `skill:<name>` (namespaced ones by their bare name too), registry id from the source", () => {
		const off = disabledSkillNames(["skill:pdf", "ext:x", "skill:review"]);
		const pdf = skillRow(
			{ name: "pdf", description: "  PDF\n tools ", filePath: "/s/SKILL.md", _source: { provider: "skillshare", providerName: "Skill Registry", level: "user", origin: "skillshare:@alice/pdf@1.2.0", pluginName: "pdf" } },
			off,
		);
		expect(pdf).toMatchObject({ name: "pdf", description: "PDF tools", enabled: false, registryId: "@alice/pdf", plugin: "pdf", provider: "skillshare" });
		expect(skillRow({ name: "team/review", filePath: "/r/SKILL.md" }, off).enabled).toBe(false);
		expect(skillRow({ name: "lab", filePath: "/l/SKILL.md", hide: true }, off)).toMatchObject({ enabled: true, hidden: true, provider: "unknown" });
		expect(registryIdOf("claude")).toBeUndefined();
	});

	test("search hits and catalog entries", () => {
		const hit = searchHit({ scope: "alice", name: "pdf", description: "d", version: "1.0.0", publisher: { username: "alice" }, updatedAt: 5, weeklyDownloads: 3 }, new Map([["@alice/pdf", "user"]]));
		expect(hit).toMatchObject({ id: "@alice/pdf", publisher: "alice", installed: "user", weeklyDownloads: 3 });
		expect(searchHit({ name: "x" }, new Map())).toBeUndefined();
		const row = catalogRow({ name: "hello", description: "Hi", version: "1.0.0", commands: "./commands", mcpServers: {}, tags: ["fun"] }, "lab", ["user"]);
		expect(row).toMatchObject({ id: "hello@lab", provides: ["commands", "mcpServers"], keywords: ["fun"], installed: ["user"] });
	});

	test("package plugins: what they bring, their features, the package's own description, a linked folder", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-plugins-pkg-"));
		const real = path.join(dir, "checkout");
		fs.mkdirSync(real);
		fs.writeFileSync(path.join(real, "package.json"), JSON.stringify({ name: "lab", version: "0.1.0", description: "  Lab\n plugin " }));
		fs.symlinkSync(real, path.join(dir, "lab"));
		const manifest = { extensions: ["x.ts"], tools: "", commands: ["c.md"], features: { a: { description: "A", default: true }, b: {} } };
		const linked = packageRow({ name: "lab", version: "0.1.0", path: path.join(dir, "lab"), manifest, enabledFeatures: null, enabled: false });
		expect(linked).toMatchObject({ description: "Lab plugin", enabled: false, linked: true, provides: ["extensions", "commands"] });
		expect(linked.features).toEqual([
			{ name: "a", description: "A", enabled: true },
			{ name: "b", description: undefined, enabled: false },
		]);
		// The manifest's own description wins; a folder without package.json has none.
		expect(packageRow({ name: "lab", version: "0.1.0", path: real, manifest: { description: "From omp" }, enabledFeatures: ["b"], enabled: true })).toMatchObject({ description: "From omp", linked: false });
		expect(packageRow({ name: "gone", version: "1.0.0", path: path.join(dir, "gone"), enabledFeatures: null, enabled: true }).description).toBeUndefined();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
