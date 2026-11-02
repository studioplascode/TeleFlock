#!/usr/bin/env bun
/**
 * Refusal fallback lab driver: plays the TeleFlock app against the lab tf-hostd (setup.sh) through
 * `tf-hostd attach` (plain JSON lines) and checks what the host does when the provider refuses a turn.
 *
 * The mock provider (mock.ts) refuses every turn on Opus (`stop_reason: "refusal"`, `stop_details`
 * type `refusal`, category `cyber`) and answers on Sonnet; Haiku refuses too. Real omp and herdr, the
 * working tree's bridge and tf-hostd run the rest. After the prompt the driver does nothing: whatever
 * continues, continues on the host's own.
 *
 * Scenarios (each prints its evidence: the transcript's rows, the model, the mock's requests, the
 * Activity entries and notifications that came with it):
 *   no-rule      no rule: the turn stays refused, Activity and the notification say so once, nothing else
 *   other-rule   a rule for another category: the same
 *   rule-stay    rule opus → sonnet (cyber): the turn continues on Sonnet by itself, no new prompt; the
 *                transcript shows the notice; one Activity entry, one notification; the agent stays on Sonnet
 *   rule-back    the same with `after: back`: the agent returns to Opus once the continued turn ended
 *   retry-with   no rule; the app's one-off `agent.refusalRetry` continues the refused turn on Sonnet
 *   loop-guard   rules opus → haiku and haiku → opus: Haiku refuses the same turn, nothing loops
 *   omp-chain    omp's own fallback chain recovers the turn: hostd stays out of it and posts no refusal
 *
 * Usage (inside the lab): scripts/lab/run <lab> -- bun scripts/lab/refusal/drive.ts \
 *   --lab-env /tmp/tf-lab-<lab>/lab.env [--only name[,name…]] [--quiet 8]
 * Writes <logs>/drive-<time>.log. Exit 0: every check held; 2: a check failed; 1: error.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { sleep } from "bun";

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
const HOSTD = L.HOSTD ?? "";
const SESSION = L.SESSION ?? "";
const RELAY = L.RELAY_PORT ?? "";
const CWD = L.WORK ?? "";
const HOME = L.HOSTD_HOME ?? "";
const LOGS = L.LOGS ?? "/tmp";
if (!HOSTD || !SESSION || !RELAY || !CWD || !HOME || !HOME.startsWith("/tmp/")) {
	console.error("drive: need --lab-env (setup.sh writes it) of a lab under /tmp");
	process.exit(1);
}
const ONLY = opt("only")?.split(",");
const QUIET_MS = Number(opt("quiet") ?? 8) * 1000;

const OPUS = "refusal-lab/lab-opus-5-5";
const SONNET = "refusal-lab/lab-sonnet-5-5";
const HAIKU = "refusal-lab/lab-haiku-5-5";
const NOTICE = "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued";

// ── output ─────────────────────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = `${LOGS}/drive-${stamp}.log`;
const begun = Date.now();
let t0 = begun;
const failures: string[] = [];
let checks = 0;

function note(kind: string, text: string): void {
	const ms = Date.now() - t0;
	const line = `${`+${(ms / 1000).toFixed(1)}s`.padStart(8)} ${kind.padEnd(9)} ${text}`;
	console.log(line);
	try {
		appendFileSync(logFile, `${line}\n`);
	} catch {}
}

function check(ok: boolean, what: string, detail?: unknown): void {
	checks++;
	if (ok) note("ok", what);
	else {
		failures.push(what);
		note("FAIL", `${what}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	}
}

async function until<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = probe();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out after ${(ms / 1000).toFixed(0)}s waiting for ${what}`);
		await sleep(150);
	}
}

// ── link to tf-hostd ───────────────────────────────────────────────────────────────────────────
const attach = Bun.spawn([HOSTD, "--relay-port", RELAY, "attach", "--session", SESSION], { stdin: "pipe", stdout: "pipe", stderr: Bun.file(`${LOGS}/drive-${stamp}.attach.stderr`) });
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: Timer }>();
let nextId = 1;
let host: Json = { agents: [] };
const welcome = Promise.withResolvers<void>();
/** What the app was told: every `notify` message, with the time it came. */
const notifications: { at: number; n: Json }[] = [];
/** Per agent: the transcript the app would show (applySession semantics). */
const mirrors = new Map<string, Json[]>();

