// Tests for the bridge's 2.3.0 TeleFlock Browser (docs/bridge-protocol.md "TeleFlock Browser"): the
// runtime override of omp's `browser.cdpUrl` (relay off meanwhile, what it replaced put back), the
// end of an "Allow once" override with the turn, the `use_user_browser` request and its answers,
// and the whole extension against a fake hostd with a fake omp whose root exports carry its live
// Settings and browser setting handles.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, {
	applyBrowserOverride,
	BROWSER_ONCE_ENDED,
	type BrowserOutcome,
	BrowserLink,
	type BrowserSettings,
	browserToolText,
	clearBrowserOverride,
	isLoopbackCdp,
	registerBrowserTool,
} from "./teleflock-bridge";

type Json = Record<string, unknown>;
const SLOT = Symbol.for("teleflock.bridge");
const URL_A = "http://127.0.0.1:45123";
const URL_B = "http://127.0.0.1:45999";

/** One omp setting: what the configs say, and the session's runtime override above them. */
function fakeHandle<T>(store: object, configured: T | undefined) {
	const h = {
		configured,
		runtime: undefined as T | undefined,
		get(s: unknown): T | undefined {
			if (s !== store) throw new Error("not omp's Settings");
			return h.runtime ?? h.configured;
		},
		override(s: unknown, value: T) {
			if (s !== store) throw new Error("not omp's Settings");
			h.runtime = value;
		},
		clearOverride(s: unknown) {
			if (s !== store) throw new Error("not omp's Settings");
			h.runtime = undefined;
		},
		provenance: () => (h.runtime !== undefined ? "runtime" : h.configured !== undefined ? "global" : "default"),
	};
	return h;
}

/** omp's live Settings with its `browser.cdpUrl` / `browser.relay` / `browser.enabled` handles. */
function fakeBrowserSettings(init: { cdpUrl?: string; relay?: boolean; enabled?: boolean } = {}) {
	const store = { name: "Settings.instance" };
	const cdpUrl = fakeHandle<string | undefined>(store, init.cdpUrl);
	const relay = fakeHandle<boolean>(store, init.relay ?? false);
	const enabled = fakeHandle<boolean>(store, init.enabled ?? true);
	const settings: BrowserSettings = { store: () => store, cdpUrl, relay, enabled };
	return { store, cdpUrl, relay, enabled, settings };
}

function link(opts: { linked?: boolean; settings?: BrowserSettings | undefined; env?: Record<string, string | undefined> } = {}) {
	const events: Array<[string, Json]> = [];
	const notes: string[] = [];
	const state = { linked: opts.linked ?? true };
	const b = "settings" in opts ? undefined : fakeBrowserSettings();
	const settings = "settings" in opts ? opts.settings : b?.settings;
	const env = opts.env ?? {};
	const l = new BrowserLink({ settings: () => settings, emit: (e, d) => events.push([e, d]), linked: () => state.linked, env, log: () => {}, tell: t => notes.push(t) });
	return { l, events, notes, state, b, env };
}

/** The bridge error `f` throws: its protocol code and message. */
const thrown = (f: () => unknown): Json => {
	try {
		f();
	} catch (err) {
		if (!(err instanceof Error)) throw err;
		return { code: "code" in err ? err.code : undefined, message: err.message };
	}
	throw new Error("did not throw");
};

