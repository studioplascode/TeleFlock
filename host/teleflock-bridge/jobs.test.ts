// Tests for the bridge's 2.1.0 background jobs (docs/bridge-protocol.md "Background jobs"): the pure
// mapping of omp's job snapshots, widgets and output to the wire, and the `jobs` / `jobCancel` ops
// and the `jobs` event of the whole extension against a fake hostd socket with a fake omp whose
// AgentSession has omp's job API (`getAsyncJobTree`, `inspectAsyncJob`, `cancelAsyncJob`, …).
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, { jobGlance, jobOutput, jobsSummary, jobWidget, jobWire, type JobItem, latestLiveWidget, listJobs, JOBS_NONE } from "./teleflock-bridge";

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
});

/** omp's `JobWidgetView` of a test runner: headline `140`, meter `140/190 tests`. */
const testsWidget = (updatedAt: number, state = "live"): Json => ({
	title: "bun test",
	headline: { text: "140", label: "tests", trend: { text: "▲ 12", tone: "success" } },
	stage: "\u001b[32mrunning\u001b[0m src/board",
	blocks: [{ kind: "meter", label: "tests", value: 140 / 190, text: "140/190" }],
	state,
	updatedAt,
});

describe("job widgets", () => {
	test("the glance is omp's: a meter's whole when the headline restates its numerator", () => {
		expect(jobGlance(testsWidget(5))).toEqual({ text: "140/190", label: "tests", trend: "▲ 12", trendTone: "success" });
		// A headline of its own stays.
		expect(jobGlance({ headline: { text: "186 tok/s", label: "decode" }, blocks: [{ kind: "meter", text: "7/9 trials" }] })).toEqual({ text: "186 tok/s", label: "decode" });
		// No headline: the first chart's latest figure, else the first meter's text.
		expect(jobGlance({ blocks: [{ kind: "spark", label: "req/s", values: [1, 2], last: "2 req/s" }] })).toEqual({ text: "2 req/s", label: "req/s" });
		expect(jobGlance({ blocks: [{ kind: "spark", values: [], last: "0" }, { kind: "meter", label: "trials", text: "7/9" }] })).toEqual({ text: "7/9", label: "trials" });
		expect(jobGlance({ blocks: [{ kind: "text", text: "phase 2" }] })).toBeUndefined();
		expect(jobGlance("nope")).toBeUndefined();
	});

	test("the wire widget: title, glance, plain stage, meter progress clamped, state, time", () => {
		expect(jobWidget(testsWidget(5))).toEqual({
			title: "bun test",
			glance: { text: "140/190", label: "tests", trend: "▲ 12", trendTone: "success" },
			stage: "running src/board",
			progress: 140 / 190,
			progressText: "140/190",
			state: "live",
			updatedAt: 5,
		});
		expect(jobWidget({ title: "x", blocks: [{ kind: "meter", value: 3, text: "3/1" }] })).toMatchObject({ progress: 1, state: "fallback", updatedAt: 0 });
	});

	test("the freshest live widget wins (authoring and fallback views are no headline yet)", () => {
		const widgets = [
			{ id: "bg_1", view: testsWidget(10) },
			{ id: "bg_2", view: testsWidget(30, "authoring") },
			{ id: "bg_3", view: testsWidget(20) },
		];
		expect(latestLiveWidget(widgets)?.id).toBe("bg_3");
		expect(latestLiveWidget([{ id: "bg_2", view: testsWidget(1, "fallback") }])).toBeUndefined();
	});
});

describe("job output", () => {
	test("ANSI removed, carriage-return redraws collapsed to what the terminal shows", () => {
		expect(jobOutput("\u001b[1mok\u001b[0m 1\r\nprogress 10%\rprogress 50%\rprogress 90%\ndone\n")).toEqual({ output: "ok 1\nprogress 90%\ndone\n", cut: false });
	});

	test("long output keeps the newest part from a line start", () => {
		const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
		const { output, cut } = jobOutput(lines, 1_000);
		expect(cut).toBe(true);
		expect(output.length).toBeLessThanOrEqual(1_000);
		expect(output.startsWith("line ")).toBe(true);
		expect(output.endsWith("line 4999")).toBe(true);
	});
});