function send(obj: Json): void {
	attach.stdin.write(`${JSON.stringify(obj)}\n`);
	attach.stdin.flush();
}

function call(method: string, params: Json, timeoutMs = 60_000): Promise<Json> {
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

function applySession(agentId: string, ev: Json): void {
	let rows = mirrors.get(agentId);
	switch (ev.k) {
		case "reset":
			mirrors.set(agentId, [...(ev.snapshot?.items ?? [])]);
			return;
		case "upsert": {
			if (!rows) return;
			const i = rows.findIndex(r => r.id === ev.item.id);
			if (i >= 0) rows[i] = ev.item;
			else rows.push(ev.item);
			return;
		}
		case "append": {
			const r = rows?.find(x => x.id === ev.id);
			if (!r) return;
			if (ev.field === "text") r.text = (r.text ?? "") + ev.text;
			else if (ev.field === "output") r.output = (r.output ?? "") + ev.text;
			return;
		}
		case "remove":
			if (rows) mirrors.set(agentId, rows.filter(r => r.id !== ev.id));
			return;
	}
}

(async () => {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of attach.stdout) {
		buf += decoder.decode(chunk, { stream: true });
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			let m: Json;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			switch (m.t) {
				case "welcome":
					welcome.resolve();
					break;
				case "snapshot":
					host = m.state;
					break;
				case "patch":
					for (const op of m.ops ?? []) {
						if (op.op === "agent") {
							host.agents = (host.agents ?? []).filter((a: Json) => a.id !== op.id);
							if (op.value) host.agents.push(op.value);
						} else if (op.op === "info") host.info = op.info;
					}
					break;
				case "notify":
					notifications.push({ at: Date.now(), n: m.notification });
					break;
				case "res": {
					const p = pending.get(m.id);
					if (!p) break;
					pending.delete(m.id);
					clearTimeout(p.timer);
					if (m.error) p.reject(Object.assign(new Error(`${m.error.code}: ${m.error.message}`), { code: m.error.code, hint: m.error.hint }));
					else p.resolve(m.result);
					break;
				}
				case "session":
					applySession(m.agentId, m.ev);
					break;
				case "error":
					note("wire", `hostd error: ${JSON.stringify(m.error)}`);
					break;
			}
		}
	}
})();

// ── what the host and the mock say ─────────────────────────────────────────────────────────────
interface Agent {
	id: string;
	name: string;
}

const agentOf = (a: Agent): Json => (host.agents ?? []).find((x: Json) => x.id === a.id) ?? {};
const modelOf = (a: Agent): string => {
	const m = agentOf(a).omp?.model;
	return m ? `${m.provider}/${m.id}` : "?";
};
const thinkingOf = (a: Agent): string => String(agentOf(a).omp?.thinking ?? "-");
const rowsOf = (a: Agent): Json[] => mirrors.get(a.id) ?? [];

/** One request of the agent under test to the mock (side calls left out). */
interface Req {
	n: number;
	model: string;
	refuses: boolean;
	msgs: number;
	users: number;
	lastUser: string;
	at: number;
}

function mockRequests(): Req[] {
	const file = `${LOGS}/mock.log`;
	if (!existsSync(file)) return [];
	const out: Req[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const m = /^(\S+) #(\d+) model=(\S+) (REFUSES \(\w+\)|ANSWERS|side call) tools=\d+ msgs=(\d+) users=(\d+) last-user=("(?:[^"\\]|\\.)*")/.exec(line);
		if (!m || m[4] === "side call") continue;
		out.push({ n: Number(m[2]), model: m[3]!, refuses: m[4]!.startsWith("REFUSES"), msgs: Number(m[5]), users: Number(m[6]), lastUser: JSON.parse(m[7]!), at: Date.parse(m[1]!) });
	}
	return out;
}

