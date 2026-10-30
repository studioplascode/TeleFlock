// 2.1.0 `caps.restore`: `restorable` / `restore`, omp's own `--restore` for the live session, and
// `caps.restoreSelect`: `restore {turn?, subagentIds?}` for the listed parts only
// (docs/bridge-protocol.md "Restore"), against a fake hostd and a fake omp.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge from "./teleflock-bridge";

type Json = Record<string, unknown>;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-restore-hostd-"));
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
	await new Promise<void>(r => server.listen(sock, r));
	cleanups.push(() => {
		conn?.destroy();
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	let id = 0;
	return {
		dir,
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
type Hostd = Awaited<ReturnType<typeof startHostd>>;

/** What a test adds to the fake omp before the bridge loads: root exports (`ns`), the main
 *  session's members, registry refs. */
type Setup = (omp: { ns: Json; main: Json; refs: Map<string, Json>; file: string }) => void;

/** A fake omp: the main session's branch ends cut off (`cut`), one subagent transcript too. */
async function bridgedOmp(hostd: Hostd, withRestore: boolean, setup?: Setup) {
	process.env.TF_BRIDGE_SOCK = hostd.sock;
	const subFile = path.join(hostd.dir, "Worker.jsonl");
	fs.writeFileSync(subFile, [{ type: "session", id: "sub" }, { type: "message", cut: true }].map(e => JSON.stringify(e)).join("\n"));
	const doneFile = path.join(hostd.dir, "Done.jsonl");
	fs.writeFileSync(doneFile, JSON.stringify({ type: "message" }));
	const sm = {
		getSessionId: () => "S1",
		getSessionFile: () => path.join(hostd.dir, "S1.jsonl"),
		getLeafId: () => null,
		getEntries: () => [],
		getBranch: () => [{ type: "message", cut: true }],
		getCwd: () => "/w",
		getArtifactsDir: () => null,
		getEntry: () => undefined,
		isSessionOnDisk: () => true,
		buildSessionContext: () => ({ messages: [] }),
	};
	const main: Json & { isStreaming: boolean; turns: number } = {
		isStreaming: false,
		/** Calls of omp's own `restoreInterruptedTurn()`. */
		turns: 0,
		sessionManager: sm,
		agent: { state: { messages: [] } },
		subscribe: () => () => {},
		retry: async () => false,
		restoreInterruptedTurn: async () => {
			main.turns++;
			return true;
		},
		waitForIdle: async () => {},
		settings: {},
	};
	const refs = new Map<string, Json>([
		["Main", { id: "Main", kind: "main", status: "idle", session: main, sessionFile: sm.getSessionFile() }],
		["Worker", { id: "Worker", kind: "sub", parentId: "Main", status: "idle", sessionFile: subFile }],
		["Done", { id: "Done", kind: "sub", parentId: "Main", status: "idle", sessionFile: doneFile }],
	]);
	const registry = { get: (id: string) => refs.get(id), list: () => [...refs.values()], onChange: () => () => {} };
	const restores: Json[] = [];
	const ns: Json = {
		VERSION: "18.13.3",
		AgentRegistry: class {
			static global() {
				return registry;
			}
		},
	};
	if (withRestore) {
		ns.hasRestorableTurn = (entries: Json[]) => entries.some(e => e.cut === true);
		ns.restoreSession = async (session: unknown, options: Json) => {
			restores.push({ session, options });
			return { turn: true, subagents: ["Worker"] };
		};
	}
	setup?.({ ns, main, refs, file: sm.getSessionFile() });
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const ctx: Json = {
		mode: "rpc",
		hasUI: false,
		cwd: "/w",
		sessionManager: sm,
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
	const events = { on: () => () => {}, emit: () => {} };
	const pi = {
		pi: ns,
		logger: { debug: () => {} },
		events,
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
	await until(() => hostd.lines.some(l => l.t === "hello"), 5_000);
	return { main, events, restores, registry, refs };
}

/** omp's AsyncJobManager as the bridge uses it: a job runs at once, `running` until it settles;
 *  `full` is omp's running-job cap. */
function fakeJobs() {
	type Job = { id: string; type: string; label: string; options: Json; status: string; agentId?: unknown; ownerId?: unknown; settled: Promise<{ value?: unknown; error?: unknown }> };
	const jobs: Job[] = [];
	const manager = {
		jobs,
		full: false,
		register(type: string, label: string, run: (c: { jobId: string; signal: AbortSignal }) => Promise<unknown>, options: Json) {
			if (manager.full) throw new Error("Background job limit reached (15). Wait for running jobs to finish or cancel one.");
			const id = String(options.id ?? label);
			const job: Job = { id, type, label, options, status: "running", agentId: options.agentId, ownerId: options.ownerId, settled: Promise.resolve({}) };
			jobs.push(job);
			job.settled = run({ jobId: id, signal: new AbortController().signal }).then(
				value => {
					job.status = "completed";
					return { value };
				},
				(error: unknown) => {
					job.status = "failed";
					return { error };
				},
			);
			return id;
		},
		getAllJobs: () => jobs,
	};
	return manager;
}

class FakeAsyncJobError extends Error {
	constructor(
		message: string,
		readonly structured?: unknown,
	) {
		super(message);
	}
}

/**
 * The fake omp with what `caps.restoreSelect` needs: omp's task internals, background jobs and
 * `ensurePersistedRoster`, which registers the session's persisted subagents (a freshly resumed omp
 * has none in its registry). Transcripts sit where omp keeps them (`S1/<parents…>/<id>.jsonl`).
 */
async function selectOmp(hostd: Hostd) {
	const root = path.join(hostd.dir, "S1");
	const cut = { type: "message", cut: true };
	const init = (task: string, extra: Json = {}): Json => ({ type: "session_init", task, tools: ["read", "yield"], ...extra });
	const asked = { type: "message", message: { role: "user", content: "go on" } };
	/** A reply omp saved when its process ended while it streamed: `aborted`, empty, no exit record. */
	const reply = (extra: Json = {}): Json => ({ type: "message", message: { role: "assistant", content: [], stopReason: "aborted", ...extra } });
	const tree: Array<{ id: string; parent: string; rel: string; entries: Json[]; status?: string }> = [
		{ id: "Reader", parent: "Main", rel: "Reader.jsonl", entries: [init("read the docs"), cut] },
		{ id: "Child", parent: "Reader", rel: "Reader/Child.jsonl", entries: [init("skim a.md", { tools: ["read"] }), cut] },
		{ id: "Builder", parent: "Main", rel: "Builder.jsonl", entries: [init("build it"), cut] },
		{ id: "Killed", parent: "Main", rel: "Killed.jsonl", entries: [init("killed"), cut] },
		{ id: "Isolated", parent: "Main", rel: "Isolated.jsonl", entries: [init("isolated", { isolated: true }), cut] },
		{ id: "Finished", parent: "Main", rel: "Finished.jsonl", entries: [init("finished"), { type: "message" }] },
		{ id: "NoInit", parent: "Main", rel: "NoInit.jsonl", entries: [cut] },
		{ id: "Busy", parent: "Main", rel: "Busy.jsonl", entries: [init("busy"), cut], status: "running" },
		{ id: "Sleeper", parent: "Main", rel: "Sleeper.jsonl", entries: [init("sleep, then report"), asked, reply()] },
		// Exit recovery's abort record is for omp's restore to judge, never a cut-off reply.
		{ id: "Closed", parent: "Main", rel: "Closed.jsonl", entries: [init("closed"), asked, reply({ errorMessage: "Previous OMP process exited before completing the turn." })] },
		{ id: "Caller", parent: "Main", rel: "Caller.jsonl", entries: [init("caller"), asked, reply({ content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] })] },
	];
	for (const t of tree) {
		const file = path.join(root, t.rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, [{ type: "session", id: t.id }, ...t.entries].map(e => JSON.stringify(e)).join("\n"));
	}
	fs.writeFileSync(path.join(root, "Killed.jsonl.tombstone"), "");
	const jobs = fakeJobs();
	const rosterCalls: unknown[][] = [];
	const followUps: Json[] = [];
	const finish = new Map<string, (result: Json) => void>();
	const revived: string[] = [];
	/** Sleeper as omp's lifecycle manager revives it: its stopped reply ends its messages. */
	const sleeper = {
		isStreaming: false,
		/** Calls of omp's `retry()`. */
		retries: 0,
		sessionManager: {
			getEntries: () => tree.find(t => t.id === "Sleeper")!.entries,
			getSessionFile: () => path.join(root, "Sleeper.jsonl"),
			buildSessionContext: () => ({ messages: sleeper.agent.state.messages }),
		},
		agent: { state: { messages: [{ role: "user", content: "go on" }, { role: "assistant", content: [], stopReason: "aborted" }] } },
		subscribe: () => () => {},
		async retry() {
			sleeper.retries++;
			return true;
		},
		// omp's own leaves the reply alone: no exit record follows it.
		async restoreInterruptedTurn() {
			return false;
		},
	};
	const live = new Map<string, Json>([["Sleeper", sleeper]]);
	const omp = await bridgedOmp(hostd, true, ({ ns, main, refs }) => {
		main.asyncJobManager = jobs;
		ns.ensurePersistedRoster = async (registry: unknown, file: unknown) => {
			rosterCalls.push([registry, file]);
			for (const t of tree) {
				const sessionFile = path.join(root, t.rel);
				const status = t.status ?? (fs.existsSync(`${sessionFile}.tombstone`) ? "aborted" : "parked");
				refs.set(t.id, { id: t.id, displayName: t.id, kind: "sub", parentId: t.parent, status, sessionFile });
			}
			return file;
		};
		// omp's follow-up turn: with `restore` it goes on through the live session's
		// restoreInterruptedTurn(), then settles when the test says so.
		ns.runSubagentFollowUpTurn = async (o: Json) => {
			followUps.push(o);
			const { promise, resolve } = Promise.withResolvers<Json>();
			finish.set(String(o.id), resolve);
			const s = live.get(String(o.id));
			if (s && typeof s.restoreInterruptedTurn === "function") await s.restoreInterruptedTurn();
			return promise;
		};
		ns.formatTaskResultSummary = (r: Json, o: Json) => `<task-result exit=${r.exitCode} ms=${o.totalDurationMs}>`;
		ns.extractSessionInit = (entries: Json[]) => entries.find(e => e.type === "session_init") ?? null;
		ns.persistedAgentDefinition = (name: string, i: Json) => ({ name, task: i.task });
		ns.AsyncJobError = FakeAsyncJobError;
		// Only `retry`'s path revives through it; omp's follow-up turn revives a restored subagent itself.
		ns.AgentLifecycleManager = class {
			static global() {
				return {
					ensureLive: async (id: string) => {
						revived.push(id);
						return live.get(id) ?? refs.get(id)?.session;
					},
					release: async () => true,
				};
			}
		};
	});
	return { ...omp, root, jobs, rosterCalls, followUps, finish, revived, sleeper };
}

describe("restore (caps.restore)", () => {
	test("announced only with omp's restore functions", async () => {
		const hostd = await startHostd();
		await bridgedOmp(hostd, false);
		const hello = hostd.lines.find(l => l.t === "hello")!;
		expect((hello.caps as Json).restore).toBe(false);
		expect((hello.caps as Json).restoreSelect).toBe(false);
		expect(await hostd.request("restore")).toMatchObject({ ok: false, error: { code: "unsupported" } });
	});

	test("restorable reads omp's rules; restore runs omp's restoreSession", async () => {
		const hostd = await startHostd();
		const omp = await bridgedOmp(hostd, true);
		const hello = hostd.lines.find(l => l.t === "hello")!;
		expect((hello.caps as Json).restore).toBe(true);
		// The branch is cut off; Worker's transcript too; Done's is not.
		expect(await hostd.request("restorable")).toMatchObject({ ok: true, result: { turn: true, subagents: ["Worker"] } });
		expect(await hostd.request("restore")).toMatchObject({ ok: true, result: { turn: true, subagents: ["Worker"] } });
		expect(omp.restores).toHaveLength(1);
		expect(omp.restores[0]!.session).toBe(omp.main);
		expect((omp.restores[0]!.options as Json).eventBus).toBe(omp.events);
		// Never while a turn runs.
		omp.main.isStreaming = true;
		expect(await hostd.request("restore")).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await hostd.request("restorable")).toMatchObject({ ok: true, result: { turn: false } });
	});
});

describe("restore {turn?, subagentIds?} (caps.restoreSelect)", () => {
	test("announced only with omp's persisted roster, task internals and background jobs", async () => {
		const hostd = await startHostd();
		await bridgedOmp(hostd, true);
		const hello = hostd.lines.find(l => l.t === "hello")!;
		expect((hello.caps as Json).restore).toBe(true);
		expect((hello.caps as Json).restoreSelect).toBe(false);
		expect(await hostd.request("restore", { turn: true })).toMatchObject({ ok: false, error: { code: "unsupported" } });
		expect(await hostd.request("restore", { subagentIds: ["Worker"] })).toMatchObject({ ok: false, error: { code: "unsupported" } });

		const other = await startHostd();
		await selectOmp(other);
		expect((other.lines.find(l => l.t === "hello")!.caps as Json).restoreSelect).toBe(true);
	});

	test("restorable reads omp's persisted roster first, as a freshly resumed omp has none", async () => {
		const hostd = await startHostd();
		const omp = await selectOmp(hostd);
		// Killed has a tombstone, Finished was not cut off, Busy runs; Done is the base fixture's finished one.
		expect(await hostd.request("restorable")).toMatchObject({ ok: true, result: { turn: true, subagents: ["Worker", "Reader", "Child", "Builder", "Isolated", "NoInit"] } });
		expect(omp.rosterCalls).toEqual([[omp.registry, path.join(hostd.dir, "S1.jsonl")]]);
		expect(omp.jobs.jobs).toHaveLength(0);
	});

	test("restores only the listed subagents omp would revive, parents first; the rest is skipped with a reason", async () => {
		const hostd = await startHostd();
		const omp = await selectOmp(hostd);
		const res = await hostd.request("restore", { turn: false, subagentIds: ["Child", "Reader", "Killed", "Isolated", "Finished", "NoInit", "Busy", "Ghost", "Main", "Reader"] });
		expect(res.ok).toBe(true);
		const out = res.result as { turn: boolean; subagents: string[]; skipped: Array<{ agentId: string; reason: string }> };
		expect(out.turn).toBe(false);
		expect(out.subagents).toEqual(["Reader", "Child"]);
		expect(Object.fromEntries(out.skipped.map(s => [s.agentId, s.reason]))).toEqual({
			Ghost: "omp does not know this agent",
			Main: "it is not a subagent",
			Killed: "it was killed",
			Isolated: "it ran isolated; its worktree is gone",
			Finished: "its turn was not cut off",
			NoInit: "its transcript has no session_init to revive it from",
			Busy: "it is running",
		});
		// omp's persisted roster first (only it knows the subagents of a resumed session).
		expect(omp.rosterCalls).toHaveLength(1);
		expect(omp.rosterCalls[0]![0]).toBe(omp.registry);
		expect(omp.rosterCalls[0]![1]).toBe(path.join(hostd.dir, "S1.jsonl"));
		// Each as a background job of its parent, as omp's restoreSubagents registers it; Builder is
		// cut off too but not listed: never touched.
		expect(omp.jobs.jobs.map(j => [j.type, j.label, j.options])).toEqual([
			["task", "Reader", { id: "Reader", agentId: "Reader", ownerId: "Main" }],
			["task", "Child", { id: "Child", agentId: "Child", ownerId: "Reader" }],
		]);
		expect(omp.followUps.map(o => o.id)).toEqual(["Reader", "Child"]);
		expect(omp.followUps[0]).toMatchObject({
			agent: { name: "Reader", task: "read the docs" },
			message: "read the docs",
			restore: true,
			structured: true,
			artifactsDir: omp.root,
			maxRuntimeMs: 0,
		});
		expect(omp.followUps[0]!.eventBus).toBe(omp.events);
		expect(omp.followUps[0]!.signal).toBeInstanceOf(AbortSignal);
		expect(omp.followUps[1]).toMatchObject({ message: "skim a.md", restore: true, structured: false, artifactsDir: path.join(omp.root, "Reader") });
		// omp's own restore path: no session turn, no restoreSession, no lifecycle revive (armRetry).
		expect(omp.main.turns).toBe(0);
		expect(omp.restores).toHaveLength(0);
		expect(omp.revived).toEqual([]);

		// A subagent whose restore runs is not restored twice.
		expect(await hostd.request("restore", { subagentIds: ["Reader"] })).toMatchObject({
			ok: true,
			result: { turn: false, subagents: [], skipped: [{ agentId: "Reader", reason: "it is running" }] },
		});
		expect(omp.jobs.jobs).toHaveLength(2);

		// The parent receives omp's task result; a failed run is omp's AsyncJobError with its output.
		omp.finish.get("Reader")!({ exitCode: 0, durationMs: 7, structuredOutput: { found: 2 } });
		omp.finish.get("Child")!({ exitCode: 1, error: "boom", durationMs: 3, structuredOutput: { partial: true } });
		expect(await omp.jobs.jobs[0]!.settled).toEqual({ value: { text: "<task-result exit=0 ms=7>", structured: { found: 2 } } });
		const failed = (await omp.jobs.jobs[1]!.settled).error;
		expect(failed).toBeInstanceOf(FakeAsyncJobError);
		expect((failed as FakeAsyncJobError).message).toBe("<task-result exit=1 ms=3>");
		expect((failed as FakeAsyncJobError).structured).toEqual({ partial: true });
	});

	test("a listed subagent whose reply was cut off mid-stream goes on through omp's retry", async () => {
		const hostd = await startHostd();
		const omp = await selectOmp(hostd);
		const res = await hostd.request("restore", { subagentIds: ["Sleeper", "Closed", "Caller"] });
		expect(res).toMatchObject({ ok: true, result: { turn: false, subagents: ["Sleeper"] } });
		expect(Object.fromEntries(((res.result as Json).skipped as Json[]).map(s => [s.agentId, s.reason]))).toEqual({
			Closed: "its turn was not cut off",
			Caller: "its turn was not cut off",
		});
		// As `retry {agentId}`: a job of its parent under its id whose follow-up turn (`restore`) goes on
		// through the revived session's restoreInterruptedTurn(), armed to be omp's retry().
		expect(omp.jobs.jobs.map(j => [j.type, j.label, j.options])).toEqual([["task", "Sleeper", { id: "Sleeper", agentId: "Sleeper", ownerId: "Main" }]]);
		await until(() => omp.sleeper.retries === 1);
		expect(new Set(omp.revived)).toEqual(new Set(["Sleeper"]));
		expect(omp.followUps).toHaveLength(1);
		expect(omp.followUps[0]).toMatchObject({ id: "Sleeper", message: "sleep, then report", restore: true, structured: true });
		omp.finish.get("Sleeper")!({ exitCode: 0, durationMs: 4 });
		expect(await omp.jobs.jobs[0]!.settled).toEqual({ value: "<task-result exit=0 ms=4>" });
		expect(omp.sleeper.retries).toBe(1);
		expect(omp.followUps).toHaveLength(1);
	});

	test("retry {agentId} and resumeTree read omp's persisted roster first", async () => {
		// A freshly resumed omp's registry knows no subagent until its persisted roster is read.
		const hostd = await startHostd();
		const omp = await selectOmp(hostd);
		expect(await hostd.request("retry", { agentId: "Sleeper" })).toMatchObject({ ok: true, result: { started: true } });
		expect(omp.rosterCalls).toEqual([[omp.registry, path.join(hostd.dir, "S1.jsonl")]]);
		expect(omp.jobs.jobs.map(j => j.label)).toEqual(["Sleeper"]);

		const other = await startHostd();
		const tree = await selectOmp(other);
		expect(await other.request("resumeTree", { subagentIds: ["Sleeper"], root: false })).toMatchObject({
			ok: true,
			result: { root: false, subagents: [{ agentId: "Sleeper", started: true }] },
		});
		expect(tree.rosterCalls).toHaveLength(1);
		expect(tree.jobs.jobs.map(j => j.label)).toEqual(["Sleeper"]);
	});

	test("turn: true runs the session's own restoreInterruptedTurn, never while it streams", async () => {
		const hostd = await startHostd();
		const omp = await selectOmp(hostd);
		expect(await hostd.request("restore", { turn: true })).toMatchObject({ ok: true, result: { turn: true, subagents: [], skipped: [] } });
		expect(omp.main.turns).toBe(1);
		expect(omp.restores).toHaveLength(0);
		expect(omp.rosterCalls).toHaveLength(0);
		expect(omp.jobs.jobs).toHaveLength(0);

		// A streaming session refuses its turn, before any subagent goes on.
		omp.main.isStreaming = true;
		expect(await hostd.request("restore", { turn: true, subagentIds: ["Reader"] })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(omp.main.turns).toBe(1);
		expect(omp.jobs.jobs).toHaveLength(0);
		// Subagents alone go on while it streams (their results reach the parent as job results).
		expect(await hostd.request("restore", { subagentIds: ["Reader"] })).toMatchObject({ ok: true, result: { turn: false, subagents: ["Reader"], skipped: [] } });
		expect(omp.main.turns).toBe(1);

		// omp's running-job cap: a skip with omp's message.
		omp.jobs.full = true;
		const capped = await hostd.request("restore", { subagentIds: ["Child"] });
		expect(capped).toMatchObject({ ok: true, result: { subagents: [], skipped: [{ agentId: "Child" }] } });
		expect(((capped.result as Json).skipped as Json[])[0]!.reason).toStartWith("Background job limit reached");

		expect(await hostd.request("restore", { turn: "yes" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
		expect(await hostd.request("restore", { subagentIds: "Reader" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
	});

	test("no selection keeps omp's restoreSession unchanged", async () => {
		const hostd = await startHostd();
		const omp = await selectOmp(hostd);
		const res = await hostd.request("restore", {});
		expect(res).toMatchObject({ ok: true });
		expect(res.result).toEqual({ turn: true, subagents: ["Worker"] });
		expect(omp.restores).toHaveLength(1);
		expect(omp.rosterCalls).toHaveLength(0);
		expect(omp.jobs.jobs).toHaveLength(0);
		expect(omp.main.turns).toBe(0);
	});
});
