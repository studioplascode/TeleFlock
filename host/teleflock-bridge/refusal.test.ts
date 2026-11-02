// Tests for the bridge's 2.3.0 refusal fallback (docs/bridge-protocol.md "Refusal fallback"): telling
// a refusal omp dropped from the context, the turn it began with, how omp goes on with it, and the
// `turn_error` event and `retryRefused` op of the whole extension against a fake hostd with a fake omp
// that settles a refused turn the way omp ≥ 18.13 does (dropped from the context, reported by
// `getLastAssistantMessage()` until the next run).
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, { armRetry, continueRefused, failedTail, isRefusal, type RefusalSession, refusalInfo, refusedTurn, turnStart } from "./teleflock-bridge";

type Json = Record<string, unknown>;
const SLOT = Symbol.for("teleflock.bridge");

const user = (text: string, timestamp = 1): Json => ({ role: "user", content: text, timestamp });
const ok = (text: string, calls: string[] = []): Json => ({
	role: "assistant",
	content: [{ type: "text", text }, ...calls.map(id => ({ type: "toolCall", id, name: "read", arguments: {} }))],
	stopReason: calls.length ? "toolUse" : "stop",
});
const result = (id: string, text: string): Json => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }] });
/** A custom message as omp puts it in the context (`role: "custom"`). */
const custom = (customType: string, timestamp: number, attribution = "agent"): Json => ({ role: "custom", customType, content: customType, display: false, attribution, timestamp });
/** An Anthropic refusal as omp's provider builds it, fallback credit included. */
const refusal = (extra: Json = {}): Json => ({
	role: "assistant",
	content: [{ type: "text", text: "" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	stopReason: "error",
	errorMessage: "Refusal (cyber): The request asks for working exploit code.",
	stopDetails: { type: "refusal", category: "cyber", explanation: "The request asks for working exploit code.", fallback_credit_token: "fct_secret" },
	fallbackCreditHandle: { token: "fct_secret" },
	timestamp: 9_000,
	...extra,
});

describe("refusal helpers", () => {
	test("isRefusal and refusalInfo: refusal and sensitive stops, without omp's fallback credit", () => {
		expect(isRefusal(refusal())).toBe(true);
		expect(isRefusal(refusal({ stopDetails: { type: "sensitive" } }))).toBe(true);
		expect(isRefusal(refusal({ stopReason: "stop" }))).toBe(false);
		expect(isRefusal(refusal({ stopDetails: { type: "overloaded" } }))).toBe(false);
		expect(isRefusal({ role: "assistant", stopReason: "error", errorMessage: "429" })).toBe(false);
		const info = refusalInfo(refusal());
		expect(info).toEqual({ kind: "refusal", category: "cyber", explanation: "The request asks for working exploit code." });
		expect(JSON.stringify(info)).not.toContain("fct_secret");
		expect(refusalInfo(refusal({ stopDetails: { type: "sensitive", category: " ", explanation: "" } }))).toEqual({ kind: "sensitive" });
		expect(refusalInfo(ok("fine"))).toBeNull();
	});

	test("turnStart: the time of the last message that started a turn, whatever followed it", () => {
		expect(turnStart([user("a", 1), ok("x", ["t1"]), result("t1", "r"), user("b", 7), ok("y", ["t2"]), result("t2", "r")])).toBe(7);
		expect(turnStart([ok("x")])).toBeUndefined();
		expect(turnStart([{ role: "user", content: "no time" }])).toBeUndefined();
		// A background job's result started the turn after the user's had ended: that turn is its own,
		// so a fallback in the user's turn leaves it its own fallback (the turn ended on the refusal
		// omp dropped from the context).
		expect(turnStart([user("go", 1_000), { ...ok("done"), timestamp: 2_000 }, custom("async-result", 9_000)])).toBe(9_000);
		// What else omp starts a turn with (18.15): an IRC message that wakes the agent, a launched
		// process's end, goal mode's next turn, a session_stop hook's, autoresearch's, and a user's
		// prompt it sends as a custom message (a skill command, a collab guest's prompt).
		for (const [type, attribution] of [
			["irc:incoming", "agent"],
			["launch-completion", "agent"],
			["goal-continuation", "agent"],
			["session-stop-continuation", "agent"],
			["autoresearch-resume", "agent"],
			["skill-prompt", "user"],
			["collab-prompt", "user"],
		]) {
			expect(turnStart([user("go", 1_000), ok("done"), custom(type!, 9_000, attribution)])).toBe(9_000);
		}
		// What omp adds within a turn starts none: its notes, nudges and reminders (custom messages,
		// synthetic `developer` prompts such as the continue after a dropped refusal), an agent's
		// skill prompt, the advisor's comments, the bridge's own note; nor does going on after a
		// fallback, which adds no message: the loop guard holds.
		const within = [
			custom("ttsr-injection", 3_000),
			custom("todo-error-reminder", 3_100),
			custom("advisor", 3_200),
			custom("skill-prompt", 3_300, "agent"),
			custom("teleflock-browser", 3_400),
			{ role: "developer", content: "Continue.", synthetic: true, timestamp: 3_500 },
		];
		expect(turnStart([user("go", 1_000), ok("x", ["t1"]), result("t1", "r"), ...within])).toBe(1_000);
	});

	test("refusedTurn: the refusal omp dropped (until the next run), or one still in the context", () => {
		const r = refusal();
		const pruned = { retry: async () => false, subscribe: () => () => {}, agent: { state: { messages: [user("go"), ok("reading", ["t1"]), result("t1", "x")] } }, getLastAssistantMessage: () => r } as unknown as RefusalSession;
		expect(refusedTurn(pruned)).toBe(r);
		// The next run cleared it: the last assistant message is an answer.
		const answered = { ...pruned, getLastAssistantMessage: () => ok("done") } as RefusalSession;
		expect(refusedTurn(answered)).toBeUndefined();
		// An omp that keeps the refused turn: the failed tail.
		const kept = { ...pruned, agent: { state: { messages: [user("go"), r] } }, getLastAssistantMessage: undefined } as unknown as RefusalSession;
		expect(refusedTurn(kept)).toBe(r);
		// Another failure ends the context: no refusal, whatever omp remembers.
		const limited = { ...pruned, agent: { state: { messages: [user("go"), { role: "assistant", stopReason: "error", errorMessage: "429" }] } } } as unknown as RefusalSession;
		expect(refusedTurn(limited)).toBeUndefined();
	});

	test("continueRefused: omp's retry for a kept refused turn, else its own continuation, else its continue", async () => {
		const calls: string[] = [];
		const base = {
			subscribe: () => () => {},
			retry: async () => {
				calls.push("retry");
				return true;
			},
			resumeAfterAskReanswer: () => {
				calls.push("continuation");
			},
			resume: async () => {
				calls.push("resume");
			},
		};
		expect(await continueRefused({ ...base, agent: { state: { messages: [user("go"), refusal()] } } } as unknown as RefusalSession)).toBe(true);
		expect(await continueRefused({ ...base, agent: { state: { messages: [user("go")] } } } as unknown as RefusalSession)).toBe(true);
		expect(await continueRefused({ ...base, resumeAfterAskReanswer: undefined, agent: { state: { messages: [user("go")] } } } as unknown as RefusalSession)).toBe(true);
		expect(await continueRefused({ subscribe: base.subscribe, retry: base.retry, agent: { state: { messages: [user("go")] } } } as unknown as RefusalSession)).toBe(false);
		expect(calls).toEqual(["retry", "continuation", "resume"]);
	});

	test("armRetry goes on through the given function, once", async () => {
		const calls: string[] = [];
		const s = {
			subscribe: () => () => {},
			retry: async () => {
				calls.push("retry");
				return true;
			},
			restoreInterruptedTurn: async () => false,
		};
		const armed = armRetry(s as never, async () => {
			calls.push("goOn");
			return true;
		});
		expect(await s.restoreInterruptedTurn()).toBe(true);
		expect(armed.used()).toBe(true);
		expect(await s.restoreInterruptedTurn()).toBe(false);
		expect(calls).toEqual(["goOn"]);
	});
});

// ─── the extension against a fake hostd ───────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) {
		try {
			c();
		} catch {
			// best effort
		}
	}
	delete (globalThis as Record<symbol, unknown>)[SLOT];
	delete process.env.TF_BRIDGE_SOCK;
});

