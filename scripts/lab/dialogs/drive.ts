#!/usr/bin/env bun
/**
 * Dialogs lab driver: does over the lab devserver's /ws what the app does (the same frames:
 * `{id, hostId, method, params}` → `{id, result | error}`; `{event}` frames are ignored), reads and
 * types into the agent's herdr pane through the lab's herdr, and checks every step. Run it after
 * setup.sh, outside the lab (it talks to 127.0.0.1 and to the lab's herdr through scripts/lab/run):
 *
 *   bun scripts/lab/dialogs/drive.ts <lab> [--agent ID] [--name NAME] [--only LIST] [--app]
 *     --agent ID   use this agent instead of starting one
 *     --name NAME  the started agent's name (default settings)
 *     --only LIST  comma-separated scenarios, in order (default: once,deny,tui,qa,pty)
 *     --app        the app answers: at each answer step the driver says what to pick and waits (5 min)
 *                  for the request to be answered elsewhere (the UI), then checks the effect
 *
 * Scenarios (each one prompt; the mock's scripted turn raises one of omp's own prompts):
 *   once  DLG-CFG on    omp's cfg approval reaches the app as an approval "Change task.perCallModel?"
 *                       (Always for this session / Allow once ★ / Deny), the agent reads Needs you;
 *                       Allow once from the app applies it and omp's TUI dialog closes
 *   deny  DLG-CFG eval  the card's detail shows `"on" → "eval"` (the first change applied); Deny from
 *                       the app denies it
 *   tui   DLG-CFG off   the detail shows `"on" → "off"` (the denied change did not apply); Enter in the
 *                       TUI (omp highlights Allow once) answers it there and the app's card goes away
 *   qa    DLG-QA        omp's report_tool_issue consent reaches the app as a Yes/No confirmation; Yes
 *                       from the app records it (the mock collector gets the report). omp asks once per
 *                       agent dir: the agent must start while the lab's config.yml has no
 *                       `dev.autoqaConsent` (setup.sh --fresh, or delete that line, then a new agent)
 *   pty   DLG-PTY       omp's interactive console: the agent reads Needs you, not answerable in the app,
 *                       with what the TUI shows; typing a word in the terminal ends it
 * Exit 0 when every check passed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const lab = args[0]?.startsWith("-") ? undefined : args[0];
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
if (!lab || args.includes("--help") || args.includes("-h")) {
	console.error("usage: bun scripts/lab/dialogs/drive.ts <lab> [--agent ID] [--name NAME] [--only once,deny,tui,qa,pty] [--app]");
	process.exit(64);
}
const envFile = `/tmp/tf-lab-${lab}/lab.env`;
if (!existsSync(envFile)) {
	console.error(`drive: no ${envFile}; run scripts/lab/dialogs/setup.sh ${lab} first`);
	process.exit(66);
}
const env = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const HOST = "lab";
const APP = args.includes("--app");
const SCENARIOS = ["once", "deny", "tui", "qa", "pty"];
const order = (opt("--only") ?? SCENARIOS.join(",")).split(",").map(s => s.trim()).filter(Boolean);
for (const s of order) if (!SCENARIOS.includes(s)) throw new Error(`unknown scenario ${s} (${SCENARIOS.join(", ")})`);
const RUN = join(import.meta.dir, "../run");
const CFG_CHOICES = ["Always for this session", "Allow once", "Deny"];

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

// ─── the lab's herdr (through scripts/lab/run, never the caller's) ─────────────────────────────

function herdr(...argv: string[]): string {
	const r = Bun.spawnSync([RUN, lab!, "--", "herdr", "--session", env.SESSION!, ...argv], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`herdr ${argv.join(" ")}: ${r.stderr.toString().trim()}`);
	return r.stdout.toString();
}

// ─── agent ──────────────────────────────────────────────────────────────────────────────────────

const host = await until("host lab never answered state.get", 180, () => call("state.get", {}, 10_000), 1000);
say(`host lab online: tf-hostd ${host.info?.hostdVersion}, omp ${host.info?.omp?.version ?? "?"}, herdr session ${host.info?.herdrSession}`);

let agentId = opt("--agent") ?? "";
if (!agentId) {
	const params = {
		target: { kind: "cwd", cwd: env.WORK, label: "settings-lab" },
		spec: { kind: "omp", name: opt("--name") ?? "settings", model: "mock/lab-1", plan: false },
	};
	say(`agent.start ${JSON.stringify(params)}`);
	const started = await call("agent.start", params, 180_000);
	agentId =
		started.agentId ??
		(await until("herdr never reported the started agent", 120, async () => (await call("state.get", {}, 10_000)).agents?.find((a: Json) => a.paneId === started.paneId)?.id, 1000));
}
const agentNow = async (): Promise<Json> => {
	const a = (await call("state.get", {}, 10_000)).agents?.find((x: Json) => x.id === agentId);
	if (!a) throw new Error(`agent ${agentId} is gone`);
	return a;
};
const first = await until(`agent ${agentId}'s link never went live`, 180, async () => {
	const a = await agentNow();
	return a.omp?.link === "live" ? a : undefined;
});
const paneId: string = first.paneId;
say(`agent ${agentId} live in pane ${paneId}: omp ${first.omp.version}, pid ${first.omp.pid}, bridge ${first.omp.bridge}, session ${first.omp.sessionFile}`);
if (first.omp.pid) {
	const exe = Bun.spawnSync(["readlink", "-f", `/proc/${first.omp.pid}/exe`]).stdout.toString().trim();
	check("the agent runs the lab's pinned omp", exe === env.OMP, `${exe} (pinned ${env.OMP})`);
}
check("omp 18.15.0", String(first.omp.version ?? host.info?.omp?.version ?? "").includes("18.15.0"), String(first.omp.version ?? host.info?.omp?.version));

const visible = () => herdr("pane", "read", paneId, "--source", "visible");

// ─── steps ──────────────────────────────────────────────────────────────────────────────────────

/** Sends `text` as the app's composer does and returns the transcript's last row id before it. */
async function prompt(text: string): Promise<Set<string>> {
	const seen = new Set<string>(((await call("session.open", { agentId, limit: 60 })).items ?? []).map((r: Json) => r.id));
	say(`agent.prompt ${JSON.stringify(text)}`);
	await call("agent.prompt", { agentId, text, images: [], delivery: "auto" }, 60_000);
	return seen;
}

