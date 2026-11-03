#!/usr/bin/env bun
/**
 * RenameCtx lab driver: "Name it again" end to end against the real stack set up by setup.sh (lab herdr, lab
 * tf-hostd with the TeleFlock bridge, real omp, a mock model that records every request).
 *
 *   bun scripts/lab/renamectx/drive.ts [--out DIR] [--no-goal]
 *     --out DIR   where the evidence is copied (default /root/TeleFlock/target/evidence/renamectx, gitignored); it survives
 *                 `scripts/lab/stop renamectx --purge`
 *     --no-goal   do not set an omp goal between the second and third prompt
 *
 * Steps (each prints `ok` / `FAIL`):
 *   1 start an omp agent `lab-agent` in the lab's work folder (agent.start) and wait for its bridge link
 *   2 four prompts that build one objective (Bloomworks M0): the plan with todo phases, a track decision, a
 *     layout note, and the latest step, a tiny edit ("Update hud.rs to show the population counter");
 *     an omp goal is set after the second prompt
 *   3 `session.digest` → /tmp/tf-lab-renamectx/digest.json; first prompt n=1, todo phases, prompt count, latest last
 *   4 the client's composition against the lab host: src/core/ai.ts, routed through `aiTesting.setComplete` to
 *     the host's `ai.complete` over the devserver's /ws. First `suggestAgentRename` with `agentRenameInput(agent,
 *     [], digest)` (the session never opened in the app), then the whole `renameAgain` flow of
 *     src/features/board/renameAgain.ts (its Io wired to the lab host: transcript rows from `session.open`,
 *     `agent.renameHandle`, `agent.rename`)
 *   5 reads the mock's recording (requests.jsonl) and checks what omp's tiny model received
 * Evidence (in /tmp/tf-lab-renamectx and copied to --out): digest.json, rename-request.txt (the renameAgain
 * flow's call), rename-request-norows.txt (no transcript rows), requests.jsonl (every provider request),
 * rename-result.json (answer, parsed name/title, applied rename), agent-after.json, mock.log, hostd.log.
 * Exit 0 when every check passed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AI_SYSTEM, aiTesting, agentRenamePrompt, suggestAgentRename, type AgentRenameInput } from "@/core/ai";
import { usePrefs } from "@/core/prefs";
import { agentRenameInput, renameAgain, type Io } from "@/features/board/renameAgain";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const OUT = opt("--out") ?? "/root/TeleFlock/target/evidence/renamectx";
const useGoal = !args.includes("--no-goal");
const root = "/tmp/tf-lab-renamectx";
const envFile = `${root}/lab.env`;
if (!existsSync(envFile)) {
	console.error(`drive: no ${envFile}; run scripts/lab/renamectx/setup.sh first`);
	process.exit(66);
}
const env = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const HOST = "lab";

// ─── wire: the devserver's /ws, the frames the app's core speaks ────────────────────────────────

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
		if (msg.error) p?.reject(Object.assign(new Error(`${msg.error.code}: ${msg.error.message}`), { code: msg.error.code, hint: msg.error.hint }));
		else p?.resolve(msg.result);
	};
	sock.onclose = () => {
		for (const p of pending.values()) p.reject(new Error("devserver closed the connection"));
		pending.clear();
	};
	await opened.promise;
}

/** One host method on the lab host; its answer (wire JSON). */
async function call(method: string, params: Json, timeoutMs = 30_000): Promise<any> {
	if (!sock || sock.readyState !== WebSocket.OPEN) await connect();
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

const agentNow = async (agentId: string): Promise<Json> => {
	const a = (await call("state.get", {}, 10_000)).agents?.find((x: Json) => x.id === agentId);
	if (!a) throw new Error(`agent ${agentId} is gone`);
	return a;
};

const requests = (): Json[] =>
	existsSync(env.REQUESTS!)
		? readFileSync(env.REQUESTS!, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(l => JSON.parse(l))
		: [];

// ─── 1. the agent ───────────────────────────────────────────────────────────────────────────────

const started = await call("agent.start", { target: { kind: "cwd", cwd: env.WORK, label: "bloomworks" }, spec: { kind: "omp", name: "lab-agent", model: "mock/lab-1", plan: false } }, 180_000);
const agentId: string =
	started.agentId ?? (await until("herdr never reported the started agent", 120, async () => (await call("state.get", {}, 10_000)).agents?.find((a: Json) => a.paneId === started.paneId)?.id, 1000));
const first = await until(`agent ${agentId}'s link never went live`, 180, async () => {
	const a = await agentNow(agentId);
	return a.omp?.link === "live" ? a : undefined;
});
say(`agent ${agentId} live in pane ${first.paneId}: omp ${first.omp.version}, bridge ${first.omp.bridge}, session ${first.omp.sessionFile}`);
check("omp agent is live through the TeleFlock bridge", first.omp.bridge === true && first.omp.link === "live");

// ─── 2. the prompts ─────────────────────────────────────────────────────────────────────────────

const PROMPTS = [
	"Build Bloomworks, a cozy city-builder game in Rust on wgpu. Milestone M0: render core, asset pipeline, zoning, HUD, Windows build. Plan it in phases with todos.",
	"Track decision: run the asset pipeline and zoning as two parallel tracks, HUD after them; keep the Windows build green in CI from day one.",
	"Layout note: one cargo workspace with the crates bw-render, bw-assets, bw-sim and bw-ui; the game binary is bloomworks.",
	"Update hud.rs to show the population counter",
] as const;
const GOAL = "Ship Bloomworks milestone M0: a playable cozy city-builder on Rust and wgpu with zoning, a HUD and a Windows build";

/** Waits until the mock has seen no request for `quietMs` and the agent is not running (omp's goal mode keeps asking the model for a while). */
async function quiet(quietMs = 3_000): Promise<void> {
	let seen = -1;
	let since = Date.now();
	await until("agent never went quiet", 180, async () => {
		const n = requests().length;
		if (n !== seen) {
			seen = n;
			since = Date.now();
			return undefined;
		}
		const a = await agentNow(agentId);
		return Date.now() - since >= quietMs && a.column !== "running" && !a.needs ? true : undefined;
	}, 500);
}

async function prompt(text: string): Promise<void> {
	const n = requests().length;
	say(`agent.prompt ${JSON.stringify(text)}`);
	await call("agent.prompt", { agentId, text, images: [], delivery: "auto" }, 60_000);
	await until("the model never saw the prompt", 60, async () => (requests().length > n ? true : undefined), 300);
	await quiet();
}

for (const [i, text] of PROMPTS.entries()) {
	await prompt(text);
	if (i === 1 && useGoal) {
		say(`agent.goal set ${JSON.stringify(GOAL)}`);
		await call("agent.goal", { agentId, op: "set", objective: GOAL }, 30_000);
		await until("goal never showed on the agent", 30, async () => ((await agentNow(agentId)).omp?.goal?.objective ? true : undefined), 500);
		await quiet(); // omp's goal mode runs its own turns for a while
	}
}
const recorded = requests();
check("mock saw the todo init call from the agent", recorded.some(r => r.kind === "todo-init"));
say(`${recorded.length} provider requests so far`);

// ─── 3. the digest ──────────────────────────────────────────────────────────────────────────────

const digest = await call("session.digest", { agentId }, 30_000);
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/digest.json`, `${JSON.stringify(digest, null, 2)}\n`);
const phases = (digest.todos ?? []).map((p: Json) => p.name);
say(`digest: promptCount=${digest.promptCount} prompts=${digest.prompts?.length} phases=${JSON.stringify(phases)} summaries=${digest.summaries?.length} subagents=${digest.subagentCount}`);
check("digest: first prompt is n=1 and the original objective", digest.prompts?.[0]?.n === 1 && digest.prompts[0].text === PROMPTS[0], `n=${digest.prompts?.[0]?.n}`);
// omp posts a goal's objective as a user message (steering) of the session: the digest counts it as a prompt.
const expected = useGoal ? [PROMPTS[0]!, PROMPTS[1]!, GOAL, PROMPTS[2]!, PROMPTS[3]!] : PROMPTS;
check(`digest: promptCount is ${expected.length} (the four prompts${useGoal ? " and the goal's objective message" : ""})`, digest.promptCount === expected.length, `promptCount=${digest.promptCount}`);
check("digest: the prompts in order, n counting from 1, the tiny edit last", expected.every((p, i) => digest.prompts?.[i]?.text === p && digest.prompts[i].n === i + 1) && digest.prompts?.length === expected.length, JSON.stringify((digest.prompts ?? []).map((p: Json) => p.n)));
check("digest: todo phases Foundations / Parallel tracks / Ship M0", JSON.stringify(phases) === JSON.stringify(["Foundations", "Parallel tracks", "Ship M0"]), JSON.stringify(phases));
check("digest: the todo items are there", (digest.todos ?? []).reduce((n: number, p: Json) => n + (p.tasks?.length ?? 0), 0) === 8, `${(digest.todos ?? []).map((p: Json) => p.tasks?.length)} tasks per phase`);

// ─── 4. the client's composition against the lab host ───────────────────────────────────────────

usePrefs.setState({ aiNaming: true });
const completions: { params: Json; result?: Json; error?: string }[] = [];
aiTesting.setComplete(async (hostId, params) => {
	const rec: (typeof completions)[number] = { params: params as Json };
	completions.push(rec);
	try {
		rec.result = await call("ai.complete", params as Json, 40_000);
		return rec.result as any;
	} catch (e) {
		rec.error = e instanceof Error ? e.message : String(e);
		throw e;
	}
});

const agent = await agentNow(agentId);
check("agent is live in the board's terms: omp goal visible", !useGoal || !!agent.omp?.goal?.objective, agent.omp?.goal?.objective ?? "no goal");
const key = `${HOST}::${agentId}`;
const view = { ...agent, hostId: HOST, key } as any;
const rows = ((await call("session.open", { agentId, limit: 200 })).items ?? []) as any[];
say(`agent: name=${agent.name} title=${JSON.stringify(agent.title)} column=${agent.column} live.line=${JSON.stringify(agent.live?.line)}`);

const mockRenames = () => requests().filter(r => r.kind === "agentRename");
const before = mockRenames().length;

// 4a: no transcript rows (the session was never opened in the app), digest only
const inputA = agentRenameInput(view, [], digest);
const outA = await suggestAgentRename(HOST, inputA, []);
say(`suggestAgentRename (no rows) → ${JSON.stringify(outA)}`);
check("suggestAgentRename (no transcript rows) answered", outA.ok, outA.ok ? JSON.stringify(outA.value) : JSON.stringify(outA.failure));

// 4b: the whole renameAgain flow with its Io wired to the lab host
let flowInput: AgentRenameInput | undefined;
let flowOut: unknown;
const io: Io = {
	agents: () => [view],
	transcript: () => rows,
	digest: (_h, id) => call("session.digest", { agentId: id }, 30_000),
	renameHandle: (_h, id, name) => call("agent.renameHandle", { agentId: id, name }, 30_000),
	renameTitle: (_h, id, title) => call("agent.rename", { agentId: id, title }, 30_000),
	suggest: async (hostId, input, taken, opts) => {
		flowInput = input;
		flowOut = await suggestAgentRename(hostId, input, taken, opts);
		return flowOut as any;
	},
};
await renameAgain(key, io);
say(`renameAgain → suggest ${JSON.stringify(flowOut)}`);
check("renameAgain: the suggestion came back parsed", (flowOut as any)?.ok === true, JSON.stringify(flowOut));
await Bun.sleep(2_000);
const after = await agentNow(agentId);
say(`agent after: name=${after.name} title=${JSON.stringify(after.title)}`);
writeFileSync(`${root}/agent-after.json`, `${JSON.stringify({ before: { name: agent.name, title: agent.title }, after: { name: after.name, title: after.title } }, null, 2)}\n`);
check("renameAgain applied the name (herdr handle)", after.name === "bloomworks-m0", after.name);
check("renameAgain applied the title (omp session title)", after.title === "Bloomworks city-builder, milestone M0", JSON.stringify(after.title));

// ─── 5. what omp's tiny model received ──────────────────────────────────────────────────────────

const renames = mockRenames().slice(before);
check("the mock recorded two agentRename requests (no-rows call, renameAgain flow)", renames.length === 2, `${renames.length}`);

/** The user message the mock received, as omp sent it. */
const userOf = (r: Json): string => (r.messages as Json[]).filter(m => m.role === "user").map(m => m.text).join("\n---\n");

function saveRequest(file: string, rec: Json, input: AgentRenameInput, answer: unknown): string {
	const user = userOf(rec);
	const text = [
		`# agentRename request as omp's tiny model received it (mock request #${rec.n}, ${rec.at}, model ${rec.model}, tools offered: ${JSON.stringify(rec.tools)})`,
		`# messages: ${(rec.messages as Json[]).map(m => m.role).join(", ")}`,
		"",
		"=== SYSTEM PROMPT (verbatim, all system/developer messages joined with a newline) ===",
		rec.system,
		"",
		"=== USER MESSAGE (verbatim) ===",
		user,
		"",
		"=== MODEL ANSWER ===",
		JSON.stringify(answer),
		"",
	].join("\n");
	writeFileSync(`${root}/${file}`, text);
	return user;
}

