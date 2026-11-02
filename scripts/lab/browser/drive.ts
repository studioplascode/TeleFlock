#!/usr/bin/env bun
/**
 * Browser lab driver: does over the lab devserver's /ws what the app does (`{id, hostId?, method,
 * params}` → `{id, result | error}`; `{event}` frames: notifications are kept, the rest ignored),
 * talks DevTools to the browser the way the app's panel does (its raw port, with the page's Origin),
 * and has real omp agents (mock model, see mock.ts) drive the browser with omp's own browser tooling
 * (`eval` with `browser.open`, …) through tf-hostd's port and the app core's DevTools proxy. Run it
 * after setup.sh, outside the lab (it only talks to 127.0.0.1, reads files and /proc; the browser
 * it screenshots the UI with runs inside the lab):
 *
 *   bun scripts/lab/browser/drive.ts <lab> [--keep]
 *     --keep   leave the devserver running at the end (skips the stop-on-exit check)
 *
 * The test site (served here): /set?k=&v= sets a persistent cookie k=v, /read?k= shows cookie k,
 * /popup has a link that opens /child in a new tab, /user is the user's own page; each page shows
 * its value in #value.
 * 1. Engine: `browser.configSet {enginePath}` with setup's --chrome, else `browser.installEngine`
 *    (the pinned Chrome for Testing, checked and unpacked into <data>/browser/engine) unless an
 *    engine is found; then `browser.start`: running, DevTools on loopback, open to the
 *    devserver's origin and refused to another. The user opens their own tab over DevTools.
 * 2. (a) Attach on purpose: `browser.attach` an omp agent (scout); its card says so once the board
 *    caught up; its port answers /json/version and lists only its pages; the agent opens /set
 *    (cookie tf_a) and reads the page, and its DevTools see its tab, never the user's.
 * 3. (c) Persistence: `browser.stop` leaves no browser process; after `browser.start` the agent,
 *    attached again, reads cookie tf_a it set in (a). `browser.detach`: its tab stays, detached;
 *    its port closes.
 * 4. (b) `use_user_browser` (agent asker, prompt `USE-BROWSER …`): the request shows in
 *    `browser.status`, as a needs-you card and a notification; Allow for this session → the agent
 *    reads the user's cookie tf_a; Deny → the declined text and no browser call; Allow once → the
 *    agent works (omp's `browser.cdpUrl` a session override) and the attachment ends with the turn;
 *    next turn omp's setting is back, the agent was told why, and its tab call fails.
 * 5. (d) Two agents at once (scout, asker): each drives its own tab and sees only its own pages,
 *    `Browser.close` is refused, a popup is its opener's, take over makes the agent's next call
 *    fail with "the user took over this tab", hand back lets it drive the tab again, a detach
 *    keeps its tabs (detached) and the other agent working.
 * 6. Cap 1: a third agent's allowed request waits, `browser.attach` answers `browser_busy` (and
 *    attaches with `overCap`), a detach admits the waiting one.
 * 7. SIGTERM to the devserver: the browser stops with it, nothing is left running.
 * With setup's --ui (or --vite) it screenshots the UI at 1440×900 into /tmp/tf-lab-<lab>/shots:
 * the request card and the board in (b), the tab strip grouped by owner while both agents drive
 * and after a detach in (d). Exit 0 when every check passed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const lab = args[0]?.startsWith("-") ? undefined : args[0];
if (!lab || args.includes("--help") || args.includes("-h")) {
	console.error("usage: bun scripts/lab/browser/drive.ts <lab> [--keep]");
	process.exit(64);
}
const keep = args.includes("--keep");
const envFile = `/tmp/tf-lab-${lab}/lab.env`;
if (!existsSync(envFile)) {
	console.error(`drive: no ${envFile}; run scripts/lab/browser/setup.sh ${lab} first`);
	process.exit(66);
}
const env = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const HOST = "lab";
const REPO = `${import.meta.dir}/../../..`;

// ─── wire ───────────────────────────────────────────────────────────────────────────────────────

const sock = new WebSocket(env.WS!);
const pending = new Map<number, PromiseWithResolvers<Json>>();
let nextId = 1;
const opened = Promise.withResolvers<void>();
sock.onopen = () => opened.resolve();
sock.onerror = () => opened.reject(new Error(`cannot open ${env.WS}`));
await opened.promise;
/** The notifications the app core passed on (`AppEvent::Notify`). */
const notified: Json[] = [];
sock.onmessage = m => {
	const msg = JSON.parse(String(m.data));
	if (msg.event?.type === "notify") notified.push(msg.event);
	if (msg.event || typeof msg.id !== "number") return;
	const p = pending.get(msg.id);
	pending.delete(msg.id);
	if (msg.error) p?.reject(Object.assign(new Error(`${msg.error.code}: ${msg.error.message}`), { code: msg.error.code }));
	else p?.resolve(msg.result);
};
sock.onclose = () => {
	for (const p of pending.values()) p.reject(new Error("devserver closed the connection"));
};

