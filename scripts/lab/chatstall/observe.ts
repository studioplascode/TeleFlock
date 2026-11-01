#!/usr/bin/env bun
/**
 * ChatStall observer: plays the TeleFlock app against a lab tf-hostd and times whether (and when)
 * the transcript catches up with omp's turn.
 *
 * Attaches through `tf-hostd attach` (plain JSON lines: a hello without `features`), starts an omp
 * agent in the lab's work dir (`agent.start`, or `--agent ID` reuses one), waits until its link is
 * live, opens its session (`session.open`, limit 300), sends the scripted prompt (`agent.prompt`
 * with CHATSTALL-LAB) and from then on applies every `session` event to a local transcript (reset /
 * upsert / append / remove, as src/core/store/reduce.ts applySession does) and polls `state.get`
 * every second. Ground truth comes from omp's own session file (the path hostd reports).
 *
 * Timeline (ms since the prompt): rows appearing, tool rows changing status, host state changes
 * (column, herdr state, link, liveness), the host's turn end (column review/done after running),
 * omp's entries landing in its session file (OMP-END: the final answer), the transcript showing the
 * final answer complete (FINAL: last row is the assistant answer with the table, not streaming), and
 * the lines of hostd.log matching warn/repair/stall/resync, of the bridge fault log and of the mock.
 * Verdict: `caught_up_after_turn_end_ms` (transcript final − host turn end; ≤ 0: the transcript was
 * there first) and `caught_up_after_omp_end_ms` (− omp's file), or FROZEN after the timeout with the
 * stuck rows. Writes <logs>/observe-<label>-<time>.{log,json}; exit 0 caught up, 2 frozen, 1 error.
 *
 * Usage (inside the lab): scripts/lab/run <lab> -- bun scripts/lab/chatstall/observe.ts \
 *   --lab-env /tmp/tf-lab-<lab>/lab.env [--label NAME] [--timeout 180] [--agent ID] [--settle 5]
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { FINAL_ANSWER, FINAL_END, PROMPT } from "./turn.ts";

type Json = Record<string, any>;

// ── options ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
}
const labEnvFile = opt("lab-env") ?? (process.env.TF_LAB ? `/tmp/tf-lab-${process.env.TF_LAB}/lab.env` : undefined);
const L: Record<string, string> = {};
if (labEnvFile && existsSync(labEnvFile)) {
	for (const line of readFileSync(labEnvFile, "utf8").split("\n")) {
		const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
		if (m) L[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
	}
}
const HOSTD = opt("hostd") ?? L.HOSTD ?? "";
const SESSION = opt("session") ?? L.SESSION ?? "";
const RELAY = opt("relay-port") ?? L.RELAY_PORT ?? "";
const CWD = opt("cwd") ?? L.WORK ?? "";
const HOME = opt("hostd-home") ?? L.HOSTD_HOME ?? process.env.TF_HOSTD_HOME ?? "";
const LOGS = opt("logs") ?? L.LOGS ?? "/tmp";
const ROOT = L.ROOT ?? `${HOME}/..`;
const LABEL = opt("label") ?? L.LAB ?? "run";
const TIMEOUT_MS = Number(opt("timeout") ?? 180) * 1000;
const SETTLE_MS = Number(opt("settle") ?? 5) * 1000;
const REUSE = opt("agent");
const TEXT = opt("prompt") ?? PROMPT;
if (!HOSTD || !SESSION || !RELAY || !CWD || !HOME) {
	console.error("observe: need --lab-env (setup.sh writes it) or --hostd --session --relay-port --cwd --hostd-home");
	process.exit(1);
}
if (!HOME.startsWith("/tmp/")) {
	console.error(`observe: TF_HOSTD_HOME ${HOME} is not a lab home`);
	process.exit(1);
}

// ── timeline ───────────────────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = `${LOGS}/observe-${LABEL}-${stamp}`;
const begun = Date.now();
let t0 = 0; // the prompt went out (host and observer share the clock)
const events: { ms: number; kind: string; text: string }[] = [];

function note(kind: string, text: string, at = Date.now()): void {
	const ms = t0 ? at - t0 : at - begun;
	const when = t0 ? `${ms >= 0 ? "+" : "-"}${(Math.abs(ms) / 1000).toFixed(3)}s` : `setup ${(ms / 1000).toFixed(1)}s`;
	const line = `${when.padStart(10)} ${kind.padEnd(9)} ${text}`;
	console.log(line);
	try {
		appendFileSync(`${base}.log`, `${line}\n`);
	} catch {}
	if (t0) events.push({ ms, kind, text });
}

// ── link to tf-hostd ───────────────────────────────────────────────────────────────────────────
const attach = Bun.spawn([HOSTD, "--relay-port", RELAY, "attach", "--session", SESSION], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: Bun.file(`${base}.attach.stderr`),
});
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: Timer }>();
let nextId = 1;
let host: Json = { agents: [] };
const welcome = Promise.withResolvers<void>();

function send(obj: Json): void {
	attach.stdin.write(`${JSON.stringify(obj)}\n`);
	attach.stdin.flush();
}

function call(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
	const id = nextId++;
	const { promise, resolve, reject } = Promise.withResolvers<Json>();
	const timer = setTimeout(() => {
		pending.delete(id);
		reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
	}, timeoutMs);
	pending.set(id, { resolve, reject, timer });
	send({ t: "req", id, method, params });
	return promise;
}

(async () => {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of attach.stdout) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
			if (!line.trim()) continue;
			let m: Json;
			try {
				m = JSON.parse(line);
			} catch {
				note("wire", `unparsable line (${line.length} bytes)`);
				continue;
			}
			onMessage(m);
		}
	}
	note("wire", "tf-hostd attach closed its output");
})();

function onMessage(m: Json): void {
	switch (m.t) {
		case "welcome":
			note("wire", `welcome: hostd ${m.hostdVersion}, client ${m.clientId}`);
			welcome.resolve();
			break;
		case "snapshot":
			host = m.state;
			observeHost();
			break;
		case "patch":
			for (const op of m.ops ?? []) {
				if (op.op === "agent") {
					host.agents = (host.agents ?? []).filter((a: Json) => a.id !== op.id);
					if (op.value) host.agents.push(op.value);
				} else if (op.op === "info") host.info = op.info;
			}
			observeHost();
			break;
		case "res": {
			const p = pending.get(m.id);
			if (!p) break;
			pending.delete(m.id);
			clearTimeout(p.timer);
			if (m.error) p.reject(new Error(`${m.error.code}: ${m.error.message}`));
			else p.resolve(m.result);
			break;
		}
		case "session":
			if (m.agentId === agentId) onSession(m.ev);
			break;
		case "error":
			note("wire", `hostd error: ${JSON.stringify(m.error)}`);
			break;
	}
}

// ── transcript (applySession semantics) ────────────────────────────────────────────────────────
let rows = new Map<string, Json>();
let order: string[] = [];
let resets = 0;
let firstRowAt = 0;
let transcriptFinalAt = 0;
let finalExact = false;
const seen = new Map<string, { status?: string; streaming?: boolean; args?: string }>();

function argsText(r: Json): string {
	const a = { ...(r.args ?? {}) };
	delete a.i;
	return JSON.stringify(a);
}

function rowLabel(r: Json): string {
	const id = String(r.id).slice(-10);
	switch (r.kind) {
		case "tool":
			return `tool ${r.tool} …${id} [${r.status}] args=${argsText(r).slice(0, 140)}`;
		case "thinking":
			return `thinking …${id}${r.redacted ? " (redacted)" : ""}${r.streaming ? " streaming" : ""} ${String(r.text ?? "").length} chars`;
		case "assistant":
			return `assistant …${id}${r.streaming ? " streaming" : ""} ${String(r.text ?? "").length} chars${r.error ? ` error=${r.error}` : ""}`;
		case "user":
			return `user …${id} ${JSON.stringify(String(r.text ?? "").slice(0, 60))}`;
		default:
			return `${r.kind} …${id} ${JSON.stringify(r.text ?? r.summary ?? "").slice(0, 80)}`;
	}
}

function reset(items: Json[]): void {
	rows = new Map();
	order = [];
	for (const it of items) {
		if (!rows.has(it.id)) order.push(it.id);
		rows.set(it.id, it);
	}
}

function onSession(ev: Json): void {
	switch (ev.k) {
		case "reset":
			resets++;
			reset(ev.snapshot?.items ?? []);
			note("RESET", `session reset #${resets}: ${order.length} rows`);
			break;
		case "upsert": {
			const fresh = !rows.has(ev.item.id);
			rows.set(ev.item.id, ev.item);
			if (fresh) order.push(ev.item.id);
			break;
		}
		case "append": {
			const it = rows.get(ev.id);
			if (!it) break;
			const next = { ...it };
			if (ev.field === "text" && "text" in next) next.text = (next.text ?? "") + ev.text;
			else if (ev.field === "output" && next.kind === "tool") next.output = (next.output ?? "") + ev.text;
			rows.set(ev.id, next);
			break;
		}
		case "remove":
			if (!rows.has(ev.id)) break;
			rows.delete(ev.id);
			order = order.filter(id => id !== ev.id);
			break;
		case "ended":
			note("session", `ended: ${ev.reason}`);
			break;
		default:
			return;
	}
	observeRows();
}

/** The last content row (notices, mode markers and IRC rows aside). */
function lastContentRow(): Json | undefined {
	for (let i = order.length - 1; i >= 0; i--) {
		const r = rows.get(order[i]!);
		if (r && ["assistant", "tool", "thinking", "user"].includes(r.kind)) return r;
	}
	return undefined;
}

