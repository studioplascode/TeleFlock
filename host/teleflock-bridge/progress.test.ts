// Tests for the bridge's 2.6.0 main-agent progress (docs/bridge-protocol.md "Main-agent progress"):
// the reply parser (omp's `parseCompletionEstimate` rules), the question, the schedule of
// ProgressProbe (first wait from the run's start, never two at once, skipped while not ready,
// cancelled with the run, a run omp goes on with and its end), and the whole extension against a
// fake hostd with a fake omp whose context runs side turns: `state.progress` once the agent
// answered, the side turn billed to the session, no question for a hostd that does not read the
// answer or with omp's `task.completionProbe` off, and the estimate gone with the run.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, {
	agoText,
	inflightCalls,
	type MainProgress,
	parseProgressReply,
	PROGRESS_DELAYS_MS,
	PROGRESS_SETTLE_MS,
	PROGRESS_USAGE_PURPOSE,
	progressDelays,
	progressPrompt,
	ProgressProbe,
} from "./teleflock-bridge";

type Json = Record<string, unknown>;
const SLOT = Symbol.for("teleflock.bridge");
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
	delete process.env.TF_BRIDGE_PROGRESS_DELAYS;
});

/** Frames cross a real unix socket (the extension's own I/O), so the condition is polled, not timed. */
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await Bun.sleep(5);
	}
}

describe("the reply, read by omp's rules", () => {
	test("the JSON line, also in a fence or prose; pct a number or a numeric string, clamped and rounded", () => {
		expect(parseProgressReply('{"pct": 40, "stage": "wiring the API"}')).toEqual({ pct: 40, stage: "wiring the API" });
		expect(parseProgressReply('```json\n{"pct": "65%", "stage": "tests"}\n```')).toEqual({ pct: 65, stage: "tests" });
		expect(parseProgressReply('Sure: {"percent": 72.6} is my guess')).toEqual({ pct: 73 });
		expect(parseProgressReply('{"pct": 140}')).toEqual({ pct: 100 });
		expect(parseProgressReply('{"pct": -3}')).toEqual({ pct: 0 });
	});

	test("the stage comes from the first object with one, as one plain line of at most 80 characters", () => {
		// Braces inside a string do not split the object; an object without `pct` still names the stage.
		expect(parseProgressReply('{"stage": "reading {the} router"} then {"pct": 10}')).toEqual({ pct: 10, stage: "reading {the} router" });
		const shown = JSON.stringify({ pct: 5, stage: "  \u001b[32mtwo\u001b[0m\n  lines\u0007 " });
		expect(parseProgressReply(shown)).toEqual({ pct: 5, stage: "two lines" });
		// Cut by characters, never inside a surrogate pair (hostd refuses half of one).
		const stage = parseProgressReply(JSON.stringify({ pct: 50, stage: `${"x".repeat(78)}😀yz` }))!.stage!;
		expect(Array.from(stage)).toHaveLength(80);
		expect(stage.endsWith("x😀…")).toBe(true);
	});

	test("without a JSON pct a plain percentage counts (a stage seen stays); nothing readable is no estimate", () => {
		expect(parseProgressReply('{"stage": "benchmarks"} Roughly 70%.')).toEqual({ pct: 70, stage: "benchmarks" });
		expect(parseProgressReply("~65 % done")).toEqual({ pct: 65 });
		expect(parseProgressReply('{"pct": "lots"}')).toBeUndefined();
		expect(parseProgressReply('{"pct": 40')).toBeUndefined();
		expect(parseProgressReply("not sure yet")).toBeUndefined();
	});
});