/** An app method (`hostId` absent) or a host method on host `lab`. */
async function call(method: string, params: Json, timeoutMs = 30_000, host: string | undefined = method.startsWith("browser.") ? undefined : HOST): Promise<Json> {
	const id = nextId++;
	const answer = Promise.withResolvers<Json>();
	pending.set(id, answer);
	const timer = setTimeout(() => {
		pending.delete(id);
		answer.reject(new Error(`${method}: no answer within ${timeoutMs / 1000}s`));
	}, timeoutMs);
	sock.send(JSON.stringify(host ? { id, hostId: host, method, params } : { id, method, params }));
	try {
		return await answer.promise;
	} finally {
		clearTimeout(timer);
	}
}

const t0 = Date.now();
const say = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
	if (!ok) failed++;
};

async function until<T>(what: string, secs: number, probe: () => Promise<T | undefined>, everyMs = 500): Promise<T> {
	let last = "";
	for (const end = Date.now() + secs * 1000; Date.now() < end; await Bun.sleep(everyMs)) {
		try {
			const v = await probe();
			if (v !== undefined) return v;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
	}
	throw new Error(`${what} within ${secs}s${last ? ` (last error: ${last})` : ""}`);
}

const status = () => call("browser.status", {});
const card = async (agentId: string) => (await call("state.get", {})).agents?.find((a: Json) => a.id === agentId);

/** Processes whose command line names the lab's browser profile. */
function browserProcesses(): string[] {
	const want = `--user-data-dir=${env.PROFILE}`;
	const out: string[] = [];
	for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
		try {
			const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
			if (cmd.includes(want)) out.push(`${pid} ${cmd.slice(0, 100)}`);
		} catch {}
	}
	return out;
}

// ─── DevTools ───────────────────────────────────────────────────────────────────────────────────

class Cdp {
	#next = 0;
	#waiting = new Map<number, PromiseWithResolvers<Json>>();
	closed = Promise.withResolvers<void>();
	private constructor(readonly ws: WebSocket) {
		ws.onmessage = m => {
			const msg = JSON.parse(String(m.data));
			const p = this.#waiting.get(msg.id);
			if (!p) return;
			this.#waiting.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error.message));
			else p.resolve(msg.result);
		};
		ws.onclose = () => {
			for (const p of this.#waiting.values()) p.reject(new Error("closed"));
			this.closed.resolve();
		};
	}

	/** Opens `url` as a page of `origin` does (no Origin header without one). */
	static async open(url: string, origin?: string): Promise<Cdp> {
		// Bun's WebSocket takes request headers; a page's browser sends its Origin the same way.
		const ws = origin ? new WebSocket(url, { headers: { Origin: origin } }) : new WebSocket(url);
		const ready = Promise.withResolvers<void>();
		ws.onopen = () => ready.resolve();
		ws.onerror = () => ready.reject(new Error(`cannot open ${url}${origin ? ` as ${origin}` : ""}`));
		ws.onclose = () => ready.reject(new Error(`${url} closed before it opened`));
		await ready.promise;
		return new Cdp(ws);
	}

	call(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
		const id = ++this.#next;
		const p = Promise.withResolvers<Json>();
		this.#waiting.set(id, p);
		this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		const timer = setTimeout(() => p.reject(new Error(`${method}: no answer`)), 15_000);
		return p.promise.finally(() => clearTimeout(timer));
	}

	close() {
		this.ws.close();
	}
}

const pages = async (c: Cdp) => ((await c.call("Target.getTargets")).targetInfos as Json[]).filter(t => t.type === "page");

// ─── the UI, screenshotted (setup's --ui / --vite) ──────────────────────────────────────────────

/** A headless Chrome inside the lab that shows the UI at 1440×900 and screenshots it. */
class Viewer {
	private constructor(
		readonly cdp: Cdp,
		readonly session: string,
	) {}