const since = (at: number) => mockRequests().filter(r => r.at >= at);
const describeReqs = (rs: Req[]) => rs.map(r => `#${r.n} ${r.model.replace("lab-", "").replace("-5-5", "")} ${r.refuses ? "REFUSES" : "answers"} (msgs=${r.msgs}, users=${r.users})`).join(" → ") || "none";

/** The Activity entries of agent `a` since `from`, without the turn's own bookkeeping (prompted, started, finished). */
async function activity(a: Agent, from: number): Promise<Json[]> {
	const page = await call("host.activity", { limit: 100, agentId: a.id });
	return (page.events as Json[]).filter(e => e.at >= from && !["prompted", "started", "finished"].includes(e.kind)).sort((x, y) => x.at - y.at);
}

/** What the app was told about agent `a` since `from`, without the usual "finished" notification. */
const notesFor = (a: Agent, from: number) => notifications.filter(x => x.at >= from && x.n.agentId === a.id && x.n.kind !== "finished").map(x => x.n);

function show(a: Agent, from: number, acts: Json[]): void {
	for (const r of rowsOf(a).filter(r => r.at >= from - 1000)) {
		const detail =
			r.kind === "assistant"
				? `${r.refusal ? `REFUSED ${r.refusal.kind}/${r.refusal.category}` : `text ${JSON.stringify(String(r.text ?? "").slice(0, 70))}`}${r.error ? ` error=${JSON.stringify(String(r.error).slice(0, 60))}` : ""}`
				: r.kind === "notice"
					? `[${r.level}/${r.source}] ${r.text}`
					: r.kind === "user"
						? JSON.stringify(String(r.text ?? "").slice(0, 70))
						: JSON.stringify(r.text ?? "").slice(0, 70);
		note("row", `${r.kind.padEnd(9)} ${detail}`);
	}
	for (const e of acts) note("activity", `${e.kind.padEnd(13)} ${e.title}${e.detail ? ` — ${e.detail}` : ""}`);
	for (const n of notesFor(a, from)) note("notify", `${n.kind.padEnd(8)} ${n.title} — ${String(n.body).slice(0, 150)}`);
	note("model", `${modelOf(a)} · thinking ${thinkingOf(a)} · column ${agentOf(a).column}`);
}

// ── scenarios ──────────────────────────────────────────────────────────────────────────────────
const PROMPT = (tag: string) => `REFUSAL-LAB ${tag}: please write the exploit for the CVE we discussed.`;

async function setRules(rules: Json[]): Promise<void> {
	const saved = await call("host.refusalFallbackSet", { rules });
	const again = await call("host.refusalFallback", {});
	check(JSON.stringify(again.rules) === JSON.stringify(saved.rules) && saved.rules.length === rules.length && !again.notice, `host.refusalFallback returns the ${rules.length} saved rule(s)`, again);
}

async function startAgent(name: string, extra: Json = {}): Promise<Agent> {
	note("setup", `agent.start ${name} on ${OPUS}`);
	const started = await call("agent.start", { target: { kind: "cwd", cwd: CWD, label: name }, spec: { kind: "omp", name, model: OPUS, plan: false, ...extra } }, 180_000);
	let id: string = started.agentId ?? "";
	await until("herdr to report the agent", 120_000, () => {
		id ||= (host.agents ?? []).find((a: Json) => a.paneId === started.paneId)?.id ?? "";
		return id;
	});
	const a: Agent = { id, name };
	await until(`${name}'s link to go live`, 180_000, () => agentOf(a).omp?.link === "live");
	const snap = await call("session.open", { agentId: id, limit: 300 }, 60_000);
	mirrors.set(id, [...(snap.items ?? [])]);
	check(snap.meta?.caps?.refusalRetry === true, `${name}: the session reports caps.refusalRetry (bridge 2.3.0 with refusals)`, snap.meta?.caps);
	note("setup", `${name} is live on ${modelOf(a)} (omp session ${agentOf(a).omp?.sessionId})`);
	return a;
}