/** The agent once it shows a request of `kind`; logs its column, needs and what the TUI shows. */
async function needsOf(kind: string, secs = 90): Promise<Json> {
	const a = await until(`no ${kind} request on ${agentId}`, secs, async () => {
		const a = await agentNow();
		return a.needs?.kind === kind ? a : undefined;
	});
	const n = a.needs;
	say(`needs: column ${a.column}, ${JSON.stringify({ kind: n.kind, title: n.title, question: n.question, detail: n.detail, answerable: n.answerable, requestId: n.requestId, options: n.options?.map((o: Json) => `${o.label}${o.recommended ? "★" : ""}${o.tone && o.tone !== "neutral" ? `(${o.tone})` : ""}`) })}`);
	return a;
}

/** Answers the agent's request from the app (or, with --app, waits for the UI to). */
async function answer(a: Json, choice: string): Promise<void> {
	const requestId = a.needs.requestId;
	if (APP) {
		say(`>>> answer "${choice}" in the app now (request ${requestId})`);
	} else {
		say(`agent.answer ${requestId} ${JSON.stringify(choice)}`);
		await call("agent.answer", { agentId, requestId, answer: { choices: [choice], cancel: false, chat: false } }, 30_000);
	}
	await until(`request ${requestId} still pending`, APP ? 300 : 30, async () => ((await agentNow()).needs?.requestId === requestId ? undefined : true));
	say(`request ${requestId} resolved`);
}

/** The turn's closing line `DLG-LAB <kind> done: …` that came after `seen`. */
async function done(kind: string, seen: Set<string>, secs = 90): Promise<string> {
	const row = await until(`no "DLG-LAB ${kind} done" answer`, secs, async () =>
		((await call("session.open", { agentId, limit: 60 })).items ?? []).find((r: Json) => !seen.has(r.id) && r.kind === "assistant" && !r.streaming && r.text?.includes(`DLG-LAB ${kind} done`)),
	);
	const line = String(row.text).split("\n").find((l: string) => l.includes("DLG-LAB"))!;
	say(`turn done: ${line}`);
	return line;
}

async function settled(): Promise<Json> {
	return until("the agent never settled", 60, async () => {
		const a = await agentNow();
		return a.column !== "running" && !a.needs ? a : undefined;
	});
}

// ─── scenarios ──────────────────────────────────────────────────────────────────────────────────

async function cfg(name: string, value: string, previous: string, reply: string, via: "app" | "tui"): Promise<void> {
	console.log(`\n── ${name}: DLG-CFG ${value} (${via === "tui" ? "answered in the TUI" : `${reply} from the app`})`);
	const seen = await prompt(`DLG-CFG ${value}: set task.perCallModel to ${value} for this session.`);
	const a = await needsOf("approval");
	const n = a.needs;
	check(`${name}: the agent reads Needs you`, a.column === "needs", a.column);
	check(`${name}: the card is "Change task.perCallModel?"`, n.title === "Change task.perCallModel?", n.title);
	check(`${name}: the question is omp's headline`, n.question === "⚙️ Your agent wants to change `task.perCallModel` for this session.", n.question);
	check(`${name}: the detail is the change`, n.detail === `"${previous}" → "${value}"`, n.detail);
	check(`${name}: choices Always for this session / Allow once ★ (primary) / Deny (danger)`, JSON.stringify(n.options.map((o: Json) => o.label)) === JSON.stringify(CFG_CHOICES) && n.options[1].recommended && n.options[1].tone === "primary" && n.options[2].tone === "danger" && n.options.filter((o: Json) => o.recommended).length === 1, n.options.map((o: Json) => `${o.label}:${o.tone}${o.recommended ? "★" : ""}`).join(" "));
	check(`${name}: answerable in the app`, n.answerable === true && !!n.requestId);
	const before = await until("omp's TUI never showed its dialog", 20, async () => {
		const s = visible();
		return s.includes("wants to change") ? s : undefined;
	});
	check(`${name}: omp's TUI shows its own dialog too`, before.includes("Allow once") && before.includes("Always for this session"));
	if (via === "tui") {
		say("TUI: Enter (omp highlights Allow once)");
		herdr("pane", "send-keys", paneId, "enter");
		await until("the app's card stayed after the TUI answered", 30, async () => ((await agentNow()).needs?.requestId === n.requestId ? undefined : true));
		check(`${name}: answering in the TUI closed the app's card`, true);
	} else {
		await answer(a, reply);
	}
	const after = await until("omp's TUI dialog stayed open", 20, async () => {
		const s = visible();
		return s.includes("wants to change") ? undefined : s;
	});
	check(`${name}: omp's TUI dialog closed`, !after.includes("Allow once"));
	const line = await done("cfg", seen);
	const denied = /denied|declined|not approved|refused/i.test(line);
	check(`${name}: the write ${reply === "Deny" ? "was denied" : "applied"}`, reply === "Deny" ? denied : !denied && line.includes(value), line);
	await settled();
}

