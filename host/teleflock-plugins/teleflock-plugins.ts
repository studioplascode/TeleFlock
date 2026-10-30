/**
 * TeleFlock skills & plugins helper: an omp extension that tf-hostd runs in a throwaway headless omp
 * (`omp --mode rpc --no-session --no-extensions -e <home>/ext/teleflock-plugins.ts`, cwd = the
 * project folder the answer is about, or an empty folder for user-level answers) to read omp's
 * skills and plugins with omp's own code: skill discovery exactly as a session does it (every
 * provider, switched-off skills included), the Skillshare registry installs (`skills.json` /
 * `skills.lock.json`) and their updates, package plugins (`PluginManager`), marketplace plugins,
 * marketplaces and their catalogs (`MarketplaceManager`).
 *
 * Embedded in tf-hostd (`crates/tf-hostd/src/ops/plugins`) and written next to the companion
 * extension; architecture §3.26 has the protocol (the MCP helper's, §3.15):
 *
 *   TF_PLUGINS_IN   request JSON `{v: 1, op, deadlineAt, …}` (owner-only; deleted as soon as it is read)
 *   TF_PLUGINS_OUT  JSON lines appended by this helper: `hello`, then exactly one `result` or
 *                   `error` line, after which the process exits
 *
 * Changes (installs, removals, switches) don't run here: tf-hostd runs omp's own CLI for them
 * (`omp skill …`, `omp plugin …`). Everything here only reads, except that the registry is asked
 * about versions and searches over HTTP (`skills.registryUrl`, the routes omp's `SkillshareClient`
 * uses; omp's skillshare modules can't be imported by extensions).
 *
 * Runs inside the extension factory (omp waits for it), so no model, session or stdin is needed.
 * omp internals are imported dynamically by literal specifier and feature-checked: an omp without
 * one answers `unsupported`. Nothing here writes to stdout/stderr.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const HELPER_VERSION = "1.0.0";
const DEFAULT_REGISTRY = "https://skills.omp.sh";
/** Without a deadline from tf-hostd. */
const DEFAULT_BUDGET_MS = 25_000;
/** One registry request at most (the deadline may cut it shorter). */
const REGISTRY_TIMEOUT_MS = 8_000;
/** Registry requests at once while looking for updates. */
const REGISTRY_PARALLEL = 6;
const MAX_DESCRIPTION = 600;
const MAX_WARNINGS = 50;

type Json = Record<string, unknown>;
type Line = { t: string } & Json;

