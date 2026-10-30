// Tests for the bridge's 2.1.0 resume features (docs/bridge-protocol.md "Resume"): the turn-error
// classifier and retry hints, failed-tail detection, the `context` limit guard, the session-file tail,
// the one-shot retry arming, and the `retry` / `resumeTree` / `failedTails` / `setAutoResume` ops and
// `turn_error` events of the whole extension against a fake hostd socket with a fake omp.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, {
	armRetry,
	classifyTurnError,
	type ErrorClassifier,
	failedTail,
	guardContext,
	LIMIT_NEUTRAL,
	neutralizeTaskResults,
	quietIfDelivered,
	type RetrySession,
	retryHintMs,
	sessionFileTail,
} from "./teleflock-bridge";

type Json = Record<string, unknown>;
const SLOT = Symbol.for("teleflock.bridge");

const limitError = (extra: Json = {}): Json => ({
	role: "assistant",
	content: [{ type: "text", text: "" }],
	api: "openai-completions",
	provider: "mocklab",
	model: "mock-1",
	stopReason: "error",
	errorMessage: "429 You have hit your usage limit. Try again in 2 minutes.",
	errorStatus: 429,
	timestamp: 1_000,
	...extra,
});
const user = (text: string): Json => ({ role: "user", content: text, timestamp: 1 });
const ok = (text: string, calls: string[] = []): Json => ({
	role: "assistant",
	content: [{ type: "text", text }, ...calls.map(id => ({ type: "toolCall", id, name: "task", arguments: {} }))],
	stopReason: calls.length ? "toolUse" : "stop",
});
const result = (id: string, text: string, extra: Json = {}): Json => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], ...extra });
const failedTask = (id: string, error: string) =>
	`<task-result id="${id}" agent="explore" status="failed (exit 1)" duration="3s">\n<output>\n${error}\n</output>\n</task-result>`;
const isLimit = (text: string) => classifyTurnError({ errorMessage: text }).class !== "other";

/** Every tool result follows an assistant tool call with its id, and every call has its result. */
function pairingValid(messages: unknown[]): boolean {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const m of messages as Json[]) {
		if (m.role === "assistant") for (const b of (m.content as Json[]) ?? []) if (b.type === "toolCall") calls.add(String(b.id));
		if (m.role === "toolResult") {
			if (!calls.has(String(m.toolCallId))) return false;
			results.add(String(m.toolCallId));
		}
	}
	return [...calls].every(id => results.has(id));
}

describe("classifyTurnError", () => {
	test("text fallback: usage limits, temporary rate limits, everything else", () => {
		expect(classifyTurnError(limitError()).class).toBe("usageLimit");
		expect(classifyTurnError({ errorMessage: "402 Payment Required" }).class).toBe("usageLimit");
		expect(classifyTurnError({ errorMessage: "insufficient_quota: You exceeded your current quota" }).class).toBe("usageLimit");
		expect(classifyTurnError({ errorMessage: "429 Too Many Requests", errorStatus: 429 }).class).toBe("rateLimit");
		expect(classifyTurnError({ errorMessage: "529 overloaded_error: Overloaded" }).class).toBe("rateLimit");
		expect(classifyTurnError({ errorMessage: "500 Internal Server Error", errorStatus: 500 }).class).toBe("other");
		expect(classifyTurnError({ errorMessage: "401 invalid x-api-key", errorStatus: 401 }).class).toBe("other");
		expect(classifyTurnError({}).class).toBe("other");
	});

	test("omp's classifier decides when present, on a copy of the message", () => {
		const USAGE = 0x0008_0000;
		const seen: Json[] = [];
		const ai: ErrorClassifier = {
			Flag: { UsageLimit: USAGE },
			classifyMessage(m) {
				seen.push(m);
				m.errorId = 7; // omp writes the id back: never onto omp's own message
				return String(m.errorMessage).includes("quota") ? USAGE : 429;
			},
			is: (id, flag) => ((id ?? 0) & flag) === flag,
			parseRateLimitReason: text => (text.includes("concurrent") ? "CONCURRENT_LIMIT" : "UNKNOWN"),
		};
		const msg = { errorMessage: "quota exceeded", errorStatus: 429, provider: "p" };
		expect(classifyTurnError(msg, ai)).toEqual({ class: "usageLimit", reason: "UNKNOWN" });
		expect(msg).not.toHaveProperty("errorId");
		expect(seen[0]).toMatchObject({ provider: "p", errorStatus: 429 });
		expect(classifyTurnError({ errorMessage: "slow down", errorStatus: 429 }, ai).class).toBe("rateLimit");
		expect(classifyTurnError({ errorMessage: "too many concurrent requests", errorStatus: 503 }, ai).class).toBe("rateLimit");
		expect(classifyTurnError({ errorMessage: "bad request", errorStatus: 400 }, ai).class).toBe("other");
	});

	test("the neutral line is not a limit itself (the guard stays idempotent)", () => {
		expect(classifyTurnError({ errorMessage: LIMIT_NEUTRAL }).class).toBe("other");
	});
});

