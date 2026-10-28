/**
 * TeleFlock MCP helper: an omp extension that tf-hostd runs in a throwaway headless omp
 * (`omp --mode rpc --no-session --no-extensions -e <home>/ext/teleflock-mcp.ts`, cwd = the folder
 * the answer is about) to look at MCP servers with omp's own code: discovery (every config source
 * omp reads), connecting the way a session does (auth, env expansion, `!command` values), OAuth
 * sign-in (`/mcp reauth` engine), sign-out (`/mcp unauth`), and the Smithery registry search.
 *
 * Embedded in tf-hostd (`crates/tf-hostd/src/ops/mcp/helper.rs`) and written next to the companion
 * extension; architecture §3.15 has the protocol:
 *
 *   TF_MCP_IN     request JSON `{v: 1, op, …}` (owner-only; deleted as soon as it is read)
 *   TF_MCP_OUT    JSON lines appended by this helper: `hello`, progress events, then exactly one
 *                 `result` or `error` line, after which the process exits
 *   TF_MCP_INPUT  `auth` only: where tf-hostd drops a pasted redirect address / code
 *
 * Everything runs inside the extension factory (omp waits for it), so the process needs no model,
 * session or stdin. omp internals are imported dynamically and feature-checked: an omp without one
 * answers `unsupported` instead of breaking. Nothing here writes to stdout/stderr.
 */
import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const HELPER_VERSION = "1.0.0";
/** Tool descriptions are clipped: the app shows one or two lines. */
const MAX_DESCRIPTION = 400;
const MAX_TOOLS = 500;

type Json = Record<string, unknown>;
type Line = { t: string } & Json;

// Structural views of the omp internals used here (no type imports: older builds may lack them).
interface ManagerLike {
	setAuthStorage(s: unknown): void;
	discoverAndConnect(o?: Json): Promise<unknown>;
	waitForStartup(ms: number): Promise<{ connected: string[]; pending: string[]; failed: { name: string; error: string }[] }>;
	getConnection(name: string): { serverInfo?: { name?: string; version?: string } } | undefined;
	getTools(): { name: string; description?: string; mcpServerName?: string; mcpToolName?: string }[];
	disconnectAll(): Promise<void>;
}
interface SourceMeta {
	provider: string;
	providerName?: string;
	path?: string;
	level?: string;
}
type ServerConfig = Json & { type?: string; url?: string; command?: string; enabled?: boolean; auth?: Json };

