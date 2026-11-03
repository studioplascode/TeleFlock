#!/usr/bin/env bun
/**
 * AiLatency lab driver: latency of `ai.complete` through a lab tf-hostd against the Rambler lab's mock model
 * (scripts/lab/rambler/mock.ts: lab-tiny answers after 150 ms), cold, warm and prewarmed.
 *
 * Setup (everything under /tmp/tf-lab-ailatency, nothing real is touched):
 *   D=/tmp/tf-lab-ailatency/omp-agent; mkdir -p $D
 *   sed s/18781/18791/ scripts/lab/rambler/models.yml > $D/models.yml; cp scripts/lab/rambler/config.yml $D/config.yml
 *   scripts/lab/run ailatency -- env MOCK_PORT=18791 bun scripts/lab/rambler/mock.ts &
 *   scripts/lab/run ailatency -- bun scripts/lab/ailatency/measure.ts <tf-hostd> [relay-port] [runs] [prewarm] [long]
 *
 * Each series prints min / p50 / p95 / max of the wall time the client sees. A cold call uses a system prompt no
 * worker exists for (a hostd without the pool starts omp for every call, so all its calls are cold). Warm calls
 * run back to back, then 1.5 s apart. `prewarm`
 * also measures the first call after `ai.prewarm` (+ 3 s of speech); hostds older than 0.9.0 skip that series.
 * `long` (5 more minutes) measures Rambler's one call at the end of 150 s of speech, past the host's 2 min idle
 * window: once with the worker prewarmed at the start only, once prewarmed again every 60 s, as the app does.
 * The client attaches to herdr session `tf-lab-$TF_LAB` (the lab's name, set by scripts/lab/run).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [hostd, relayPort = "47491", runsArg = "10", prewarmArg = "prewarm", longArg = ""] = process.argv.slice(2);
if (!hostd) throw new Error("usage: measure.ts <tf-hostd> [relay-port] [runs] [prewarm|noprewarm] [long]");
const session = `tf-lab-${process.env.TF_LAB ?? "ailatency"}`;
const runs = Number(runsArg);
const repo = join(import.meta.dir, "../../..");

const src = readFileSync(join(repo, "src/core/ai.ts"), "utf8");
const system = /^  ramble:\n    "((?:[^"\\]|\\.)*)",$/m.exec(src)?.[1];
if (!system) throw new Error("ramble system prompt not found in src/core/ai.ts");
const SYSTEM: string = JSON.parse(`"${system}"`);
const prompt = (said: string) => `<context>\nRepository: teleflock\n</context>\n\n<transcript>\n${said}\n</transcript>\n\nRewritten prompt for the whole transcript above:`;

const child = Bun.spawn([hostd, "attach", "--session", session, "--relay-port", relayPort], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const pending = new Map<number, (m: any) => void>();
let welcomed: (() => void) | undefined;
const hello = new Promise<void>(r => (welcomed = r));
(async () => {
	let buf = "";
	for await (const chunk of child.stdout) {
		buf += new TextDecoder().decode(chunk);
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let m: any;
			try { m = JSON.parse(line); } catch { continue; }
			if (m.t === "welcome") welcomed?.();
			if (m.t === "res") pending.get(m.id)?.(m);
		}
	}
})();
const send = (v: object) => { child.stdin.write(`${JSON.stringify(v)}\n`); child.stdin.flush(); };
send({ t: "hello", protocol: 1, client: { app: "ailatency-lab", version: "0", platform: "linux", device: "ailatency" }, herdrSession: session });
await Promise.race([hello, Bun.sleep(60_000).then(() => { throw new Error("no welcome from tf-hostd"); })]);

let next = 1;
async function rpc(method: string, params: object): Promise<{ ok: boolean; result?: any; error?: any; wall: number }> {
	const id = next++;
	const t0 = performance.now();
	const res = await new Promise<any>(r => { pending.set(id, r); send({ t: "req", id, method, params }); });
	return { ok: !res.error, result: res.result, error: res.error, wall: performance.now() - t0 };
}
const complete = (sys: string, said: string, role = "tiny") => rpc("ai.complete", { task: "ramble", system: sys, prompt: prompt(said), role, timeoutMs: 20_000 });

const stats = (label: string, xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
	console.log(`${label.padEnd(34)} n=${String(s.length).padStart(2)}  min ${s[0]!.toFixed(0).padStart(5)}  p50 ${q(0.5).toFixed(0).padStart(5)}  p95 ${q(0.95).toFixed(0).padStart(5)}  max ${s.at(-1)!.toFixed(0).padStart(5)} ms`);
};
const said = (i: number) => `um so I want to add a retry to the uploader you know in src slash net slash upload dot ts. and also make the timeout configurable ${i}`;
let failed = false;
const take = (r: { ok: boolean; error?: any; wall: number; result?: any }, what: string) => {
	if (!r.ok) { failed = true; console.log(`FAIL ${what}: ${JSON.stringify(r.error)}`); }
	else if (!String(r.result.text).startsWith("[lab-tiny]")) { failed = true; console.log(`FAIL ${what}: unexpected answer ${r.result.text}`); }
	return r.wall;
};

const cold: number[] = [];
for (let i = 0; i < runs; i++) cold.push(take(await complete(`${SYSTEM} (cold ${i} ${Date.now()})`, said(i)), "cold"));
stats("cold (no worker for this prompt)", cold);

const key = `${SYSTEM} (warm ${Date.now()})`;
take(await complete(key, said(-1)), "warm start");
const warm: number[] = [];
for (let i = 0; i < runs * 2; i++) warm.push(take(await complete(key, said(i)), "warm"));
stats("warm, back to back", warm);

// Calls 1.5 s apart: the worker has been reset by the next call.
const paced: number[] = [];
for (let i = 0; i < runs; i++) {
	await Bun.sleep(1_500);
	paced.push(take(await complete(key, said(i)), "paced"));
}
stats("warm, 1.5 s apart", paced);

if (prewarmArg === "prewarm") {
	const first: number[] = [];
	for (let i = 0; i < runs; i++) {
		const k = `${SYSTEM} (prewarmed ${i} ${Date.now()})`;
		const w = await rpc("ai.prewarm", { task: "ramble", system: k, role: "tiny" });
		if (!w.ok && w.error?.code === "unknown_method") { console.log("ai.prewarm: unknown_method (host older than 0.9.0), series skipped"); break; }
		if (!w.ok) { failed = true; console.log(`FAIL prewarm: ${JSON.stringify(w.error)}`); break; }
		await Bun.sleep(3_000);
		first.push(take(await complete(k, said(i)), "prewarmed"));
	}
	if (first.length) stats("first call after ai.prewarm + 3 s", first);
}

// Rambler: one call when the dictation ends, `ai.prewarm` when it starts and again every 60 s while it lasts.
if (longArg === "long") {
	// tf-hostd drops a client silent for 45 s: ping while the "speech" lasts.
	const speak = async (ms: number) => {
		for (let left = ms; left > 0; left -= 15_000) {
			await Bun.sleep(Math.min(left, 15_000));
			send({ t: "ping", ts: Date.now() });
		}
	};
	for (const again of [false, true]) {
		const k = `${SYSTEM} (long ${again ? "rewarmed" : "once"} ${Date.now()})`;
		const warm = () => rpc("ai.prewarm", { task: "ramble", system: k, role: "tiny" });
		const w = await warm();
		if (!w.ok) { failed = w.error?.code !== "unknown_method"; console.log(`long series skipped: ${JSON.stringify(w.error)}`); break; }
		await speak(60_000);
		if (again) await warm();
		await speak(60_000);
		if (again) await warm();
		await speak(30_000);
		const wall = take(await complete(k, said(0)), "long");
		console.log(`${`call after 150 s of speech, ${again ? "prewarmed every 60 s" : "prewarmed at the start only"}`.padEnd(64)} ${wall.toFixed(0).padStart(5)} ms`);
	}
}

send({ t: "bye" });
await child.exited;
process.exit(failed ? 1 : 0);
