#!/usr/bin/env bun
/**
 * Agent chat lab driver: does over the lab devserver's /ws what the app's message board does (the
 * same frames: `{id, hostId, method, params}` → `{id, result | error}`; `{event}` frames are
 * ignored) and checks the board's data, `session.agentChat`, against the tree the mock plays (see
 * mock.ts). Run it after setup.sh, outside the lab (it talks to 127.0.0.1, and to the lab's
 * tf-hostd and herdr through scripts/lab/run):
 *
 *   bun scripts/lab/agentchat/drive.ts <lab> [--only LIST] [--agent ID]
 *     --only LIST  comma-separated phases, in order (default: live,restart,ping,old)
 *     --agent ID   use this agent (its tree already ran) instead of starting one; phases after live
 *
 * Phases:
 *   live     starts agent `chatlab`, prompts ACB-TREE, follows `session.agentChat` incrementally
 *            (epoch + after) while the tree runs, then sends what the user sends from the board
 *            (`agent.subagent` chat: one subagent, then all three as one broadcast); checks every
 *            message of the tree once, in causal order, with sender, recipients, flags, reply link and
 *            receipts; the incremental copy equals a full fetch; the session meta names the log
 *   restart  stops tf-hostd (`tf-hostd stop`; the devserver attaches a new daemon), waits for the
 *            agent's bridge, checks a new epoch and the log rebuilt from the session files: the same
 *            messages, once each, in the same order; receipts as omp's files tell them
 *   ping     prompts ACB-PING (Main asks the idle Orchestrator, which writes back): both messages
 *            once, live, after the restart
 *   old      the bridge of the last release (old-bridge.ts, 2.2.0: no `caps.agentChat`) for a second
 *            agent `oldchat`: its log is not live and comes from the transcript files alone; the
 *            same tree's messages once each
 * Exit 0 when every check passed. The last log of each phase is printed as a table.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const lab = args[0]?.startsWith("-") ? undefined : args[0];
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
if (!lab || args.includes("--help") || args.includes("-h")) {
	console.error("usage: bun scripts/lab/agentchat/drive.ts <lab> [--only live,restart,ping,old] [--agent ID]");
	process.exit(64);
}
const envFile = `/tmp/tf-lab-${lab}/lab.env`;
if (!existsSync(envFile)) {
	console.error(`drive: no ${envFile}; run scripts/lab/agentchat/setup.sh ${lab} first`);
	process.exit(66);
}
const env = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const HOST = "lab";
const PHASES = ["live", "restart", "ping", "old"];
const order = (opt("--only") ?? PHASES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
for (const s of order) if (!PHASES.includes(s)) throw new Error(`unknown phase ${s} (${PHASES.join(", ")})`);
const RUN = join(import.meta.dir, "../run");
const A = "Orchestrator.WorkerA";
const B = "Orchestrator.WorkerB";
const O = "Orchestrator";

// ─── wire ───────────────────────────────────────────────────────────────────────────────────────

let sock: WebSocket;
const pending = new Map<number, PromiseWithResolvers<Json>>();
let nextId = 1;

async function connect(): Promise<void> {
	sock = new WebSocket(env.WS!);
	const opened = Promise.withResolvers<void>();
	sock.onopen = () => opened.resolve();
	sock.onerror = () => opened.reject(new Error(`cannot open ${env.WS}`));
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
		pending.clear();
	};
	await opened.promise;
}

/** One host method on host `lab`; its answer (wire JSON, shaped as src/core/gen describes). */
async function call(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
	if (sock.readyState !== WebSocket.OPEN) await connect();
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

/** A command in the lab's environment (its tf-hostd home, its herdr), never the caller's. */
function inLab(...argv: string[]): string {
	const r = Bun.spawnSync([RUN, lab!, "--", ...argv], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
	return r.stdout.toString();
}

// ─── agents ─────────────────────────────────────────────────────────────────────────────────────

const agentNow = async (agentId: string): Promise<Json> => {
	const a = (await call("state.get", {}, 10_000)).agents?.find((x: Json) => x.id === agentId);
	if (!a) throw new Error(`agent ${agentId} is gone`);
	return a;
};

async function startAgent(name: string): Promise<{ agentId: string; first: Json }> {
	const params = { target: { kind: "cwd", cwd: env.WORK, label: "chat-lab" }, spec: { kind: "omp", name, model: "mock/lab-1", plan: false } };
	say(`agent.start ${JSON.stringify(params)}`);
	const started = await call("agent.start", params, 180_000);
	const agentId: string =
		started.agentId ?? (await until("herdr never reported the started agent", 120, async () => (await call("state.get", {}, 10_000)).agents?.find((a: Json) => a.paneId === started.paneId)?.id, 1000));
	const first = await live(agentId);
	say(`agent ${agentId} live in pane ${first.paneId}: omp ${first.omp.version}, pid ${first.omp.pid}, bridge ${first.omp.bridge}, session ${first.omp.sessionFile}`);
	return { agentId, first };
}

async function live(agentId: string, secs = 180): Promise<Json> {
	return until(`agent ${agentId}'s link never went live`, secs, async () => {
		const a = await agentNow(agentId);
		return a.omp?.link === "live" ? a : undefined;
	});
}

async function prompt(agentId: string, text: string): Promise<void> {
	say(`agent.prompt ${JSON.stringify(text)}`);
	await call("agent.prompt", { agentId, text, images: [], delivery: "auto" }, 60_000);
}

/** Main's assistant row holding `marker`, once it is there. */
async function said(agentId: string, marker: string, secs = 240): Promise<string> {
	const row = await until(`"${marker}" never came`, secs, async () =>
		((await call("session.open", { agentId, limit: 80 })).items ?? []).find((r: Json) => r.kind === "assistant" && !r.streaming && r.text?.includes(marker)),
	1000);
	return String(row.text);
}

async function settled(agentId: string, secs = 120): Promise<void> {
	await until(`agent ${agentId} never settled`, secs, async () => {
		const a = await agentNow(agentId);
		return a.column !== "running" && !a.needs ? true : undefined;
	});
}

// ─── the board's log ────────────────────────────────────────────────────────────────────────────

/** The board's copy of one session's log, kept as the app keeps it: whole on a new epoch, else
 *  the messages changed after its revision merged in by id. */
class Board {
	epoch?: string;
	rev = 0;
	byId = new Map<string, Json>();
	live?: boolean;
	resets = 0;
	/** Every receipt outcome each message (by text) showed, in order. */
	seen = new Map<string, string[]>();

	constructor(readonly agentId: string) {}

	async fetch(): Promise<Json> {
		const page = await call("session.agentChat", { agentId: this.agentId, epoch: this.epoch, after: this.epoch ? this.rev : undefined });
		if (page.reset || page.epoch !== this.epoch) {
			this.byId.clear();
			this.resets++;
		}
		this.epoch = page.epoch;
		this.rev = page.rev;
		this.live = page.live;
		for (const m of page.messages ?? []) {
			this.byId.set(m.id, m);
			const states = this.seen.get(m.text) ?? [];
			const now = receipts(m);
			if (states.at(-1) !== now) states.push(now);
			this.seen.set(m.text, states);
		}
		return page;
	}

	messages(): Json[] {
		return [...this.byId.values()].sort((a, b) => a.at - b.at || Number(a.id.slice(1)) - Number(b.id.slice(1)));
	}
}

const receipts = (m: Json) => (m.receipts ?? []).map((r: Json) => `${r.to}:${r.outcome}`).join(" ");

/** One message the tree sends (texts start with `ACB …`, see mock.ts). */
interface Want {
	key: string;
	/** The text starts with this. */
	text: string;
	from: string;
	to: string[];
	broadcast?: boolean;
	progress?: boolean;
	wakeRelay?: boolean;
	/** `key` of the message it answers. */
	replyTo?: string;
	/** Per recipient: the outcomes that are right (the first one is what the lab normally sees). */
	outcomes: Record<string, string[]>;
	/** The error a failed receipt carries (a part of it). */
	error?: string;
	/** It happens after these (`key`s). */
	after?: string[];
}

const TREE: Want[] = [
	{ key: "plan", text: "ACB orch→all:", from: O, to: ["Main", A, B], broadcast: true, outcomes: { Main: ["injected"], [A]: ["injected"], [B]: ["injected"] } },
	{ key: "main", text: "ACB main→orch: Got the plan", from: "Main", to: [O], outcomes: { [O]: ["injected"] }, after: ["plan"] },
	{ key: "progress", text: "ACB a→orch (progress):", from: A, to: [O], progress: true, outcomes: { [O]: ["injected"] }, after: ["plan"] },
	{ key: "ask", text: "ACB a→b:", from: A, to: [B], outcomes: { [B]: ["woken", "revived"] }, after: ["progress"] },
	{ key: "relay", text: "ACB b→a:", from: B, to: [A], wakeRelay: true, replyTo: "ask", outcomes: { [A]: ["injected"] }, after: ["ask"] },
	{ key: "nobody", text: "ACB a→nobody:", from: A, to: ["Nobody"], outcomes: { Nobody: ["failed"] }, error: "Unknown agent", after: ["relay"] },
	{ key: "self", text: "ACB a→a:", from: A, to: [A], outcomes: { [A]: ["failed"] }, error: "yourself", after: ["nobody"] },
	{ key: "report", text: "ACB a→orch: The API is up", from: A, to: [O], outcomes: { [O]: ["injected"] }, after: ["self"] },
];
const USER: Want[] = [
	{ key: "user-a", text: "ACB user→a:", from: "user", to: [A], outcomes: { [A]: ["injected"] }, after: ["report"] },
	{ key: "user-all", text: "ACB user→all:", from: "user", to: [O, A, B], broadcast: true, outcomes: { [O]: ["injected"], [A]: ["injected"], [B]: ["injected"] }, after: ["user-a"] },
];
const PING: Want[] = [
	{ key: "ping", text: "ACB main→orch: Still there", from: "Main", to: [O], outcomes: { [O]: ["woken", "revived"] } },
	{ key: "pong", text: "ACB orch→main: Still here", from: O, to: ["Main"], outcomes: { Main: ["woken", "injected"] }, after: ["ping"] },
];

/** Checks `msgs` (a log, oldest first) against `wants`: each once, fields, receipts, order.
 *  `filesOnly`: no tap; omp's transcript rows of a wake relay do not always say so (its `wait`
 *  result can lack `wakeRelay`), so only its reply link is checked. */
function checkLog(label: string, msgs: Json[], wants: Want[], opts: { outcomes?: (w: Want, to: string) => string[]; filesOnly?: boolean } = {}): Map<string, Json> {
	const found = new Map<string, Json>();
	for (const w of wants) {
		const hits = msgs.filter(m => String(m.text).startsWith(w.text));
		check(`${label}: ${w.key} (${w.text.slice(0, 26)}…) is on the board once`, hits.length === 1, `${hits.length}×`);
		const m = hits[0];
		if (!m) continue;
		found.set(w.key, m);
		const flags = (x: Json) => `broadcast=${!!x.broadcast} progress=${!!x.progress}${opts.filesOnly && w.wakeRelay ? "" : ` wakeRelay=${!!x.wakeRelay}`}`;
		check(`${label}: ${w.key}: from ${w.from} to ${w.to.join(", ")}`, m.from === w.from && JSON.stringify([...m.to].sort()) === JSON.stringify([...w.to].sort()), `${m.from} → ${m.to.join(", ")}`);
		check(`${label}: ${w.key}: ${flags(w)}`, flags(m) === flags(w), flags(m));
		const got = Object.fromEntries((m.receipts ?? []).map((r: Json) => [r.to, r]));
		const ok = w.to.every(to => (opts.outcomes?.(w, to) ?? w.outcomes[to] ?? []).includes(got[to]?.outcome)) && (m.receipts ?? []).length === w.to.length;
		check(`${label}: ${w.key}: receipts ${w.to.map(to => `${to}:${(opts.outcomes?.(w, to) ?? w.outcomes[to] ?? []).join("|")}`).join(" ")}`, ok, receipts(m));
		if (w.error) check(`${label}: ${w.key}: the failure says why`, (m.receipts ?? []).some((r: Json) => String(r.error ?? "").includes(w.error!)), (m.receipts ?? []).map((r: Json) => r.error).join(" | "));
	}
	for (const w of wants) {
		const m = found.get(w.key);
		if (!m) continue;
		if (w.replyTo) {
			const target = found.get(w.replyTo);
			check(`${label}: ${w.key} answers ${w.replyTo}`, !!target && m.replyTo === target.id, `replyTo ${m.replyTo}, ${w.replyTo} is ${target?.id}`);
		} else check(`${label}: ${w.key} answers nothing`, !m.replyTo, String(m.replyTo));
		for (const before of w.after ?? []) {
			const b = found.get(before);
			if (b) check(`${label}: ${before} comes before ${w.key}`, msgs.indexOf(b) < msgs.indexOf(m) && b.at <= m.at, `${b.id}@${b.at} / ${m.id}@${m.at}`);
		}
	}
	const known = new Set([...found.values()].map(m => m.id));
	const extra = msgs.filter(m => !known.has(m.id));
	check(`${label}: nothing else on the board`, extra.length === 0, extra.map(m => `${m.from}→${m.to}: ${String(m.text).slice(0, 60)}`).join(" | "));
	const sorted = msgs.every((m, i) => i === 0 || msgs[i - 1]!.at <= m.at);
	check(`${label}: oldest first`, sorted);
	return found;
}

function table(label: string, msgs: Json[]): void {
	console.log(`\n${label}:`);
	const t = (ms: number) => new Date(ms).toISOString().slice(11, 23);
	for (const m of msgs) {
		const flags = [m.broadcast && "broadcast", m.progress && "progress", m.wakeRelay && "wakeRelay", m.replyTo && `replyTo ${m.replyTo}`].filter(Boolean).join(", ");
		console.log(`  ${m.id.padEnd(4)} ${t(m.at)} ${m.from} → ${m.to.join(", ")}${flags ? ` [${flags}]` : ""}: ${JSON.stringify(String(m.text).slice(0, 70))}  {${receipts(m)}}`);
	}
}

/** Follows the log until `done` holds (every 400 ms, incrementally). */
async function follow(board: Board, secs: number, done: (msgs: Json[]) => boolean): Promise<Json[]> {
	return until("the board never got every message", secs, async () => {
		await board.fetch();
		const msgs = board.messages();
		return done(msgs) ? msgs : undefined;
	}, 400);
}

const settledReceipts = (msgs: Json[], wants: Want[]) => wants.every(w => msgs.some(m => String(m.text).startsWith(w.text) && (m.receipts ?? []).length === w.to.length && m.receipts.every((r: Json) => r.outcome !== "pending")));

async function meta(agentId: string): Promise<Json | undefined> {
	return (await call("session.open", { agentId, limit: 1 })).meta?.agentChat;
}

// ─── phases ─────────────────────────────────────────────────────────────────────────────────────

await connect();
const host = await until("host lab never answered state.get", 180, () => call("state.get", {}, 10_000), 1000);
say(`host lab online: tf-hostd ${host.info?.hostdVersion}, omp ${host.info?.omp?.version ?? "?"}, herdr session ${host.info?.herdrSession}`);

let agentId = opt("--agent") ?? "";

async function runTree(board: Board, label: string): Promise<Json[]> {
	await prompt(board.agentId, "ACB-TREE: run the agent chat lab tree.");
	const msgs = await follow(board, 300, m => settledReceipts(m, TREE));
	await said(board.agentId, "ACB-LAB tree done");
	await settled(board.agentId);
	say(`${label}: the tree is done (${msgs.length} messages, ${board.resets} reset(s), rev ${board.rev})`);
	// What the user sends from the board: one subagent, then every subagent at once.
	say(`${label}: agent.subagent chat → ${A}`);
	await call("agent.subagent", { agentId: board.agentId, subagentId: A, action: "chat", message: "ACB user→a: Thanks, all done here." });
	for (const to of [O, A, B]) {
		say(`${label}: agent.subagent chat (broadcast) → ${to}`);
		await call("agent.subagent", { agentId: board.agentId, subagentId: to, action: "chat", message: "ACB user→all: Wrap up, we ship tonight.", broadcast: true });
	}
	return follow(board, 120, m => settledReceipts(m, [...TREE, ...USER]));
}

for (const phase of order) {
	console.log(`\n── ${phase}`);
	if (phase === "live") {
		const started = await startAgent("chatlab");
		agentId = started.agentId;
		const exe = Bun.spawnSync(["readlink", "-f", `/proc/${started.first.omp.pid}/exe`]).stdout.toString().trim();
		check("the agent runs the lab's pinned omp 18.15.0", exe === env.OMP && String(started.first.omp.version).includes("18.15.0"), `${exe}, ${started.first.omp.version}`);
		const before = await meta(agentId);
		check("the session meta names a live log (bridge 2.3.0, caps.agentChat)", before?.live === true && typeof before.epoch === "string", JSON.stringify(before));
		const board = new Board(agentId);
		const msgs = await runTree(board, "live");
		table("live log (incremental copy)", msgs);
		checkLog("live", msgs, [...TREE, ...USER]);
		check("live: one epoch throughout (no reset after the first fetch)", board.resets === 1, `${board.resets} resets`);
		const whole = await call("session.agentChat", { agentId });
		check("live: the incremental copy equals a full fetch", JSON.stringify(whole.messages) === JSON.stringify(board.messages()), `${whole.messages.length} vs ${msgs.length}`);
		check("live: the log says it is live", whole.live === true);
		// The meta follows the log within its coalescing window (one `meta` per session per 500 ms).
		const same = (x: Json | undefined) => x?.epoch === whole.epoch && x?.rev === whole.rev && x?.count === whole.messages.length && x?.live === true;
		const m = await until("the meta never caught up", 10, async () => {
			const x = await meta(agentId);
			return same(x) ? x : undefined;
		}).catch(() => meta(agentId));
		check("live: the meta names the log's epoch, revision and count", same(m), JSON.stringify(m));
		const pendingSeen = [...board.seen.entries()].filter(([, s]) => s.length > 1).map(([text, s]) => `${text.slice(0, 18)}: ${s.join(" → ")}`);
		say(`receipt changes seen while following: ${pendingSeen.join("; ") || "none"}`);
	}
	if (phase === "restart") {
		const before = await call("session.agentChat", { agentId });
		say(`stopping tf-hostd (log epoch ${before.epoch}, rev ${before.rev}, ${before.messages.length} messages)`);
		const hostdBin = join(env.HOSTD_HOME!, "bin", "tf-hostd");
		say(inLab(existsSync(hostdBin) ? hostdBin : env.HOSTD!, "stop").trim() || "tf-hostd stop: ok");
		await until("tf-hostd never stopped", 30, async () => (inLab("sh", "-c", `test -S ${env.HOSTD_HOME}/run/hostd.sock && echo up || echo down`).includes("down") ? true : undefined)).catch(() => say("the socket stayed (a new daemon may already run)"));
		await until("the host never came back", 120, async () => (await call("state.get", {}, 10_000)).info?.hostdVersion, 1000);
		const back = await live(agentId);
		say(`host back, agent ${agentId} live again (bridge ${back.omp.bridge})`);
		const m = await meta(agentId);
		check("restart: the meta names a new epoch", !!m && m.epoch !== before.epoch, `${before.epoch} → ${m?.epoch}`);
		const board = new Board(agentId);
		const msgs = await follow(board, 60, x => x.length >= before.messages.length).catch(() => board.messages());
		table("after the restart (rebuilt from the session files)", msgs);
		// What omp's files cannot tell: a wake relay has no sender-side record (omp sends it, not a
		// `write` call), and the user's request is not in a file (the subagent's prompt is), so their
		// receipts are what the recipients' files show.
		checkLog("restart", msgs, [...TREE, ...USER], { filesOnly: true, outcomes: (w, to) => (w.key === "relay" || w.from === "user" ? ["received"] : w.outcomes[to]!) });
		const shape = (x: Json[]) => x.map(y => `${y.from}>${[...y.to].sort().join(",")}:${y.text}`);
		check("restart: the same messages as before the restart, in the same order", JSON.stringify(shape(msgs)) === JSON.stringify(shape(before.messages)), `${msgs.length} vs ${before.messages.length}`);
	}
	if (phase === "ping") {
		const board = new Board(agentId);
		await board.fetch();
		const base = board.messages().length;
		await prompt(agentId, "ACB-PING: ask the Orchestrator whether it is still there.");
		await said(agentId, "ACB-LAB ping done");
		const msgs = await follow(board, 60, x => settledReceipts(x, PING));
		table("after ACB-PING", msgs.slice(base));
		checkLog("ping", msgs.slice(base), PING);
		const page = await call("session.agentChat", { agentId });
		check("ping: still a live log after the restart", page.live === true);
	}
	if (phase === "old") {
		const ext = join(env.HOSTD_HOME!, "ext", "teleflock-bridge.ts");
		const keep = `${ext}.lab-keep`;
		copyFileSync(ext, keep);
		copyFileSync(env.OLD_BRIDGE!, ext);
		let old: { agentId: string; first: Json };
		try {
			old = await startAgent("oldchat");
		} finally {
			copyFileSync(keep, ext);
		}
		const hello = await until("hostd never logged the old agent's bridge", 30, async () =>
			readFileSync(join(env.HOSTD_HOME!, "hostd.log"), "utf8")
				.split("\n")
				.find(l => l.includes("bridge connected") && l.includes(`pid=${old.first.omp.pid}`)),
		);
		check("old: the agent loaded the last release's bridge (2.2.0)", hello.includes("version=2.2.0"), hello.replace(/^.*bridge connected/, "bridge connected"));
		const m = await meta(old.agentId);
		check("old: the meta names a log that is not live (no caps.agentChat)", m?.live === false, JSON.stringify(m));
		const board = new Board(old.agentId);
		const msgs = await runTree(board, "old");
		table("older bridge (transcript files only)", msgs);
		// Without the tap, a leg's outcome is what omp's files hold: the sender's `write` result (its
		// receipts), else the recipient's row (`received`).
		checkLog("old", msgs, [...TREE, ...USER], { filesOnly: true, outcomes: (w, to) => (w.key === "relay" ? ["received"] : w.outcomes[to]!) });
		check("old: the log says it is not live", board.live === false);
	}
}

console.log(`\nagent ${agentId}`);
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
sock.close();
process.exit(failed ? 1 : 0);