	static async open(chrome: string): Promise<Viewer> {
		const dir = `${env.ROOT}/viewer`;
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		// Chrome refuses to run as root with its sandbox (the lab machine runs as root).
		const flags = [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"];
		Bun.spawn([`${REPO}/scripts/lab/run`, lab!, "--", chrome, ...flags], { stdout: "ignore", stderr: "ignore", cwd: REPO });
		const active = await until("the viewer's DevToolsActivePort", 30, async () => {
			const text = existsSync(`${dir}/DevToolsActivePort`) ? readFileSync(`${dir}/DevToolsActivePort`, "utf8") : "";
			return text.includes("\n") ? text.trim().split("\n") : undefined;
		}, 200);
		const cdp = await Cdp.open(`ws://127.0.0.1:${active[0]}${active[1]}`);
		const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
		await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
		// A device the UI never ran on may open "What's new" (GitHub release notes) over everything:
		// this one has seen every version already (the UI's persisted `tf.whatsNew`).
		await cdp.call("Page.enable", {}, sessionId);
		await cdp.call(
			"Page.addScriptToEvaluateOnNewDocument",
			{ source: `try { localStorage.getItem("tf.whatsNew") || localStorage.setItem("tf.whatsNew", JSON.stringify({ state: { seen: "999.0.0", failedStarts: 0 }, version: 0 })); } catch {}` },
			sessionId,
		);
		await cdp.call("Page.navigate", { url: `${env.URL}#/board` }, sessionId);
		return new Viewer(cdp, sessionId);
	}

	async eval<T>(expression: string): Promise<T> {
		const r = await this.cdp.call("Runtime.evaluate", { expression, returnByValue: true }, this.session);
		return r.result?.value as T;
	}

	/** Shows `hash` (`#/…`) and waits until the page shows every text of `expect`. */
	async show(hash: string, expect: string[], secs = 120): Promise<void> {
		await this.eval(`location.hash = ${JSON.stringify(hash)}`).catch(() => undefined);
		await until(`the UI never showed ${JSON.stringify(expect)} at ${hash}`, secs, async () => {
			const text = (await this.eval<string>("document.body ? document.body.innerText : ''")) ?? "";
			return expect.every(e => text.includes(e)) ? true : undefined;
		});
	}

	async shot(name: string): Promise<string> {
		const { data } = await this.cdp.call("Page.captureScreenshot", { format: "png" }, this.session);
		mkdirSync(`${env.ROOT}/shots`, { recursive: true });
		const file = `${env.ROOT}/shots/${name}.png`;
		writeFileSync(file, Buffer.from(data, "base64"));
		return file;
	}

	close() {
		void this.cdp.call("Browser.close").catch(() => undefined);
	}
}

// ─── agents ─────────────────────────────────────────────────────────────────────────────────────

async function startAgent(name: string): Promise<string> {
	const params = { target: { kind: "cwd", cwd: env.WORK, label: "site" }, spec: { kind: "omp", name, model: "mock/lab-1", plan: false } };
	const r = await call("agent.start", params, 180_000);
	const id: string =
		r.agentId ?? (await until(`herdr never reported ${name}`, 120, async () => (await call("state.get", {}, 10_000)).agents?.find((a: Json) => a.paneId === r.paneId)?.id));
	await until(`${name}'s link never went live`, 180, async () => ((await call("state.get", {}, 10_000)).agents?.find((x: Json) => x.id === id)?.omp?.link === "live" ? true : undefined));
	say(`agent ${name} (${id}) live`);
	return id;
}

async function seenAnswers(agentId: string): Promise<Set<string>> {
	const items: Json[] = (await call("session.open", { agentId, limit: 30 })).items ?? [];
	return new Set(items.filter(r => r.kind === "assistant").map(r => r.id));
}

/** Sends a prompt; the set is what the agent had answered before it. */
async function send(agentId: string, text: string): Promise<Set<string>> {
	const before = await seenAnswers(agentId);
	await call("agent.prompt", { agentId, text, images: [], delivery: "auto" }, 60_000);
	return before;
}

/** The agent's next `BROWSER-LAB done` answer (the mock quotes every tool result in it). */
async function answered(agentId: string, since: Set<string>, secs = 150): Promise<string> {
	const row = await until("no BROWSER-LAB answer", secs, async () => {
		const items: Json[] = (await call("session.open", { agentId, limit: 30 })).items ?? [];
		return items.find(r => r.kind === "assistant" && !r.streaming && r.text?.includes("BROWSER-LAB done") && !since.has(r.id));
	});
	return String(row.text);
}

const turn = async (agentId: string, text: string) => answered(agentId, await send(agentId, text));

/** The JSON an agent's eval printed after `tag` (quoted in its answer). */
function printed(answer: string, tag = "BRW-RESULT"): Json | undefined {
	const m = new RegExp(`${tag} (\\{.*\\})`).exec(answer);
	return m ? JSON.parse(m[1]!) : undefined;
}

const brief = (answer: string) => answer.replace(/\s+/g, " ").slice(0, 300);

// The code the agents run in omp's eval (`browser` is omp's browser global; `tab.run` hands it
// the raw Puppeteer browser, whose own DevTools session lists what the proxy lets it see).
const LIST_PAGES = `async ({ browser }) => {
	const s = await browser.target().createCDPSession();
	try { return (await s.send("Target.getTargets")).targetInfos.filter(t => t.type === "page").map(t => t.url); }
	finally { await s.detach().catch(() => {}); }
}`;
const openAndRead = (name: string, url: string) => `const tab = await browser.open({ name: ${JSON.stringify(name)}, url: ${JSON.stringify(url)} });
const value = await tab.text("#value");
const pages = await tab.run(${LIST_PAGES});
console.log("BRW-RESULT " + JSON.stringify({ value, pages }));`;
/** omp's own view of its `browser.cdpUrl` setting (value and where it comes from). */
const OMP_CDP_URL = `(await tool.read({ path: "cfg://browser/cdpUrl" })).text.split("\\n").slice(0, 4).join(" | ")`;
const readTab = (name: string, tag = "BRW-RESULT") => `console.log("${tag} " + JSON.stringify({ value: await browser.tab(${JSON.stringify(name)}).text("#value") }));`;

// ─── 1. engine and start ────────────────────────────────────────────────────────────────────────

const host = await until("host lab never answered state.get", 180, () => call("state.get", {}, 10_000));
say(`host lab online: tf-hostd ${host.info?.hostdVersion}, omp ${host.info?.omp?.version ?? "?"}`);

let config = await call("browser.config", {});
if (env.CHROME) {
	config = await call("browser.configSet", { enginePath: env.CHROME });
	check("browser.configSet takes the lab's browser", config.enginePath === env.CHROME, config.enginePath);
} else if (!config.engines?.length) {
	check("Chrome for Testing has a build for this device", config.download?.available === true, JSON.stringify(config.download));
	say(`browser.installEngine (Chrome for Testing ${config.download?.version})`);
	await call("browser.installEngine", {});
	let shown = -1;
	const done = await until("the Chrome for Testing download did not finish", 900, async () => {
		const s = await status();
		if (s.install?.error) throw Object.assign(new Error(s.install.error), { fatal: true });
		const pct = s.install?.progress ?? -1;
		if (pct >= shown + 20) {
			shown = pct;
			say(`  downloading: ${pct} %`);
		}
		return s.install ? undefined : s;
	}, 1000);
	check("Chrome for Testing downloaded, checked and found", done.engine?.name === "Chrome for Testing" && done.state === "off", JSON.stringify(done.engine));
	config = await call("browser.config", {});
	check("browser.config: installed", config.download?.installed === true && config.engines?.some((e: Json) => e.name === "Chrome for Testing"), JSON.stringify(config.engines));
}
const started = await call("browser.start", {}, 90_000);
check("browser.start: running headless", started.state === "running" && started.headed === false && !!started.cdpPort && !!started.wsUrl, `${started.state} port ${started.cdpPort} ${started.engine?.name} ${started.engine?.version}`);
check("the persistent profile is the lab's", started.profileDir === env.PROFILE, started.profileDir);
check("one browser process tree runs the profile", browserProcesses().length > 0, `${browserProcesses().length} processes`);
let user = await Cdp.open(started.wsUrl, env.ORIGIN);
check("DevTools take the devserver page's origin", true, env.ORIGIN);
const evil = await Cdp.open(started.wsUrl, "http://evil.example").then(
	c => (c.close(), "opened"),
	e => String(e),
);
check("DevTools refuse another origin", evil !== "opened", evil);

// The UI loads (its first load takes a while) while the agents start.
const viewer = env.URL ? await Viewer.open(env.CHROME || started.engine?.path) : undefined;
if (!viewer) say("no UI in this lab (setup without --ui or --vite): no screenshots");

const seen: string[] = [];
const escape = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const site = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req) {
		const url = new URL(req.url);
		const cookies = req.headers.get("cookie") ?? "";
		seen.push(`${url.pathname}${url.search} ${cookies}`);
		const k = url.searchParams.get("k") ?? "tf";
		const v = url.searchParams.get("v") ?? "";
		const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
		let body: string;
		if (url.pathname === "/set") {
			headers["set-cookie"] = `${k}=${encodeURIComponent(v)}; Max-Age=86400; Path=/; SameSite=Lax`;
			body = `<title>set ${escape(k)}</title><p id="value">set:${escape(v)}</p>`;
		} else if (url.pathname === "/read") {
			const m = new RegExp(`(?:^|;\\s*)${k}=([^;]*)`).exec(cookies);
			body = `<title>read ${escape(k)}</title><p id="value">cookie:${m ? escape(decodeURIComponent(m[1]!)) : "(none)"}</p>`;
		} else if (url.pathname === "/popup") {
			body = `<title>popup ${escape(v)}</title><p id="value">popup:${escape(v)}</p><a id="open" href="/child?v=${encodeURIComponent(v)}" target="_blank">open the child page</a>`;
		} else {
			body = `<title>${escape(url.pathname.slice(1))} ${escape(v)}</title><p id="value">${escape(url.pathname.slice(1))}:${escape(v)}</p>`;
		}
		return new Response(`<!doctype html><html><body>${body}</body></html>`, { headers });
	},
});
const siteUrl = `http://127.0.0.1:${site.port}`;
const userTab = (await user.call("Target.createTarget", { url: `${siteUrl}/user?v=secret` })).targetId as string;
await until("the user's page never loaded", 20, async () => (seen.some(l => l.startsWith("/user")) ? true : undefined));
say(`the user's own tab ${userTab} shows ${siteUrl}/user?v=secret`);