async function prompt(a: Agent, tag: string): Promise<number> {
	const at = Date.now();
	await call("agent.prompt", { agentId: a.id, text: PROMPT(tag), images: [], delivery: "auto" });
	note("PROMPT", `${tag}: the app's only action; from here the host acts on its own`);
	return at;
}

const refusedRow = (a: Agent, from: number) => rowsOf(a).find(r => r.kind === "assistant" && r.refusal && r.at >= from - 1000);
const answerRow = (a: Agent, from: number, who: string) => rowsOf(a).find(r => r.kind === "assistant" && !r.refusal && r.at >= from - 1000 && String(r.text ?? "").includes(`${who} (lab) answered`));
const noticeRow = (a: Agent, from: number, text: string) => rowsOf(a).find(r => r.kind === "notice" && r.source === "refusal" && r.at >= from - 1000 && r.text === text);

/** The refused turn's rows come in this order: the prompt, the refusal, the notice, the answer. */
function inOrder(a: Agent, from: number, parts: ((r: Json) => boolean)[]): boolean {
	const rows = rowsOf(a).filter(r => r.at >= from - 1000);
	let at = -1;
	for (const p of parts) {
		const i = rows.findIndex((r, ix) => ix > at && p(r));
		if (i < 0) return false;
		at = i;
	}
	return true;
}