describe("job lists", () => {
	const job = (id: string, extra: Partial<JobItem> = {}): JobItem => ({ id, type: "bash", status: "running", label: id, startTime: 1, ...extra });

	test("the job tree when the AgentSession has one, else its snapshot, else the public snapshot", () => {
		const tree = { running: [job("b", { startTime: 20 }), job("a", { startTime: 10 })], recent: [job("old", { status: "completed", startTime: 1 }), job("new", { status: "failed", startTime: 5 })], rootId: "Main" };
		const listed = listJobs({ getAsyncJobTree: () => tree, getAsyncJobSnapshot: () => ({ running: [], recent: [] }) });
		expect(listed?.running.map(j => j.id)).toEqual(["a", "b"]); // oldest first
		expect(listed?.recent.map(j => j.id)).toEqual(["new", "old"]); // newest first
		expect(listed?.rootId).toBe("Main");
		expect(listJobs({ getAsyncJobSnapshot: () => ({ running: [job("s")], recent: [] }) })?.running.map(j => j.id)).toEqual(["s"]);
		// A throwing or missing API falls through; malformed rows are dropped.
		const thrower = { getAsyncJobTree: () => { throw new Error("x"); } };
		expect(listJobs(thrower, () => ({ running: [job("p"), { nope: 1 }], recent: null }))?.running.map(j => j.id)).toEqual(["p"]);
		expect(listJobs(undefined)).toBeUndefined();
		expect(listJobs({}, () => null)).toBeUndefined();
	});

	test("summary: counts, the wait, the freshest live widget of a running job and its label", () => {
		const list = { running: [job("bg_1", { label: "bun test" }), job("bg_2")], recent: [job("bg_0", { status: "completed" })], rootId: "Main" };
		const summary = jobsSummary(list, [{ id: "bg_1", view: testsWidget(9) }, { id: "gone", view: testsWidget(99) }], true);
		expect(summary).toEqual({ running: 2, recent: 1, waiting: true, glance: { text: "140/190", label: "tests", trend: "▲ 12", trendTone: "success" }, glanceJob: "bun test" });
		expect(JSON.stringify(jobsSummary({ running: [], recent: [] }, [], false))).toBe(JOBS_NONE);
	});

	test("wire rows: owners below the root, task agents, cancellable only while running, inspection", () => {
		const name = (id: string) => ({ "0-Explore": "Explore" })[id];
		const sub = jobWire(job("bg_7", { ownerId: "0-Explore", command: "sleep 600" }), { rootId: "Main", name, cancellable: true, inspection: { pids: [41], output: "tick\n", cwd: "/w", exitCode: undefined, artifactId: "a1" } });
		expect(sub).toEqual({
			id: "bg_7",
			kind: "bash",
			status: "running",
			label: "bg_7",
			command: "sleep 600",
			startedAt: 1,
			ownerId: "0-Explore",
			ownerName: "Explore",
			cancellable: true,
			output: "tick\n",
			pids: [41],
			cwd: "/w",
			artifactId: "a1",
		});
		const task = jobWire(job("0-Explore", { type: "task", agentId: "0-Explore", ownerId: "Main", status: "completed", endTime: 9 }), {
			rootId: "Main",
			name,
			cancellable: true,
			inspection: { pids: [1], exitCode: 0 },
		});
		expect(task).toMatchObject({ kind: "task", status: "completed", agentId: "0-Explore", agentName: "Explore", endedAt: 9, cancellable: false, exitCode: 0 });
		expect(task.ownerId).toBeUndefined(); // the root's own job
		expect(task.pids).toBeUndefined(); // settled: no live pids
		expect(jobWire(job("x", { status: "weird" }), { name, cancellable: false }).status).toBe("completed");
	});
});

// ─── whole extension ──────────────────────────────────────────────────────────────────────────

/** Frames cross a real unix socket (the extension's own I/O), so the condition is polled, not timed. */
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 5);
		await promise;
	}
}

interface FakeHostd {
	sock: string;
	lines: Json[];
	request(op: string, params?: Json): Promise<Json>;
}

async function startHostd(): Promise<FakeHostd> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-jobs-hostd-"));
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

interface FakeJob extends JobItem {
	output?: string;
	pids?: number[];
}

/** omp's async job manager as the AgentSession exposes it: jobs of `Main` and of subagent `0-Explore`. */
function fakeJobs() {
	const jobs = new Map<string, FakeJob>();
	const cancels: Array<[string, string]> = [];
	const settle = (j: FakeJob) => {
		j.status = "cancelled";
		j.endTime = 99;
	};
	/** A session's `cancelAsyncJob`: only its own running jobs (omp checks the owner). */
	const canceller = (owner: string) => (id: string) => {
		const j = jobs.get(id);
		if (!j || j.ownerId !== owner || j.status !== "running") return false;
		settle(j);
		cancels.push([owner, id]);
		return true;
	};
	return {
		jobs,
		cancels,
		widgets: [] as Array<{ id: string; type: string; view: Json }>,
		pending: false,
		tree() {
			const all = [...jobs.values()].map(({ output: _o, pids: _p, ...item }) => item);
			return { running: all.filter(j => j.status === "running"), recent: all.filter(j => j.status !== "running"), rootId: "Main", agents: [] };
		},
		inspect(id: string) {
			const j = jobs.get(id);
			return j ? { command: j.command, cwd: "/w", pids: j.status === "running" ? (j.pids ?? []) : [], output: j.output, widget: this.widgets.find(w => w.id === id)?.view } : undefined;
		},
		canceller,
	};
}

