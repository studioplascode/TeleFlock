#!/usr/bin/env bun
/**
 * Model access lab driver (architecture §3.22 "Model access"): plays the TeleFlock app against the lab
 * tf-hostd (setup.sh) through `tf-hostd attach` and checks what the host does with an agent on Claude
 * Mythos 5.2 whose omp has two signed-in Anthropic accounts, one of which the provider refuses Mythos
 * on (mock.ts: `no-mythos@`, a 404 `not_found_error`; `mythos@` serves it).
 *
 *   learn      a prompt: whatever omp does with the refusal, hostd learns that `no-mythos@` refuses
 *              Mythos and `mythos@` serves it (`host.limits` → `models`)
 *   stop       `mythos@` runs out (mock phase `yes-out`, 90 s): the turn stops; the ticket leaves
 *              `no-mythos@`'s room out (`noAccess`) and waits for `mythos@`'s reset, then resumes on
 *              it (moving the session there first when omp's own choice is a refusing account)
 *   use        `agent.useAccount` pins the session to `mythos@` (omp's `/session pin` through the
 *              bridge's `pinAccount`): omp's pin says so, and the next request goes to `mythos@` first
 *
 * Usage (inside the lab's network namespace, setup.sh prints the command):
 *   scripts/lab/run <lab> -- nsenter --net=<ns> bun scripts/lab/models/drive.ts --lab-env /tmp/tf-lab-<lab>/lab.env
 * Writes <logs>/drive-<time>.log. Exit 0: every check held; 2: a check failed; 1: error.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { sleep } from "bun";

type Json = Record<string, any>;

const argv = process.argv.slice(2);
const labEnvFile = argv[argv.indexOf("--lab-env") + 1];
const L: Record<string, string> = {};
for (const line of readFileSync(labEnvFile ?? "", "utf8").split("\n")) {
	const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
	if (m) L[m[1]!] = m[2]!;
}
const { HOSTD, SESSION, RELAY_PORT, WORK, HOSTD_HOME, OMP_AGENT, LOGS, MOCK_PORT } = L as Record<string, string>;
if (!HOSTD || !HOSTD_HOME?.startsWith("/tmp/") || !OMP_AGENT?.startsWith("/tmp/")) {
	console.error("drive: need --lab-env of a lab under /tmp (setup.sh writes it)");
	process.exit(1);
}
const MYTHOS = "anthropic/claude-mythos-5-2";
const NO = "anthropic|email:no-mythos@example.test|org:org_lab_no";
const YES = "anthropic|email:mythos@example.test|org:org_lab_yes";

const logFile = `${LOGS}/drive-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
const t0 = Date.now();
const failures: string[] = [];
function note(kind: string, text: string): void {
	const line = `${`+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8)} ${kind.padEnd(9)} ${text}`;
	console.log(line);
	appendFileSync(logFile, `${line}\n`);
}
function check(ok: boolean, what: string, detail?: unknown): void {
	if (ok) note("ok", what);
	else {
		failures.push(what);
		note("FAIL", `${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
async function until<T>(what: string, ms: number, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await probe();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out after ${(ms / 1000).toFixed(0)}s waiting for ${what}`);
		await sleep(500);
	}
}

// ── link to tf-hostd ───────────────────────────────────────────────────────────────────────────
const attach = Bun.spawn([HOSTD, "--relay-port", RELAY_PORT!, "attach", "--session", SESSION!], { stdin: "pipe", stdout: "pipe", stderr: Bun.file(`${LOGS}/drive.attach.stderr`) });
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
let nextId = 1;
let host: Json = { agents: [] };
const welcome = Promise.withResolvers<void>();
function call(method: string, params: Json): Promise<Json> {
	const id = nextId++;
	const { promise, resolve, reject } = Promise.withResolvers<Json>();
	pending.set(id, { resolve, reject });
	attach.stdin.write(`${JSON.stringify({ t: "req", id, method, params })}\n`);
	attach.stdin.flush();
	return promise;
}
(async () => {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of attach.stdout) {
		buf += decoder.decode(chunk, { stream: true });
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			let m: Json;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			if (m.t === "welcome") welcome.resolve();
			else if (m.t === "snapshot") host = m.state;
			else if (m.t === "patch")
				for (const op of m.ops ?? []) {
					if (op.op !== "agent") continue;
					host.agents = (host.agents ?? []).filter((a: Json) => a.id !== op.id);
					if (op.value) host.agents.push(op.value);
				}
			else if (m.t === "res") {
				const p = pending.get(m.id);
				pending.delete(m.id);
				if (m.error) p?.reject(new Error(`${m.error.code}: ${m.error.message}`));
				else p?.resolve(m.result);
			}
		}
	}
})();

// ── what the host, omp and the mock say ─────────────────────────────────────────────────────────
const agentOf = (id: string): Json => (host.agents ?? []).find((a: Json) => a.id === id) ?? {};
interface Req {
	at: number;
	account: string;
	model: string;
	verdict: string;
	side: boolean;
}
function mockRequests(from: number): Req[] {
	const file = `${LOGS}/mock.log`;
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.flatMap((line) => {
			const m = /^(\S+) #\d+ account=(\S+) model=(\S+) (404 not_found|429 usage|ANSWERS) side=(\w+)/.exec(line);
			return m ? [{ at: Date.parse(m[1]!), account: m[2]!, model: m[3]!, verdict: m[4]!, side: m[5] === "true" }] : [];
		})
		.filter((r) => r.at >= from && !r.side && r.model === "claude-mythos-5-2");
}
const describe = (rs: Req[]) => rs.map((r) => `${r.account}:${r.verdict}`).join(" → ") || "none";
async function models(key: string): Promise<Json[]> {
	const limits = await call("host.limits", { refresh: true });
	return (limits.accounts as Json[]).find((a) => a.key === key)?.models ?? [];
}
/** omp's pin of the session in the lab's own agent.db (read-only). */
function ompPin(sid: string): { credentialId?: number; explicit?: boolean; email?: string } {
	const db = new Database(`${OMP_AGENT}/agent.db`, { readonly: true });
	try {
		const row = db.query("SELECT value FROM cache WHERE key = ?").get(`session:sticky:anthropic:${sid}`) as { value?: string } | null;
		const pin = row?.value ? JSON.parse(row.value) : {};
		const cred = pin.credentialId == null ? null : (db.query("SELECT identity_key FROM auth_credentials WHERE id = ?").get(pin.credentialId) as { identity_key?: string } | null);
		return { credentialId: pin.credentialId, explicit: pin.explicit === true, email: cred?.identity_key ?? undefined };
	} finally {
		db.close();
	}
}
async function activity(id: string, from: number): Promise<Json[]> {
	const page = await call("host.activity", { limit: 100, agentId: id });
	return (page.events as Json[]).filter((e) => e.at >= from && e.kind === "modelChanged");
}
async function prompt(id: string, text: string): Promise<number> {
	const at = Date.now();
	await call("agent.prompt", { agentId: id, text, images: [], delivery: "auto" });
	note("PROMPT", text);
	return at;
}
const idle = (id: string) => agentOf(id).state === "idle" || agentOf(id).column === "review";