describe("the override of omp's browser settings", () => {
	test("only http://127.0.0.1:<port>", () => {
		expect(isLoopbackCdp(URL_A)).toBe(true);
		expect(isLoopbackCdp("http://127.0.0.1:1")).toBe(true);
		for (const bad of ["http://localhost:9222", "https://127.0.0.1:9222", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:9222/json", "http://10.0.0.2:9222", "http://127.0.0.1"]) {
			expect(isLoopbackCdp(bad)).toBe(false);
		}
	});

	test("points omp at the endpoint with the relay off, and puts back what the user had", () => {
		const b = fakeBrowserSettings({ cdpUrl: "http://127.0.0.1:9222", relay: true });
		b.cdpUrl.runtime = "http://127.0.0.1:9333"; // the session's own override (omp's `--config`-less runtime layer)
		const env: Record<string, string | undefined> = { PI_BROWSER_RELAY: "1" };
		const saved = applyBrowserOverride(b.settings, URL_A, env);
		expect([b.cdpUrl.get(b.store), b.relay.get(b.store), env.PI_BROWSER_RELAY]).toEqual([URL_A, false, "0"]);
		// A second override (another app took it over) keeps what the first replaced.
		expect(applyBrowserOverride(b.settings, URL_B, env, saved)).toBe(saved);
		expect(b.cdpUrl.get(b.store)).toBe(URL_B);
		clearBrowserOverride(b.settings, saved, env);
		expect([b.cdpUrl.runtime, b.cdpUrl.get(b.store), b.relay.runtime, b.relay.get(b.store), env.PI_BROWSER_RELAY]).toEqual([
			"http://127.0.0.1:9333",
			"http://127.0.0.1:9333",
			undefined,
			true,
			"1",
		]);
		// Nothing of the user's: no runtime layer and no variable afterwards.
		const plain = fakeBrowserSettings();
		const none: Record<string, string | undefined> = {};
		clearBrowserOverride(plain.settings, applyBrowserOverride(plain.settings, URL_A, none), none);
		expect([plain.cdpUrl.runtime, plain.relay.runtime, "PI_BROWSER_RELAY" in none]).toEqual([undefined, undefined, false]);
	});

	test("browserOverride checks its params and needs omp's settings", () => {
		const { l, b } = link();
		expect(thrown(() => l.override({ cdpUrl: "http://example.com:80" }))).toMatchObject({ code: "invalid_params" });
		expect(thrown(() => l.override({ cdpUrl: URL_A, scope: "forever" }))).toMatchObject({ code: "invalid_params" });
		expect(b!.cdpUrl.runtime).toBeUndefined();
		expect(thrown(() => link({ settings: undefined }).l.override({ cdpUrl: URL_A }))).toMatchObject({ code: "unsupported" });
		// Dropping an override that is not there is fine (hostd retries a detach).
		expect(link({ settings: undefined }).l.override({ cdpUrl: null })).toEqual({});
	});

	test("Allow once: a turn override ends once omp settled the turn; hostd hears why, the model reads why", async () => {
		const { l, b, events, notes } = link();
		l.override({ cdpUrl: URL_A, scope: "turn" });
		expect(l.lease).toEqual({ url: URL_A, scope: "turn" });
		const idle = Promise.withResolvers<void>();
		l.turnEnded(idle.promise);
		expect(l.lease).toBeDefined(); // omp still retries or runs a follow-up
		expect(notes).toEqual([]);
		idle.resolve();
		// The link's reaction to omp settling runs before this one (registered first).
		await idle.promise;
		expect(l.lease).toBeUndefined();
		expect(b!.cdpUrl.runtime).toBeUndefined();
		expect(events).toEqual([["browser_released", { reason: "turnEnded" }]]);
		// Its tabs fail from now on with Puppeteer's detached frames: the next turn starts knowing why.
		expect(notes).toEqual([BROWSER_ONCE_ENDED]);
	});

	test("a session override outlives turns; one renewed meanwhile is not ended by the older turn", async () => {
		const { l, events, notes } = link();
		l.override({ cdpUrl: URL_A });
		l.turnEnded();
		expect(l.lease?.scope).toBe("session");
		l.override({ cdpUrl: URL_A, scope: "turn" });
		const idle = Promise.withResolvers<void>();
		l.turnEnded(idle.promise);
		// The user allowed it for the session while omp settled the turn.
		l.override({ cdpUrl: URL_A, scope: "session" });
		idle.resolve();
		await idle.promise;
		expect(l.lease?.scope).toBe("session");
		// hostd detaches: no event (it asked), no note.
		l.override({ cdpUrl: null });
		expect(l.lease).toBeUndefined();
		expect(events).toEqual([]);
		expect(notes).toEqual([]);
	});

	test("Allow once for a subagent lasts the subagent's turn, not the main session's; the subagent reads why", async () => {
		const { l, events, notes } = link();
		const told: string[] = [];
		const call = l.ask("to read the dashboard", undefined, { session: "explore", tell: t => told.push(t) });
		const id = events[0]![1].id;
		l.override({ cdpUrl: URL_A, scope: "turn" });
		l.answer({ id, allow: true, scope: "turn" });
		expect(await call).toMatchObject({ attached: true, scope: "turn" });
		// The main session's turn ends while the subagent still works with the browser.
		l.turnEnded();
		expect(l.lease).toBeDefined();
		// The subagent's own turn ends; once omp settled it, the override goes.
		const idle = Promise.withResolvers<void>();
		l.turnEnded(idle.promise, "explore");
		expect(l.lease).toBeDefined();
		idle.resolve();
		await idle.promise;
		expect(l.lease).toBeUndefined();
		expect(events.at(-1)).toEqual(["browser_released", { reason: "turnEnded" }]);
		expect([told, notes]).toEqual([[BROWSER_ONCE_ENDED], []]);
	});

	test("callers that shared the request keep it until each one's turn ended; an agent that finds it attached learns whose turn it lasts", async () => {
		const { l, events, notes } = link();
		const told: string[] = [];
		const fromMain = l.ask("to read the dashboard");
		const fromSub = l.ask("to read the dashboard too", undefined, { session: "explore", tell: t => told.push(t) });
		l.override({ cdpUrl: URL_A, scope: "turn" });
		l.answer({ id: events[0]![1].id, allow: true, scope: "turn" });
		await Promise.all([fromMain, fromSub]);
		// A third agent finds it attached for another agent's turn.
		const late = await l.ask("me as well", undefined, { session: "review", tell: t => told.push(`review: ${t}`) });
		expect(late).toMatchObject({ attached: true, already: true, scope: "turn" });
		expect(browserToolText(late)).toContain("until the turn it was allowed for ends");
		expect(browserToolText(late)).not.toContain("until this turn ends");
		l.turnEnded(undefined, "review");
		l.turnEnded(undefined, "explore");
		expect(l.lease).toBeDefined();
		l.turnEnded();
		expect(l.lease).toBeUndefined();
		expect(notes).toEqual([BROWSER_ONCE_ENDED]);
		expect(told).toEqual([BROWSER_ONCE_ENDED, `review: ${BROWSER_ONCE_ENDED}`]);
		// An attach from the app that nobody asked for lasts the main session's turn, as before.
		l.override({ cdpUrl: URL_B, scope: "turn" });
		l.turnEnded(undefined, "explore");
		expect(l.lease).toBeDefined();
		l.turnEnded();
		expect(l.lease).toBeUndefined();
	});
});

describe("use_user_browser", () => {
	test("asks through hostd; Allow (after hostd's override) tells the agent how and the rules", async () => {
		const { l, events } = link();
		const call = l.ask("to download last month's invoices");
		const [event, req] = events[0]!;
		expect(event).toBe("browser_request");
		expect(req).toMatchObject({ reason: "to download last month's invoices" });
		expect(typeof req.at).toBe("number");
		expect(l.pending?.id).toBe(req.id as string);
		l.override({ cdpUrl: URL_A, scope: "turn" });
		expect(l.answer({ id: req.id, allow: true, scope: "turn" })).toEqual({});
		const out = await call;
		expect(out).toMatchObject({ allow: true, attached: true, scope: "turn", cdpUrl: URL_A });
		expect(events.at(-1)).toEqual(["browser_request_end", { id: req.id }]);
		const text = browserToolText(out);
		expect(text).toContain("until this turn ends");
		expect(text).toContain("browser.open(");
		expect(text).toContain("logins and cookies are shared");
		for (const rule of ["do not sign out", "switch accounts", "account or security settings", "payments", "irreversible"]) expect(text).toContain(rule);
		// While it is attached, nobody is asked again.
		const again = await l.ask("one more page");
		expect(again).toMatchObject({ attached: true, already: true });
		expect(browserToolText(again)).toContain("You can already use");
		expect(events.filter(([e]) => e === "browser_request")).toHaveLength(1);
	});

	test("Deny, and no app with a browser (hostd answers at once)", async () => {
		const { l, events } = link();
		const denied = l.ask("to check my bank balance");
		l.answer({ id: events[0]![1].id, allow: false });
		const d = await denied;
		expect(d).toMatchObject({ allow: false, attached: false });
		expect(browserToolText(d)).toContain("The user declined");
		const none = l.ask("to log in to the admin page");
		const id = events.find(([e, data]) => e === "browser_request" && data.id !== events[0]![1].id)![1].id;
		l.answer({ id, allow: false, unavailable: true, message: "No TeleFlock app with a browser is connected to this host right now." });
		const n = await none;
		expect(n).toMatchObject({ allow: false, unavailable: true });
		expect(browserToolText(n)).toContain("not available: No TeleFlock app with a browser is connected");
		// An answer to a request that is over.
		expect(thrown(() => l.answer({ id, allow: false }))).toMatchObject({ code: "not_found" });
	});

	test("answers without asking: not linked, omp's browser off, omp without the settings", async () => {
		const off = link({ linked: false });
		expect(await off.l.ask("x")).toMatchObject({ allow: false, unavailable: true, message: "TeleFlock is not connected to this omp session" });
		expect(off.events).toEqual([]);
		const disabled = link();
		disabled.b!.enabled.configured = false;
		expect((await disabled.l.ask("x")).message).toContain("browser.enabled");
		const old = link({ settings: undefined });
		expect((await old.l.ask("x")).message).toContain("browser settings are missing");
		expect([...disabled.events, ...old.events]).toEqual([]);
	});

	test("calls share one request; cancelling the last waiter ends it", async () => {
		const { l, events } = link();
		const a = new AbortController();
		const b = new AbortController();
		const first = l.ask("to read the dashboard", a.signal);
		const second = l.ask("to read the dashboard again", b.signal);
		expect(events.map(([e]) => e)).toEqual(["browser_request"]);
		a.abort();
		await expect(first).rejects.toThrow();
		expect(l.pending).toBeDefined(); // the second call still waits
		b.abort(new Error("Esc"));
		await expect(second).rejects.toThrow("Esc");
		expect(l.pending).toBeUndefined();
		expect(events.map(([e]) => e)).toEqual(["browser_request", "browser_request_end"]);
		// Already cancelled: nothing is asked.
		await expect(l.ask("late", a.signal)).rejects.toThrow();
		expect(events).toHaveLength(2);
	});

	test("hostd's connection goes: the override ends, the request waits and is announced again; closing ends both", async () => {
		const { l, events, b, state } = link();
		l.override({ cdpUrl: URL_A });
		state.linked = true;
		l.unlinked();
		expect(l.lease).toBeUndefined();
		expect(b!.cdpUrl.runtime).toBeUndefined();
		const call = l.ask("to open my calendar");
		const id = events[0]![1].id;
		state.linked = false;
		l.unlinked();
		l.hello();
		expect(events.map(([e, d]) => [e, d.id])).toEqual([
			["browser_request", id],
			["browser_request", id],
		]);
		l.override({ cdpUrl: URL_B });
		l.close("a newer TeleFlock bridge took over this omp; ask again");
		expect(l.lease).toBeUndefined();
		expect(await call).toMatchObject({ allow: false, unavailable: true, attached: false });
		expect(events.at(-1)).toEqual(["browser_request_end", { id }]);
	});

	test("an Allow whose override is gone again says so", () => {
		const out: BrowserOutcome = { allow: true, scope: "session", attached: false };
		expect(browserToolText(out)).toContain("detached the browser again");
	});

	test("registration: an essential tool that asks with the reason and omp's abort signal", async () => {
		const field = (type: string) => {
			const f: Json = { type };
			f.optional = () => ((f.optional_ = true), f);
			f.describe = (text: string) => ((f.description = text), f);
			return f;
		};
		const zod = { object: (shape: Json) => ({ type: "object", shape }), string: () => field("string"), enum: () => field("enum") };
		const tools: Json[] = [];
		const asked: Array<[string, AbortSignal | undefined]> = [];
		const pi = { zod, registerTool: (t: Json) => tools.push(t) };
		const reg = registerBrowserTool(pi as never, async (reason, signal) => {
			asked.push([reason, signal]);
			return { allow: false, attached: false };
		});
		expect(reg).toBe(true);
		const tool = tools[0]!;
		expect([tool.name, tool.label, tool.loadMode]).toEqual(["use_user_browser", "Use my browser", "essential"]);
		expect(String(tool.description)).toContain("signed in");
		expect(Object.keys((tool.parameters as { shape: Json }).shape)).toEqual(["reason"]);
		const execute = tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Json }>;
		const signal = new AbortController().signal;
		const res = await execute("c1", { reason: "  to file\n my  expenses " }, signal, undefined, {});
		expect(asked).toEqual([["to file my expenses", signal]]);
		expect(res.details).toEqual({ allowed: false, scope: undefined, unavailable: undefined });
		expect(res.content[0]?.text).toContain("declined");
		await expect(execute("c2", { reason: "   " }, signal)).rejects.toThrow("reason");
		expect(registerBrowserTool({ registerTool: () => {} } as never, async () => ({ allow: false, attached: false }))).toBe(false);
	});
});