function observeRows(): void {
	for (const id of order) {
		const r = rows.get(id)!;
		const prev = seen.get(id);
		const cur = { status: r.status, streaming: r.streaming, args: r.kind === "tool" ? argsText(r) : undefined };
		seen.set(id, cur);
		if (!prev) {
			if (!t0) continue;
			if (!firstRowAt) {
				firstRowAt = Date.now();
				note("FIRST", `first row after the prompt: ${rowLabel(r)}`);
			} else note("row+", rowLabel(r));
			continue;
		}
		if (prev.status !== cur.status) note("tool", `${r.tool} …${String(id).slice(-10)} ${prev.status} → ${cur.status} args=${argsText(r).slice(0, 140)}`);
		if (prev.streaming !== cur.streaming && r.kind !== "tool") note("row", `${rowLabel(r)} (streaming ${prev.streaming} → ${cur.streaming})`);
	}
	for (const id of [...seen.keys()]) {
		if (!rows.has(id)) {
			seen.delete(id);
			note("row-", `removed …${String(id).slice(-10)}`);
		}
	}
	const last = lastContentRow();
	const done = !!last && last.kind === "assistant" && !last.streaming && String(last.text).includes("|---|") && String(last.text).includes(FINAL_END);
	if (done && !transcriptFinalAt && t0) {
		transcriptFinalAt = Date.now();
		finalExact = last!.text === FINAL_ANSWER;
		note("FINAL", `transcript shows the final answer complete (${String(last!.text).length} chars, ${finalExact ? "exactly as streamed" : "DIFFERS from what the mock streamed"})`);
	} else if (!done && transcriptFinalAt) {
		note("FINAL", "the final answer row is no longer complete/last (a reset or a later row)");
		transcriptFinalAt = 0;
	}
}