class HelperError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const emitTo = (out: string) => (line: Line) => {
	try {
		fs.appendFileSync(out, `${JSON.stringify(line)}\n`, { mode: 0o600 });
	} catch {
		/* tf-hostd times out instead */
	}
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function clip(s: string | undefined, max: number): string | undefined {
	if (!s) return undefined;
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** `import()` an omp module by literal name (omp's loader maps only literal specifiers). */
async function need<T>(load: () => Promise<unknown>, what: string, version: string): Promise<T> {
	try {
		return (await load()) as T;
	} catch (e) {
		throw new HelperError("unsupported", `omp ${version} lacks ${what} (${message(e)}): update omp`);
	}
}

const mcpManagerModule = (v: string) =>
	need<{ MCPManager: new (cwd: string, cache: unknown, loader: unknown) => ManagerLike }>(
		() => import("@oh-my-pi/pi-coding-agent/mcp/manager"),
		"mcp/manager",
		v,
	);
const mcpConfigModule = (v: string) =>
	need<{
		loadAllMCPConfigs(cwd: string, o?: Json): Promise<{ configs: Record<string, ServerConfig>; sources: Record<string, SourceMeta> }>;
		filterExaMCPServers(c: Record<string, ServerConfig>, s: Record<string, SourceMeta>): { configs: Record<string, ServerConfig> };
		filterBrowserMCPServers(c: Record<string, ServerConfig>, s: Record<string, SourceMeta>): { configs: Record<string, ServerConfig> };
	}>(() => import("@oh-my-pi/pi-coding-agent/mcp/config"), "mcp/config", v);
const writerModule = (v: string) =>
	need<{ readMCPConfigFile(p: string): Promise<Json>; updateMCPServer(p: string, n: string, c: Json): Promise<void> }>(
		() => import("@oh-my-pi/pi-coding-agent/mcp/config-writer"),
		"mcp/config-writer",
		v,
	);
const reauthModule = (v: string) =>
	need<{
		findMcpServerForAuth(n: string, cwd: string, m?: unknown, o?: Json): Promise<{ filePath: string; scope: string; config: ServerConfig } | null>;
		reauthorizeMcpServer(n: string, f: unknown, o: Json): Promise<{ persisted: boolean; credentialId: string }>;
		stripMcpOAuthAuth(c: ServerConfig): ServerConfig;
		McpReauthRefusalError?: new (...a: never[]) => Error;
		MCPOAuthCancelledError?: new (...a: never[]) => Error;
	}>(() => import("@oh-my-pi/pi-coding-agent/mcp/oauth-reauth"), "mcp/oauth-reauth", v);
const credentialsModule = (v: string) =>
	need<{
		lookupMcpOAuthCredentialForServer(s: unknown, auth: unknown, url?: string): { credential?: unknown } | undefined;
		removeManagedMcpOAuthCredential(s: unknown, id?: string): Promise<unknown>;
		removeManagedMcpOAuthCredentials(s: unknown, ids: string[]): Promise<boolean>;
		mcpOAuthCredentialIdsForServerUrl(url: string): string[];
	}>(() => import("@oh-my-pi/pi-coding-agent/mcp/oauth-credentials"), "mcp/oauth-credentials", v);

/** omp's `mcp.enableProjectConfig` (default on). */
async function projectConfigEnabled(pi: Json): Promise<boolean> {
	try {
		const mod = (await import("@oh-my-pi/pi-coding-agent/mcp/settings")) as { cfgMcpEnableProjectConfig?: { get(s: unknown): unknown } };
		const settings = (pi.Settings as { instance?: unknown } | undefined)?.instance;
		const v = settings ? mod.cfgMcpEnableProjectConfig?.get(settings) : undefined;
		return v !== false;
	} catch {
		return true;
	}
}

/** omp's own reading of an auth failure: `oauth` (sign in), `apikey` (needs a key), else undefined. */
async function authKind(error: string, url: string | undefined): Promise<string | undefined> {
	try {
		const mod = (await import("@oh-my-pi/pi-coding-agent/mcp/oauth-discovery")) as {
			analyzeAuthError?(e: Error, url?: string): { requiresAuth?: boolean; authType?: string };
		};
		const r = mod.analyzeAuthError?.(new Error(error), url);
		if (r?.requiresAuth) return r.authType ?? "unknown";
	} catch {
		/* fall back to the message */
	}
	return /\b401\b|unauthori[sz]ed|invalid[_ ]token|authenticat|www-authenticate/i.test(error) ? "unknown" : undefined;
}

function toolsOf(manager: ManagerLike, name: string): { name: string; description?: string }[] {
	return manager
		.getTools()
		.filter(t => t.mcpServerName === name)
		.slice(0, MAX_TOOLS)
		.map(t => ({ name: t.mcpToolName ?? t.name, description: clip(t.description, MAX_DESCRIPTION) }));
}

function serverInfoOf(manager: ManagerLike, name: string): { name: string; version?: string } | undefined {
	const info = manager.getConnection(name)?.serverInfo;
	return info?.name ? { name: info.name, version: info.version || undefined } : undefined;
}

const urlOf = (c: ServerConfig | undefined): string | undefined => (typeof c?.url === "string" ? c.url : undefined);

/** Connects `configs` in a manager of its own (omp's session code path) and reports each. */
async function connectAll(
	pi: Json,
	version: string,
	cwd: string,
	configs: Record<string, ServerConfig>,
	sources: Record<string, SourceMeta>,
	timeoutMs: number,
): Promise<Record<string, Json>> {
	const out: Record<string, Json> = {};
	const names = Object.keys(configs);
	if (names.length === 0) return out;
	const { MCPManager } = await mcpManagerModule(version);
	const manager = new MCPManager(cwd, null, async () => ({ configs, sources, exaApiKeys: [] }));
	manager.setAuthStorage(await authStorage(pi));
	try {
		await manager.discoverAndConnect({ startupTimeoutMs: 0, filterExa: false, filterBrowser: false });
		const status = await manager.waitForStartup(timeoutMs);
		const failed = new Map(status.failed.map(f => [f.name, f.error]));
		for (const name of names) {
			if (status.connected.includes(name)) {
				out[name] = { status: "connected", tools: toolsOf(manager, name), serverInfo: serverInfoOf(manager, name) };
			} else if (failed.has(name)) {
				const error = failed.get(name) ?? "failed";
				const auth = await authKind(error, urlOf(configs[name]));
				out[name] = { status: auth ? "needsAuth" : "failed", error: clip(error, 2000), authType: auth };
			} else {
				out[name] = { status: "pending" };
			}
		}
	} finally {
		await Promise.race([manager.disconnectAll().catch(() => {}), sleep(3000)]);
	}
	return out;
}

let authStorageValue: unknown;
async function authStorage(pi: Json): Promise<unknown> {
	if (authStorageValue) return authStorageValue;
	const discover = pi.discoverAuthStorage as (() => Promise<unknown>) | undefined;
	if (typeof discover !== "function") throw new HelperError("unsupported", "this omp does not expose discoverAuthStorage: update omp");
	authStorageValue = await discover();
	return authStorageValue;
}

async function signedIn(pi: Json, version: string, config: ServerConfig | undefined): Promise<boolean> {
	const url = urlOf(config);
	if (!url) return false;
	if (config?.auth && (config.auth as Json).type === "oauth") return true;
	try {
		const creds = await credentialsModule(version);
		return !!creds.lookupMcpOAuthCredentialForServer(await authStorage(pi), config?.auth, url)?.credential;
	} catch {
		return false;
	}
}

/** Every server omp would see from `cwd`, with session status. `only`: connect just these. */
async function probe(pi: Json, version: string, cwd: string, req: Json): Promise<Json> {
	const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 20_000, 1000), 60_000);
	const only = Array.isArray(req.only) ? new Set(req.only.map(String)) : undefined;
	const enableProject = await projectConfigEnabled(pi);
	const cfg = await mcpConfigModule(version);
	const writer = await writerModule(version);

	// Inventory: every definition from every source, disabled and shadowed ones included.
	let inventory: { name: string; enabled?: boolean; _source: SourceMeta; _shadowed?: boolean; config: ServerConfig }[] = [];
	try {
		const disc = (await import("@oh-my-pi/pi-coding-agent/discovery")) as { loadCapability(id: string, o: Json): Promise<{ all: Json[] }> };
		const cap = (await import("@oh-my-pi/pi-coding-agent/capability/mcp")) as { mcpCapability: { id: string } };
		const res = await disc.loadCapability(cap.mcpCapability.id, { cwd });
		inventory = res.all.map(item => {
			const { _source, _shadowed, name, transport, ...rest } = item as Json & { _source: SourceMeta; _shadowed?: boolean; name: string; transport?: string };
			const config: ServerConfig = { ...rest, type: transport ?? (rest.command ? "stdio" : rest.url ? "http" : "stdio") };
			return { name, enabled: rest.enabled as boolean | undefined, _source, _shadowed, config };
		});
	} catch {
		// Older omp: what loadAllMCPConfigs returns (enabled, deduplicated servers only).
		const loaded = await cfg.loadAllMCPConfigs(cwd, { filterExa: false, enableProjectConfig: true });
		inventory = Object.entries(loaded.configs).map(([name, config]) => ({ name, enabled: config.enabled, _source: loaded.sources[name] ?? { provider: "unknown" }, config }));
	}

	const userFile = (pi.getMCPConfigPath as ((s: string, cwd: string) => string) | undefined)?.("user", cwd);
	let denied = new Set<string>();
	let forced = new Set<string>();
	if (userFile) {
		try {
			const user = await writer.readMCPConfigFile(userFile);
			denied = new Set(Array.isArray(user.disabledServers) ? user.disabledServers.map(String) : []);
			forced = new Set(Array.isArray(user.enabledServers) ? user.enabledServers.map(String) : []);
		} catch {
			/* omp ignores an unreadable user file for the lists too */
		}
	}

	// What sessions load: omp's loader with its own filters.
	const loaded = await cfg.loadAllMCPConfigs(cwd, { filterExa: false, enableProjectConfig: enableProject });
	const kept = cfg.filterExaMCPServers(loaded.configs, loaded.sources).configs;
	const browserKept = cfg.filterBrowserMCPServers(kept, loaded.sources).configs;
	const toConnect: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(kept)) if (!only || only.has(name)) toConnect[name] = config;
	const results = await connectAll(pi, version, cwd, toConnect, loaded.sources, timeoutMs);

