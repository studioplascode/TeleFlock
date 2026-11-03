#!/usr/bin/env bun
/**
 * DispatchSlash lab driver: plays the app against the lab's tf-hostd through `tf-hostd attach`
 * (JSON lines), so the app's 0.9.1 gate doesn't apply. Run inside the lab after setup.sh:
 *
 *   scripts/lab/run dispatchslash -- bun scripts/lab/dispatchslash/drive.ts [plan|skill|inject|fail]…   (default: all)
 *
 * plan    `worktree.create` with `agent.command: "/plan add a settings page"`: omp is in plan mode and
 *         the model gets the task text (with omp's plan-mode instructions), never "/plan …" as text.
 * skill   `agent.start` with `/skill:labcheck do X`: the model gets the project skill's body and "do X".
 * inject  `agent.start` with `/fast on` while the bridge file is away: hostd types the builtin through
 *         herdr; fast mode is on, no turn starts, no request reaches the model.
 * fail    `agent.start` with `/nope do X`: "/nope didn't run" activity, nothing reaches the model.
 * Prints what the mock received per case (trimmed) and exits 0 when every check passed.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";

type Json = Record<string, any>;
const L: Record<string, string> = Object.fromEntries(
	readFileSync("/tmp/tf-lab-dispatchslash/lab.env", "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const cases = process.argv.slice(2).length ? process.argv.slice(2) : ["plan", "skill", "inject", "fail"];
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
	if (!ok) failed++;
};

const attach = Bun.spawn([L.HOSTD!, "--relay-port", L.RELAY_PORT!, "attach", "--session", L.SESSION!], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const pending = new Map<number, PromiseWithResolvers<Json>>();
let nextId = 1;
const welcome = Promise.withResolvers<void>();
(async () => {
	let buf = "";
	for await (const chunk of attach.stdout) {
		buf += new TextDecoder().decode(chunk);
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			const m = JSON.parse(line) as Json;
			if (m.t === "welcome") welcome.resolve();
			if (m.t === "res") {
				const p = pending.get(m.id);
				pending.delete(m.id);
				if (m.error) p?.reject(new Error(`${m.error.code}: ${m.error.message}`));
				else p?.resolve(m.result ?? {});
			}
		}
	}
})();
async function call(method: string, params: Json, ms = 120_000): Promise<Json> {
	const id = nextId++;
	const p = Promise.withResolvers<Json>();
	pending.set(id, p);
	attach.stdin.write(`${JSON.stringify({ t: "req", id, method, params })}\n`);
	attach.stdin.flush();
	const timer = setTimeout(() => p.reject(new Error(`${method}: no answer in ${ms} ms`)), ms);
	try {
		return await p.promise;
	} finally {
		clearTimeout(timer);
	}
}
const agentOf = async (id: string): Promise<Json | undefined> => ((await call("state.get", {})).agents ?? []).find((a: Json) => a.id === id);
const mockSince = (since: number): Json[] =>
	readFileSync(L.MOCK_LOG!, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l) as Json)
		.filter(r => r.at >= since);
const until = async (what: string, secs: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
	for (let i = 0; i < secs * 2; i++) {
		if (await test()) return true;
		await Bun.sleep(500);
	}
	say(`gave up waiting: ${what}`);
	return false;
};
const show = (reqs: Json[]) => {
	for (const r of reqs) console.log(`    mock #${r.n}: texts=${JSON.stringify(r.texts)}\n             system≈${JSON.stringify(r.system)}`);
	if (!reqs.length) console.log("    mock: (no request)");
};
const activities = async (agentId: string): Promise<Json[]> => (await call("host.activity", { agentId, limit: 20 })).events ?? [];
const spec = (name: string, command: string): Json => ({ kind: "omp", name, plan: false, command });

attach.stdin.write(`${JSON.stringify({ t: "hello", protocol: 1, client: { app: "teleflock-lab", version: "0.9.1", platform: "linux", device: "dispatchslash-lab" }, herdrSession: L.SESSION })}\n`);
attach.stdin.flush();
await welcome.promise;
say(`attached to ${L.SESSION}`);

for (const c of cases) {
	const since = Date.now();
	console.log(`\n== ${c}`);
	if (c === "plan") {
		const made = await call("worktree.create", { cwd: L.WORK, branch: "dispatch/settings-page", label: "settings-page", existing: false, trust: true, agent: spec("settings-page", "/plan add a settings page") });
		const id = made.agent?.agentId as string;
		say(`worktree ${made.path}, agent ${id}`);
		await until("a request with the task", 120, () => mockSince(since).some(r => r.texts.some((t: string) => t.includes("add a settings page"))));
		await Bun.sleep(1500);
		const reqs = mockSince(since);
		show(reqs);
		const a = await agentOf(id);
		check("omp is in plan mode", a?.omp?.mode === "plan", `mode=${a?.omp?.mode}`);
		check("the model got the task text", reqs.some(r => r.texts.some((t: string) => t.includes("add a settings page"))));
		check("no literal /plan reached the model", !reqs.some(r => r.texts.some((t: string) => t.trimStart().startsWith("/plan"))));
		check("omp's plan-mode instructions went with it", reqs.some(r => /plan mode/i.test(`${r.system} ${r.texts.join(" ")}`)));
	} else if (c === "skill") {
		const started = await call("agent.start", { target: { kind: "cwd", cwd: L.WORK, label: "skillcase" }, spec: spec("skillcase", "/skill:labcheck do X") });
		say(`agent ${started.agentId}`);
		await until("a request with the skill", 120, () => mockSince(since).some(r => r.texts.some((t: string) => t.includes("LABCHECK-SKILL-BODY"))));
		await Bun.sleep(1500);
		const reqs = mockSince(since);
		show(reqs);
		check("the model got the skill's body", reqs.some(r => r.texts.some((t: string) => t.includes("LABCHECK-SKILL-BODY"))));
		check("and its arguments", reqs.some(r => r.texts.some((t: string) => t.includes("do X"))));
		check("no literal /skill:labcheck reached the model", !reqs.some(r => r.texts.some((t: string) => t.trimStart().startsWith("/skill:labcheck"))));
	} else if (c === "inject") {
		const bridge = `${L.HOSTD_HOME}/ext/teleflock-bridge.ts`;
		renameSync(bridge, `${bridge}.away`);
		let id = "";
		let pane = "";
		try {
			const started = await call("agent.start", { target: { kind: "cwd", cwd: L.WORK, label: "fastcase" }, spec: spec("fastcase", "/fast on") });
			id = started.agentId as string;
			pane = started.paneId as string;
		} finally {
			// omp got its -e argument at launch; the next launches have the bridge again.
			if (existsSync(`${bridge}.away`)) renameSync(`${bridge}.away`, bridge);
		}
		say(`agent ${id} (no bridge)`);
		// Without the bridge hostd doesn't learn omp's fast mode: omp's own notice in the pane says it.
		const screen = () => new TextDecoder().decode(Bun.spawnSync(["herdr", "--session", L.SESSION!, "pane", "read", pane, "--source", "recent", "--lines", "40"]).stdout);
		const on = await until("fast mode on", 60, () => screen().includes("Fast mode enabled"));
		await Bun.sleep(3000);
		const a = await agentOf(id);
		const acts = await activities(id);
		show(mockSince(since));
		check("the agent runs without the bridge", a?.omp?.bridge === false, `bridge=${a?.omp?.bridge}, link=${a?.omp?.link}`);
		check("fast mode is on (omp's notice in the pane)", on, screen().split("\n").find(l => l.includes("Fast mode")) ?? "");
		check("no turn started", (a?.turns ?? 0) === 0 && a?.state !== "working", `turns=${a?.turns}, state=${a?.state}`);
		check("nothing reached the model", mockSince(since).every(r => r.texts.length === 0));
		check("no failure activity", !acts.some(e => e.kind === "error"), JSON.stringify(acts.map(e => e.title)));
		console.log(`    link live since ${a?.omp?.linkSince ? new Date(a.omp.linkSince).toISOString() : "-"} (the card leaves "Starting agent" 10 s after it)`);
	} else if (c === "fail") {
		const id = (await call("agent.start", { target: { kind: "cwd", cwd: L.WORK, label: "failcase" }, spec: spec("failcase", "/nope do X") })).agentId as string;
		say(`agent ${id}`);
		const err = await until("the didn't-run activity", 60, async () => (await activities(id)).some(e => e.kind === "error"));
		await Bun.sleep(3000);
		const acts = await activities(id);
		const e = acts.find(x => x.kind === "error");
		console.log(`    activity: ${e ? `${e.title} — ${e.detail}` : "(none)"}`);
		show(mockSince(since));
		check('"/nope didn\'t run" is recorded', err && e?.title === "/nope didn't run");
		check("nothing reached the model", mockSince(since).every(r => r.texts.length === 0));
	}
}
attach.kill();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