// ── host state ─────────────────────────────────────────────────────────────────────────────────
let agentId = REUSE ?? "";
let lastTuple = "";
let sawRunning = false;
let hostTurnEndAt = 0;
let lastTurnEndedSeen = 0;

function agent(): Json | undefined {
	return (host.agents ?? []).find((a: Json) => a.id === agentId);
}

function observeHost(): void {
	const a = agent();
	if (!a) return;
	const omp = a.omp ?? {};
	const live = [a.live?.streaming && "streaming", a.live?.thinking && "thinking", a.live?.tool && `tool:${a.live.tool.label ?? a.live.tool.name}`].filter(Boolean).join(",") || "-";
	const tuple = `column=${a.column} herdr=${a.state} link=${omp.link}${omp.linkReason ? `(${omp.linkReason})` : ""}${omp.linkVia ? ` via=${omp.linkVia}` : ""} live=${live}`;
	if (tuple !== lastTuple) {
		lastTuple = tuple;
		note("host", tuple);
	}
	if (!t0) return;
	if (a.column === "running" || a.column === "needs") sawRunning = true;
	if (sawRunning && !hostTurnEndAt && (a.column === "review" || a.column === "done")) {
		hostTurnEndAt = Date.now();
		note("TURN-END", `host state says the turn ended (column ${a.column})`);
	}
	const ended = Number(omp.lastTurnEndedAt ?? 0);
	if (ended > t0 && ended !== lastTurnEndedSeen) {
		lastTurnEndedSeen = ended;
		note("host", `omp.lastTurnEndedAt = +${((ended - t0) / 1000).toFixed(3)}s`);
		// Without herdr's omp integration the column never leaves review: hostd's own turn end counts.
		if (!hostTurnEndAt) {
			hostTurnEndAt = ended;
			note("TURN-END", "host state says the turn ended (omp.lastTurnEndedAt)", ended);
		}
	}
}