// ─── the extension against a fake hostd ───────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) {
		try {
			c();
		} catch {
			// best effort
		}
	}
	delete (globalThis as Record<symbol, unknown>)[SLOT];
	delete process.env.TF_BRIDGE_SOCK;
});

/** Polls `pred`: the fake hostd's lines arrive over a socket, so there is no event to await. */
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 5);
		await promise;
	}
}

async function startHostd() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-browser-hostd-"));
	const sock = path.join(dir, "bridge.sock");
	const secret = "cd".repeat(32);
	fs.writeFileSync(path.join(dir, "bridge.secret"), secret);
	const lines: Json[] = [];
	let conn: net.Socket | undefined;
	const server = net.createServer(c => {
		conn = c;
		c.setEncoding("utf8");
		let buf = "";
		c.on("data", (chunk: string) => {
			buf += chunk;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				lines.push(JSON.parse(buf.slice(0, i)) as Json);
				buf = buf.slice(i + 1);
			}
		});
		c.write(`${JSON.stringify({ t: "auth", v: 1, secret })}\n`);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(sock, () => listening.resolve());
	await listening.promise;
	cleanups.push(() => {
		conn?.destroy();
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	let id = 0;
	return {
		sock,
		lines,
		events: (name: string) => lines.filter(l => l.t === "event" && l.event === name),
		close: () => conn?.destroy(),
		async request(op: string, params: Json = {}): Promise<Json> {
			const reqId = ++id;
			conn?.write(`${JSON.stringify({ t: "req", id: reqId, op, params })}\n`);
			await until(() => lines.some(l => l.t === "res" && l.id === reqId));
			return lines.find(l => l.t === "res" && l.id === reqId)!;
		},
	};
}

/** A fake omp (rpc mode) whose root exports carry its live Settings and browser setting handles. */
async function bridgedOmp(hostd: { sock: string }) {
	process.env.TF_BRIDGE_SOCK = hostd.sock;
	const b = fakeBrowserSettings({ cdpUrl: "http://127.0.0.1:9222" });
	let sid = "S1";
	const sm = {
		getSessionId: () => sid,
		getSessionFile: () => `/tmp/${sid}.jsonl`,
		getLeafId: () => null,
		getEntries: () => [],
		getBranch: () => [],
		getCwd: () => "/w",
		getArtifactsDir: () => null,
		getEntry: () => undefined,
		isSessionOnDisk: () => true,
	};
	const session = {
		isStreaming: false,
		sessionManager: sm,
		agent: { state: { messages: [] as unknown[] } },
		subscribe: () => () => {},
		settle: [] as Array<() => void>,
		waitForIdle(): Promise<void> {
			const idle = Promise.withResolvers<void>();
			session.settle.push(idle.resolve);
			return idle.promise;
		},
	};
	const refs: Record<string, Json> = { Main: { id: "Main", kind: "main", status: "idle", session, sessionFile: "/tmp/S1.jsonl" } };
	const registry = { get: (id: string) => refs[id], list: () => Object.values(refs), onChange: () => () => {} };
	const ns: Json = {
		VERSION: "18.15.0",
		AgentRegistry: class {
			static global() {
				return registry;
			}
		},
		Settings: { instance: b.store },
		cfgBrowserCdpUrl: b.cdpUrl,
		cfgBrowserRelay: b.relay,
		cfgBrowserEnabled: b.enabled,
	};
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const ctx: Json = {
		mode: "rpc",
		hasUI: false,
		cwd: "/w",
		sessionManager: sm,
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		model: undefined,
		isIdle: () => !session.isStreaming,
		getContextUsage: () => undefined,
		setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
		clearTimer: (t: Timer) => clearInterval(t),
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		abort: () => {},
		hasPendingMessages: () => false,
		getPendingPlanReview: () => undefined,
	};
	const field = (type: string) => {
		const f: Json = { type };
		f.optional = () => f;
		f.describe = () => f;
		return f;
	};
	const tools = new Map<string, Json>();
	/** What the bridge told the model (`pi.sendMessage`): the message and how omp should deliver it. */
	const sent: Array<[Json, Json | undefined]> = [];
	const pi = {
		pi: ns,
		zod: { object: (shape: Json) => ({ type: "object", shape }), string: () => field("string"), enum: () => field("enum") },
		logger: { debug: () => {} },
		events: { on: () => () => {}, emit: () => {} },
		on(name: string, fn: (e: Json, c: object) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand() {},
		registerTool: (t: Json) => tools.set(String(t.name), t),
		getServiceTiers: () => ({}),
		getThinkingLevel: () => "low",
		getSessionName: () => undefined,
		getCommands: () => [],
		sendUserMessage() {},
		sendMessage: (m: Json, o?: Json) => sent.push([m, o]),
	};
	const fire = (name: string, event: Json = { type: name }) => (handlers.get(name) ?? []).map(fn => fn(event, ctx));
	await teleflockBridge(pi as never);
	fire("session_start");
	cleanups.push(() => fire("session_shutdown"));
	await until(() => hostd.lines.some(l => l.t === "hello"), 5_000);
	const execute = tools.get("use_user_browser")!.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Json }>;
	const useBrowser = (reason: string, signal?: AbortSignal) => execute("call-1", { reason }, signal, undefined, ctx);
	/** A subagent's session with its own binding of the extension (omp runs the factory per session). */
	const subagent = async (id: string) => {
		const subSm = { ...sm, getSessionId: () => `sub-${id}`, getSessionFile: () => `/tmp/sub-${id}.jsonl` };
		const subSession = { ...session, sessionManager: subSm, settle: [] as Array<() => void> };
		subSession.waitForIdle = (): Promise<void> => {
			const idle = Promise.withResolvers<void>();
			subSession.settle.push(idle.resolve);
			return idle.promise;
		};
		refs[id] = { id, kind: "sub", parentId: "Main", status: "running", session: subSession, sessionFile: `/tmp/sub-${id}.jsonl` };
		const subHandlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
		const subTools = new Map<string, Json>();
		const subSent: Array<[Json, Json | undefined]> = [];
		const subCtx: Json = { ...ctx, sessionManager: subSm, agent: { kind: "sub", id, name: id, depth: 1 } };
		const subPi = {
			...pi,
			on(name: string, fn: (e: Json, c: object) => unknown) {
				subHandlers.set(name, [...(subHandlers.get(name) ?? []), fn]);
			},
			registerTool: (t: Json) => subTools.set(String(t.name), t),
			sendMessage: (m: Json, o?: Json) => subSent.push([m, o]),
		};
		const subFire = (name: string, event: Json = { type: name }) => (subHandlers.get(name) ?? []).map(fn => fn(event, subCtx));
		await teleflockBridge(subPi as never);
		subFire("session_start");
		const subExecute = subTools.get("use_user_browser")!.execute as typeof execute;
		return { session: subSession, sent: subSent, fire: subFire, useBrowser: (reason: string) => subExecute("call-s1", { reason }, undefined, undefined, subCtx) };
	};
	return { b, session, sent, fire, useBrowser, subagent, switchTo: (next: string) => (sid = next) };
}

describe("the TeleFlock Browser against a fake hostd", () => {
	test("hello says caps.browser; Allow once: request, override, answer, then the turn's end releases it", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).browser).toBe(true);
		const call = omp.useBrowser("to read the release checklist on the intranet");
		await until(() => hostd.events("browser_request").length === 1);
		const req = hostd.events("browser_request")[0]!;
		expect(req).toMatchObject({ sessionId: "S1", data: { reason: "to read the release checklist on the intranet" } });
		const id = (req.data as Json).id;
		// hostd attaches first (the app chose Allow once), then answers.
		expect(await hostd.request("browserOverride", { cdpUrl: URL_A, scope: "turn" })).toMatchObject({ ok: true });
		expect([omp.b.cdpUrl.get(omp.b.store), omp.b.relay.get(omp.b.store)]).toEqual([URL_A, false]);
		expect(await hostd.request("browserAnswer", { id, allow: true, scope: "turn", cdpUrl: URL_A })).toMatchObject({ ok: true });
		const res = await call;
		expect(res.details).toMatchObject({ allowed: true, scope: "turn" });
		expect(res.content[0]!.text).toContain("until this turn ends");
		expect(hostd.events("browser_request_end").map(e => (e.data as Json).id)).toEqual([id]);
		// The turn ends; omp settles it (its retries) before the override goes.
		omp.fire("agent_end");
		await hostd.request("ping");
		expect(hostd.events("browser_released")).toEqual([]);
		for (const settle of omp.session.settle.splice(0)) settle();
		await until(() => hostd.events("browser_released").length === 1);
		expect(hostd.events("browser_released")[0]!.data).toEqual({ reason: "turnEnded" });
		expect([omp.b.cdpUrl.get(omp.b.store), omp.b.relay.get(omp.b.store), omp.b.cdpUrl.runtime]).toEqual(["http://127.0.0.1:9222", false, undefined]);
		// The model reads why with its next prompt, without starting a turn of its own.
		expect(omp.sent).toEqual([[{ customType: "teleflock-browser", content: BROWSER_ONCE_ENDED, display: false }, { deliverAs: "nextTurn" }]]);
	});

	test("Deny; bad params; a session switch announces the request again; hostd gone drops the override", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		expect(await hostd.request("browserOverride", { cdpUrl: "http://192.168.1.5:9222" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
		expect(await hostd.request("browserAnswer", { id: "nope", allow: false })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const call = omp.useBrowser("to change my DNS records");
		await until(() => hostd.events("browser_request").length === 1);
		const id = (hostd.events("browser_request")[0]!.data as Json).id;
		// omp moves to another session (/new): hostd's new session hears the request again.
		omp.switchTo("S2");
		omp.fire("session_switch");
		await until(() => hostd.events("browser_request").length === 2);
		expect(hostd.events("browser_request")[1]).toMatchObject({ sessionId: "S2", data: { id } });
		expect(await hostd.request("browserAnswer", { id, allow: false })).toMatchObject({ ok: true });
		expect((await call).content[0]!.text).toContain("declined");
		expect(omp.b.cdpUrl.runtime).toBeUndefined();
		// Attached for the session; then hostd's connection goes, and the override with it.
		await hostd.request("browserOverride", { cdpUrl: URL_B });
		expect(omp.b.cdpUrl.get(omp.b.store)).toBe(URL_B);
		hostd.close();
		await until(() => omp.b.cdpUrl.runtime === undefined);
		expect(omp.b.relay.runtime).toBeUndefined();
		// hostd may attach it again when it is back: the model is told nothing.
		expect(omp.sent).toEqual([]);
	});

	test("Allow once asked by a subagent: the main session's turn leaves it, the subagent's ends it and the subagent reads why", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		const sub = await omp.subagent("explore");
		const call = sub.useBrowser("to download the invoices");
		await until(() => hostd.events("browser_request").length === 1);
		const id = (hostd.events("browser_request")[0]!.data as Json).id;
		await hostd.request("browserOverride", { cdpUrl: URL_A, scope: "turn" });
		await hostd.request("browserAnswer", { id, allow: true, scope: "turn", cdpUrl: URL_A });
		expect((await call).content[0]!.text).toContain("until this turn ends");
		// The main agent's turn ends (it handed the work off): the subagent keeps the browser.
		omp.fire("agent_end");
		for (const settle of omp.session.settle.splice(0)) settle();
		await hostd.request("ping");
		expect(hostd.events("browser_released")).toEqual([]);
		expect(omp.b.cdpUrl.get(omp.b.store)).toBe(URL_A);
		// The subagent's turn ends; once omp settled it, the browser goes back.
		sub.fire("agent_end");
		await hostd.request("ping");
		expect(hostd.events("browser_released")).toEqual([]);
		for (const settle of sub.session.settle.splice(0)) settle();
		await until(() => hostd.events("browser_released").length === 1);
		expect(omp.b.cdpUrl.runtime).toBeUndefined();
		// The note goes to the subagent that used it, not to the main agent.
		expect(sub.sent).toEqual([[{ customType: "teleflock-browser", content: BROWSER_ONCE_ENDED, display: false }, { deliverAs: "nextTurn" }]]);
		expect(omp.sent).toEqual([]);
	});
});