/** A fake omp whose main AgentSession has omp's job API (`jobApi: false`: an omp without it). */
async function bridgedOmp(hostd: FakeHostd, opts: { jobApi?: boolean; registry?: boolean; mode?: string } = {}) {
	process.env.TF_BRIDGE_SOCK = hostd.sock;
	const sm = {
		getSessionId: () => "S1",
		getSessionFile: () => "/tmp/S1.jsonl",
		getLeafId: () => null,
		getEntries: () => [],
		getBranch: () => [],
		getCwd: () => "/w",
		getArtifactsDir: () => null,
		getEntry: () => undefined,
		isSessionOnDisk: () => true,
	};
	const jobs = fakeJobs();
	const session: Json = {
		sessionManager: sm,
		isStreaming: false,
		model: { name: "Lab Mock", id: "mock-1", contextWindow: 200_000 },
		subscribe: () => () => {},
		getAsyncJobSnapshot: () => ({ running: jobs.tree().running.filter(j => j.ownerId === "Main"), recent: [] }),
	};
	if (opts.jobApi !== false) {
		Object.assign(session, {
			getAsyncJobTree: () => jobs.tree(),
			inspectAsyncJob: (id: string) => jobs.inspect(id),
			cancelAsyncJob: jobs.canceller("Main"),
			getRunningJobWidgets: () => jobs.widgets.filter(w => jobs.jobs.get(w.id)?.status === "running" && jobs.jobs.get(w.id)?.ownerId === "Main"),
			hasPendingAsyncWork: () => jobs.pending,
		});
	}
	const sub = { id: "0-Explore", kind: "sub", parentId: "Main", displayName: "Explore", status: "running", session: { cancelAsyncJob: jobs.canceller("0-Explore") } };
	const main: Json = { id: "Main", kind: "main", status: "idle", session, sessionFile: "/tmp/S1.jsonl" };
	const ns: Json = { VERSION: "18.13.3" };
	if (opts.registry !== false)
		ns.AgentRegistry = class {
			static global() {
				const refs: Record<string, Json> = { Main: main, "0-Explore": sub };
				return { get: (id: string) => refs[id], list: () => Object.values(refs), onChange: () => () => {} };
			}
		};
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const intervals: Array<() => void> = [];
	const ctx: Json = {
		mode: opts.mode ?? "tui",
		hasUI: false,
		ui: { setStatus() {}, theme: { fg: (_c: string, s: string) => s } },
		cwd: "/w",
		sessionManager: sm,
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		model: { provider: "mocklab", id: "mock-1", name: "Lab Mock", contextWindow: 200_000 },
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 900, contextWindow: 200_000, percent: 0.45 }),
		// omp's public snapshot: the main agent's own jobs.
		getAsyncJobSnapshot: () => ({ running: jobs.tree().running.filter(j => j.ownerId === "Main"), recent: [] }),
		setInterval: (fn: () => void, _ms: number) => {
			intervals.push(fn);
			return setInterval(() => {}, 60_000);
		},
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
	const fire = (name: string, event: Json) => (handlers.get(name) ?? []).map(fn => fn(event, ctx));
	await teleflockBridge(pi as never);
	fire("session_start", { type: "session_start" });
	cleanups.push(() => fire("session_shutdown", { type: "session_shutdown" }));
	await until(() => hostd.lines.some(l => l.t === "hello"), 10_000);
	// The tick writes into the ordered writer: a `ping` answered after it means its events arrived.
	const tick = async () => {
		intervals.at(-1)?.();
		await hostd.request("ping");
	};
	return { session, jobs, tick };
}

const jobEvents = (hostd: FakeHostd) => hostd.lines.filter(l => l.t === "event" && l.event === "jobs").map(l => l.data as Json);