// ─── 2. (a) attach on purpose ───────────────────────────────────────────────────────────────────

const scout = await startAgent("scout");
const attached = await call("browser.attach", { hostId: HOST, agentId: scout }, 60_000);
let att = attached.attachments?.find((a: Json) => a.agentId === scout);
check("(a) browser.attach: the agent is attached for the session", att?.scope === "session" && att?.hostPort > 0, JSON.stringify(att));
// hostd marks the board dirty on attach and publishes it a moment later: the card follows.
const lent = await until("the card never said whose browser it drives", 10, async () => (await card(scout))?.browser?.attached, 100).catch(e => String(e));
check("(a) its card says whose browser it drives", lent?.scope === "session" && !!lent?.device, JSON.stringify(lent));
const version = await (await fetch(`http://127.0.0.1:${att.hostPort}/json/version`)).json();
check("(a) the agent's port answers /json/version through tf-hostd", String(version.webSocketDebuggerUrl).startsWith(`ws://127.0.0.1:${att.hostPort}/devtools/browser/`), version.webSocketDebuggerUrl);
const a1 = await turn(scout, `BRW-EVAL\n${openAndRead("lab", `${siteUrl}/set?k=tf_a&v=scout-a`)}`);
const r1 = printed(a1);
check("(a) omp opened the page in the user's browser through the proxy and read it", r1?.value === "set:scout-a" && a1.includes(`on connected http://127.0.0.1:${att.hostPort}`), brief(a1));
check("(a) the agent's DevTools see its tab, never the user's", r1?.pages?.some((u: string) => u.includes("/set?k=tf_a")) && !r1?.pages?.some((u: string) => u.includes("/user")), JSON.stringify(r1?.pages));
const listed: Json[] = await (await fetch(`http://127.0.0.1:${att.hostPort}/json/list`)).json();
check("(a) its /json/list has only its pages", listed.length > 0 && listed.every(t => !String(t.url).includes("/user")), listed.map(t => t.url).join(", "));
const userPages = await pages(user);
check("(a) the user's DevTools see both tabs", userPages.some(t => t.targetId === userTab) && userPages.some(t => String(t.url).includes("/set?k=tf_a")), userPages.map(t => t.url).join(", "));
const owned = await until("the agent's tab never showed as its own", 10, async () => {
	const s = await status();
	return s.tabs?.some((t: Json) => t.agentId === scout && !t.detached) ? s : undefined;
});
const conn = owned.attachments?.find((a: Json) => a.agentId === scout);
check("(a) status: the agent's tab and its connections", conn?.connections >= 1 && owned.tabs.some((t: Json) => t.agentName === "scout") && !owned.tabs.some((t: Json) => t.targetId === userTab), JSON.stringify(conn));