async function qa(): Promise<void> {
	console.log("\n── qa: DLG-QA (Yes from the app)");
	const decided = /^\s*autoqaConsent:\s*(\w+)/m.exec(readFileSync(join(env.OMP_AGENT!, "config.yml"), "utf8"))?.[1];
	if (decided) return check("qa: omp has not decided the report_tool_issue consent yet", false, `${env.OMP_AGENT}/config.yml has autoqaConsent: ${decided}`);
	const seen = await prompt("DLG-QA: report the write tool's stale path to the omp devs.");
	const a = await needsOf("confirm");
	const n = a.needs;
	check("qa: the agent reads Needs you", a.column === "needs", a.column);
	check("qa: a confirmation with Yes / No, nothing ★", n.title === "Confirm" && JSON.stringify(n.options.map((o: Json) => o.label)) === '["Yes","No"]' && !n.options.some((o: Json) => o.recommended), `${n.title}: ${n.options.map((o: Json) => o.label).join("/")}`);
	check("qa: question is omp's headline, detail its body", /Your agent/.test(n.question) && /devs/.test(n.detail ?? ""), `${n.question} | ${n.detail}`);
	const before = visible();
	check("qa: omp's TUI shows its own dialog too", before.includes(n.question.replace(/^\S+\s/, "").slice(0, 30)), n.question);
	await answer(a, "Yes");
	const after = await until("omp's TUI dialog stayed open", 20, async () => {
		const s = visible();
		return s.includes(n.question.replace(/^\S+\s/, "").slice(0, 30)) ? undefined : s;
	});
	check("qa: omp's TUI dialog closed", !!after);
	await done("qa", seen);
	const mockLog = join(env.LOGS!, "mock.log");
	const reported = await until("the mock collector never got the report", 30, async () => (readFileSync(mockLog, "utf8").includes("qa report:") ? true : undefined)).catch(() => false);
	check("qa: the granted report reached the (mock) collector", reported === true);
	await settled();
}

async function pty(): Promise<void> {
	console.log("\n── pty: DLG-PTY (answered in the terminal)");
	const seen = await prompt("DLG-PTY: open a console and ask me for a word.");
	const a = await needsOf("blocked", 60);
	const n = a.needs;
	check("pty: the agent reads Needs you, not Running", a.column === "needs", a.column);
	check("pty: not answerable in the app (Answer in terminal)", n.answerable === false && !n.requestId, `answerable ${n.answerable}, requestId ${n.requestId}`);
	// The console prints its question a second in (see mock.ts); the card follows what the TUI shows.
	const shown = await until("the card never showed the console's question", 15, async () => {
		const x = (await agentNow()).needs;
		return x?.kind === "blocked" && /Type a word and press Enter:/.test(x.detail ?? "") ? x : undefined;
	}).catch(() => (n as Json));
	check("pty: the question is the console the TUI shows, its rows the detail", /Console/.test(shown.question) && /Type a word and press Enter:/.test(shown.detail ?? ""), `${JSON.stringify(shown.question)} / ${JSON.stringify(shown.detail)}`);
	say("TUI: types `lab` + Enter into the console");
	herdr("pane", "send-text", paneId, "lab");
	herdr("pane", "send-keys", paneId, "enter");
	const line = await done("pty", seen);
	check("pty: the console got the word, its PTY never resized while it waited", line.includes("got: lab") && !line.includes("RESIZED"), line);
	const b = await settled();
	check("pty: Needs you cleared once the terminal answered", !b.needs, JSON.stringify(b.needs ?? null));
}

for (const s of order) {
	if (s === "once") await cfg("once", "on", "off", "Allow once", "app");
	if (s === "deny") await cfg("deny", "eval", "on", "Deny", "app");
	if (s === "tui") await cfg("tui", "off", "on", "Allow once", "tui");
	if (s === "qa") await qa();
	if (s === "pty") await pty();
}

console.log(`\nagent ${agentId} (pane ${paneId})`);
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
sock.close();
process.exit(failed ? 1 : 0);