describe("the question", () => {
	test("omp's anchors for the user's current request, the calls still being written, the previous estimate", () => {
		const bare = progressPrompt([]);
		expect(bare.startsWith("<progress-check>\n")).toBe(true);
		expect(bare).toContain("user's current request");
		expect(bare).toContain("- 75–90%: all deliverables written; running tests, fixing failures");
		expect(bare).toContain("NEVER use tools.");
		expect(bare).not.toContain("interrupted mid-response");
		expect(bare).not.toContain("previous estimate");
		const full = progressPrompt([{ name: "write", path: "src/app.ts", chars: 5120 }, { name: "bash", chars: 40 }], { pct: 40, stage: "wiring", ago: "5m" });
		expect(full).toContain("- `write` (src/app.ts): 5120 characters of arguments so far\n- `bash`: 40 characters of arguments so far\nCount that work as done so far.");
		expect(full).toContain('Your previous estimate, 5m ago, was 40% at stage "wiring".');
	});

	test("ages as omp writes them", () => {
		expect([850, 42_500, 59_960, 300_000, 330_000, 3_900_000, 2 * 86_400_000 + 3 * 3_600_000].map(agoText)).toEqual(["850ms", "42.5s", "1m", "5m", "5m30s", "1h5m", "2d3h"]);
	});

	test("the calls being written: their names, paths and how much of the arguments pi-ai streamed", () => {
		const partial = Symbol("provider.block.partialJson");
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "Writing it." },
				{ type: "toolCall", name: "write", arguments: { path: "src/app.ts" }, [partial]: '{"path":"src/app.ts","content":"export const' },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
			],
		};
		expect(inflightCalls(message)).toEqual([
			{ name: "write", path: "src/app.ts", chars: 44 },
			{ name: "bash", chars: JSON.stringify({ command: "ls" }).length },
		]);
		expect(inflightCalls({ role: "user", content: [] })).toEqual([]);
		expect(inflightCalls(undefined)).toEqual([]);
	});

	test("the schedule is omp's unless the test hook names one", () => {
		expect(PROGRESS_DELAYS_MS).toEqual([120_000, 300_000, 600_000, 1_800_000, 3_600_000]);
		expect(progressDelays(undefined)).toBe(PROGRESS_DELAYS_MS);
		expect(progressDelays("2000, 3000")).toEqual([2000, 3000]);
		expect(progressDelays("x,-5,0")).toBe(PROGRESS_DELAYS_MS);
	});
});