// ─── 3. (c) the cookie survives a restart ───────────────────────────────────────────────────────

user.close();
const stopped = await call("browser.stop", {}, 60_000);
check("(c) browser.stop: off, no agent attached", stopped.state === "off" && !stopped.attachments?.length, `${stopped.state} ${JSON.stringify(stopped.attachments)}`);
check("(c) browser.stop leaves no browser process", browserProcesses().length === 0, browserProcesses().join(" | "));
const again = await call("browser.start", {}, 90_000);
check("(c) browser.start again: running on a new port", again.state === "running" && again.cdpPort !== started.cdpPort, `${again.cdpPort}`);
user = await Cdp.open(again.wsUrl, env.ORIGIN);
att = (await call("browser.attach", { hostId: HOST, agentId: scout }, 60_000)).attachments?.find((a: Json) => a.agentId === scout);
// omp keeps its tab "lab" bound to the endpoint of the browser that stopped: it releases it first.
const a2 = await turn(scout, `BRW-EVAL\nawait browser.close({ name: "lab" }).catch(() => {});\n${openAndRead("lab", `${siteUrl}/read?k=tf_a`)}`);
check("(c) the cookie the agent set in (a) survived browser.stop/start (persistent profile)", printed(a2)?.value === "cookie:scout-a", brief(a2));
check("(c) the restarted browser sent it to the site", seen.some(l => l.startsWith("/read?k=tf_a") && l.includes("tf_a=scout-a")), seen.filter(l => l.startsWith("/read")).join(" | "));
const scoutTab = (await status()).tabs?.find((t: Json) => t.agentId === scout)?.targetId;
await call("browser.detach", { hostId: HOST, agentId: scout }, 30_000);
const afterDetach = await status();
check("(c) browser.detach: no attachment, its tab stays, detached", !afterDetach.attachments?.some((a: Json) => a.agentId === scout) && afterDetach.tabs?.find((t: Json) => t.targetId === scoutTab)?.detached === true, JSON.stringify(afterDetach.tabs));
const gone = await fetch(`http://127.0.0.1:${att.hostPort}/json/version`).then(r => `answered ${r.status}`, e => String(e));
check("(c) its host port is closed", !gone.startsWith("answered 200"), gone);
check("(c) its card forgets it", (await until("the card kept the browser", 10, async () => ((await card(scout))?.browser?.attached ? undefined : true), 100).catch(() => false)) === true);

// ─── 4. (b) use_user_browser ────────────────────────────────────────────────────────────────────

async function request(agentId: string, text: string): Promise<{ req: Json; before: Set<string> }> {
	const before = await send(agentId, text);
	const req = await until("the request never showed in browser.status", 60, async () => (await status()).requests?.find((r: Json) => r.agentId === agentId));
	return { req, before };
}