	const servers: Json[] = [];
	for (const item of inventory) {
		const name = item.name;
		const src = item._source;
		const disabled = denied.has(name) || (item.enabled === false && !forced.has(name));
		const projectOff = !enableProject && src.level === "project";
		const live = loaded.configs[name];
		// The definition sessions use for this name is this item unless it is shadowed.
		const mine = !item._shadowed;
		let status: Json;
		if (disabled) status = { status: "disabled" };
		else if (item._shadowed) status = { status: "notLoaded" };
		else if (projectOff) status = { status: "skipped", note: "Project MCP configs are switched off in omp (mcp.enableProjectConfig)." };
		else if (live && !kept[name]) status = { status: "skipped", note: "omp uses its built-in Exa search instead (with this server's API key)." };
		else if (results[name]) status = results[name];
		else if (only && kept[name]) status = { status: "unchanged" };
		else status = { status: "notLoaded" };
		if (mine && live && kept[name] && !browserKept[name]) {
			status.note = "omp skips browser automation servers while its own browser tool is on.";
		}
		servers.push({
			name,
			provider: src.provider,
			providerName: src.providerName,
			path: src.path,
			level: src.level,
			enabled: !disabled,
			shadowed: !!item._shadowed,
			signedIn: await signedIn(pi, version, item.config),
			// omp's own definitions are read by tf-hostd from the file; others are shown from here.
			config: src.provider === "native" ? undefined : item.config,
			...status,
		});
	}
	return { servers };
}