// ── omp's session file (ground truth) and the lab's logs ───────────────────────────────────────
let ompTurnEndAt = 0;
const fileEntries = new Set<string>();

function scanSessionFile(): void {
	const file = agent()?.omp?.sessionFile;
	if (!t0 || !file || !existsSync(file)) return;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.startsWith("{")) continue;
		let e: Json;
		try {
			e = JSON.parse(line);
		} catch {
			continue; // a line being written
		}
		if (e.type !== "message" || !e.id || fileEntries.has(e.id)) continue;
		fileEntries.add(e.id);
		const at = Date.parse(e.timestamp ?? "") || Date.now();
		if (at < t0 - 1000) continue;
		const msg = e.message ?? {};
		const content: Json[] = Array.isArray(msg.content) ? msg.content : [];
		const what = content.map(b => (b.type === "toolCall" ? `toolCall:${b.name}` : b.type === "text" ? `text(${b.text.length})` : b.type)).join(" ");
		note("omp-file", `${msg.role}${msg.toolName ? ` ${msg.toolName}` : ""} ${what}${msg.stopReason ? ` stop=${msg.stopReason}` : ""}`, at);
		if (msg.role === "assistant" && content.some(b => b.type === "text" && String(b.text).includes(FINAL_END))) {
			ompTurnEndAt = at;
			note("OMP-END", "omp wrote the final answer to its session file", at);
		}
	}
}

const tails = new Map<string, number>();
/** New complete lines of `file` since the last call (starts at its size when first seen). */
function newLines(file: string): string[] {
	if (!existsSync(file)) return [];
	const size = statSync(file).size;
	const from = tails.get(file);
	if (from === undefined || size < from) {
		tails.set(file, from === undefined ? size : 0);
		if (from === undefined) return [];
	}
	const start = tails.get(file)!;
	if (size <= start) return [];
	const buf = Buffer.alloc(size - start);
	const fd = openSync(file, "r");
	readSync(fd, buf, 0, buf.length, start);
	closeSync(fd);
	const text = buf.toString("utf8");
	const end = text.lastIndexOf("\n");
	if (end < 0) return [];
	tails.set(file, start + Buffer.byteLength(text.slice(0, end + 1)));
	return text.slice(0, end).split("\n");
}