describe("jobs against a fake hostd", () => {
	test("hello announces caps.jobs; the jobs event follows changes, once per change, from the tick", async () => {
		const hostd = await startHostd();
		const { session, jobs, tick } = await bridgedOmp(hostd);
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).jobs).toBe(true);

		await tick();
		expect(jobEvents(hostd)).toEqual([]); // no jobs, nothing to say

		jobs.jobs.set("bg_1", { id: "bg_1", type: "bash", status: "running", label: "bun test", command: "bun test", startTime: 10, ownerId: "Main", output: "ok 1\n", pids: [41] });
		jobs.widgets.push({ id: "bg_1", type: "bash", view: testsWidget(50) });
		jobs.jobs.set("0-Explore", { id: "0-Explore", type: "task", status: "running", label: "Explore the router", startTime: 5, ownerId: "Main", agentId: "0-Explore" });
		jobs.jobs.set("bg_2", { id: "bg_2", type: "bash", status: "running", label: "sleep 600", command: "sleep 600", startTime: 7, ownerId: "0-Explore" });
		jobs.pending = true;
		await tick();
		await tick(); // unchanged: no second event
		expect(jobEvents(hostd)).toEqual([{ running: 3, recent: 0, waiting: true, glance: { text: "140/190", label: "tests", trend: "▲ 12", trendTone: "success" }, glanceJob: "bun test" }]);

		// Streaming again: not waiting.
		session.isStreaming = true;
		await tick();
		expect(jobEvents(hostd).at(-1)?.waiting).toBe(false);
		session.isStreaming = false;

		// jobs: the tree in order (running oldest first), owners and agents named, the inspected job's output.
		const res = await hostd.request("jobs", { inspect: ["bg_1"] });
		expect(res).toMatchObject({ ok: true });
		const view = res.result as { jobs: Json[]; waiting: boolean; at: number };
		expect(view.waiting).toBe(true);
		expect(view.jobs.map(j => j.id)).toEqual(["0-Explore", "bg_2", "bg_1"]);
		expect(view.jobs[0]).toMatchObject({ kind: "task", agentId: "0-Explore", agentName: "Explore", cancellable: true });
		expect(view.jobs[1]).toMatchObject({ ownerId: "0-Explore", ownerName: "Explore", cancellable: true });
		expect(view.jobs[1]!.output).toBeUndefined(); // not inspected
		expect(view.jobs[2]).toMatchObject({ output: "ok 1\n", pids: [41], cwd: "/w", widget: { title: "bun test", state: "live" } });
		const all = (await hostd.request("jobs", { inspectAll: true })).result as { jobs: Json[] };
		expect(all.jobs.every(j => "cwd" in j)).toBe(true);

		// jobCancel: the root's job through the main session, a subagent's through its own session.
		const killed = await hostd.request("jobCancel", { id: "bg_1" });
		expect(killed.ok).toBe(true);
		const after = killed.result as { jobs: Json[] };
		expect(after.jobs.find(j => j.id === "bg_1")).toMatchObject({ status: "cancelled", cancellable: false, endedAt: 99 });
		expect((await hostd.request("jobCancel", { id: "bg_2" })).ok).toBe(true);
		expect(jobs.cancels).toEqual([["Main", "bg_1"], ["0-Explore", "bg_2"]]);
		// Cancelling sent the change at once.
		expect(jobEvents(hostd).at(-1)).toMatchObject({ running: 1, recent: 2 });

		// Settled or unknown jobs: not_found; bad params: invalid_params.
		expect(await hostd.request("jobCancel", { id: "bg_1" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await hostd.request("jobCancel", { id: "bg_404" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await hostd.request("jobCancel", {})).toMatchObject({ ok: false, error: { code: "invalid_params" } });

		// Everything evicted: the card is told once.
		jobs.jobs.clear();
		jobs.pending = false;
		await tick();
		expect(jobEvents(hostd).at(-1)).toEqual({ running: 0, recent: 0, waiting: false });
	}, 20_000);

	test("widgets are read in omp's TUI only (reading one may make omp write its spec)", async () => {
		const hostd = await startHostd();
		const { jobs, tick } = await bridgedOmp(hostd, { mode: "rpc" });
		jobs.jobs.set("bg_1", { id: "bg_1", type: "bash", status: "running", label: "bun test", startTime: 1, ownerId: "Main" });
		jobs.widgets.push({ id: "bg_1", type: "bash", view: testsWidget(50) });
		await tick();
		expect(jobEvents(hostd)).toEqual([{ running: 1, recent: 0, waiting: false }]);
	}, 20_000);

	test("an omp without the job API: the public snapshot lists the main agent's jobs; nothing cancels", async () => {
		const hostd = await startHostd();
		const { jobs, tick } = await bridgedOmp(hostd, { jobApi: false, registry: false });
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).jobs).toBe(true);
		jobs.jobs.set("bg_1", { id: "bg_1", type: "bash", status: "running", label: "sleep 9", startTime: 1, ownerId: "Main" });
		jobs.jobs.set("bg_2", { id: "bg_2", type: "bash", status: "running", label: "sub's", startTime: 2, ownerId: "0-Explore" });
		await tick();
		// Without hasPendingAsyncWork: idle with a running job of its own reads as waiting.
		expect(jobEvents(hostd)).toEqual([{ running: 1, recent: 0, waiting: true }]);
		const view = (await hostd.request("jobs", { inspectAll: true })).result as { jobs: Json[] };
		expect(view.jobs).toEqual([{ id: "bg_1", kind: "bash", status: "running", label: "sleep 9", startedAt: 1, cancellable: false }]);
		expect(await hostd.request("jobCancel", { id: "bg_1" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
	}, 20_000);
});