async function test(pi: Json, version: string, cwd: string, req: Json): Promise<Json> {
	const name = String(req.name ?? "");
	const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 20_000, 1000), 60_000);
	let config: ServerConfig | undefined;
	let source: SourceMeta = { provider: "native", providerName: "TeleFlock test", path: "", level: "user" };
	if (req.config && typeof req.config === "object") {
		let raw = req.config as ServerConfig;
		try {
			const helpers = (await import("@oh-my-pi/pi-coding-agent/discovery/helpers")) as { expandEnvVarsDeep?<T>(o: T): T };
			if (helpers.expandEnvVarsDeep) raw = helpers.expandEnvVarsDeep(raw);
		} catch {
			/* unexpanded: `${VAR}` stays literal */
		}
		config = { ...raw, type: raw.type ?? (raw.command ? "stdio" : raw.url ? "http" : "stdio") };
	} else {
		const cfg = await mcpConfigModule(version);
		const loaded = await cfg.loadAllMCPConfigs(cwd, { filterExa: false });
		config = loaded.configs[name];
		if (loaded.sources[name]) source = loaded.sources[name];
		if (!config) throw new HelperError("not_found", `omp doesn't load a server named “${name}” here (missing or switched off)`);
	}
	const started = Date.now();
	const res = (await connectAll(pi, version, cwd, { [name]: config }, { [name]: source }, timeoutMs))[name] ?? { status: "failed", error: "no result" };
	return { ...res, ms: Date.now() - started };
}

/** Waits for tf-hostd to drop pasted input at `path` (deleted once read). */
function pastedInput(path: string | undefined, signal: AbortSignal): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	if (!path) return promise; // never resolves: the callback server or a timeout ends the flow
	const tick = setInterval(() => {
		try {
			const text = fs.readFileSync(path, "utf8");
			fs.rmSync(path, { force: true });
			clearInterval(tick);
			resolve(text.trim());
		} catch {
			/* not there yet */
		}
	}, 200);
	signal.addEventListener(
		"abort",
		() => {
			clearInterval(tick);
			reject(new Error("aborted"));
		},
		{ once: true },
	);
	return promise;
}

async function auth(pi: Json, version: string, cwd: string, req: Json, emit: (l: Line) => void): Promise<Json> {
	const name = String(req.name ?? "");
	const mod = await reauthModule(version);
	const found = await mod.findMcpServerForAuth(name, cwd, undefined, { enableProjectConfig: await projectConfigEnabled(pi) });
	if (!found) throw new HelperError("not_found", `no MCP server named “${name}” in omp's config here`);
	const abort = new AbortController();
	try {
		const outcome = await mod.reauthorizeMcpServer(name, found, {
			authStorage: await authStorage(pi),
			cwd,
			signal: abort.signal,
			onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) =>
				emit({ t: "auth", url: info.url, launchUrl: info.launchUrl, instructions: info.instructions }),
			onProgress: (msg: string) => emit({ t: "progress", message: clip(msg, 300) }),
			onManualCodeInput: (signal: AbortSignal) => pastedInput(process.env.TF_MCP_INPUT, signal),
		});
		return { persisted: outcome.persisted, scope: found.scope, path: found.filePath };
	} catch (e) {
		if (mod.MCPOAuthCancelledError && e instanceof mod.MCPOAuthCancelledError) throw new HelperError("cancelled", "Sign-in cancelled");
		if (mod.McpReauthRefusalError && e instanceof mod.McpReauthRefusalError) throw new HelperError("refused", message(e));
		throw e;
	} finally {
		abort.abort();
	}
}

