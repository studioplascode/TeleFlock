#!/usr/bin/env bun
/**
 * Steer lab driver (bridge 2.4.0): plays the app against the lab's tf-hostd through
 * `tf-hostd attach` (JSON lines). Run inside the lab after setup.sh:
 *
 *   scripts/lab/run steer -- bun scripts/lab/steer/drive.ts [default|explicit]…   (default: both)
 *
 * Each case writes the lab's omp config (`explicit`: with `steeringMode: one-at-a-time`), starts an
 * omp agent, waits until its bridge serves it, prompts `STEER-LAB` (the mock answers with a slow
 * `bash sleep 12`), sends two steers through `agent.prompt` at once while that tool runs, follows
 * the host queue (`state.get` → `omp.queue`) until the turn ends, then pulls back with
 * `agent.dequeue` and reads the queue again (board and session meta). It prints the mock's
 * requests of the turn (steering mode "all": both steers in the request after the tool;
 * "one-at-a-time": one per request) and exits 0 when every check passed.
 */
import { readFileSync, writeFileSync } from "node:fs";

type Json = Record<string, any>;
const L: Record<string, string> = Object.fromEntries(
	readFileSync("/tmp/tf-lab-steer/lab.env", "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const cases = process.argv.slice(2).length ? process.argv.slice(2) : ["default", "explicit"];
const STEERS = ["STEER-A: only look at the lab files", "STEER-B: do not change anything yet"];
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
const send = (obj: Json) => {
	attach.stdin.write(`${JSON.stringify(obj)}\n`);
	attach.stdin.flush();
};
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
async function call(method: string, params: Json, ms = 30_000): Promise<Json> {
	const id = nextId++;
	const p = Promise.withResolvers<Json>();
	pending.set(id, p);
	send({ t: "req", id, method, params });
	const timer = setTimeout(() => p.reject(new Error(`${method}: no answer in ${ms} ms`)), ms);
	try {
		return await p.promise;
	} finally {
		clearTimeout(timer);
	}
}
const agentOf = async (id: string): Promise<Json | undefined> => ((await call("state.get", {})).agents ?? []).find((a: Json) => a.id === id);
const empty = (q: Json | undefined): boolean => q?.steering?.length === 0 && q?.followUp?.length === 0;
const mockLines = (): Json[] =>
	readFileSync(L.MOCK_LOG!, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l) as Json);

send({ t: "hello", protocol: 1, client: { app: "teleflock-lab", version: "0.9.1", platform: "linux", device: "steer-lab" }, herdrSession: L.SESSION });
await welcome.promise;
const ping = setInterval(() => send({ t: "ping", ts: Date.now() }), 10_000);
const baseConfig = readFileSync(`${L.HERE}/config.yml`, "utf8");

for (const label of cases) {
	const explicit = label === "explicit";
	console.log(`\n── case ${label}: steeringMode ${explicit ? "one-at-a-time set in omp's config" : "not set"} ──`);
	writeFileSync(`${L.OMP_AGENT}/config.yml`, explicit ? `${baseConfig}steeringMode: one-at-a-time\n` : baseConfig);
	const started = await call("agent.start", { target: { kind: "cwd", cwd: L.WORK, label: `steer-${label}` }, spec: { kind: "omp", name: `steer-${label}-${Date.now().toString(36).slice(-4)}`, model: "steerlab/lab-1", plan: false } }, 180_000);
	let id: string = started.agentId ?? "";
	let a: Json | undefined;
	for (let i = 0; i < 180; i++, await Bun.sleep(1000)) {
		if (!id) id = ((await call("state.get", {})).agents ?? []).find((x: Json) => x.paneId === started.paneId)?.id ?? "";
		a = id ? await agentOf(id) : undefined;
		if (a?.omp?.link === "live" && a.omp.linkVia === "bridge") break;
	}
	check("the agent's session is served by the bridge", a?.omp?.link === "live" && a?.omp?.linkVia === "bridge", `${a?.omp?.link} via ${a?.omp?.linkVia}`);
	const meta = (await call("session.open", { agentId: id, limit: 5 }, 60_000)).meta as Json;
	check("its caps say bridge", meta?.caps?.bridge === true && meta?.caps?.prompt === true, JSON.stringify({ bridge: meta?.caps?.bridge, steer: meta?.caps?.steer, prompt: meta?.caps?.prompt }));
	const from = mockLines().length;
	await call("agent.prompt", { agentId: id, text: `STEER-LAB (${label}): run the slow step`, images: [], delivery: "auto" }, 60_000);
	for (let i = 0; i < 120 && !(a?.live?.tool != null); i++, await Bun.sleep(250)) a = await agentOf(id);
	check("the slow tool runs", a?.live?.tool != null, JSON.stringify(a?.live?.tool ?? null));
	await Bun.sleep(1000);
	say(`sending both steers at once: ${STEERS.map(s => JSON.stringify(s)).join(", ")}`);
	await Promise.all(STEERS.map(text => call("agent.prompt", { agentId: id, text, images: [], delivery: "auto" }, 60_000)));
	const seen: string[] = [];
	let idleFor = 0;
	for (let i = 0; i < 240 && idleFor < 3; i++, await Bun.sleep(250)) {
		a = await agentOf(id);
		const q = JSON.stringify(a?.omp?.queue ?? null);
		if (seen.at(-1) !== q) {
			seen.push(q);
			say(`host queue: ${q} (column ${a?.column}, tool ${a?.live?.tool ? "running" : "none"})`);
		}
		idleFor = a?.column !== "running" && a?.state !== "working" && mockLines().slice(from).some(l => l.kind === "answer") ? idleFor + 1 : 0;
	}
	const turn = mockLines().slice(from).filter(l => l.kind !== "side");
	console.log("mock requests of this turn:");
	for (const l of turn) console.log(`  #${l.n} ${l.kind} ${JSON.stringify(l.texts)}`);
	const withSteers = turn.filter(l => l.texts.some((t: string) => t.includes("STEER-A") || t.includes("STEER-B")));
	const together = withSteers.some(l => STEERS.every((s: string) => l.texts.some((t: string) => t.includes(s.slice(0, 7)))));
	if (explicit) check("the user's one-at-a-time is left alone: one steer per request", !together && withSteers.length === 2, `${withSteers.length} request(s) carry steers`);
	else check("both steers reach the model in one request", together && withSteers.length === 1, `${withSteers.length} request(s) carry steers`);
	check("the host queue is empty after the turn", empty(a?.omp?.queue), JSON.stringify(a?.omp?.queue));
	const dq = await call("agent.dequeue", { agentId: id }, 30_000);
	check("agent.dequeue on the emptied queue returns nothing", !dq.text, JSON.stringify(dq));
	a = await agentOf(id);
	const after = (await call("session.open", { agentId: id, limit: 5 }, 60_000)).meta as Json;
	check("no stale entry in hostd's state (board and session meta)", empty(a?.omp?.queue) && empty(after?.queue), `${JSON.stringify(a?.omp?.queue)} / ${JSON.stringify(after?.queue)}`);
}
writeFileSync(`${L.OMP_AGENT}/config.yml`, baseConfig);
clearInterval(ping);
send({ t: "bye" });
attach.kill();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
