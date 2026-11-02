#!/usr/bin/env bun
/**
 * Artifacts lab driver: does over the lab devserver's /ws what the app does (the same frames:
 * `{id, hostId, method, params}` → `{id, result | error}`; `{event}` frames are ignored), then checks
 * the result. Run it after setup.sh, outside the lab (it only talks to 127.0.0.1 and reads files):
 *
 *   bun scripts/lab/artifacts/drive.ts <lab> [--agent ID] [--name NAME] [--prompts LIST]
 *     --agent ID      prompt this agent instead of starting one
 *     --name NAME     the started agent's name (default presenter)
 *     --prompts LIST  comma-separated, in order, from html, again, md, evil (default all four)
 *
 * 1. Waits for host `lab` to answer `state.get`, then `agent.start` (what the New agent dialog
 *    sends): target `{kind: "cwd", cwd: <work folder>, label: "weekly-report"}`, spec
 *    `{kind: "omp", name, model: "mock/lab-1", plan: false}`; waits for the agent's link to be live.
 * 2. Per prompt: `agent.prompt` with the marker text (`PRESENT-HTML`, `PRESENT-HTML again`,
 *    `PRESENT-MD`, `PRESENT-EVIL`), then waits for the final answer's `PRESENT-LAB <key> done`.
 * 3. Checks: the transcript as hostd serves it (`session.open` with a small limit, then
 *    `session.history` pages) has a finished `present` row with a typed `artifact` per prompt
 *    (title, kind, version, name, assets, source); each snapshot is in the session's `local://`
 *    root (`session.artifacts`) with the row's size; the report's logo was copied beside it and
 *    `session.artifact {kind: local, base64: true}` answers it as `data`; the sink logged nothing.
 * Exit 0 when every check passed.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const lab = args[0]?.startsWith("-") ? undefined : args[0];
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
if (!lab || args.includes("--help") || args.includes("-h")) {
	console.error("usage: bun scripts/lab/artifacts/drive.ts <lab> [--agent ID] [--name NAME] [--prompts html,again,md,evil]");
	process.exit(64);
}
const envFile = `/tmp/tf-lab-${lab}/lab.env`;
if (!existsSync(envFile)) {
	console.error(`drive: no ${envFile}; run scripts/lab/artifacts/setup.sh ${lab} first`);
	process.exit(66);
}
const env = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const HOST = "lab";

interface Expect {
	prompt: string;
	title: string;
	slug: string;
	kind: string;
	ext: string;
	source?: string;
	assets: number;
}
const PROMPTS: Record<string, Expect> = {
	html: { prompt: "PRESENT-HTML: build this week's CI report as one page and show it to me.", title: "Lab report", slug: "lab-report", kind: "html", ext: "html", source: "report/index.html", assets: 1 },
	again: { prompt: "PRESENT-HTML again: Friday's flaky runs were re-run, update the report and show it again.", title: "Lab report", slug: "lab-report", kind: "html", ext: "html", source: "report/index.html", assets: 1 },
	md: { prompt: "PRESENT-MD: write up the lab notes and show them to me.", title: "Lab notes", slug: "lab-notes", kind: "markdown", ext: "md", assets: 0 },
	evil: { prompt: "PRESENT-EVIL: build the sandbox test page and show it to me.", title: "Evil page", slug: "evil-page", kind: "html", ext: "html", source: "evil/index.html", assets: 0 },
};
const order = (opt("--prompts") ?? "html,again,md,evil").split(",").map(s => s.trim()).filter(Boolean);
for (const k of order) if (!PROMPTS[k]) throw new Error(`unknown prompt ${k} (html, again, md, evil)`);

// ─── wire ───────────────────────────────────────────────────────────────────────────────────────

const sock = new WebSocket(env.WS!);
const pending = new Map<number, PromiseWithResolvers<Json>>();
let nextId = 1;
const opened = Promise.withResolvers<void>();
sock.onopen = () => opened.resolve();
sock.onerror = () => opened.reject(new Error(`cannot open ${env.WS}`));
await opened.promise;
sock.onmessage = m => {
	const msg = JSON.parse(String(m.data));
	if (msg.event || typeof msg.id !== "number") return;
	const p = pending.get(msg.id);
	pending.delete(msg.id);
	if (msg.error) p?.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
	else p?.resolve(msg.result);
};
sock.onclose = () => {
	for (const p of pending.values()) p.reject(new Error("devserver closed the connection"));
};

/** One host method on host `lab`; its answer (wire JSON, shaped as src/core/gen describes). */
async function call(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
	const id = nextId++;
	const answer = Promise.withResolvers<Json>();
	pending.set(id, answer);
	const timer = setTimeout(() => {
		pending.delete(id);
		answer.reject(new Error(`${method}: no answer within ${timeoutMs / 1000}s`));
	}, timeoutMs);
	sock.send(JSON.stringify({ id, hostId: HOST, method, params }));
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

async function until<T>(what: string, secs: number, probe: () => Promise<T | undefined>): Promise<T> {
	let last = "";
	for (const end = Date.now() + secs * 1000; Date.now() < end; await Bun.sleep(1000)) {
		try {
			const v = await probe();
			if (v !== undefined) return v;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
	}
	throw new Error(`${what} within ${secs}s${last ? ` (last error: ${last})` : ""}`);
}

// ─── agent ──────────────────────────────────────────────────────────────────────────────────────

const host = await until("host lab never answered state.get", 180, () => call("state.get", {}, 10_000));
say(`host lab online: tf-hostd ${host.info?.hostdVersion}, omp ${host.info?.omp?.version ?? "?"}, herdr session ${host.info?.herdrSession}`);

let agentId = opt("--agent") ?? "";
if (!agentId) {
	const params = {
		target: { kind: "cwd", cwd: env.WORK, label: "weekly-report" },
		spec: { kind: "omp", name: opt("--name") ?? "presenter", model: "mock/lab-1", plan: false },
	};
	say(`agent.start ${JSON.stringify(params)}`);
	const started = await call("agent.start", params, 180_000);
	say(`agent.start → ${JSON.stringify(started)}`);
	agentId =
		started.agentId ??
		(await until("herdr never reported the started agent", 120, async () => (await call("state.get", {}, 10_000)).agents?.find((a: Json) => a.paneId === started.paneId)?.id));
}
const agent = await until(`agent ${agentId}'s link never went live`, 180, async () => {
	const a = (await call("state.get", {}, 10_000)).agents?.find((x: Json) => x.id === agentId);
	return a?.omp?.link === "live" ? a : undefined;
});
say(`agent ${agentId} live: omp session ${agent.omp.sessionId}, file ${agent.omp.sessionFile}, bridge ${agent.omp.bridge}`);

// ─── prompts ────────────────────────────────────────────────────────────────────────────────────

for (const key of order) {
	const marker = `PRESENT-LAB ${key} done`;
	const answered = (items: Json[] | undefined): Json[] => (items ?? []).filter(r => r.kind === "assistant" && !r.streaming && r.text?.includes(marker));
	const seen = new Set(answered((await call("session.open", { agentId, limit: 40 })).items).map(r => r.id));
	say(`agent.prompt ${JSON.stringify(PROMPTS[key]!.prompt)}`);
	await call("agent.prompt", { agentId, text: PROMPTS[key]!.prompt, images: [], delivery: "auto" }, 60_000);
	const done = await until(`no "${marker}" answer`, 180, async () => answered((await call("session.open", { agentId, limit: 40 })).items).find(r => !seen.has(r.id)));
	say(`${key} answered: ${JSON.stringify(done.text.split("\n")[0].slice(0, 140))}`);
}

// ─── checks ─────────────────────────────────────────────────────────────────────────────────────

// The whole transcript: session.open with a small limit, then session.history pages.
const open = await call("session.open", { agentId, limit: 10 }, 30_000);
const rows: Json[] = [...(open.items ?? [])];
let cursor: string | undefined = open.hasMore ? open.cursor : undefined;
let pages = 0;
while (cursor) {
	const page = await call("session.history", { agentId, cursor, limit: 10 }, 30_000);
	rows.unshift(...(page.items ?? []));
	cursor = page.hasMore ? page.cursor : undefined;
	pages++;
}
say(`transcript: ${rows.length} rows (session.open + ${pages} session.history pages)`);
const presents = rows.filter(r => r.kind === "tool" && r.tool === "present");
check("every present row finished ok with an artifact", presents.length > 0 && presents.every(r => r.status === "ok" && r.artifact), presents.map(r => `${r.status}${r.artifact ? "+artifact" : ""}`).join(", "));

const listing = await call("session.artifacts", { agentId }, 30_000);
const localRoot: string = listing.localRoot ?? "";
check("session.artifacts names the local:// root", !!localRoot && existsSync(localRoot), localRoot);

// The present rows of this run, matched to the prompts in order (the newest ones).
const ours = presents.slice(-order.length);
const reports: number[] = [];
const logos: string[] = [];
order.forEach((key, i) => {
	const e = PROMPTS[key]!;
	const a: Json | undefined = ours[i]?.artifact;
	if (!a) return check(`${key}: a present row with an artifact`, false, `${ours.length} rows for ${order.length} prompts`);
	const expectVersion = key === "again" && reports.length ? reports.at(-1)! + 1 : undefined;
	if (e.slug === "lab-report") reports.push(a.version);
	const file = join(localRoot, a.name);
	const fields = a.title === e.title && a.kind === e.kind && a.slug === e.slug && a.source === e.source && a.assets === e.assets;
	check(`${key}: row artifact ${a.title} v${a.version}`, fields && (expectVersion === undefined || a.version === expectVersion), JSON.stringify(a));
	check(`${key}: name and url`, a.name === `presented/${e.slug}-v${a.version}.${e.ext}` && a.url === `local://${a.name}`, `${a.name} ${a.url}`);
	check(`${key}: snapshot on disk with the row's size`, existsSync(file) && statSync(file).size === a.size, `${file} (${existsSync(file) ? statSync(file).size : "missing"} bytes, row says ${a.size})`);
	if (e.assets) {
		const logo = `presented/${e.slug}-v${a.version}.files/logo.svg`;
		logos.push(logo);
		const path = join(localRoot, logo);
		check(`${key}: logo.svg copied beside it`, existsSync(path) && readFileSync(path, "utf8") === readFileSync(join(env.WORK!, "report/logo.svg"), "utf8"), path);
	}
});
if (order.includes("html") && order.includes("again") && reports.length >= 2) {
	const [first, second] = reports.slice(-2).map(v => readFileSync(join(localRoot, `presented/lab-report-v${v}.html`), "utf8"));
	check(`version ${reports.at(-2)} stayed as presented, version ${reports.at(-1)} has the new headline`, !!first?.includes("<h1>Weekly build report</h1>") && !!second?.includes("Friday's failures fixed"));
}

for (const name of logos) {
	const read = await call("session.artifact", { agentId, kind: "local", name, base64: true }, 30_000);
	const bytes = typeof read.data === "string" ? Buffer.from(read.data, "base64") : undefined;
	check(
		`session.artifact {kind: local, name: ${name}, base64: true} answers data`,
		!!bytes && bytes.equals(readFileSync(join(localRoot, name))) && read.text === undefined && !read.truncated,
		bytes ? `${bytes.length} bytes, size ${read.size}, binary ${read.binary}, path ${read.path}` : JSON.stringify(read).slice(0, 200),
	);
}

const sink = existsSync(env.SINK_LOG!) ? readFileSync(env.SINK_LOG!, "utf8").split("\n").filter(Boolean) : [];
check("the sink logged no request during the agent run", sink.length === 0, sink.length ? sink.join(" | ") : `${env.SINK_LOG} is empty`);

console.log(`agent ${agentId}; local:// root ${localRoot}`);
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
sock.close();
process.exit(failed ? 1 : 0);