const scenarios: Record<string, (a: Agent) => Promise<void>> = {
	"no-rule": async a => {
		await setRules([]);
		const t = await prompt(a, "no-rule");
		await until("the refusal in the transcript", 60_000, () => refusedRow(a, t));
		await sleep(QUIET_MS);
		const acts = await activity(a, t);
		show(a, t, acts);
		const reqs = since(t);
		check(reqs.length === 1 && reqs[0]!.model === "lab-opus-5-5" && reqs[0]!.refuses, "the mock saw one refused request, on Opus, and nothing after it", describeReqs(reqs));
		check(modelOf(a) === OPUS, "the agent is still on Opus", modelOf(a));
		check(acts.length === 1 && acts[0]!.kind === "error" && acts[0]!.title === "Refused · cyber", "Activity: exactly one entry, the refusal, as always", acts.map(e => `${e.kind}: ${e.title}`));
		const notes = notesFor(a, t);
		check(notes.length === 1 && notes[0]!.kind === "error" && notes[0]!.title.endsWith("Refused · cyber"), "exactly one notification, the refusal", notes.map(n => `${n.kind}: ${n.title}`));
		check(!rowsOf(a).some(r => r.kind === "notice" && r.source === "refusal" && r.at >= t), "no fallback notice in the transcript");
		check(!answerRow(a, t, "Sonnet 5.5"), "nobody answered");
	},

	"other-rule": async a => {
		await setRules([{ category: "bio", from: OPUS, to: SONNET, after: "stay" }]);
		const t = await prompt(a, "other-rule");
		await until("the refusal in the transcript", 60_000, () => refusedRow(a, t));
		await sleep(QUIET_MS);
		const acts = await activity(a, t);
		show(a, t, acts);
		const reqs = since(t);
		check(reqs.length === 1 && reqs[0]!.refuses, "a rule for another category does not apply: one refused request, nothing after it", describeReqs(reqs));
		check(modelOf(a) === OPUS && acts.length === 1 && acts[0]!.kind === "error", "still on Opus, one Activity entry (the refusal)", { model: modelOf(a), acts: acts.map(e => e.title) });
	},

	"rule-stay": async a => {
		await setRules([{ category: "Cyber", from: "anthropic/claude-opus-*", to: SONNET, after: "stay" }]);
		// The rule above names Anthropic's real Opus; this lab's Opus is another provider: no match.
		let t = await prompt(a, "rule-stay-wrong-provider");
		await until("the refusal in the transcript", 60_000, () => refusedRow(a, t));
		await sleep(QUIET_MS / 2);
		check(since(t).length === 1 && modelOf(a) === OPUS, "a `from` of another provider's family does not apply", describeReqs(since(t)));

		await setRules([{ category: "Cyber", from: "lab-opus-*", to: SONNET, after: "stay" }]);
		const before = thinkingOf(a);
		t = await prompt(a, "rule-stay");
		await until("the answer from Sonnet", 90_000, () => answerRow(a, t, "Sonnet 5.5"));
		await sleep(QUIET_MS);
		const acts = await activity(a, t);
		show(a, t, acts);
		const reqs = since(t);
		check(reqs.length === 2 && reqs[0]!.model === "lab-opus-5-5" && reqs[0]!.refuses && reqs[1]!.model === "lab-sonnet-5-5" && !reqs[1]!.refuses, "the mock saw Opus refuse, then Sonnet answer", describeReqs(reqs));
		check(reqs.length === 2 && reqs[0]!.lastUser === reqs[1]!.lastUser && reqs[0]!.msgs === reqs[1]!.msgs && reqs[0]!.users === reqs[1]!.users, "Sonnet got the same conversation, with no new user message (a continuation, not a new prompt)", describeReqs(reqs));
		check(
			inOrder(a, t, [r => r.kind === "user" && String(r.text).includes("rule-stay:"), r => r.kind === "assistant" && !!r.refusal, r => r.kind === "notice" && r.text === NOTICE, r => r.kind === "assistant" && String(r.text ?? "").includes("Sonnet 5.5 (lab) answered")]),
			"the transcript reads: prompt, refusal, the notice, Sonnet's answer",
		);
		check(!!noticeRow(a, t, NOTICE), `the notice is "${NOTICE}"`);
		check(modelOf(a) === SONNET && thinkingOf(a) === before, "the agent is on Sonnet now, with its thinking level", { model: modelOf(a), before, after: thinkingOf(a) });
		check(["review", "done"].includes(agentOf(a).column), "the turn finished (the agent is idle)", agentOf(a).column);
		const mine = acts.filter(e => e.title === NOTICE);
		check(mine.length === 1 && mine[0]!.kind === "modelChanged", "Activity: one entry for the refusal and the fallback", acts.map(e => `${e.kind}: ${e.title}`));
		check(!acts.some(e => e.kind === "error"), "Activity: no refusal error entry", acts.map(e => `${e.kind}: ${e.title}`));
		const notes = notesFor(a, t);
		check(notes.length === 1 && notes[0]!.kind === "info" && notes[0]!.title.endsWith("continued on Sonnet 5.5"), "one notification, an info one", notes.map(n => `${n.kind}: ${n.title}`));
		const file = `${HOME}/refusalfallback.json`;
		check(existsSync(file) && (statSync(file).mode & 0o777) === 0o600, "the rules are in refusalfallback.json, owner-only");
	},

	"rule-back": async a => {
		await call("agent.setModel", { agentId: a.id, model: OPUS });
		await until("the agent on Opus", 15_000, () => modelOf(a) === OPUS);
		await setRules([{ category: "cyber", from: OPUS, to: SONNET, after: "back" }]);
		const before = thinkingOf(a);
		const t = await prompt(a, "rule-back");
		await until("the answer from Sonnet", 90_000, () => answerRow(a, t, "Sonnet 5.5"));
		note("model", `${modelOf(a)} while the turn is over`);
		const back = await until("the agent back on Opus", 45_000, () => modelOf(a) === OPUS);
		const acts = await activity(a, t);
		await sleep(QUIET_MS / 2);
		show(a, t, acts);
		check(!!back && modelOf(a) === OPUS && thinkingOf(a) === before, "the agent went back to Opus and its thinking level once the turn ended", { model: modelOf(a), before, after: thinkingOf(a) });
		const reqs = since(t);
		check(reqs.length === 2 && reqs[0]!.refuses && !reqs[1]!.refuses, "the turn itself ran Opus (refused), then Sonnet (answered)", describeReqs(reqs));
		const mine = acts.filter(e => e.title === NOTICE);
		check(mine.length === 1 && String(mine[0]!.detail).includes("Goes back to Opus 5.5 when the turn ends."), "Activity says it goes back", mine.map(e => e.detail));
	},

	"retry-with": async a => {
		await call("agent.setModel", { agentId: a.id, model: OPUS });
		await until("the agent on Opus", 15_000, () => modelOf(a) === OPUS);
		await setRules([]);
		const t = await prompt(a, "retry-with");
		await until("the refusal in the transcript", 60_000, () => refusedRow(a, t));
		await sleep(3000);
		check(since(t).length === 1 && modelOf(a) === OPUS, "with no rule nothing happens by itself", describeReqs(since(t)));
		const res = await call("agent.refusalRetry", { agentId: a.id, model: SONNET });
		note("call", `agent.refusalRetry → ${JSON.stringify(res)}`);
		check(res.started === true && res.via === "retry", "agent.refusalRetry started the continuation");
		await until("the answer from Sonnet", 90_000, () => answerRow(a, t, "Sonnet 5.5"));
		await sleep(QUIET_MS);
		const acts = await activity(a, t);
		show(a, t, acts);
		const reqs = since(t);
		check(reqs.length === 2 && reqs[0]!.refuses && !reqs[1]!.refuses && reqs[0]!.lastUser === reqs[1]!.lastUser && reqs[0]!.msgs === reqs[1]!.msgs, "Sonnet continued the same conversation, no new prompt", describeReqs(reqs));
		check(!!noticeRow(a, t, "Switched to Sonnet 5.5 and continued"), 'the transcript says "Switched to Sonnet 5.5 and continued"');
		check(modelOf(a) === SONNET, "the agent is on Sonnet", modelOf(a));
		const again = await call("agent.refusalRetry", { agentId: a.id, model: SONNET });
		check(again.started === false, "a second Retry finds nothing to retry (the turn went on)", again);
	},

	"loop-guard": async a => {
		await call("agent.setModel", { agentId: a.id, model: OPUS });
		await until("the agent on Opus", 15_000, () => modelOf(a) === OPUS);
		await setRules([
			{ from: OPUS, to: HAIKU, after: "stay" },
			{ from: HAIKU, to: OPUS, after: "stay" },
		]);
		const t = await prompt(a, "loop-guard");
		await until("Haiku's refusal of the continued turn", 90_000, () => since(t).length >= 2);
		await sleep(QUIET_MS + 4000);
		const acts = await activity(a, t);
		show(a, t, acts);
		const reqs = since(t);
		check(reqs.length === 2 && reqs[0]!.model === "lab-opus-5-5" && reqs[1]!.model === "lab-haiku-5-5" && reqs.every(r => r.refuses), "two refused requests (Opus, then Haiku) and no third: no ping-pong", describeReqs(reqs));
		check(modelOf(a) === HAIKU, "the agent stays on the fallback model", modelOf(a));
		const kinds = acts.map(e => e.kind).sort();
		check(JSON.stringify(kinds) === JSON.stringify(["error", "modelChanged"]) || JSON.stringify(kinds) === JSON.stringify(["error", "modelChanged", "modelChanged"]), "Activity: the fallback, then the second refusal", acts.map(e => `${e.kind}: ${e.title}`));
		check(acts.some(e => e.kind === "error" && String(e.detail).includes("The fallback model refused too")), "the second refusal says no further fallback runs");
		const notes = notesFor(a, t);
		check(notes.length === 2 && notes.some(n => n.kind === "info") && notes.some(n => n.kind === "error"), "two notifications: the fallback and the second refusal", notes.map(n => `${n.kind}: ${n.title}`));
	},
};