async function unauth(pi: Json, version: string, cwd: string, req: Json): Promise<Json> {
	const name = String(req.name ?? "");
	const mod = await reauthModule(version);
	const creds = await credentialsModule(version);
	const writer = await writerModule(version);
	const found = await mod.findMcpServerForAuth(name, cwd, undefined, { enableProjectConfig: await projectConfigEnabled(pi) });
	if (!found) throw new HelperError("not_found", `no MCP server named “${name}” in omp's config here`);
	const storage = await authStorage(pi);
	const current = found.config.auth as { type?: string; credentialId?: string } | undefined;
	let removed = false;
	if (current?.type === "oauth") {
		await creds.removeManagedMcpOAuthCredential(storage, current.credentialId);
		removed = true;
	}
	const url = urlOf(found.config);
	if (url && (found.config.type === "http" || found.config.type === "sse")) {
		removed = (await creds.removeManagedMcpOAuthCredentials(storage, creds.mcpOAuthCredentialIdsForServerUrl(url))) || removed;
	}
	if (current) await writer.updateMCPServer(found.filePath, name, mod.stripMcpOAuthAuth(found.config));
	return { removed: removed || !!current, scope: found.scope };
}

async function search(version: string, req: Json): Promise<Json> {
	const query = String(req.query ?? "").trim();
	const limit = Math.min(Math.max(Number(req.limit) || 12, 1), 30);
	const reg = await need<{ searchSmitheryRegistry(q: string, o: Json): Promise<Json[]> }>(
		() => import("@oh-my-pi/pi-coding-agent/mcp/smithery-registry"),
		"mcp/smithery-registry",
		version,
	);
	let apiKey: string | undefined;
	try {
		const authMod = (await import("@oh-my-pi/pi-coding-agent/mcp/smithery-auth")) as { getSmitheryApiKey?(): Promise<string | undefined> | string | undefined };
		apiKey = (await authMod.getSmitheryApiKey?.()) || undefined;
	} catch {
		/* the registry answers without a key */
	}
	const results = await reg.searchSmitheryRegistry(query, { limit, apiKey });
	return {
		entries: results.map(r => {
			const d = (r.display ?? {}) as Json;
			return {
				id: r.id,
				name: r.name,
				title: d.displayName ?? r.title ?? r.name,
				description: clip((r.description as string) ?? (d.description as string), 600),
				useCount: d.useCount ?? r.useCount ?? 0,
				verified: d.verified === true,
				remote: r.sourceType === "remote",
				homepage: d.homepage,
				config: r.config,
				inputs: r.requiredInputs ?? [],
				warnings: r.warnings ?? [],
				tools: Array.isArray(d.tools) ? (d.tools as Json[]).slice(0, MAX_TOOLS).map(t => ({ name: t.name, description: clip(t.description as string, MAX_DESCRIPTION) })) : [],
			};
		}),
	};
}

export default async function teleflockMcp(api: Json & { pi?: Json }) {
	const inPath = process.env.TF_MCP_IN;
	const out = process.env.TF_MCP_OUT;
	if (!inPath || !out) return; // loaded any other way: do nothing
	const emit = emitTo(out);
	const pi = (api.pi ?? {}) as Json;
	const version = String(pi.VERSION ?? "?");
	let code = 0;
	try {
		emit({ t: "hello", helperVersion: HELPER_VERSION, ompVersion: version, cwd: process.cwd() });
		let req: Json;
		try {
			req = JSON.parse(fs.readFileSync(inPath, "utf8")) as Json;
		} finally {
			fs.rmSync(inPath, { force: true });
		}
		const cwd = process.cwd();
		let result: Json;
		switch (req.op) {
			case "probe":
				result = await probe(pi, version, cwd, req);
				break;
			case "test":
				result = await test(pi, version, cwd, req);
				break;
			case "auth":
				result = await auth(pi, version, cwd, req, emit);
				break;
			case "unauth":
				result = await unauth(pi, version, cwd, req);
				break;
			case "search":
				result = await search(version, req);
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