const asker = await startAgent("asker");
// b1: Allow for this session. The agent reads the cookie scout set: the logins are the user's.
const b1 = await request(asker, `USE-BROWSER Read the lab page while signed in as you\nBRW-EVAL\n${openAndRead("lab", `${siteUrl}/read?k=tf_a`)}`);
check("(b) the request shows with the agent's reason", b1.req.reason.includes("Read the lab page") && b1.req.agentName === "asker" && b1.req.waiting === false, JSON.stringify(b1.req));
const needs = await until("the card never asked", 10, async () => {
	const c = await card(asker);
	return c?.needs?.browser ? c.needs : undefined;
}, 200);
check("(b) its card asks as a needs-you question", needs.requestId === b1.req.id && needs.options?.map((o: Json) => o.id).join() === "session,turn,deny", JSON.stringify({ title: needs.title, options: needs.options?.map((o: Json) => o.label) }));
const note = await until("no notification", 10, async () => notified.find(n => n.notification?.requestId === b1.req.id), 200).catch(() => undefined);
check("(b) a notification asks the user", note?.notification?.title === "asker wants to use your browser" && note?.notification?.body?.includes("Read the lab page"), JSON.stringify(note?.notification && { title: note.notification.title, body: note.notification.body, actions: note.notification.actions?.map((a: Json) => a.id) }));
if (viewer) {
	await viewer.show(`#/agent/${HOST}/${asker}`, ["asker wants to use your browser", "Allow for this session", "Allow once"]);
	say(`screenshot ${await viewer.shot("b-request-card")}`);
	await viewer.show("#/board", ["Read the lab page while signed in as you", "Allow once"]);
	say(`screenshot ${await viewer.shot("b-board-needs-you")}`);
}
const allowed = await call("browser.answer", { requestId: b1.req.id, allow: true, scope: "session" }, 60_000);
check("(b) Allow for this session attaches it for the session", allowed.attachments?.find((a: Json) => a.agentId === asker)?.scope === "session", JSON.stringify(allowed.attachments));
const ab1 = await answered(asker, b1.before);
check("(b) the agent heard it may use the browser, for the session", ab1.includes("allowed you to use their TeleFlock Browser for this session"), brief(ab1));
check("(b) it then read the user's signed-in page (cookie tf_a)", printed(ab1)?.value === "cookie:scout-a", brief(ab1.slice(ab1.indexOf("[eval]"))));
await call("browser.detach", { hostId: HOST, agentId: asker }, 30_000);

// b2: Deny.
const b2 = await request(asker, `USE-BROWSER Once more\nBRW-EVAL\nconsole.log("BRW-RESULT {\\"ran\\":true}");`);
await call("browser.answer", { requestId: b2.req.id, allow: false }, 30_000);
const ab2 = await answered(asker, b2.before);
check("(b) Deny: the agent gets the declined text and no browser", ab2.includes("The user declined") && !ab2.includes("[eval]") && !(await status()).attachments?.some((a: Json) => a.agentId === asker), brief(ab2));

// b3: Allow once.
const b3 = await request(asker, `USE-BROWSER Just this once\nBRW-EVAL\n${openAndRead("once", `${siteUrl}/set?k=tf_b&v=once`)}\nconsole.log("BRW-CFG " + JSON.stringify({ cdpUrl: ${OMP_CDP_URL} }));`);
const once = await call("browser.answer", { requestId: b3.req.id, allow: true, scope: "turn" }, 60_000);
const onceAtt = once.attachments?.find((a: Json) => a.agentId === asker);
check("(b) Allow once attaches it for the turn", onceAtt?.scope === "turn", JSON.stringify(once.attachments));
const ab3 = await answered(asker, b3.before);
check("(b) the agent heard: until this turn ends", ab3.includes("until this turn ends"), brief(ab3));
check("(b) it drove the browser in that turn", printed(ab3)?.value === "set:once", brief(ab3.slice(ab3.indexOf("[eval]"))));
check("(b) meanwhile omp's browser.cdpUrl is the bridge's session override", String(printed(ab3, "BRW-CFG")?.cdpUrl).includes(`"http://127.0.0.1:${onceAtt?.hostPort}"`) && String(printed(ab3, "BRW-CFG")?.cdpUrl).includes("source: session override"), printed(ab3, "BRW-CFG")?.cdpUrl);
await until("the turn-scoped attachment never ended", 60, async () => ((await status()).attachments?.some((a: Json) => a.agentId === asker) ? undefined : true));
check("(b) Allow once ended with the turn", true);
check("(b) its card forgets it", (await until("the card kept the browser", 10, async () => ((await card(asker))?.browser ? undefined : true), 100).catch(() => false)) === true);
const shut = await fetch(`http://127.0.0.1:${onceAtt?.hostPort}/json/version`).then(r => `answered ${r.status}`, e => String(e));
check("(b) its host port is closed", !shut.startsWith("answered 200"), shut);
const ab4 = await turn(asker, `BRW-EVAL\nconsole.log("BRW-CFG " + JSON.stringify({ cdpUrl: ${OMP_CDP_URL} }));\nBRW-EVAL\n${readTab("once")}`);
check("(b) next turn omp's browser.cdpUrl is back (no override)", /browser\.cdpUrl: null .*source: default/.test(String(printed(ab4, "BRW-CFG")?.cdpUrl)), printed(ab4, "BRW-CFG")?.cdpUrl);
check("(b) the agent read why before its next turn", ab4.includes("[context] TeleFlock: the user allowed you their TeleFlock Browser once"), brief(ab4));
check("(b) its browser call there fails at once", !printed(ab4) && /\[eval\][\s\S]*(Error|error)/.test(ab4.slice(ab4.lastIndexOf("[eval]"))), brief(ab4.slice(ab4.lastIndexOf("[eval]"))));