/** A clock that moves only when the test says: each timer waits until `elapse` fires it. */
function testClock(start = 1_000) {
	const timers: Array<{ fn: () => void; ms: number; setAt: number; fired: boolean; cleared: boolean }> = [];
	const clock = {
		at: start,
		now: () => clock.at,
		setTimer(fn: () => void, ms: number) {
			const timer = { fn, ms, setAt: clock.at, fired: false, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer(timer: unknown) {
			const mine = timers.find(t => t === timer);
			if (mine) mine.cleared = true;
		},
	};
	/** The pending wait passes: the clock moves to its end and the timer fires. */
	const elapse = (): void => {
		const timer = timers.findLast(t => !t.fired && !t.cleared);
		if (!timer) throw new Error("no timer pending");
		clock.at = timer.setAt + timer.ms;
		timer.fired = true;
		timer.fn();
	};
	return { clock, timers, elapse };
}

/** Lets the probe's promise chain run (no timer involved: its side turns answer from promises). */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A ProgressProbe on a test clock whose side turns answer `reply(n)` (`n`: 1 for the first question). */
function probeHarness(opts: { delays: number[]; reply?: (n: number, signal: AbortSignal) => Promise<string>; ready?: () => boolean }) {
	const time = testClock();
	const asked: Array<{ prompt: string; at: number; signal: AbortSignal }> = [];
	const estimates: MainProgress[] = [];
	const logs: string[] = [];
	const probe = new ProgressProbe(
		{
			ready: () => opts.ready?.() ?? true,
			ask: (prompt, signal) => {
				asked.push({ prompt, at: time.clock.at, signal });
				return opts.reply?.(asked.length, signal) ?? Promise.resolve(`{"pct": ${asked.length * 10}, "stage": "step ${asked.length}"}`);
			},
			inflight: () => [],
			estimated: p => estimates.push(p),
			log: m => logs.push(m),
		},
		opts.delays,
		time.clock,
	);
	return { probe, time, asked, estimates, logs };
}

describe("the questions of a run", () => {
	test("the first after the first wait from the run's start, each next one the next wait after the last answer; the last wait repeats", async () => {
		const h = probeHarness({ delays: [60, 120] });
		h.probe.start();
		expect(h.time.timers.map(t => [t.ms, t.setAt])).toEqual([[60, 1_000]]);
		h.time.elapse();
		await flush();
		expect(h.asked.map(a => a.at)).toEqual([1_060]);
		expect(h.time.timers.map(t => [t.ms, t.setAt])).toEqual([
			[60, 1_000],
			[120, 1_060],
		]);
		h.time.elapse();
		await flush();
		expect(h.time.timers.at(-1)).toMatchObject({ ms: 120, setAt: 1_180 });
		expect(h.estimates).toEqual([
			{ pct: 10, stage: "step 1", at: 1_060, since: 1_000 },
			{ pct: 20, stage: "step 2", at: 1_180, since: 1_000 },
		]);
		expect(h.probe.progress).toEqual(h.estimates[1]!);
		// Each question after the first carries the answer before it.
		expect(h.asked[0]!.prompt).not.toContain("previous estimate");
		expect(h.asked[1]!.prompt).toContain('Your previous estimate, 120ms ago, was 10% at stage "step 1".');
	});

	test("never two at once: the next wait starts when a slow answer came", async () => {
		const answer = Promise.withResolvers<string>();
		const h = probeHarness({ delays: [30], reply: () => answer.promise });
		h.probe.start();
		h.time.elapse();
		await flush();
		expect(h.asked).toHaveLength(1);
		expect(h.time.timers).toHaveLength(1); // nothing scheduled while the answer is out
		h.time.clock.at += 500;
		answer.resolve('{"pct": 25}');
		await flush();
		expect(h.time.timers.at(-1)).toMatchObject({ ms: 30, setAt: 1_530 });
		expect(h.estimates.map(e => [e.pct, e.at])).toEqual([[25, 1_530]]);
	});

	test("not ready (the agent idle, nobody to tell): that question is skipped and the schedule goes on", async () => {
		let checks = 0;
		const h = probeHarness({ delays: [30, 60, 90], ready: () => ++checks > 2 });
		h.probe.start();
		for (let i = 0; i < 3; i++) {
			h.time.elapse();
			await flush();
		}
		expect(h.time.timers.map(t => t.ms)).toEqual([30, 60, 90, 90]);
		expect(h.asked.map(a => a.at)).toEqual([1_000 + 30 + 60 + 90]);
	});

	test("stop: the wait is cleared, the question in flight aborted and its late answer dropped; nothing more is asked", async () => {
		const idle = probeHarness({ delays: [20] });
		idle.probe.start();
		idle.probe.stop();
		expect(idle.time.timers[0]!.cleared).toBe(true);

		const late = Promise.withResolvers<string>();
		const h = probeHarness({ delays: [20], reply: () => late.promise });
		h.probe.start();
		h.time.elapse();
		await flush();
		h.probe.stop();
		expect(h.asked[0]!.signal.aborted).toBe(true);
		late.resolve('{"pct": 99}'); // omp answered anyway
		await flush();
		expect([h.estimates, h.probe.progress, h.logs]).toEqual([[], undefined, []]);
		expect(h.time.timers).toHaveLength(1);
	});

	test("a failed side turn or a reply without a percentage is logged, and the schedule goes on", async () => {
		const h = probeHarness({ delays: [20], reply: n => (n === 1 ? Promise.reject(new Error("429 rate limited")) : Promise.resolve(n === 2 ? "no idea" : '{"pct": 30}')) });
		h.probe.start();
		for (let i = 0; i < 3; i++) {
			h.time.elapse();
			await flush();
		}
		expect(h.logs).toEqual(["progress question: 429 rate limited", 'progress reply without a percentage: "no idea"']);
		expect(h.estimates.map(e => e.pct)).toEqual([30]);
	});

	test("a run omp goes on with keeps its estimate and schedule for its next start; a quiet omp ends it", async () => {
		const h = probeHarness({ delays: [20, 60_000] });
		h.probe.start();
		h.time.elapse();
		await flush();
		const first = h.probe.progress!;
		expect(first).toEqual({ pct: 10, stage: "step 1", at: 1_020, since: 1_000 });
		h.probe.keep();
		expect(h.probe.kept).toBe(true);
		// omp goes on (a retry, background jobs): the next run is the same one, on the same schedule.
		h.time.clock.at = 5_000;
		h.probe.start();
		expect([h.probe.kept, h.probe.progress, h.time.timers.length]).toEqual([false, first, 2]);
		h.probe.keep();
		h.probe.settle(false); // quiet from 5 000
		h.time.clock.at += PROGRESS_SETTLE_MS - 1;
		h.probe.settle(false);
		expect(h.probe.progress).toBe(first);
		h.probe.settle(true); // working again: the quiet starts over
		h.probe.settle(false);
		h.time.clock.at += PROGRESS_SETTLE_MS;
		h.probe.settle(false);
		expect([h.probe.kept, h.probe.progress, h.time.timers[1]!.cleared]).toEqual([false, undefined, true]);
		// The next run is a new one: its own start, its own first question.
		h.probe.start();
		expect(h.time.timers.at(-1)).toMatchObject({ ms: 20, setAt: 14_999 });
		h.time.elapse();
		await flush();
		expect(h.estimates.at(-1)).toEqual({ pct: 20, stage: "step 2", at: 15_019, since: 14_999 });
		expect(h.asked[1]!.prompt).not.toContain("previous estimate");
	});
});

// ─── whole extension ──────────────────────────────────────────────────────────────────────────

interface FakeHostd {
	sock: string;
	lines: Json[];
}

/** A fake hostd: authenticates, answers each `hello` with `welcome` (carrying `caps`), records frames. */
async function startHostd(caps?: Json): Promise<FakeHostd> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-progress-hostd-"));
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
				const frame = JSON.parse(buf.slice(0, i)) as Json;
				buf = buf.slice(i + 1);
				lines.push(frame);
				if (frame.t === "hello") c.write(`${JSON.stringify({ t: "welcome", v: 2, hostd: "0.9.5", ...(caps ? { caps } : {}) })}\n`);
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
	return { sock, lines };
}

/** What the fake omp's `ctx.runEphemeralTurn` does: `onUsage` (omp ≥ 18.20) or not, and the reply. */
interface SideTurns {
	onUsage: boolean;
	reply: (signal: AbortSignal) => Promise<string>;
}

/** A fake omp: the main AgentSession in omp's registry (streaming when told), whose context runs
 *  side turns through `sides`, and whose session manager journals usage (`appendModelUsage`). */
async function bridgedOmp(hostd: FakeHostd, sides: SideTurns, opts: { completionProbe?: boolean } = {}) {
	process.env.TF_BRIDGE_SOCK = hostd.sock;
	process.env.TF_BRIDGE_PROGRESS_DELAYS = "40";
	let leaf = "e7";
	const journal: Array<{ entry: Json; owner: Json }> = [];
	const sm = {
		getSessionId: () => "S1",
		getSessionFile: () => "/tmp/S1.jsonl",
		getLeafId: () => leaf,
		getEntries: () => [],
		getBranch: () => [],
		getCwd: () => "/w",
		getArtifactsDir: () => null,
		getEntry: () => undefined,
		isSessionOnDisk: () => true,
		appendModelUsage(entry: Json, owner: Json) {
			journal.push({ entry, owner });
			return "u1";
		},
	};
	const write = { type: "toolCall", name: "write", arguments: { path: "src/app.ts", content: "export const x = 1;" } };
	const session: Json = {
		sessionManager: sm,
		settings: {},
		isStreaming: false,
		isRetrying: false,
		model: { name: "Lab Mock", id: "mock-1", contextWindow: 200_000 },
		agent: { state: { streamMessage: { role: "assistant", content: [write] } } },
		subscribe: () => () => {},
	};
	const main = { id: "Main", kind: "main", status: "running", session, sessionFile: "/tmp/S1.jsonl" };
	const ns: Json = {
		VERSION: "18.20.0",
		AgentRegistry: class {
			static global() {
				return { get: (id: string) => (id === "Main" ? main : undefined), list: () => [main], onChange: () => () => {} };
			}
		},
	};
	// omp's `task.completionProbe` handle, read against the session (a settings scope).
	if (opts.completionProbe !== undefined) ns.cfgTaskCompletionProbe = { get: (scope: object) => (scope === session ? opts.completionProbe : undefined) };
	const asked: Array<Json & { signal: AbortSignal }> = [];
	const usage = { input: 900, output: 12, cacheRead: 8000, cacheWrite: 0, totalTokens: 8912, cost: { input: 0.001, output: 0.0002, cacheRead: 0.0004, cacheWrite: 0, total: 0.0016 } };
	const message = { role: "assistant", api: "openai-completions", provider: "mocklab", model: "mock-1", usage, stopReason: "stop" };
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const intervals: Array<() => void> = [];
	const ctx: Json = {
		mode: "tui",
		hasUI: false,
		ui: { setStatus() {}, theme: { fg: (_c: string, s: string) => s } },
		cwd: "/w",
		sessionManager: sm,
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		model: { provider: "mocklab", id: "mock-1", name: "Lab Mock", contextWindow: 200_000 },
		isIdle: () => session.isStreaming !== true,
		getContextUsage: () => ({ tokens: 900, contextWindow: 200_000, percent: 0.45 }),
		setInterval: (fn: () => void) => {
			intervals.push(fn);
			return setInterval(() => {}, 60_000);
		},
		clearTimer: (t: Timer) => clearInterval(t),
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		abort: () => {},
		hasPendingMessages: () => false,
		getPendingPlanReview: () => undefined,
		async runEphemeralTurn(options: Json & { signal: AbortSignal; onUsage?: (m: Json) => void }) {
			asked.push(options);
			const replyText = await sides.reply(options.signal);
			if (sides.onUsage) options.onUsage?.(message);
			return { replyText, assistantMessage: message };
		},
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
	const fire = (name: string, event: Json) => (handlers.get(name) ?? []).map(fn => fn(event, ctx));
	await teleflockBridge(pi as never);
	fire("session_start", { type: "session_start" });
	cleanups.push(() => fire("session_shutdown", { type: "session_shutdown" }));
	await until(() => hostd.lines.some(l => l.t === "hello"), 10_000);
	return {
		session,
		asked,
		journal,
		fire,
		setLeaf: (id: string) => (leaf = id),
		/** One tick of the bridge's 1 s ticker. */
		tick: () => intervals.at(-1)?.(),
	};
}

const states = (hostd: FakeHostd) => hostd.lines.filter(l => l.t === "event" && l.event === "state").map(l => l.data as Json);
const isProgress = (v: unknown): v is MainProgress => !!v && typeof v === "object" && "pct" in v && "at" in v && "since" in v;
/** The progress of the last `state` hostd got (`undefined`: none). */
const lastProgress = (hostd: FakeHostd): MainProgress | undefined => {
	const progress = states(hostd).at(-1)?.progress;
	return isProgress(progress) ? progress : undefined;
};
const answer = (text: string) => () => Promise.resolve(text);
/** A question that is skipped, or never asked, leaves no trace to wait for. The bridge's schedule runs
 *  on real timers here (`TF_BRIDGE_PROGRESS_DELAYS` 40 ms): this lets several of its steps pass. */
const severalSteps = () => Bun.sleep(200);

describe("the main agent's progress against a fake hostd", () => {
	test("a hostd that reads it gets the agent's answer in `state`, the side turn is billed to the session, and the run's end takes it away", async () => {
		const hostd = await startHostd({ progress: true });
		const omp = await bridgedOmp(hostd, { onUsage: true, reply: answer('{"pct": 40, "stage": "wiring the settings page"}') });
		omp.session.isStreaming = true;
		const t0 = Date.now();
		omp.fire("agent_start", { type: "agent_start" });
		await until(() => lastProgress(hostd) !== undefined);
		const progress = lastProgress(hostd)!;
		expect(progress).toMatchObject({ pct: 40, stage: "wiring the settings page" });
		expect(progress.since).toBeGreaterThanOrEqual(t0);
		expect(progress.at).toBeGreaterThanOrEqual(progress.since + 35);
		// The question: omp's, with the call the agent is still writing.
		const question = omp.asked[0]!;
		expect(question.promptText).toContain("<progress-check>");
		expect(question.promptText).toContain(`- \`write\` (src/app.ts): ${JSON.stringify({ path: "src/app.ts", content: "export const x = 1;" }).length} characters of arguments so far`);
		// Billed once, as omp bills its own probe, on the branch it was asked from.
		expect(omp.journal).toEqual([
			{
				entry: expect.objectContaining({ purpose: PROGRESS_USAGE_PURPOSE, api: "openai-completions", provider: "mocklab", model: "mock-1", stopReason: "stop", usage: expect.objectContaining({ output: 12 }) }),
				owner: { sessionId: "S1", parentId: "e7" },
			},
		]);
		// The run ends: no estimate any more, and no more questions.
		omp.fire("agent_end", { type: "agent_end", messages: [] });
		await until(() => states(hostd).at(-1)?.progress === undefined);
		const asked = omp.asked.length;
		await severalSteps();
		expect(omp.asked).toHaveLength(asked);
	}, 20_000);

	test("an omp without `onUsage` (before 18.20): the reply's message is billed", async () => {
		const hostd = await startHostd({ progress: true });
		const omp = await bridgedOmp(hostd, { onUsage: false, reply: answer('{"pct": 15}') });
		omp.session.isStreaming = true;
		omp.setLeaf("e9");
		omp.fire("agent_start", { type: "agent_start" });
		await until(() => lastProgress(hostd) !== undefined);
		expect(omp.journal).toHaveLength(1);
		expect(omp.journal[0]).toMatchObject({ entry: { purpose: PROGRESS_USAGE_PURPOSE }, owner: { sessionId: "S1", parentId: "e9" } });
	}, 20_000);

	test("no question for a hostd that does not read the answer", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd, { onUsage: true, reply: answer('{"pct": 40}') });
		omp.session.isStreaming = true;
		omp.fire("agent_start", { type: "agent_start" });
		await severalSteps();
		expect(omp.asked).toEqual([]);
		expect(omp.journal).toEqual([]);
	}, 20_000);

	test("omp's `task.completionProbe` off: the main agent is not asked either", async () => {
		const hostd = await startHostd({ progress: true });
		const omp = await bridgedOmp(hostd, { onUsage: true, reply: answer('{"pct": 40}') }, { completionProbe: false });
		omp.session.isStreaming = true;
		omp.fire("agent_start", { type: "agent_start" });
		await severalSteps();
		expect(omp.asked).toEqual([]);
	}, 20_000);

	test("asked only while the agent works; a question in flight when the run ends is aborted and counts for nothing", async () => {
		const hostd = await startHostd({ progress: true });
		let pending: AbortSignal | undefined;
		const omp = await bridgedOmp(
			hostd,
			{
				onUsage: true,
				reply: signal => {
					pending = signal;
					const { promise, reject } = Promise.withResolvers<string>();
					signal.addEventListener("abort", () => reject(new Error("aborted")));
					return promise;
				},
			},
			{ completionProbe: true },
		);
		omp.fire("agent_start", { type: "agent_start" });
		await severalSteps(); // idle: each question so far skipped
		expect(omp.asked).toEqual([]);
		omp.session.isStreaming = true;
		await until(() => omp.asked.length === 1);
		omp.fire("agent_end", { type: "agent_end", messages: [] });
		expect(pending?.aborted).toBe(true);
		await severalSteps();
		expect(omp.asked).toHaveLength(1);
		expect(states(hostd).every(s => s.progress === undefined)).toBe(true);
	}, 20_000);

	test("a run omp goes on with by itself keeps its estimate and its start", async () => {
		const hostd = await startHostd({ progress: true });
		const omp = await bridgedOmp(hostd, { onUsage: true, reply: answer('{"pct": 55, "stage": "retrying"}') });
		omp.session.isStreaming = true;
		omp.fire("agent_start", { type: "agent_start" });
		await until(() => lastProgress(hostd) !== undefined);
		const first = lastProgress(hostd)!;
		// omp settles the run and retries a provider error by itself: the agent is idle meanwhile.
		omp.session.isStreaming = false;
		omp.session.isRetrying = true;
		omp.fire("agent_end", { type: "agent_end", messages: [], willContinue: true });
		omp.tick();
		await until(() => states(hostd).at(-1)?.idle === true);
		expect(lastProgress(hostd)).toEqual(first);
		// The retry starts the run again: still the same request, since its first start.
		omp.session.isRetrying = false;
		omp.session.isStreaming = true;
		omp.fire("agent_start", { type: "agent_start" });
		await until(() => omp.asked.length >= 2 && lastProgress(hostd)?.at !== first.at);
		expect(lastProgress(hostd)?.since).toBe(first.since);
		expect(omp.asked[1]!.promptText).toContain("Your previous estimate");
	}, 20_000);
});