const HOSTD_LOG = `${HOME}/hostd.log`;
const BRIDGE_LOG = `${ROOT}/logs/chatstall-bridge-fault.log`;
const MOCK_LOG = `${LOGS}/mock.log`;
const HOSTD_HITS = /\b(WARN|ERROR)\b|\brepair|\bstall|resync|\breload|catch.?up|self.?heal|\bfreez/i;
let hostdHits = 0;

function tailLogs(): void {
	for (const line of newLines(HOSTD_LOG)) {
		if (!HOSTD_HITS.test(line)) continue;
		hostdHits++;
		const at = Date.parse(line.slice(0, 30).trim().split(/\s+/)[0] ?? "");
		note("hostd", line.replace(/^\S+\s+/, "").slice(0, 400), Number.isFinite(at) ? at : Date.now());
	}
	for (const line of newLines(BRIDGE_LOG)) {
		const at = Date.parse(line.split(" ")[0] ?? "");
		note("bridge", line.replace(/^\S+\s+/, ""), Number.isFinite(at) ? at : Date.now());
	}
	for (const line of newLines(MOCK_LOG)) {
		if (!line.includes("#")) continue;
		const at = Date.parse(line.split(" ")[0] ?? "");
		note("mock", line.replace(/^\S+\s+/, ""), Number.isFinite(at) ? at : Date.now());
	}
}