// ─── 5. (d) two agents at once ──────────────────────────────────────────────────────────────────

await call("browser.attach", { hostId: HOST, agentId: scout }, 60_000);
await call("browser.attach", { hostId: HOST, agentId: asker }, 60_000);
if (viewer) await viewer.show("#/browser", ["scout can control this browser", "asker can control this browser"]);
const drive = (who: string) => `await browser.close({ name: "mine" }).catch(() => {});
const tab = await browser.open({ name: "mine", url: ${JSON.stringify(`${siteUrl}/popup?v=${who}`)} });
const value = await tab.text("#value");
for (let i = 0; i < 40; i++) { await tab.evaluate("document.title = '${who} drives " + i + "'"); await Bun.sleep(500); }
const seen = await tab.run(async ({ browser }) => {
	const s = await browser.target().createCDPSession();
	try {
		const pages = (await s.send("Target.getTargets")).targetInfos.filter(t => t.type === "page").map(t => t.url);
		const refused = await s.send("Browser.close").then(() => "closed it", e => String(e?.message ?? e));
		return { pages, refused };
	} finally { await s.detach().catch(() => {}); }
});
console.log("BRW-RESULT " + JSON.stringify({ value, ...seen }));`;
const [ds, da] = await Promise.all([send(scout, `BRW-EVAL\n${drive("scout")}`), send(asker, `BRW-EVAL\n${drive("asker")}`)]);
// Both drive their tabs now: the strip groups them by owner, each with its live dot.
const busy = await until("the two agents never both drove", 60, async () => {
	const s = await status();
	const recent = s.attachments?.filter((a: Json) => a.activeAt && Date.now() - a.activeAt < 3000) ?? [];
	return recent.length === 2 && s.tabs?.filter((t: Json) => !t.detached && (t.agentId === scout || t.agentId === asker)).length >= 2 ? s : undefined;
}, 250);
check("(d) both agents drive their own tabs at once", true, JSON.stringify(busy.attachments.map((a: Json) => [a.agentName, a.connections])));
if (viewer) {
	await viewer.show("#/browser", ["scout can control this browser", "asker can control this browser"], 20);
	const dots = await viewer.eval<number>("document.querySelectorAll('.animate-ping').length");
	say(`screenshot ${await viewer.shot("d-tabs-by-owner-driving")} (${dots} live dots)`);
	check("(d) the strip shows both agents driving (live dots)", dots >= 2, `${dots}`);
}
const [ads, ada] = await Promise.all([answered(scout, ds), answered(asker, da)]);
const rs = printed(ads);
const ra = printed(ada);
check("(d) each sees only its own pages", rs?.pages?.length > 0 && ra?.pages?.length > 0 && rs.pages.every((u: string) => u.includes("v=scout")) && ra.pages.every((u: string) => u.includes("v=asker")), JSON.stringify({ scout: rs?.pages, asker: ra?.pages }));
check("(d) Browser.close is refused to both", [rs?.refused, ra?.refused].every(r => String(r).includes("TeleFlock refused `Browser.close`")) && (await status()).state === "running", String(rs?.refused));
const popup = await turn(scout, `BRW-EVAL
const tab = browser.tab("mine");
const child = await tab.run(async ({ page, browser }) => {
	const created = Promise.withResolvers();
	browser.once("targetcreated", t => created.resolve(t.url()));
	setTimeout(() => created.resolve(null), 10000);
	await page.click("#open");
	return await created.promise;
});
await Bun.sleep(1000);
console.log("BRW-RESULT " + JSON.stringify({ child, pages: await tab.run(${LIST_PAGES}) }));`);
check("(d) a popup of the agent's page is the agent's", printed(popup)?.pages?.some((u: string) => u.includes("/child?v=scout")), brief(popup));
const tabs = await until("the popup never showed as scout's", 10, async () => {
	const s = await status();
	const own = s.tabs?.filter((t: Json) => t.agentId === scout && !t.detached) ?? [];
	return own.length >= 2 ? s.tabs : undefined;
});
const userView = await pages(user);
const scoutMine = userView.find(t => String(t.url).includes("/popup?v=scout"))?.targetId;
const childTab = userView.find(t => String(t.url).includes("/child?v=scout"))?.targetId;
check("(d) status: the popup belongs to scout", tabs.some((t: Json) => t.targetId === childTab && t.agentId === scout), JSON.stringify(tabs.map((t: Json) => [t.agentName, t.targetId.slice(0, 6)])));
const askerView = printed(await turn(asker, `BRW-EVAL\nconsole.log("BRW-RESULT " + JSON.stringify({ pages: await browser.tab("mine").run(${LIST_PAGES}) }));`));
check("(d) the other agent does not see it", askerView?.pages?.length > 0 && !askerView.pages.some((u: string) => u.includes("v=scout")), JSON.stringify(askerView?.pages));
await call("browser.takeOver", { targetId: scoutMine }, 30_000);
const taken = await turn(scout, `BRW-EVAL\n${readTab("mine")}`);
check("(d) take over: the agent's next call fails with \"the user took over this tab\"", taken.includes("the user took over this tab") && !printed(taken), brief(taken.slice(taken.indexOf("[eval]"))));
check("(d) status: the tab is taken over", (await status()).tabs?.find((t: Json) => t.targetId === scoutMine)?.takenOver === true);
await call("browser.handBack", { targetId: scoutMine }, 30_000);
const back = await turn(scout, `BRW-EVAL\n${readTab("mine")}`);
check("(d) hand back: the agent drives the tab again", printed(back)?.value === "popup:scout", brief(back.slice(back.indexOf("[eval]"))));
await call("browser.detach", { hostId: HOST, agentId: scout }, 30_000);
const left = await status();
check("(d) detach: its tabs stay, detached", [scoutMine, childTab].every(id => left.tabs?.find((t: Json) => t.targetId === id)?.detached === true), JSON.stringify(left.tabs?.map((t: Json) => [t.agentName, t.targetId.slice(0, 6), t.detached])));
const still = await turn(asker, `BRW-EVAL\n${readTab("mine")}`);
check("(d) the other agent keeps working", printed(still)?.value === "popup:asker", brief(still));
if (viewer) {
	await viewer.show("#/browser", ["asker can control this browser"], 30);
	await until("the strip never showed scout detached", 20, async () => ((await viewer.eval<boolean>("!document.body.innerText.includes('scout can control this browser')")) ? true : undefined));
	say(`screenshot ${await viewer.shot("d-scout-detached")}`);
}
await call("browser.detach", { hostId: HOST, agentId: asker }, 30_000);