/** Polls `pred` (the fake hostd's lines arrive over a socket: there is no event to await). */
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 5);
		await promise;
	}
}

async function startHostd() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-refusal-hostd-"));
	const sock = path.join(dir, "bridge.sock");
	const secret = "ef".repeat(32);
	fs.writeFileSync(path.join(dir, "bridge.secret"), secret);
	const lines: Json[] = [];
	let conn: net.Socket | undefined;
	const server = net.createServer(c => {
		conn = c;
		c.setEncoding("utf8");
		let buf = "";
		c.on("data", (chunk: string) => {
			buf += chunk;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				lines.push(JSON.parse(buf.slice(0, i)) as Json);
				buf = buf.slice(i + 1);
			}
		});
		c.write(`${JSON.stringify({ t: "auth", v: 1, secret })}\n`);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(sock, () => listening.resolve());
	await listening.promise;
	cleanups.push(() => {
		conn?.destroy();
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	let id = 0;
	return {
		sock,
		lines,
		async request(op: string, params: Json = {}): Promise<Json> {
			const reqId = ++id;
			conn?.write(`${JSON.stringify({ t: "req", id: reqId, op, params })}\n`);
			await until(() => lines.some(l => l.t === "res" && l.id === reqId));
			return lines.find(l => l.t === "res" && l.id === reqId)!;
		},
	};
}

type Model = { provider: string; id: string; name: string };
const MODELS: Model[] = [
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5" },
	{ provider: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
];
const resolve = (spec: string): Model | undefined => MODELS.find(m => `${m.provider}/${m.id}` === spec);

/**
 * A fake AgentSession that settles a refused turn as omp ≥ 18.13 does: the refusal leaves the
 * context and `getLastAssistantMessage()` reports it until the next run; omp's `retry()` then finds
 * nothing, and its continuation (`resumeAfterAskReanswer`) answers on the session's model.
 */
function fakeSession(sid: string, messages: unknown[], refused: Json | undefined) {
	const s = {
		isStreaming: false,
		isRetrying: false,
		model: MODELS[0] as Model,
		thinkingLevel: "high",
		pruned: refused,
		continued: [] as string[],
		retries: 0,
		sessionManager: {
			getSessionId: () => sid,
			getSessionFile: () => `/tmp/${sid}.jsonl`,
			getLeafId: () => null,
			getEntries: () => [{ type: "session_init", id: "i1", task: "explore the repo", tools: ["read", "yield"], systemPrompt: ["you explore"] }],
			getBranch: () => [],
			getCwd: () => "/w",
			getArtifactsDir: () => null,
			getEntry: () => undefined,
			isSessionOnDisk: () => true,
			buildSessionContext: () => ({ messages: s.agent.state.messages }),
		},
		agent: { state: { messages } },
		subscribe: () => () => {},
		getLastAssistantMessage: (): unknown => s.pruned ?? [...s.agent.state.messages].reverse().find(m => (m as Json).role === "assistant"),
		async retry() {
			s.retries++;
			if (!failedTail(s.agent.state.messages)) return false;
			s.agent.state.messages = [...s.agent.state.messages.slice(0, -1), ok("resumed")];
			return true;
		},
		resumeAfterAskReanswer() {
			s.pruned = undefined;
			s.continued.push(`${s.model.provider}/${s.model.id}:${s.thinkingLevel}`);
			s.agent.state.messages = [...s.agent.state.messages, ok(`answered on ${s.model.name}`)];
		},
		async setModel(model: Model) {
			s.model = model;
			s.thinkingLevel = "medium"; // omp re-applies the model's default level
			return { switched: true };
		},
		setThinkingLevel(level: string) {
			s.thinkingLevel = level;
		},
		async restoreInterruptedTurn() {
			return false; // omp leaves a terminal failure alone
		},
		async waitForIdle() {},
		asyncJobManager: undefined as unknown,
		settings: {},
	};
	return s;
}

function fakeJobs() {
	type Job = { id: string; options: Json; promise: Promise<unknown> };
	const jobs: Job[] = [];
	return {
		jobs,
		register(_type: string, label: string, run: (ctx: { jobId: string; signal: AbortSignal }) => Promise<unknown>, options: Json) {
			const job: Job = { id: String(options.id ?? label), options, promise: Promise.resolve() };
			jobs.push(job);
			job.promise = run({ jobId: job.id, signal: new AbortController().signal }).then(
				value => ({ ok: value }),
				(err: unknown) => ({ failed: err instanceof Error ? err.message : String(err) }),
			);
			return job.id;
		},
		getAllJobs: () => jobs,
		acknowledgeDeliveries: () => 0,
	};
}

async function bridgedOmp(hostd: { sock: string }) {
	process.env.TF_BRIDGE_SOCK = hostd.sock;
	const refused = refusal();
	const main = fakeSession("S1", [user("find the bug", 4_000), ok("reading", ["t1"]), result("t1", "the code")], refused);
	const sub = fakeSession("sub-explore", [user("explore the repo", 5_000)], refusal({ timestamp: 9_500 }));
	const jobs = fakeJobs();
	main.asyncJobManager = jobs;
	const refs: Record<string, Json> = {
		Main: { id: "Main", kind: "main", status: "idle", session: main, sessionFile: "/tmp/S1.jsonl" },
		explore: { id: "explore", displayName: "explore", kind: "sub", parentId: "Main", status: "idle", session: sub, sessionFile: "/tmp/sub-explore.jsonl" },
	};
	const registry = { get: (id: string) => refs[id], list: () => Object.values(refs), onChange: () => () => {} };
	const followUps: Json[] = [];
	const ns: Json = {
		VERSION: "18.14.2",
		AgentRegistry: class {
			static global() {
				return registry;
			}
		},
		AgentLifecycleManager: class {
			static global() {
				return { ensureLive: async (id: string) => refs[id]?.session, release: async () => true };
			}
		},
		// omp's follow-up turn with `restore`: it goes on through restoreInterruptedTurn().
		runSubagentFollowUpTurn: async (o: Json) => {
			followUps.push(o);
			const s = refs[String(o.id)]?.session as { restoreInterruptedTurn(): Promise<boolean> };
			return (await s.restoreInterruptedTurn()) ? { exitCode: 0, durationMs: 5 } : { exitCode: 1, error: "still refused", durationMs: 5 };
		},
		formatTaskResultSummary: (r: Json) => `<task-result status="${r.exitCode === 0 ? "completed" : "failed (exit 1)"}"></task-result>`,
		extractSessionInit: (entries: Json[]) => entries.find(e => e.type === "session_init") ?? null,
	};
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const ctx: Json = {
		mode: "rpc",
		hasUI: false,
		cwd: "/w",
		sessionManager: main.sessionManager,
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		get model() {
			return main.model;
		},
		models: { resolve },
		isIdle: () => !main.isStreaming,
		getContextUsage: () => undefined,
		setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
		clearTimer: (t: Timer) => clearInterval(t),
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		abort: () => {},
		hasPendingMessages: () => false,
		getPendingPlanReview: () => undefined,
	};
	const credentials = new Set(MODELS.map(m => `${m.provider}/${m.id}`));
	const pi = {
		pi: ns,
		logger: { debug: () => {} },
		events: { on: () => () => {}, emit: () => {} },
		on(name: string, fn: (e: Json, c: object) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand() {},
		getServiceTiers: () => ({}),
		getThinkingLevel: () => main.thinkingLevel,
		setThinkingLevel: (level: string) => main.setThinkingLevel(level),
		async setModel(model: Model) {
			if (!credentials.has(`${model.provider}/${model.id}`)) return false;
			await main.setModel(model);
			return true;
		},
		getSessionName: () => undefined,
		getCommands: () => [],
		sendUserMessage() {},
	};
	const fire = (name: string, event: Json, c: object = ctx) => (handlers.get(name) ?? []).map(fn => fn(event, c));
	await teleflockBridge(pi as never);
	fire("session_start", { type: "session_start" });
	cleanups.push(() => fire("session_shutdown", { type: "session_shutdown" }));
	await until(() => hostd.lines.some(l => l.t === "hello"), 5_000);
	return { main, sub, jobs, followUps, fire, ctx, credentials };
}

describe("refusal fallback against a fake hostd", () => {
	test("caps.refusals with omp's continuation; turn_error once omp settled the refused turn it dropped", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).refusals).toBe(true);
		// omp walks its own chain or retries: nothing yet.
		omp.main.isRetrying = true;
		omp.fire("agent_end", { type: "agent_end" });
		// A request after the watch ran: whatever it sent arrives before the answer (one ordered stream).
		await hostd.request("ping");
		expect(hostd.lines.some(l => l.event === "turn_error")).toBe(false);
		omp.main.isRetrying = false;
		omp.fire("agent_end", { type: "agent_end" });
		await until(() => hostd.lines.some(l => l.event === "turn_error"));
		const ev = hostd.lines.find(l => l.event === "turn_error")!;
		expect(ev).toMatchObject({
			sessionId: "S1",
			data: {
				agentId: "Main",
				main: true,
				kind: "other",
				provider: "anthropic",
				model: "claude-opus-5-5",
				modelName: "Opus 5.5",
				refusal: { kind: "refusal", category: "cyber", explanation: "The request asks for working exploit code." },
				promptAt: 4_000,
				at: 9_000,
			},
		});
		expect(JSON.stringify(ev)).not.toContain("fct_secret");
		omp.fire("agent_end", { type: "agent_end" });
		await hostd.request("ping");
		expect(hostd.lines.filter(l => l.event === "turn_error")).toHaveLength(1); // once per refusal
	});

	test("retryRefused: switch, keep the turn's thinking level, the notice first, then omp's continuation", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		expect(await hostd.request("liveSubscribe")).toMatchObject({ ok: true });
		expect(await hostd.request("retryRefused", { model: "anthropic/nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5", thinking: "weird" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
		omp.credentials.delete("anthropic/claude-sonnet-5-5");
		expect(await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5" })).toMatchObject({ ok: false, error: { code: "auth_required" } });
		expect(omp.main.continued).toEqual([]);
		omp.credentials.add("anthropic/claude-sonnet-5-5");
		omp.main.model = MODELS[0]!;
		omp.main.thinkingLevel = "high";
		const notice = "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued";
		const res = await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5", notice });
		expect(res).toMatchObject({
			ok: true,
			result: { started: true, model: "anthropic/claude-sonnet-5-5", modelName: "Sonnet 5.5", previous: { model: "anthropic/claude-opus-5-5", name: "Opus 5.5", thinking: "high" } },
		});
		// The refused turn's level stays (omp's setModel re-applied the model's default) and omp goes on without a prompt.
		expect(omp.main.continued).toEqual(["anthropic/claude-sonnet-5-5:high"]);
		expect(omp.main.retries).toBe(0);
		await until(() => hostd.lines.some(l => l.t === "live" && ((l.f as Json).event as Json | undefined)?.source === "refusal"));
		const live = hostd.lines.find(l => l.t === "live" && ((l.f as Json).event as Json | undefined)?.source === "refusal")!;
		expect((live.f as Json).event).toEqual({ type: "notice", level: "warning", message: notice, source: "refusal" });
		// Nothing refused any more: nothing to go on with.
		expect(await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5" })).toMatchObject({ ok: true, result: { started: false } });
		expect(omp.main.continued).toHaveLength(1);
	});

	test("retryRefused: an explicit thinking level, and nothing while the session runs", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		omp.main.isStreaming = true;
		expect(await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5" })).toMatchObject({ ok: true, result: { started: false } });
		omp.main.isStreaming = false;
		expect(await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5", thinking: "low" })).toMatchObject({ ok: true, result: { started: true } });
		expect(omp.main.continued).toEqual(["anthropic/claude-sonnet-5-5:low"]);
	});

	test("retryRefused {agentId}: the subagent switches and goes on as a job of its parent", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		const res = await hostd.request("retryRefused", { agentId: "explore", model: "anthropic/claude-sonnet-5-5" });
		expect(res).toMatchObject({ ok: true, result: { started: true, model: "anthropic/claude-sonnet-5-5", previous: { model: "anthropic/claude-opus-5-5", thinking: "high" } } });
		const job = omp.jobs.jobs[0]!;
		expect(job.options).toMatchObject({ id: "explore", agentId: "explore", ownerId: "Main" });
		expect(await job.promise).toEqual({ ok: '<task-result status="completed"></task-result>' });
		expect(omp.followUps[0]).toMatchObject({ id: "explore", restore: true, message: "explore the repo" });
		expect(omp.sub.continued).toEqual(["anthropic/claude-sonnet-5-5:high"]);
		expect(omp.sub.retries).toBe(0);
		expect(omp.main.model.id).toBe("claude-opus-5-5"); // the main session keeps its model
		expect(await hostd.request("retryRefused", { agentId: "explore", model: "anthropic/claude-sonnet-5-5" })).toMatchObject({ ok: true, result: { started: false } });
		expect(await hostd.request("retryRefused", { agentId: "nobody", model: "anthropic/claude-sonnet-5-5" })).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	test("retryRefused: the notice only once omp went on; a continuation that fails puts the model back", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		expect(await hostd.request("liveSubscribe")).toMatchObject({ ok: true });
		const notices = () => hostd.lines.filter(l => l.t === "live" && ((l.f as Json).event as Json | undefined)?.source === "refusal");
		const notice = "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued";
		// omp's continuation throws: the session runs the model and level the turn ran, hostd hears why.
		omp.main.resumeAfterAskReanswer = () => {
			throw new Error("omp is compacting the session");
		};
		const failed = await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5", notice });
		expect(failed).toMatchObject({ ok: false, error: { message: "omp is compacting the session" } });
		expect([omp.main.model.id, omp.main.thinkingLevel]).toEqual(["claude-opus-5-5", "high"]);
		// An omp that kept the refused turn, whose retry() did not go on: switched, said so in the
		// reply (hostd decides about going back), but no "switched and continued".
		omp.main.pruned = undefined;
		omp.main.agent.state.messages = [user("find the bug", 4_000), refusal()];
		omp.main.retry = async () => false;
		const res = await hostd.request("retryRefused", { model: "anthropic/claude-sonnet-5-5", notice });
		expect(res).toMatchObject({ ok: true, result: { started: false, model: "anthropic/claude-sonnet-5-5", previous: { model: "anthropic/claude-opus-5-5", thinking: "high" } } });
		await hostd.request("ping");
		expect(notices()).toEqual([]);
	});

	test("retryRefused {agentId}: a job that cannot be registered leaves the subagent on its model; the notice once it went on", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd);
		expect(await hostd.request("liveSubscribe")).toMatchObject({ ok: true });
		const notices = () => hostd.lines.filter(l => l.t === "live" && ((l.f as Json).event as Json | undefined)?.source === "refusal");
		const register = omp.jobs.register;
		omp.jobs.register = () => {
			throw new Error("Background job limit reached (4). Wait for running jobs to finish or cancel one.");
		};
		const notice = "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued";
		const failed = await hostd.request("retryRefused", { agentId: "explore", model: "anthropic/claude-sonnet-5-5", notice });
		expect(failed).toMatchObject({ ok: false, error: { message: "Background job limit reached (4). Wait for running jobs to finish or cancel one." } });
		expect([omp.sub.model.id, omp.sub.thinkingLevel, omp.sub.continued]).toEqual(["claude-opus-5-5", "high", []]);
		expect(notices()).toEqual([]);
		// Room again: the job goes on with the turn; the notice follows omp's continuation.
		omp.jobs.register = register;
		const res = await hostd.request("retryRefused", { agentId: "explore", model: "anthropic/claude-sonnet-5-5", notice });
		expect(res).toMatchObject({ ok: true, result: { started: true, previous: { model: "anthropic/claude-opus-5-5", thinking: "high" } } });
		await omp.jobs.jobs[0]!.promise;
		expect(omp.sub.continued).toEqual(["anthropic/claude-sonnet-5-5:high"]);
		await until(() => notices().length === 1);
		expect((notices()[0]!.f as Json).event).toEqual({ type: "notice", level: "warning", message: notice, source: "refusal" });
	});
});