async function main(): Promise<number> {
	note("setup", `model access lab: hostd ${HOSTD}, session ${SESSION}`);
	attach.stdin.write(`${JSON.stringify({ t: "hello", protocol: 1, client: { app: "teleflock-lab", version: "0.9.0", platform: "linux", device: "models-driver" }, herdrSession: SESSION })}\n`);
	attach.stdin.flush();
	await Promise.race([welcome.promise, sleep(60_000).then(() => Promise.reject(new Error("no welcome within 60 s")))]);
	const pinger = setInterval(() => {
		attach.stdin.write(`${JSON.stringify({ t: "ping", ts: Date.now() })}\n`);
		attach.stdin.flush();
	}, 10_000);
	pinger.unref?.();
	const started = await call("agent.start", { target: { kind: "cwd", cwd: WORK, label: "mythos" }, spec: { kind: "omp", name: "mythos", model: MYTHOS, plan: false } });
	const id: string = await until("the agent on the board", 120_000, () => started.agentId || (host.agents ?? []).find((a: Json) => a.paneId === started.paneId)?.id);
	await until("its link to go live", 180_000, () => agentOf(id).omp?.link === "live");
	const sid: string = agentOf(id).omp?.sessionId;
	note("setup", `agent ${id} on ${MYTHOS}, omp session ${sid}`);

	// learn
	let from = await prompt(id, "MODELS-LAB learn: say hello.");
	await until("the first turn to end", 120_000, () => mockRequests(from).some((r) => r.verdict === "ANSWERS") && idle(id));
	note("mock", describe(mockRequests(from)));
	const learned = await until("hostd to learn both accounts", 60_000, async () => {
		const [no, yes] = [await models(NO), await models(YES)];
		return no.some((m) => m.model === "claude-mythos-5-2" && m.denied) && yes.some((m) => m.model === "claude-mythos-5-2" && !m.denied) ? { no, yes } : undefined;
	}).catch((e) => (note("wait", String(e)), undefined));
	check(!!learned, "hostd knows no-mythos@ refuses Mythos and mythos@ serves it", learned);

	// stop: omp's own choice ends up on no-mythos@ (mythos@ is out while the agent runs Sonnet, which
	// no-mythos@ serves), then the agent goes back to Mythos and stops: no account can take it
	await fetch(`http://127.0.0.1:${MOCK_PORT}/lab/phase`, { method: "POST", body: JSON.stringify({ phase: "yes-out", seconds: 150 }) });
	const outUntil = Date.now() + 150_000;
	await call("agent.setModel", { agentId: id, model: "anthropic/claude-sonnet-5" });
	from = await prompt(id, "MODELS-LAB sonnet: say hello on Sonnet.");
	await until("the Sonnet turn to end", 120_000, () => idle(id) && Date.now() - from > 3000).catch((e) => note("wait", String(e)));
	note("pin", `before the stop: ${JSON.stringify(ompPin(sid))}`);
	await call("agent.setModel", { agentId: id, model: MYTHOS });
	from = await prompt(id, "MODELS-LAB stop: say hello again on Mythos.");
	const ticket = await until("an auto-resume ticket", 180_000, () => agentOf(id).autoResume).catch((e) => (note("wait", String(e)), undefined));
	note("mock", describe(mockRequests(from)));
	if (ticket) {
		note("ticket", JSON.stringify(ticket));
		check((ticket.noAccess ?? []).some((l: string) => l.startsWith("no-mythos@")), "the ticket leaves no-mythos@ out (noAccess)", ticket.noAccess);
		check(ticket.resumeAt == null || ticket.resumeAt >= outUntil, "it waits for mythos@'s reset, not for no-mythos@'s room", { resumeAt: ticket.resumeAt, outUntil });
		const resumed = await until("the ticket to resume and close", 8 * 60_000, () => !agentOf(id).autoResume && mockRequests(from).some((r) => r.account === "yes" && r.verdict === "ANSWERS")).catch((e) => (note("wait", String(e)), false));
		note("mock", describe(mockRequests(from)));
		check(!!resumed, "after the reset the turn goes on and mythos@ answers it");
		const moves = await activity(id, from);
		for (const e of moves) note("activity", `${e.title} — ${e.detail ?? ""}`);
		check(moves.some((e) => String(e.title).includes("to mythos@example.test")), "hostd moved the session to mythos@ before it resumed (Activity)", moves);
		note("pin", `after the resume: ${JSON.stringify(ompPin(sid))}`);
	} else check(false, "the stop opened a ticket");

	// use: the user's own pin first (omp's `/session pin <email>`, typed into omp), then the user picks
	// mythos@ through TeleFlock (`agent.useAccount`): the pin must change and the choice be recorded
	await until("the agent to be idle", 120_000, () => idle(id));
	await call("agent.slash", { agentId: id, command: "/session pin no-mythos@example.test" });
	const before = await until("omp's pin to name no-mythos@", 30_000, () => {
		const p = ompPin(sid);
		return (p.email ?? "").includes("no-mythos@example.test") ? p : undefined;
	}).catch((e) => (note("wait", String(e)), ompPin(sid)));
	note("pin", `before the choice: ${JSON.stringify(before)}`);
	check(before.explicit === true && (before.email ?? "").includes("no-mythos@example.test"), "the user's /session pin names no-mythos@ (explicit)", before);
	from = Date.now();
	let used: Json;
	try {
		used = await call("agent.useAccount", { agentId: id, key: YES });
	} catch (e) {
		check(false, "agent.useAccount answers", String(e));
		note("done", `${failures.length} check(s) failed: ${failures.join("; ")}`);
		return 2;
	}
	note("use", JSON.stringify(used));
	const pin = ompPin(sid);
	note("pin", `after the choice: ${JSON.stringify(pin)}`);
	check(pin.explicit === true && (pin.email ?? "").includes("mythos@example.test") && !(pin.email ?? "").includes("no-mythos"), "omp's pin moved to mythos@, explicit", pin);
	const chose = (await activity(id, from)).filter((e) => String(e.title).startsWith("Pinned ") && String(e.title).includes("mythos@example.test"));
	for (const e of chose) note("activity", `${e.title} — ${e.detail ?? ""}`);
	check(chose.length === 1, "Activity records the user's choice once (only agent.useAccount writes it)", chose);
	from = await prompt(id, "MODELS-LAB use: one more hello.");
	await until("the turn to end", 120_000, () => mockRequests(from).some((r) => r.verdict === "ANSWERS") && idle(id)).catch((e) => note("wait", String(e)));
	const reqs = mockRequests(from);
	note("mock", describe(reqs));
	check(reqs.length > 0 && reqs.every((r) => r.account === "yes"), "the next Mythos requests go to mythos@ only", describe(reqs));

	note("done", failures.length ? `${failures.length} check(s) failed: ${failures.join("; ")}` : "every check held");
	return failures.length ? 2 : 0;
}

main()
	.then((code) => {
		attach.kill();
		process.exit(code);
	})
	.catch((e) => {
		note("ERROR", String(e?.stack ?? e));
		attach.kill();
		process.exit(1);
	});