// ─── 6. the cap ─────────────────────────────────────────────────────────────────────────────────

const enginePath = (await call("browser.config", {})).enginePath;
await call("browser.configSet", { enginePath, cap: 1 });
await call("browser.attach", { hostId: HOST, agentId: scout }, 60_000);
const helper = await startAgent("helper");
const busyCode = await call("browser.attach", { hostId: HOST, agentId: helper }, 60_000).then(
	() => "attached",
	e => (e instanceof Error && "code" in e ? String(e.code) : String(e)),
);
check("at the cap browser.attach answers browser_busy", busyCode === "browser_busy", busyCode);
const h = await request(helper, "USE-BROWSER Help out");
const queued = await call("browser.answer", { requestId: h.req.id, allow: true, scope: "session" }, 30_000);
const waiting = queued.requests?.find((r: Json) => r.id === h.req.id);
check("an allowed request waits at the cap", waiting?.waiting === true && waiting?.scope === "session" && !queued.attachments?.some((a: Json) => a.agentId === helper), JSON.stringify(waiting));
await call("browser.detach", { hostId: HOST, agentId: scout }, 30_000);
const admitted = await until("the waiting request never attached", 60, async () => {
	const s = await status();
	return s.attachments?.some((a: Json) => a.agentId === helper) ? s : undefined;
});
check("a detach admits the waiting request", admitted.attachments.length === 1, JSON.stringify(admitted.attachments));
const helperReply = await answered(helper, h.before);
check("the waiting agent heard it may go on", helperReply.includes("allowed you to use their TeleFlock Browser for this session"), brief(helperReply));
const over = await call("browser.attach", { hostId: HOST, agentId: scout, overCap: true }, 60_000);
check("overCap attaches anyway", over.attachments?.length === 2, JSON.stringify(over.attachments?.map((a: Json) => a.agentId)));
await call("browser.detach", { hostId: HOST, agentId: scout }, 30_000);
await call("browser.detach", { hostId: HOST, agentId: helper }, 30_000);
await call("browser.configSet", { enginePath, cap: 4 });
user.close();
viewer?.close();
site.stop(true);

// ─── 7. the browser stops with the app core ─────────────────────────────────────────────────────

if (!keep) {
	const pid = Number(env.DEVSERVER_PID);
	const cmd = existsSync(`/proc/${pid}/cmdline`) ? readFileSync(`/proc/${pid}/cmdline`, "utf8") : "";
	if (cmd.includes("tf-devserver")) {
		sock.close();
		process.kill(pid, "SIGTERM");
		await until("the devserver did not exit", 30, async () => (existsSync(`/proc/${pid}`) ? undefined : true));
		check("SIGTERM to the devserver: the browser stopped with it", browserProcesses().length === 0, browserProcesses().join(" | "));
	} else {
		check("the devserver pid from lab.env runs tf-devserver", false, `${pid}: ${cmd.replaceAll("\0", " ")}`);
	}
}

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
if (keep) sock.close();
process.exit(failed ? 1 : 0);
