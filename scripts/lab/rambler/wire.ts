#!/usr/bin/env bun
/**
 * Rambler lab driver: speaks the client protocol through `tf-hostd attach` (the lab's own daemon, started
 * by `scripts/lab/run`) and sends `ai.complete` with task `ramble`, exactly the params `suggestRamble` in
 * src/core/ai.ts builds (system prompt read from that file). Checks the wire path and role selection against
 * the mock provider (mock.ts) and measures the latency the stack adds on top of the model.
 *
 * Usage: scripts/lab/run rambler -- bun scripts/lab/rambler/wire.ts <tf-hostd> [relay-port] [runs]
 * The client attaches to herdr session `tf-lab-$TF_LAB` (the lab's name, set by scripts/lab/run).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [hostd, relayPort = "47481", runsArg = "3"] = process.argv.slice(2);
if (!hostd) throw new Error("usage: wire.ts <tf-hostd> [relay-port] [runs]");
const runs = Number(runsArg);
const repo = join(import.meta.dir, "../../..");
const session = `tf-lab-${process.env.TF_LAB ?? "rambler"}`;

// The real system prompt and prompt shape, taken from the app's source.
const src = readFileSync(join(repo, "src/core/ai.ts"), "utf8");
const system = /^  ramble:\n    "((?:[^"\\]|\\.)*)",$/m.exec(src)?.[1];
if (!system) throw new Error("ramble system prompt not found in src/core/ai.ts");
const SYSTEM: string = JSON.parse(`"${system}"`);
const prompt = (transcript: string) => `<context>\nRepository: teleflock\n</context>\n\n<transcript>\n${transcript}\n</transcript>\n\nRewritten prompt for the whole transcript above:`;

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
send({ t: "hello", protocol: 1, client: { app: "rambler-lab", version: "0", platform: "linux", device: "rambler" }, herdrSession: session });
await Promise.race([hello, Bun.sleep(60_000).then(() => { throw new Error("no welcome from tf-hostd"); })]);

let next = 1;
async function call(params: object): Promise<{ ok: boolean; result?: any; error?: any; wall: number }> {
	const id = next++;
	const t0 = performance.now();
	const res = await new Promise<any>(r => { pending.set(id, r); send({ t: "req", id, method: "ai.complete", params }); });
	return { ok: !res.error, result: res.result, error: res.error, wall: performance.now() - t0 };
}

const said = "um so I want to add a retry to the uploader you know in src slash net slash upload dot ts. and also make the timeout configurable";
let failed = false;
const check = (what: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${extra ? ` (${extra})` : ""}`); if (!ok) failed = true; };

for (const [role, model] of [["tiny", "lab-tiny"], ["smol", "lab-smol"], ["default", "lab-big"]] as const) {
	const walls: number[] = [];
	let last: any;
	for (let i = 0; i < runs; i++) {
		const r = await call({ task: "ramble", system: SYSTEM, prompt: prompt(said + " ".repeat(i)), role, timeoutMs: 12_000 });
		if (!r.ok) { check(`role ${role} answers`, false, JSON.stringify(r.error)); break; }
		walls.push(r.wall);
		last = r.result;
	}
	if (!last) continue;
	check(`role ${role} reached the mock's ${model}`, last.text.startsWith(`[${model}]`), last.text.slice(0, 120));
	check(`role ${role} answer is the rewrite of the transcript`, last.text.includes("Add a retry to the uploader") || last.text.includes("add a retry to the uploader") || last.text.includes("So I want to add a retry"));
	console.log(`     ${role}: wall ${walls.map(w => Math.round(w)).join(", ")} ms, hostd-reported ${last.ms} ms, model ${last.model}`);
}

// a long-ish transcript through the same path
const long = Array.from({ length: 60 }, (_, i) => `step ${i} touch file${i} dot ts`).join(". ");
const r = await call({ task: "ramble", system: SYSTEM, prompt: prompt(long), role: "tiny", timeoutMs: 12_000 });
check("a ~2 000 character transcript goes through", r.ok && r.result.text.includes("file59"), r.ok ? `${long.length} chars, ${Math.round(r.wall)} ms` : JSON.stringify(r.error));

// an invalid role and an unknown one fail the way the app expects
const bad = await call({ task: "ramble", system: SYSTEM, prompt: prompt(said), role: "Not A Role" });
check("an invalid role is invalid_params", !bad.ok && bad.error?.code === "invalid_params", JSON.stringify(bad.error));

send({ t: "bye" });
await child.exited;
process.exit(failed ? 1 : 0);