class HelperError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function clip(s: unknown, max = MAX_DESCRIPTION): string | undefined {
	if (typeof s !== "string") return undefined;
	const t = s.replace(/\s+/g, " ").trim();
	if (!t) return undefined;
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A plain JSON object (parsed files, registry answers, omp's extension API). */
export function isObj(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** omp's Bun runtime (semver ranges as omp's skill installer resolves them). */
declare const Bun: { semver: SemverLike };

const emitTo = (out: string) => (line: Line) => {
	try {
		fs.appendFileSync(out, `${JSON.stringify(line)}\n`, { mode: 0o600 });
	} catch {
		/* tf-hostd times out instead */
	}
};

/**
 * `import()` an omp module by literal name (omp's loader maps only literal specifiers) and check
 * that it has the `exports` this helper calls; else `unsupported`.
 */
async function need<T>(load: () => Promise<unknown>, what: string, version: string, exports: readonly string[]): Promise<T> {
	let mod: unknown;
	try {
		mod = await load();
	} catch (e) {
		throw new HelperError("unsupported", `omp ${version} lacks ${what} (${message(e)}): update omp`);
	}
	const missing = exports.filter(name => !isObj(mod) || mod[name] === undefined);
	if (missing.length > 0) throw new HelperError("unsupported", `omp ${version}'s ${what} lacks ${missing.join(", ")}: update omp`);
	// Checked above for what is called; the shapes are omp's (structural views below).
	return mod as T;
}

// Structural views of the omp internals used here (no type imports: older builds may lack them).
interface SettingsLike {
	extensionsSourceLevel?(): string;
}
interface Setting<T> {
	get(s: SettingsLike): T;
}
interface SourceMeta {
	provider?: string;
	providerName?: string;
	path?: string;
	level?: string;
	origin?: string;
	pluginName?: string;
}
interface DiscoveredSkill {
	name: string;
	description?: string;
	filePath: string;
	baseDir?: string;
	hide?: boolean;
	_source?: SourceMeta;
}
interface SkillsModule {
	loadSkills(o: Json): Promise<{ skills: DiscoveredSkill[]; warnings: { skillPath?: string; message: string }[] }>;
}
interface ExtSettingsModule {
	cfgSkills: Setting<Json & { customDirectories?: string[] }>;
	cfgDisabledExtensions: Setting<string[]>;
	cfgExtensions: Setting<string[]>;
	cfgSkillsRegistryUrl?: Setting<string>;
}
interface PluginManifestLike {
	description?: string;
	extensions?: string[];
	tools?: string;
	hooks?: string;
	commands?: string[];
	features?: Record<string, { description?: string; default?: boolean }>;
}
interface PackagePluginLike {
	name: string;
	version: string;
	path: string;
	manifest?: PluginManifestLike;
	enabledFeatures: string[] | null;
	enabled: boolean;
}
interface InstalledEntryLike {
	scope: "user" | "project";
	installPath: string;
	version: string;
	lastUpdated?: string;
	enabled?: boolean;
}
interface InstalledSummaryLike {
	id: string;
	scope: "user" | "project";
	entries: InstalledEntryLike[];
	shadowedBy?: string;
}
interface MarketplaceEntryLike {
	name: string;
	sourceType: string;
	sourceUri: string;
	catalogPath: string;
	updatedAt?: string;
}
interface CatalogEntryLike {
	name: string;
	description?: string;
	version?: string;
	author?: { name?: string };
	homepage?: string;
	repository?: string;
	category?: string;
	keywords?: string[];
	tags?: string[];
	commands?: unknown;
	agents?: unknown;
	hooks?: unknown;
	mcpServers?: unknown;
	lspServers?: unknown;
}
interface CatalogLike {
	name: string;
	owner?: { name?: string };
	metadata?: { description?: string };
	plugins: CatalogEntryLike[];
}
interface MarketplaceManagerLike {
	listInstalledPlugins(): Promise<InstalledSummaryLike[]>;
	listMarketplaces(): Promise<MarketplaceEntryLike[]>;
	listAvailablePlugins(marketplace?: string): Promise<CatalogEntryLike[]>;
	getPluginInfo(name: string, marketplace: string): Promise<CatalogEntryLike | null>;
	checkForUpdates(): Promise<{ pluginId: string; scope: string; from: string; to: string }[]>;
}
interface PluginsModule {
	PluginManager: new (cwd?: string) => { list(): Promise<PackagePluginLike[]> };
	MarketplaceManager: new (o: Json) => MarketplaceManagerLike;
	getMarketplacesRegistryPath(): string;
	getInstalledPluginsRegistryPath(): string;
	getMarketplacesCacheDir(): string;
	getPluginsCacheDir(): string;
	parseMarketplaceCatalog(content: string, filePath: string): CatalogLike;
}
interface DiscoveryHelpersModule {
	resolveOrDefaultProjectRegistryPath(cwd: string): Promise<string | undefined>;
}

const extSettingsModule = (v: string) =>
	need<ExtSettingsModule>(() => import("@oh-my-pi/pi-coding-agent/extensibility/settings"), "extensibility/settings", v, [
		"cfgSkills",
		"cfgDisabledExtensions",
		"cfgExtensions",
	]);
const skillsModule = (v: string) => need<SkillsModule>(() => import("@oh-my-pi/pi-coding-agent/extensibility/skills"), "extensibility/skills", v, ["loadSkills"]);
const pluginsModule = (v: string) =>
	need<PluginsModule>(() => import("@oh-my-pi/pi-coding-agent/extensibility/plugins"), "extensibility/plugins", v, [
		"PluginManager",
		"MarketplaceManager",
		"getMarketplacesRegistryPath",
		"getInstalledPluginsRegistryPath",
		"getMarketplacesCacheDir",
		"getPluginsCacheDir",
		"parseMarketplaceCatalog",
	]);
const helpersModule = (v: string) =>
	need<DiscoveryHelpersModule>(() => import("@oh-my-pi/pi-coding-agent/discovery/helpers"), "discovery/helpers", v, ["resolveOrDefaultProjectRegistryPath"]);

/** omp's own settings instance (the process's: the same module instance omp runs). */
async function settingsOf(pi: Json, version: string): Promise<SettingsLike> {
	let holder: unknown = pi.Settings;
	if (!isObj(holder) && typeof holder !== "function") {
		holder = (await need<Json>(() => import("@oh-my-pi/pi-coding-agent/config/settings"), "config/settings", version, ["Settings"])).Settings;
	}
	const instance = (isObj(holder) || typeof holder === "function") && "instance" in holder ? holder.instance : undefined;
	if (!isObj(instance)) throw new HelperError("unsupported", `omp ${version}: settings are not initialized`);
	// omp's Settings instance; only `cfg*.get(settings)` and `extensionsSourceLevel()` are used.
	return instance as SettingsLike;
}

function expandTilde(p: string): string {
	if (p === "~") return process.env.HOME ?? p;
	if (p.startsWith("~/")) return path.join(process.env.HOME ?? "~", p.slice(2));
	return p;
}

// ───────────────────────────── registry files ─────────────────────────────

export const SKILL_ID_RE = /^@([a-z0-9][a-z0-9_]{2,31})\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const EXACT_VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
/** Lock versions are path segments of the store: exact semver only. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface Installed {
	id: string;
	scope: "user" | "project";
	range?: string;
	version?: string;
	integrity?: string;
	stored: boolean;
}

function readJson(file: string): unknown {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		const code = e instanceof Error && "code" in e ? e.code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw e;
	}
	return JSON.parse(text);
}

/** The `skills` object of a `skills.json` / `skills.lock.json`, `{}` when absent. */
function skillsOf(file: string): Json {
	const parsed = readJson(file);
	if (parsed === undefined) return {};
	if (!isObj(parsed)) throw new Error("not a JSON object");
	return isObj(parsed.skills) ? parsed.skills : {};
}

/**
 * The registry installs of one `skills.json` + `skills.lock.json` pair (omp's `listInstalledSkills`
 * for one scope), `stored` when the store holds the locked version with its integrity marker.
 */
export function readInstalls(dir: string, scope: "user" | "project", storeDir: string, warnings: string[]): Installed[] {
	const manifestFile = path.join(dir, "skills.json");
	const lockFile = path.join(dir, "skills.lock.json");
	let manifest: Json = {};
	let lock: Json = {};
	try {
		manifest = skillsOf(manifestFile);
	} catch (e) {
		warnings.push(`${manifestFile}: ${message(e)}`);
	}
	try {
		lock = skillsOf(lockFile);
	} catch (e) {
		warnings.push(`${lockFile}: ${message(e)}`);
	}
	const ids = [...new Set([...Object.keys(manifest), ...Object.keys(lock)])].filter(id => SKILL_ID_RE.test(id)).sort();
	return ids.map(id => {
		const entry = lock[id];
		const locked = isObj(entry) ? entry : {};
		const version = typeof locked.version === "string" && SEMVER_RE.test(locked.version) ? locked.version : undefined;
		const integrity = typeof locked.integrity === "string" ? locked.integrity : undefined;
		let stored = false;
		if (version && integrity) {
			try {
				stored = fs.readFileSync(path.join(storeDir, id, version, ".skillshare-integrity"), "utf8").trim() === integrity;
			} catch {
				stored = false;
			}
		}
		const range = str(manifest[id]);
		return { id, scope, range, version, integrity, stored };
	});
}

// ───────────────────────────── registry HTTP ─────────────────────────────

interface VersionSummary {
	version?: string;
	yanked?: boolean;
	deprecated?: string;
}
export interface Packument {
	description?: string;
	distTags?: Record<string, string>;
	versions?: Record<string, VersionSummary>;
}

interface SemverLike {
	satisfies(v: string, range: string): boolean;
	order(a: string, b: string): number;
}

/** The packument fields used here, from the registry's answer. */
export function packumentOf(raw: unknown): Packument {
	if (!isObj(raw)) throw new HelperError("omp_error", "the registry answered something that isn't a package");
	const distTags: Record<string, string> = {};
	if (isObj(raw.distTags)) for (const [tag, v] of Object.entries(raw.distTags)) if (typeof v === "string") distTags[tag] = v;
	const versions: Record<string, VersionSummary> = {};
	if (isObj(raw.versions)) {
		for (const [v, summary] of Object.entries(raw.versions)) {
			if (isObj(summary)) versions[v] = { version: v, yanked: summary.yanked === true, deprecated: str(summary.deprecated) };
		}
	}
	return { description: str(raw.description), distTags, versions };
}

/**
 * omp's `resolveSkillVersion`: an exact version → itself (even when yanked), a dist-tag → the
 * tagged version, a range → the highest non-yanked version satisfying it. `undefined` when
 * nothing matches.
 */
export function resolveRange(p: Packument, request: string, sv: SemverLike = Bun.semver): string | undefined {
	const versions = p.versions ?? {};
	const exact = EXACT_VERSION_RE.exec(request)?.[1];
	if (exact !== undefined) return Object.hasOwn(versions, exact) ? exact : undefined;
	const tagged = p.distTags?.[request];
	if (tagged !== undefined) return Object.hasOwn(versions, tagged) ? tagged : undefined;
	let best: string | undefined;
	for (const candidate of Object.keys(versions)) {
		if (versions[candidate]?.yanked) continue;
		let ok = false;
		try {
			ok = sv.satisfies(candidate, request);
		} catch {
			ok = false;
		}
		if (ok && (best === undefined || sv.order(candidate, best) > 0)) best = candidate;
	}
	return best;
}

/** What the registry says about one install: the update within its range, `latest`, notices. */
export function updateInfo(install: Installed, p: Packument, sv: SemverLike = Bun.semver): Json {
	const latest = p.distTags?.latest;
	const target = resolveRange(p, install.range ?? "latest", sv);
	const newer = target !== undefined && (install.version === undefined || sv.order(target, install.version) > 0);
	const current = install.version ? p.versions?.[install.version] : undefined;
	return {
		update: newer ? target : undefined,
		latest,
		description: clip(p.description),
		deprecated: clip(current?.deprecated),
		yanked: current?.yanked === true,
	};
}

function normalizeRegistryUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new HelperError("invalid_params", `invalid skill registry URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new HelperError("invalid_params", `skill registry URL must use http or https: ${raw}`);
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

async function registryGet(base: string, route: string, query: Record<string, string>, deadline: number): Promise<unknown> {
	const url = new URL(`${base}${route}`);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	const budget = Math.min(REGISTRY_TIMEOUT_MS, deadline - Date.now());
	if (budget <= 200) throw new HelperError("timeout", `no time left to ask ${base}`);
	let response: Response;
	try {
		response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(budget) });
	} catch (e) {
		throw new HelperError("omp_error", `cannot reach skill registry ${base}: ${message(e)}`);
	}
	if (response.status === 404) throw new HelperError("not_found", "not in the registry");
	if (!response.ok) {
		const payload: unknown = await response.json().catch(() => null);
		throw new HelperError("omp_error", isObj(payload) && typeof payload.error === "string" ? payload.error : `${response.status} ${response.statusText || "request failed"}`);
	}
	try {
		return await response.json();
	} catch {
		throw new HelperError("omp_error", `unexpected non-JSON response from ${base}`);
	}
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await run(items[i]!);
			}
		}),
	);
	return out;
}

// ───────────────────────────── skills ─────────────────────────────

/** `skill:<name>` entries of `disabledExtensions`. */
export function disabledSkillNames(disabled: readonly string[]): Set<string> {
	return new Set(disabled.filter(id => typeof id === "string" && id.startsWith("skill:")).map(id => id.slice(6)));
}

/** The `@scope/name` of a registry skill (`_source.origin` = `skillshare:@scope/name@1.2.3`). */
export function registryIdOf(origin: string | undefined): string | undefined {
	const m = /^skillshare:(@[^/@]+\/[^@]+)@/.exec(origin ?? "");
	return m?.[1];
}

export function skillRow(s: DiscoveredSkill, off: ReadonlySet<string>): Json {
	const src = s._source ?? {};
	const base = s.name.includes("/") ? s.name.slice(s.name.lastIndexOf("/") + 1) : s.name;
	return {
		name: s.name,
		description: clip(s.description) ?? "",
		path: s.filePath,
		provider: src.provider ?? "unknown",
		providerName: src.providerName || src.provider || "Unknown",
		level: src.level ?? "user",
		plugin: str(src.pluginName),
		registryId: registryIdOf(src.origin),
		enabled: !off.has(s.name) && !off.has(base),
		hidden: s.hide === true,
	};
}

/** Where omp keeps a project's registry installs (`<root>/.omp/`), if `cwd` is in a project. */
async function projectSkillsDir(helpers: DiscoveryHelpersModule, cwd: string): Promise<string | undefined> {
	const registry = await helpers.resolveOrDefaultProjectRegistryPath(cwd);
	// `<root>/.omp/plugins/installed_plugins.json` → `<root>/.omp`
	return registry ? path.dirname(path.dirname(registry)) : undefined;
}

async function skills(pi: Json, version: string, cwd: string, req: Json, deadline: number): Promise<Json> {
	const [es, sk, helpers] = await Promise.all([extSettingsModule(version), skillsModule(version), helpersModule(version)]);
	const settings = await settingsOf(pi, version);
	let skillsSettings = es.cfgSkills.get(settings);
	if (skillsSettings.customDirectories?.length) {
		// As `omp skill list` does: `~` is the home dir, relative entries are relative to the folder.
		skillsSettings = {
			...skillsSettings,
			customDirectories: skillsSettings.customDirectories.map(dir => {
				const expanded = expandTilde(dir);
				return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
			}),
		};
	}
	const extensionRoots = { explicit: [], mode: "merge", configured: es.cfgExtensions.get(settings), configuredLevel: settings.extensionsSourceLevel?.() ?? "user" };
	// Everything a session would load if nothing were switched off; the switches decide `enabled`.
	const loaded = await sk.loadSkills({ ...skillsSettings, cwd, disabledExtensions: [], extensionRoots });
	const off = disabledSkillNames(es.cfgDisabledExtensions.get(settings));
	const warnings = loaded.warnings.map(w => clip(w.message, 400) ?? "").filter(Boolean);

	const agentDir = str(req.agentDir);
	if (!agentDir) throw new HelperError("invalid_params", "agentDir missing");
	const storeDir = path.join(path.dirname(agentDir), "skillshare");
	const installs = readInstalls(agentDir, "user", storeDir, warnings);
	if (req.project === true) {
		const dir = await projectSkillsDir(helpers, cwd).catch(() => undefined);
		if (dir && path.resolve(dir) !== path.resolve(agentDir)) installs.push(...readInstalls(dir, "project", storeDir, warnings));
	}
	const registryUrl = normalizeRegistryUrl(es.cfgSkillsRegistryUrl?.get(settings) || DEFAULT_REGISTRY);
	const registry: Json[] = installs.map(i => ({ id: i.id, scope: i.scope, range: i.range, version: i.version, stored: i.stored, yanked: false }));
	let updatesCheckedAt: number | undefined;
	if (req.updates === true) {
		const infos = await inBatches(installs, REGISTRY_PARALLEL, async i => {
			try {
				const m = SKILL_ID_RE.exec(i.id)!;
				const p = packumentOf(await registryGet(registryUrl, `/api/v1/skills/@${m[1]}/${m[2]}`, {}, deadline));
				return updateInfo(i, p);
			} catch (e) {
				return { updateError: clip(message(e), 300) };
			}
		});
		infos.forEach((info, n) => Object.assign(registry[n]!, info));
		// Also with nothing installed: "checked just now" is the answer then.
		updatesCheckedAt = Date.now();
	}
	return {
		skills: loaded.skills.map(s => skillRow(s, off)),
		registry,
		warnings: warnings.slice(0, MAX_WARNINGS),
		registryUrl,
		updatesCheckedAt,
	};
}

export function searchHit(h: Json, installed: ReadonlyMap<string, string>): Json | undefined {
	const scope = str(h.scope);
	const name = str(h.name);
	if (!scope || !name) return undefined;
	const id = `@${scope}/${name}`;
	const publisher = isObj(h.publisher) ? h.publisher : {};
	return {
		id,
		description: clip(h.description) ?? "",
		version: str(h.version) ?? "",
		publisher: str(publisher.username) ?? scope,
		keywords: Array.isArray(h.keywords) ? h.keywords.filter(k => typeof k === "string").slice(0, 12) : [],
		updatedAt: typeof h.updatedAt === "number" ? h.updatedAt : 0,
		weeklyDownloads: typeof h.weeklyDownloads === "number" ? h.weeklyDownloads : 0,
		deprecated: clip(h.deprecated),
		installed: installed.get(id),
	};
}

async function search(pi: Json, version: string, cwd: string, req: Json, deadline: number): Promise<Json> {
	const [es, helpers] = await Promise.all([extSettingsModule(version), helpersModule(version)]);
	const settings = await settingsOf(pi, version);
	const query = str(req.query);
	if (!query) throw new HelperError("invalid_params", "query: type something to search for");
	const registryUrl = normalizeRegistryUrl(es.cfgSkillsRegistryUrl?.get(settings) || DEFAULT_REGISTRY);
	const q: Record<string, string> = { q: query };
	if (str(req.sort)) q.sort = String(req.sort);
	if (typeof req.page === "number" && req.page > 1) q.page = String(Math.floor(req.page));
	const raw = await registryGet(registryUrl, "/api/v1/search", q, deadline);
	const answer = isObj(raw) ? raw : {};
	const warnings: string[] = [];
	const installed = new Map<string, string>();
	const agentDir = str(req.agentDir);
	if (agentDir) {
		const storeDir = path.join(path.dirname(agentDir), "skillshare");
		for (const i of readInstalls(agentDir, "user", storeDir, warnings)) installed.set(i.id, "user");
		if (req.project === true) {
			const dir = await projectSkillsDir(helpers, cwd).catch(() => undefined);
			if (dir && path.resolve(dir) !== path.resolve(agentDir)) for (const i of readInstalls(dir, "project", storeDir, warnings)) installed.set(i.id, "project");
		}
	}
	const hits = Array.isArray(answer.hits) ? answer.hits : [];
	return {
		total: typeof answer.total === "number" ? answer.total : hits.length,
		page: typeof answer.page === "number" ? answer.page : 1,
		perPage: typeof answer.perPage === "number" ? answer.perPage : hits.length,
		hits: hits.flatMap(h => {
			const hit = isObj(h) ? searchHit(h, installed) : undefined;
			return hit ? [hit] : [];
		}),
		registryUrl,
	};
}

// ───────────────────────────── plugins ─────────────────────────────

const PACKAGE_KINDS: [keyof PluginManifestLike, string][] = [
	["extensions", "extensions"],
	["tools", "tools"],
	["hooks", "hooks"],
	["commands", "commands"],
];

/** The package's own `description` (package.json), which `omp plugin list` shows when the manifest has none. */
function packageDescription(dir: string): string | undefined {
	try {
		const pkg = readJson(path.join(dir, "package.json"));
		return isObj(pkg) ? clip(pkg.description) : undefined;
	} catch {
		return undefined;
	}
}

export function packageRow(p: PackagePluginLike): Json {
	const m = p.manifest ?? {};
	const provides = PACKAGE_KINDS.filter(([k]) => {
		const v = m[k];
		return Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.length > 0;
	}).map(([, label]) => label);
	let linked = false;
	try {
		linked = fs.lstatSync(p.path).isSymbolicLink() || fs.realpathSync(p.path) !== path.resolve(p.path);
	} catch {
		linked = false;
	}
	const features = Object.entries(m.features ?? {}).map(([name, f]) => ({
		name,
		description: clip(f?.description, 200),
		enabled: p.enabledFeatures === null ? f?.default === true : p.enabledFeatures.includes(name),
	}));
	const description = clip(m.description) ?? packageDescription(p.path);
	return { name: p.name, version: p.version, description, enabled: p.enabled !== false, path: p.path, linked, provides, features };
}

const CATALOG_KINDS = ["commands", "agents", "hooks", "mcpServers", "lspServers"] as const;

/** What a catalog entry says its plugin brings. */
export function catalogProvides(e: CatalogEntryLike): string[] {
	return CATALOG_KINDS.filter(k => e[k] !== undefined && e[k] !== null);
}

/** What an installed Claude-format plugin folder brings (its layout). */
export function installedProvides(dir: string | undefined): string[] {
	if (!dir) return [];
	const has = (p: string) => {
		try {
			fs.statSync(path.join(dir, p));
			return true;
		} catch {
			return false;
		}
	};
	const out: string[] = [];
	if (has("skills")) out.push("skills");
	if (has("commands")) out.push("commands");
	if (has("agents")) out.push("agents");
	if (has("hooks/hooks.json")) out.push("hooks");
	if (has(".mcp.json")) out.push("mcpServers");
	if (has(".lsp.json")) out.push("lspServers");
	return out;
}

function splitId(id: string): { name: string; marketplace: string } {
	const at = id.lastIndexOf("@");
	return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

async function marketplaceManager(P: PluginsModule, helpers: DiscoveryHelpersModule, cwd: string, project: boolean): Promise<MarketplaceManagerLike> {
	const projectInstalledRegistryPath = project ? await helpers.resolveOrDefaultProjectRegistryPath(cwd).catch(() => undefined) : undefined;
	return new P.MarketplaceManager({
		marketplacesRegistryPath: P.getMarketplacesRegistryPath(),
		installedRegistryPath: P.getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath,
		marketplacesCacheDir: P.getMarketplacesCacheDir(),
		pluginsCacheDir: P.getPluginsCacheDir(),
	});
}

async function marketplaceRows(P: PluginsModule, entries: MarketplaceEntryLike[]): Promise<{ rows: Json[]; catalogs: Map<string, CatalogLike> }> {
	const catalogs = new Map<string, CatalogLike>();
	const rows = entries.map(m => {
		const row: Json = { name: m.name, sourceType: m.sourceType, source: m.sourceUri, updatedAt: str(m.updatedAt), plugins: 0 };
		try {
			const file = path.resolve(expandTilde(m.catalogPath));
			const catalog = P.parseMarketplaceCatalog(fs.readFileSync(file, "utf8"), file);
			catalogs.set(m.name, catalog);
			row.plugins = catalog.plugins.length;
			row.description = clip(catalog.metadata?.description);
			row.owner = str(catalog.owner?.name);
		} catch (e) {
			row.error = clip(message(e), 300);
		}
		return row;
	});
	return { rows, catalogs };
}

async function plugins(pi: Json, version: string, cwd: string, req: Json): Promise<Json> {
	const [P, helpers] = await Promise.all([pluginsModule(version), helpersModule(version)]);
	const project = req.project === true;
	const warnings: string[] = [];
	const npm = new P.PluginManager(cwd);
	const packages = await npm.list().catch(e => {
		warnings.push(`package plugins: ${message(e)}`);
		return [] as PackagePluginLike[];
	});
	const mkt = await marketplaceManager(P, helpers, cwd, project);
	const [installed, marketplaces, updates] = await Promise.all([
		mkt.listInstalledPlugins().catch(e => {
			warnings.push(`marketplace plugins: ${message(e)}`);
			return [] as InstalledSummaryLike[];
		}),
		mkt.listMarketplaces().catch(e => {
			warnings.push(`marketplaces: ${message(e)}`);
			return [] as MarketplaceEntryLike[];
		}),
		mkt.checkForUpdates().catch(() => []),
	]);
	const { rows, catalogs } = await marketplaceRows(P, marketplaces);
	const marketplace = installed.map(s => {
		const entry = s.entries[0];
		const { name, marketplace: market } = splitId(s.id);
		const info = catalogs.get(market)?.plugins.find(p => p.name === name);
		const update = updates.find(u => u.pluginId === s.id && u.scope === s.scope)?.to;
		return {
			id: s.id,
			name,
			marketplace: market,
			scope: s.scope,
			version: entry?.version ?? "?",
			enabled: entry?.enabled !== false,
			shadowed: s.shadowedBy !== undefined,
			description: clip(info?.description),
			update,
			path: entry?.installPath,
			updatedAt: str(entry?.lastUpdated),
			homepage: str(info?.homepage) ?? str(info?.repository),
			provides: installedProvides(entry?.installPath),
		};
	});
	return { packages: packages.map(packageRow), marketplace, marketplaces: rows, warnings: warnings.slice(0, MAX_WARNINGS) };
}

export function catalogRow(e: CatalogEntryLike, marketplace: string, installedScopes: readonly string[]): Json {
	const id = `${e.name}@${marketplace}`;
	const keywords = [...(Array.isArray(e.keywords) ? e.keywords : []), ...(Array.isArray(e.tags) ? e.tags : [])].filter(k => typeof k === "string");
	return {
		id,
		name: e.name,
		marketplace,
		description: clip(e.description),
		version: str(e.version),
		author: str(e.author?.name),
		category: str(e.category),
		keywords: [...new Set(keywords)].slice(0, 12),
		homepage: str(e.homepage) ?? str(e.repository),
		provides: catalogProvides(e),
		installed: [...installedScopes],
	};
}

async function catalog(pi: Json, version: string, cwd: string, req: Json): Promise<Json> {
	const [P, helpers] = await Promise.all([pluginsModule(version), helpersModule(version)]);
	const mkt = await marketplaceManager(P, helpers, cwd, req.project === true);
	const only = str(req.marketplace);
	const all = await mkt.listMarketplaces();
	const entries = only ? all.filter(m => m.name === only) : all;
	if (only && entries.length === 0) throw new HelperError("not_found", `no marketplace named “${only}”`);
	const installedScopes = new Map<string, string[]>();
	for (const s of await mkt.listInstalledPlugins().catch(() => [] as InstalledSummaryLike[])) {
		installedScopes.set(s.id, [...(installedScopes.get(s.id) ?? []), s.scope]);
	}
	const { rows, catalogs } = await marketplaceRows(P, entries);
	const pluginsOut: Json[] = [];
	for (const m of entries) {
		const c = catalogs.get(m.name);
		for (const e of c?.plugins ?? []) pluginsOut.push(catalogRow(e, m.name, installedScopes.get(`${e.name}@${m.name}`) ?? []));
	}
	return { plugins: pluginsOut, marketplaces: rows };
}

export default async function teleflockPlugins(api: Json) {
	const inPath = process.env.TF_PLUGINS_IN;
	const out = process.env.TF_PLUGINS_OUT;
	if (!inPath || !out) return; // loaded any other way: do nothing
	const emit = emitTo(out);
	const pi = isObj(api.pi) ? api.pi : {};
	const version = String(pi.VERSION ?? "?");
	let code = 0;
	try {
		emit({ t: "hello", helperVersion: HELPER_VERSION, ompVersion: version, cwd: process.cwd() });
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(inPath, "utf8"));
		} finally {
			fs.rmSync(inPath, { force: true });
		}
		if (!isObj(parsed)) throw new HelperError("invalid_params", "the request is not a JSON object");
		const req = parsed;
		const cwd = process.cwd();
		const deadline = Number(req.deadlineAt) > 0 ? Number(req.deadlineAt) : Date.now() + DEFAULT_BUDGET_MS;
		let result: Json;
		switch (req.op) {
			case "skills":
				result = await skills(pi, version, cwd, req, deadline);
				break;
			case "search":
				result = await search(pi, version, cwd, req, deadline);
				break;
			case "plugins":
				result = await plugins(pi, version, cwd, req);
				break;
			case "catalog":
				result = await catalog(pi, version, cwd, req);
				break;
			default:
				throw new HelperError("invalid_params", `unknown op ${String(req.op)}`);
		}
		emit({ t: "result", ...result });
	} catch (e) {
		code = 1;
		emit({ t: "error", code: e instanceof HelperError ? e.code : "omp_error", message: clip(message(e), 2000) ?? "failed" });
	}
	// omp refuses process.exit while it loads extensions: exit right after (tf-hostd also kills it).
	setTimeout(() => process.exit(code), 0);
}