describe("retryHintMs", () => {
	test("omp's parser when given, else the common phrasings", () => {
		expect(retryHintMs("p", "x", () => 5_000)).toBe(5_000);
		expect(retryHintMs("p", "x", () => undefined)).toBeUndefined();
		expect(retryHintMs(undefined, "429 You have hit your usage limit. Try again in 2 minutes.")).toBe(120_000);
		expect(retryHintMs(undefined, "429 Too Many Requests retry-after-ms=90000")).toBe(90_000);
		expect(retryHintMs(undefined, "Your limit resets in 3 hours")).toBe(10_800_000);
		expect(retryHintMs(undefined, "retry after 30s")).toBe(30_000);
		expect(retryHintMs(undefined, "429 Too Many Requests")).toBeUndefined();
		expect(retryHintMs(undefined, undefined)).toBeUndefined();
	});

	test("a hint beyond 30 days or not finite is no hint (retryAt stays a plain integer)", () => {
		expect(retryHintMs(undefined, "retry in 99999999999999999999 h")).toBeUndefined();
		expect(retryHintMs(undefined, "retry-after-ms=99999999999999999999")).toBeUndefined();
		expect(retryHintMs("p", "x", () => Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(retryHintMs("p", "x", () => 1e300)).toBeUndefined();
		expect(retryHintMs("p", "x", () => 1_234.6)).toBe(1_235);
		expect(retryHintMs(undefined, "retry in 30 days")).toBeUndefined(); // no such unit: not read
		expect(retryHintMs(undefined, "retry in 720 h")).toBe(30 * 24 * 3_600_000);
		expect(retryHintMs(undefined, "retry in 721 h")).toBeUndefined();
	});
});

describe("failedTail", () => {
	test("a failed or aborted assistant ends the transcript, synthetic results and eval snapshots aside", () => {
		const err = limitError();
		expect(failedTail([user("hi"), err])).toBe(err);
		const aborted = { role: "assistant", content: [], stopReason: "aborted" };
		expect(failedTail([user("hi"), aborted])).toBe(aborted);
		const withCall = limitError({ content: [{ type: "toolCall", id: "c1" }] });
		const synthetic = result("c1", "aborted", { details: { __synthetic: true } });
		const evalState = { role: "custom", customType: "eval-state-context", content: "" };
		expect(failedTail([user("hi"), withCall, synthetic, evalState])).toBe(withCall);
		expect(failedTail([user("hi"), ok("done")])).toBeUndefined();
		expect(failedTail([user("hi"), ok("a", ["c1"]), result("c1", "x")])).toBeUndefined();
		expect(failedTail([])).toBeUndefined();
	});
});

describe("guardContext", () => {
	test("limit-error turns go with their paired tool results; pairing stays valid; other content stays", () => {
		const authError = limitError({ errorMessage: "401 invalid api key", errorStatus: 401, timestamp: 5 });
		const aborted = { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" };
		const failedCall = limitError({ content: [{ type: "toolCall", id: "c9", name: "read", arguments: {} }] });
		const messages = [
			user("start"),
			ok("spawning", ["t1"]),
			result("t1", "Background job t1 started"),
			limitError(),
			failedCall,
			result("c9", "aborted", { details: { __synthetic: true }, isError: true }),
			authError,
			aborted,
			user("continue"),
		];
		const out = guardContext(messages, m => classifyTurnError(m).class !== "other", isLimit);
		expect(out).not.toBeNull();
		expect(out).toEqual([user("start"), ok("spawning", ["t1"]), result("t1", "Background job t1 started"), authError, aborted, user("continue")]);
		expect(pairingValid(out!)).toBe(true);
		expect(messages).toHaveLength(9); // the input is never changed
	});

	test("a subagent's limit failure in an async-result or task result reads the neutral line", () => {
		const notice = (body: string) => `<system-notice>\nBackground job a1 has completed. Resume your work using the result below.\n${body}\nAgent: history://a1\n</system-notice>`;
		const asyncLimit = { role: "custom", customType: "async-result", content: notice(failedTask("a1", "Error: 429 You have hit your usage limit. Try again in 2 minutes.")), display: true };
		const asyncOther = { role: "custom", customType: "async-result", content: notice(failedTask("a2", "Error: ENOENT: no such file")) };
		const done = `<task-result id="a3" agent="explore" status="completed" duration="1s">\n<output>\nThe usage limit code lives in limits.rs\n</output>\n</task-result>`;
		const syncLimit = result("t2", failedTask("a4", "Error: 429 Too Many Requests"));
		const messages = [user("go"), ok("x", ["t2"]), syncLimit, asyncLimit, asyncOther, { role: "custom", customType: "async-result", content: done }];
		const out = guardContext(messages, () => false, isLimit)!;
		expect(out).not.toBeNull();
		const limitText = String((out[3] as Json).content);
		expect(limitText).toContain('<task-result id="a1" agent="explore" status="interrupted" duration="3s">');
		expect(limitText).toContain(LIMIT_NEUTRAL);
		expect(limitText).not.toContain("429");
		expect(limitText).toContain("Agent: history://a1");
		expect((out[3] as Json).customType).toBe("async-result");
		expect(out[4]).toBe(asyncOther);
		expect(out[5]).toEqual(messages[5]!);
		// A failed run whose long output merely talks about rate limits is work, not a provider failure.
		const talk = `<task-result id="a5" agent="task" status="failed (exit 1)" duration="9s">\n<output>\n${"Implemented the rate limit middleware. ".repeat(60)}\n</output>\n</task-result>`;
		expect(guardContext([user("go"), { role: "custom", customType: "async-result", content: talk }], () => false, isLimit)).toBeNull();
		const syncText = ((out[2] as Json).content as Json[])[0]!.text as string;
		expect(syncText).toContain('status="interrupted"');
		expect(syncText).not.toContain("Too Many Requests");
		expect(pairingValid(out)).toBe(true);
		// Idempotent: a second pass (a second bridge copy) changes nothing.
		expect(guardContext(out, m => classifyTurnError(m).class !== "other", isLimit)).toBeNull();
	});

	test("nothing to change: null (omp keeps its own copy)", () => {
		expect(guardContext([user("hi"), ok("hello")], () => true, () => true)).toBeNull();
		expect(neutralizeTaskResults("plain text", () => true)).toBe("plain text");
	});
});

describe("sessionFileTail", () => {
	test("reads the header id and the trailing messages of a session file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-resume-test-"));
		const file = path.join(dir, "s.jsonl");
		const lines = [
			{ type: "session", id: "sub-1", version: 3 },
			{ type: "message", id: "e1", message: user("task") },
			{ type: "model_change", id: "e2" },
			{ type: "message", id: "e3", message: limitError() },
		];
		fs.writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join("\n")}\n{"type":"mess`);
		const tail = sessionFileTail(file);
		expect(tail.sessionId).toBe("sub-1");
		expect(tail.messages).toHaveLength(2);
		expect(failedTail(tail.messages)).toMatchObject({ stopReason: "error" });
		expect(sessionFileTail(path.join(dir, "missing.jsonl"))).toEqual({ messages: [] });
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("armRetry", () => {
	test("the next restoreInterruptedTurn is omp's retry, once; disarm restores the original", async () => {
		const calls: string[] = [];
		const proto = {
			async restoreInterruptedTurn() {
				calls.push("restore");
				return false;
			},
		};
		const s = Object.assign(Object.create(proto) as object, {
			subscribe: () => () => {},
			async retry() {
				calls.push("retry");
				return true;
			},
		}) as RetrySession;
		const armed = armRetry(s);
		expect(await s.restoreInterruptedTurn!()).toBe(true);
		expect(armed.used()).toBe(true);
		expect(await s.restoreInterruptedTurn!()).toBe(false);
		armed.disarm();
		expect(calls).toEqual(["retry", "restore"]);
		expect(Object.hasOwn(s, "restoreInterruptedTurn")).toBe(false);
	});
});

describe("quietIfDelivered", () => {
	test("the resume job stays silent only when omp's own job for that agent and owner started during it", () => {
		const acked: string[] = [];
		const list = [
			{ id: "explore", agentId: "explore", ownerId: "Main", startTime: 100 },
			{ id: "old", agentId: "explore", ownerId: "Main", startTime: 50 },
			{ id: "other", agentId: "nested", ownerId: "explore", startTime: 150 },
		];
		const jobs = {
			register: () => "",
			getAllJobs: () => list,
			acknowledgeDeliveries: (ids: string[]) => acked.push(...ids),
		};
		expect(quietIfDelivered(jobs, "explore", "explore", "Main", 100)).toBe(false);
		list.push({ id: "explore-2", agentId: "explore", ownerId: "Main", startTime: 120 });
		expect(quietIfDelivered(jobs, "explore", "explore", "Main", 100)).toBe(true);
		expect(acked).toEqual(["explore"]);
		// An omp without those job manager methods: the resume job delivers.
		expect(quietIfDelivered({ register: () => "" }, "explore", "explore", "Main", 100)).toBe(false);
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

async function until(pred: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise(r => setTimeout(r, 5));
	}
}

async function startHostd() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-resume-hostd-"));
	const sock = path.join(dir, "bridge.sock");
	const secret = "cd".repeat(32);
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
	await new Promise<void>(r => server.listen(sock, r));
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

/** A fake AgentSession with omp's retry surface; `retry()` resumes a failed tail like omp's. */
function fakeSession(sid: string, messages: unknown[]) {
	const sm = {
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
	};
	const s = {
		isStreaming: false,
		isRetrying: false,
		retries: 0,
		sessionManager: sm,
		agent: { state: { messages } },
		subscribe: () => () => {},
		async retry() {
			s.retries++;
			if (!failedTail(s.agent.state.messages)) return false;
			s.agent.state.messages = [...s.agent.state.messages.slice(0, -1), ok("resumed")];
			return true;
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

/** omp's AsyncJobManager as the bridge uses it: ids suffixed like omp's (`explore-2`), a job's
 *  run sees its id, and acknowledged ids (`quiet`) are not delivered. */
function fakeJobs() {
	type Job = { id: string; type: string; label: string; options: Json; agentId?: unknown; ownerId?: unknown; startTime: number; promise: Promise<unknown> };
	const jobs: Job[] = [];
	const quiet = new Set<string>();
	return {
		jobs,
		quiet,
		register(type: string, label: string, run: (ctx: { jobId: string; signal: AbortSignal }) => Promise<unknown>, options: Json) {
			const base = String(options.id ?? label);
			let id = base;
			for (let n = 2; jobs.some(j => j.id === id); n++) id = `${base}-${n}`;
			const job: Job = { id, type, label, options, agentId: options.agentId, ownerId: options.ownerId, startTime: Date.now(), promise: Promise.resolve() };
			jobs.push(job);
			job.promise = run({ jobId: id, signal: new AbortController().signal }).then(
				value => ({ ok: value }),
				(err: unknown) => ({ failed: err instanceof Error ? err.message : String(err) }),
			);
			return id;
		},
		getAllJobs: () => jobs,
		acknowledgeDeliveries(ids: string[]) {
			for (const id of ids) quiet.add(id);
			return ids.length;
		},
	};
}

async function bridgedOmp(hostd: Awaited<ReturnType<typeof startHostd>>, withTask: boolean, opts: { wake?: boolean } = {}) {
	process.env.TF_BRIDGE_SOCK = hostd.sock;
	const main = fakeSession("S1", [user("go"), ok("spawning", ["t1"]), result("t1", "started"), limitError()]);
	const sub = fakeSession("sub-explore", [user("explore the repo"), limitError({ timestamp: 2_000 })]);
	const nested = fakeSession("sub-nested", [user("dig"), limitError({ timestamp: 3_000 })]);
	const jobs = fakeJobs();
	main.asyncJobManager = jobs;
	const refs = new Map<string, Json>([
		["Main", { id: "Main", kind: "main", status: "idle", session: main, sessionFile: "/tmp/S1.jsonl" }],
		["explore", { id: "explore", displayName: "explore", kind: "sub", parentId: "Main", status: "idle", session: sub, sessionFile: "/tmp/sub-explore.jsonl" }],
		["nested", { id: "nested", displayName: "nested", kind: "sub", parentId: "explore", status: "idle", session: nested, sessionFile: "/tmp/sub-nested.jsonl" }],
	]);
	const registry = { get: (id: string) => refs.get(id), list: () => [...refs.values()], onChange: () => () => {} };
	const followUps: Json[] = [];
	const ns: Json = {
		VERSION: "18.13.3",
		AgentRegistry: class {
			static global() {
				return registry;
			}
		},
		AgentLifecycleManager: class {
			static global() {
				return { ensureLive: async (id: string) => (refs.get(id) as Json).session, release: async () => true };
			}
		},
	};
	if (withTask) {
		// omp's follow-up turn with `restore`: it goes on through restoreInterruptedTurn().
		ns.runSubagentFollowUpTurn = async (o: Json) => {
			followUps.push(o);
			const ref = refs.get(String(o.id)) as Json;
			const s = ref.session as ReturnType<typeof fakeSession>;
			const resumed = await s.restoreInterruptedTurn();
			// omp's wake monitor saw the retried turn yield: it hands the result to the parent itself.
			if (resumed && opts.wake) jobs.register("task", String(o.id), async () => "<task-result>woke</task-result>", { id: o.id, agentId: o.id, ownerId: ref.parentId });
			return resumed ? { exitCode: 0, durationMs: 5 } : { exitCode: 1, error: "still failed", durationMs: 5 };
		};
		ns.formatTaskResultSummary = (r: Json) => `<task-result status="${r.exitCode === 0 ? "completed" : "failed (exit 1)"}"></task-result>`;
		ns.extractSessionInit = (entries: Json[]) => entries.find(e => e.type === "session_init") ?? null;
	}
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const ctx: Json = {
		mode: "rpc",
		hasUI: false,
		cwd: "/w",
		sessionManager: main.sessionManager,
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		model: { provider: "mocklab", id: "mock-1" },
		isIdle: () => !main.isStreaming,
		getContextUsage: () => undefined,
		setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
		clearTimer: (t: Timer) => clearInterval(t),
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		abort: () => {},
		hasPendingMessages: () => false,
		getPendingPlanReview: () => undefined,
	};
	const pi = {
		pi: ns,
		logger: { debug: () => {} },
		events: { on: () => () => {}, emit: () => {} },
		on(name: string, fn: (e: Json, c: object) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand() {},
		getServiceTiers: () => ({}),
		getThinkingLevel: () => "low",
		getSessionName: () => undefined,
		getCommands: () => [],
		sendUserMessage() {},
	};
	const fire = (name: string, event: Json, c: object = ctx) => (handlers.get(name) ?? []).map(fn => fn(event, c));
	await teleflockBridge(pi as never);
	fire("session_start", { type: "session_start" });
	cleanups.push(() => fire("session_shutdown", { type: "session_shutdown" }));
	await until(() => hostd.lines.some(l => l.t === "hello"), 5_000);
	return { main, sub, nested, jobs, refs, followUps, fire, ctx };
}

describe("resume ops against a fake hostd", () => {
	test("caps: retry and resumeTree only with omp's internals", async () => {
		const hostd = await startHostd();
		await bridgedOmp(hostd, false);
		const hello = hostd.lines.find(l => l.t === "hello")!;
		expect((hello.caps as Json).retry).toBe(true);
		expect((hello.caps as Json).resumeTree).toBe(false);
		expect((hello.caps as Json).turnError).toBe(true);
		expect((hello.caps as Json).limitGuard).toBe(true);
		const res = await hostd.request("retry", { agentId: "explore" });
		expect(res).toMatchObject({ ok: false, error: { code: "unsupported" } });
	});

	test("retry: omp's retry for the main session, a parent-owned job for a subagent", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd, true);
		expect(((hostd.lines.find(l => l.t === "hello")!.caps as Json).resumeTree)).toBe(true);
		expect(await hostd.request("retry")).toMatchObject({ ok: true, result: { started: true } });
		expect(omp.main.retries).toBe(1);
		expect(await hostd.request("retry")).toMatchObject({ ok: true, result: { started: false } });

		expect(await hostd.request("retry", { agentId: "explore" })).toMatchObject({ ok: true, result: { started: true } });
		const job = omp.jobs.jobs[0]!;
		expect(job).toMatchObject({ type: "task", label: "explore", options: { id: "explore", agentId: "explore", ownerId: "Main" } });
		expect(await job.promise).toEqual({ ok: '<task-result status="completed"></task-result>' });
		expect(omp.jobs.quiet.size).toBe(0);
		expect(omp.sub.retries).toBe(1);
		expect(omp.followUps[0]).toMatchObject({ id: "explore", restore: true, structured: true, message: "explore the repo" });
		// Not failed any more: nothing to resume.
		expect(await hostd.request("retry", { agentId: "explore" })).toMatchObject({ ok: true, result: { started: false } });
		expect(await hostd.request("retry", { agentId: "nobody" })).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	test("a resumed subagent's result reaches its parent once when omp's wake monitor delivered it", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd, true, { wake: true });
		expect(await hostd.request("retry", { agentId: "explore" })).toMatchObject({ ok: true, result: { started: true } });
		await until(() => omp.jobs.jobs.length === 2);
		await Promise.all(omp.jobs.jobs.map(j => j.promise));
		expect(omp.jobs.jobs.map(j => [j.id, j.ownerId])).toEqual([
			["explore", "Main"],
			["explore-2", "Main"],
		]);
		// The resume job stays silent; omp's own job carries the result.
		expect([...omp.jobs.quiet]).toEqual(["explore"]);
	});

	test("resumeTree: parents before children, then the root; failedTails lists what failed", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd, true);
		const tails = await hostd.request("failedTails");
		const listed = ((tails.result as Json).tails as Json[]).map(t => [t.agentId, t.kind, t.main]);
		expect(listed).toEqual([
			["Main", "usageLimit", true],
			["explore", "usageLimit", false],
			["nested", "usageLimit", false],
		]);
		expect(((tails.result as Json).tails as Json[])[1]).toMatchObject({ parentId: "Main", sessionId: "sub-explore", retryAt: 2_000 + 120_000 });
		const res = await hostd.request("resumeTree", { subagentIds: ["nested", "explore"], root: true });
		expect(res).toMatchObject({ ok: true, result: { root: true, subagents: [{ agentId: "explore", started: true }, { agentId: "nested", started: true }] } });
		expect(omp.jobs.jobs.map(j => [j.label, j.options.ownerId])).toEqual([
			["explore", "Main"],
			["nested", "explore"],
		]);
		expect(omp.main.retries).toBe(1);
	});

	test("turn_error once omp settled a terminal failure; the guard follows setAutoResume", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd, true);
		omp.main.isRetrying = true;
		omp.fire("agent_end", { type: "agent_end" });
		await new Promise(r => setTimeout(r, 30));
		expect(hostd.lines.some(l => l.event === "turn_error")).toBe(false);
		omp.main.isRetrying = false;
		omp.fire("agent_end", { type: "agent_end" });
		await until(() => hostd.lines.some(l => l.event === "turn_error"));
		const ev = hostd.lines.find(l => l.event === "turn_error")!;
		expect(ev).toMatchObject({ sessionId: "S1", data: { agentId: "Main", main: true, kind: "usageLimit", provider: "mocklab", errorStatus: 429, retryAt: 121_000 } });
		omp.fire("agent_end", { type: "agent_end" });
		await new Promise(r => setTimeout(r, 30));
		expect(hostd.lines.filter(l => l.event === "turn_error")).toHaveLength(1); // once per failed message

		const messages = [user("go"), limitError(), user("again")];
		const [off] = omp.fire("context", { type: "context", messages }) as Array<Json | undefined>;
		expect(off).toBeUndefined();
		expect(await hostd.request("setAutoResume", { on: true })).toMatchObject({ ok: true });
		const [on] = omp.fire("context", { type: "context", messages }) as Array<Json | undefined>;
		expect(on).toEqual({ messages: [user("go"), user("again")] });
	});
});