async function poll(): Promise<void> {
	try {
		host = await call("state.get", {}, 10_000);
	} catch (e) {
		note("wire", `state.get: ${String(e)}`);
	}
	observeHost();
	scanSessionFile();
	tailLogs();
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
	note("setup", `observer ${LABEL}: hostd ${HOSTD}, session ${SESSION}, relay ${RELAY}, cwd ${CWD}`);
	tailLogs(); // positions the tails at the logs' current ends
	send({ t: "hello", protocol: 1, client: { app: "teleflock-lab", version: "0.7.0", platform: "linux", device: `chatstall-observer-${LABEL}` }, herdrSession: SESSION });
	await Promise.race([welcome.promise, Bun.sleep(60_000).then(() => Promise.reject(new Error("no welcome within 60 s")))]);
	const pinger = setInterval(() => send({ t: "ping", ts: Date.now() }), 10_000);

	if (!agentId) {
		const started = await call(
			"agent.start",
			{ target: { kind: "cwd", cwd: CWD, label: "chatstall" }, spec: { kind: "omp", name: "chatstall", model: "chatstall/lab-1", plan: false } },
			180_000,
		);
		note("setup", `agent.start → ${JSON.stringify(started)}`);
		agentId = started.agentId ?? "";
		for (let i = 0; !agentId && i < 120; i++) {
			await Bun.sleep(1000);
			host = await call("state.get", {}, 10_000);
			agentId = (host.agents ?? []).find((a: Json) => a.paneId === started.paneId)?.id ?? "";
		}
		if (!agentId) throw new Error("herdr never reported the started agent");
	}
	for (let i = 0; agent()?.omp?.link !== "live"; i++) {
		if (i >= 180) throw new Error(`the agent's link never went live: ${lastTuple}`);
		await Bun.sleep(1000);
		await poll();
	}
	note("setup", `agent ${agentId} is live (omp session ${agent()?.omp?.sessionId}, file ${agent()?.omp?.sessionFile})`);
	const snap = await call("session.open", { agentId, limit: 300 }, 60_000);
	reset(snap.items ?? []);
	observeRows();
	note("setup", `session.open: ${order.length} rows, hasMore=${snap.hasMore}`);

	t0 = Date.now();
	await call("agent.prompt", { agentId, text: TEXT, images: [], delivery: "auto" }, 60_000);
	note("PROMPT", `agent.prompt sent (${TEXT.length} chars) at ${new Date(t0).toISOString()}`, t0);

	let settledAt = 0;
	while (Date.now() - t0 < TIMEOUT_MS) {
		await Bun.sleep(1000);
		await poll();
		if (transcriptFinalAt && (hostTurnEndAt || Date.now() - transcriptFinalAt > 20_000)) {
			settledAt ||= Date.now();
			if (Date.now() - settledAt >= SETTLE_MS) break;
		} else settledAt = 0;
	}
	clearInterval(pinger);

	const frozen = !transcriptFinalAt;
	const rel = (at: number) => (at ? at - t0 : null);
	const stuck = order
		.map(id => rows.get(id)!)
		.filter(r => r.streaming === true || (r.kind === "tool" && !["ok", "error", "aborted", "denied"].includes(r.status)));
	if (frozen) {
		note("FROZEN", `no complete final answer in the transcript ${(TIMEOUT_MS / 1000).toFixed(0)} s after the prompt${ompTurnEndAt ? ` (omp finished at +${((ompTurnEndAt - t0) / 1000).toFixed(3)}s)` : ""}`);
		for (const r of stuck) note("stuck", `${rowLabel(r)} full args=${r.kind === "tool" ? argsText(r) : "-"}`);
		for (const id of order.slice(-6)) note("last", rowLabel(rows.get(id)!));
	}

	// The same session through a fresh open: what hostd itself holds by now.
	let fresh: Json = {};
	try {
		const s = await call("session.open", { agentId, limit: 300 }, 60_000);
		const items: Json[] = s.items ?? [];
		const last = [...items].reverse().find(r => ["assistant", "tool", "thinking", "user"].includes(r.kind));
		const mirror = order.map(id => JSON.stringify(rows.get(id)));
		const diffs = items.filter((r, i) => JSON.stringify(r) !== mirror[i]).length + Math.abs(items.length - mirror.length);
		fresh = { rows: items.length, final: !!last && last.kind === "assistant" && !last.streaming && String(last.text).includes(FINAL_END), rows_differing_from_mirror: diffs };
		note("check", `fresh session.open: ${items.length} rows, final answer ${fresh.final ? "present" : "MISSING"}, ${diffs} rows differ from the observed mirror`);
	} catch (e) {
		fresh = { error: String(e) };
	}
	tailLogs();

	const result = {
		label: LABEL,
		lab: L.LAB,
		hostd: HOSTD,
		hostd_env: L.HOSTD_ENV || undefined,
		bridge: L.BRIDGE,
		agent: agentId,
		verdict: frozen ? "FROZEN" : "caught_up",
		prompt_at: new Date(t0).toISOString(),
		first_row_ms: rel(firstRowAt),
		host_turn_end_ms: rel(hostTurnEndAt),
		omp_turn_end_ms: rel(ompTurnEndAt),
		transcript_final_ms: rel(transcriptFinalAt),
		caught_up_after_turn_end_ms: transcriptFinalAt && hostTurnEndAt ? transcriptFinalAt - hostTurnEndAt : null,
		caught_up_after_omp_end_ms: transcriptFinalAt && ompTurnEndAt ? transcriptFinalAt - ompTurnEndAt : null,
		final_exact: transcriptFinalAt ? finalExact : null,
		resets,
		hostd_log_hits: hostdHits,
		host_final: lastTuple,
		stuck_rows: frozen ? stuck.map(rowLabel) : undefined,
		fresh_open: fresh,
		log: `${base}.log`,
	};
	writeFileSync(`${base}.json`, `${JSON.stringify({ ...result, events }, null, 2)}\n`);
	console.log(`RESULT ${JSON.stringify(result)}`);
	send({ t: "bye" });
	return frozen ? 2 : 0;
}

main()
	.then(code => {
		attach.kill();
		process.exit(code);
	})
	.catch(e => {
		note("ERROR", String(e?.stack ?? e));
		attach.kill();
		process.exit(1);
	});