const [recA, recB] = renames;
if (recA && recB) {
	const clientPromptA = agentRenamePrompt(inputA, []);
	const clientPromptB = agentRenamePrompt(flowInput!, []);
	const userA = saveRequest("rename-request-norows.txt", recA, inputA, completions[0]?.result);
	const user = saveRequest("rename-request.txt", recB, flowInput!, completions[1]?.result);
	writeFileSync(`${root}/rename-client-prompt.txt`, `=== SYSTEM (AI_SYSTEM.agentRename) ===\n${AI_SYSTEM.agentRename}\n\n=== USER (agentRenamePrompt, renameAgain flow) ===\n${clientPromptB}\n`);

	const sys: string = recB.system;
	const appended = sys.startsWith(AI_SYSTEM.agentRename) ? sys.slice(AI_SYSTEM.agentRename.length) : undefined;
	check("system prompt: AI_SYSTEM.agentRename is received verbatim as the start", sys.startsWith(AI_SYSTEM.agentRename));
	say(`system prompt: ${sys.length} chars, AI_SYSTEM.agentRename is ${AI_SYSTEM.agentRename.length}; omp appended ${appended === undefined ? "?" : appended.length} chars${appended ? `: ${JSON.stringify(appended.slice(0, 200))}…` : ""}`);
	check("user prompt: contains the client's composed prompt verbatim", user.includes(clientPromptB));
	check("user prompt (no rows): contains the client's composed prompt verbatim", userA.includes(clientPromptA));

	const has = (s: string) => user.includes(s);
	const tag = (t: string) => new RegExp(`<${t}>\\n([\\s\\S]*?)\\n</${t}>`).exec(user)?.[1];
	check("user prompt: <first-prompt> is the first prompt", tag("first-prompt") === PROMPTS[0]);
	check("user prompt: <later-prompts> has prompts 2 and 3", !!tag("later-prompts")?.includes("Track decision") && !!tag("later-prompts")?.includes("Layout note"), tag("later-prompts")?.slice(0, 80));
	check("user prompt: <latest-prompt> is the tiny edit", tag("latest-prompt") === PROMPTS[3], tag("latest-prompt"));
	check("user prompt: <todos> has the phases and items", ["Foundations", "Parallel tracks", "Ship M0", "Render core on wgpu", "Asset pipeline importer", "Windows build and CI", "Tag the M0 release"].every(has) && !!tag("todos"));
	check("user prompt: <goal> is the omp goal", !useGoal || tag("goal")?.startsWith("Ship Bloomworks milestone M0") === true, tag("goal"));
	check("user prompt: <current> has the old name", !!tag("current")?.includes("Name: lab-agent"), tag("current")?.split("\n")[0]);
	const pos = (t: string) => user.indexOf(`<${t}>`);
	const order = ["current", "goal", "first-prompt", "later-prompts", "latest-prompt", "todos", "latest-activity"].filter(t => pos(t) >= 0);
	check("user prompt: the tiny latest step comes after the session parts (first-prompt < later < latest-prompt < todos < latest-activity)", order.every((t, i) => i === 0 || pos(order[i - 1]!) < pos(t)), order.join(" < "));
	check("user prompt: <latest-activity> comes last, before the final question", pos("latest-activity") > pos("todos") && user.indexOf("Name and title for the overall work of this session:") > pos("latest-activity"), tag("latest-activity")?.split("\n").slice(0, 3).join(" | "));
	check("user prompt: the tiny edit also shows in <latest-activity> (the agent's last tool / reply)", /hud\.rs|population/i.test(tag("latest-activity") ?? ""), tag("latest-activity")?.split("\n").join(" | "));
	writeFileSync(
		`${root}/rename-result.json`,
		`${JSON.stringify({ modelAnswer: completions[1]?.result, parsed: (flowOut as any)?.value, appliedName: after.name, appliedTitle: after.title, noRowsAnswer: completions[0]?.result, noRowsParsed: (outA as any).value }, null, 2)}\n`,
	);
	check("parsed {name,title} from the model's answer", (flowOut as any)?.value?.name === "bloomworks-m0" && (flowOut as any)?.value?.title === "Bloomworks city-builder, milestone M0", JSON.stringify((flowOut as any)?.value));
}

// ─── evidence ───────────────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
for (const [src, name] of [
	[`${root}/digest.json`, "digest.json"],
	[`${root}/rename-request.txt`, "rename-request.txt"],
	[`${root}/rename-request-norows.txt`, "rename-request-norows.txt"],
	[`${root}/rename-client-prompt.txt`, "rename-client-prompt.txt"],
	[`${root}/rename-result.json`, "rename-result.json"],
	[`${root}/agent-after.json`, "agent-after.json"],
	[env.REQUESTS!, "requests.jsonl"],
	[`${env.LOGS}/mock.log`, "mock.log"],
	[`${env.HOSTD_HOME}/hostd.log`, "hostd.log"],
] as const) {
	if (existsSync(src)) copyFileSync(src, join(OUT, name));
}
console.log(`evidence copied to ${OUT}`);
sock?.close();
process.exit(failed ? 1 : 0);