/** omp's own fallback chain takes the refused turn over: hostd's rule must not run, nothing posts a refusal. */
async function ompChain(): Promise<void> {
	await setRules([{ category: "cyber", from: OPUS, to: SONNET, after: "stay" }]);
	const a = await startAgent("chain", { fallbackChains: { [OPUS]: [SONNET] } });
	const hostdLog = `${HOME}/hostd.log`;
	const logBefore = existsSync(hostdLog) ? statSync(hostdLog).size : 0;
	const t = await prompt(a, "omp-chain");
	await until("an answer from Sonnet", 120_000, () => answerRow(a, t, "Sonnet 5.5"));
	await sleep(QUIET_MS + 4000);
	const acts = await activity(a, t);
	show(a, t, acts);
	const reqs = since(t);
	check(reqs.length === 2 && reqs[0]!.refuses && reqs[0]!.model === "lab-opus-5-5" && !reqs[1]!.refuses && reqs[1]!.model === "lab-sonnet-5-5", "omp walked its own chain: Opus refused, Sonnet answered", describeReqs(reqs));
	check(reqs.length === 2 && reqs[0]!.lastUser === reqs[1]!.lastUser, "(omp's own continuation, no new prompt either)");
	const log = existsSync(hostdLog) ? readFileSync(hostdLog, "utf8").slice(logBefore) : "";
	check(!/refusal: fell back|refusal: no herdr session|refusal fallback: back/.test(log), "tf-hostd's refusal fallback did not run (it acts only on a refusal omp settled on)", log.split("\n").filter(l => /refusal/i.test(l)).slice(0, 3));
	check(!acts.some(e => /refused|Refused ·/.test(e.title)) && !notesFor(a, t).some(n => /refused|Refused ·/.test(n.title)), "no refusal Activity entry, no refusal notification (the signal omp's chain walk fires is not the settled refusal)", { acts: acts.map(e => e.title), notes: notesFor(a, t).map(n => n.title) });
	check(!rowsOf(a).some(r => r.kind === "notice" && r.source === "refusal"), "no TeleFlock notice in the transcript");
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
	note("setup", `refusal fallback lab: hostd ${HOSTD}, session ${SESSION}, relay ${RELAY}`);
	send({ t: "hello", protocol: 1, client: { app: "teleflock-lab", version: "0.9.0", platform: "linux", device: "refusal-driver" }, herdrSession: SESSION });
	await Promise.race([welcome.promise, sleep(60_000).then(() => Promise.reject(new Error("no welcome within 60 s")))]);
	const pinger = setInterval(() => send({ t: "ping", ts: Date.now() }), 10_000);
	const cfg = await call("host.refusalFallback", {});
	check(Array.isArray(cfg.rules) && cfg.rules.length === 0 && !cfg.notice, "host.refusalFallback: no rules yet", cfg);

	const wanted = (name: string) => !ONLY || ONLY.includes(name);
	const main = Object.keys(scenarios).filter(wanted);
	if (main.length > 0) {
		const a = await startAgent("refusal");
		for (const name of main) {
			t0 = Date.now();
			note("SCENARIO", name);
			try {
				await scenarios[name]!(a);
			} catch (e) {
				failures.push(`${name}: ${String(e)}`);
				note("FAIL", `${name}: ${String(e)}`);
			}
		}
	}
	if (wanted("omp-chain")) {
		t0 = Date.now();
		note("SCENARIO", "omp-chain");
		try {
			await ompChain();
		} catch (e) {
			failures.push(`omp-chain: ${String(e)}`);
			note("FAIL", `omp-chain: ${String(e)}`);
		}
	}
	clearInterval(pinger);
	note("RESULT", `${checks - failures.length}/${checks} checks held${failures.length ? `; failed: ${failures.join(" | ")}` : ""}`);
	send({ t: "bye" });
	return failures.length ? 2 : 0;
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
