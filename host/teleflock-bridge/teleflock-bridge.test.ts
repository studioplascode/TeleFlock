// Tests for the protocol v2 data plane of the TeleFlock bridge (docs/bridge-protocol.md "Live feed",
// "Dialogs", "Subagents"): the ordered writer's flow control, source throttling, the dialog race,
// the ask-dialog guest flow, the wrappers on omp's UI context, and the whole extension against a
// fake hostd socket with a fake omp (`pi`, contexts, AgentSession, agent registry).
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, {
	DialogHub,
	fallbackApproval,
	frameJson,
	installDialogWrappers,
	LiveTracker,
	LiveWriter,
	raceDialog,
	raceMember,
	runGuestAsk,
	Throttle,
	type Timers,
	wireEvent,
} from "./teleflock-bridge";

type Json = Record<string, unknown>;

// ─── fakes ────────────────────────────────────────────────────────────────────────────────────

/** A sink whose backlog the test controls (what `socket.writableLength` would report). */
class FakeSink {
	lines: string[] = [];
	backed = 0;
	write(line: string): void {
		this.lines.push(line);
	}
	backlog(): number {
		return this.backed;
	}
	frames(): Json[] {
		return this.lines.map(l => JSON.parse(l) as Json);
	}
}

/** Manual clock and timers for Throttle. */
class FakeTimers implements Timers {
	t = 0;
	#next = 1;
	#due = new Map<number, { at: number; fn: () => void }>();
	now(): number {
		return this.t;
	}
	set(fn: () => void, ms: number): unknown {
		const id = this.#next++;
		this.#due.set(id, { at: this.t + ms, fn });
		return id;
	}
	clear(handle: unknown): void {
		this.#due.delete(handle as number);
	}
	advance(ms: number): void {
		const end = this.t + ms;
		for (;;) {
			const next = [...this.#due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.#due.delete(next[0]);
			this.t = next[1].at;
			next[1].fn();
		}
		this.t = end;
	}
}

/** omp's `trackUserWaits` (extensibility/extensions/user-wait.ts): members read on every access. */
function trackUserWaits(ui: object): object {
	const methods = new Map<PropertyKey, { value: unknown; method: unknown }>();
	return new Proxy(ui, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const cached = methods.get(property);
			if (cached?.value === value) return cached.method;
			const method = (...args: unknown[]) => value.apply(target, args);
			methods.set(property, { value, method });
			return method;
		},
	});
}

interface LocalDialog {
	kind: string;
	args: unknown[];
	signal?: AbortSignal;
	answer(value: unknown): void;
	settled: boolean;
	aborted: boolean;
}

/** omp's TUI dialogs: each call opens one the test answers, or that closes on its signal (resolving undefined). */
function fakeTui() {
	const open: LocalDialog[] = [];
	const dialog = (kind: string, signalIndex: number, cancel: unknown) =>
		function (...args: unknown[]): Promise<unknown> {
			const opts = args[signalIndex] as { signal?: AbortSignal } | undefined;
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const d: LocalDialog = {
				kind,
				args,
				signal: opts?.signal,
				settled: false,
				aborted: false,
				answer(value) {
					if (d.settled) return;
					d.settled = true;
					resolve(value);
				},
			};
			opts?.signal?.addEventListener("abort", () => {
				if (d.settled) return;
				d.aborted = true;
				d.answer(cancel);
			});
			open.push(d);
			return promise;
		};
	const target = {
		select: dialog("select", 2, undefined),
		confirm: dialog("confirm", 2, false),
		input: dialog("input", 2, undefined),
		editor: dialog("editor", 2, undefined),
		askDialog: dialog("askDialog", 1, undefined),
		approve: dialog("approve", 1, "deny"),
		setStatus: (_key: string, _text: string | undefined) => {},
		theme: { fg: (_color: string, text: string) => text },
	};
	return { target, open, runnerUi: trackUserWaits(target) as typeof target };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise<void>(r => setTimeout(r, 5));
	}
}

// ─── LiveWriter ───────────────────────────────────────────────────────────────────────────────

describe("LiveWriter", () => {
	const ev = (n: number | string, extra: Json = {}) => ({ t: "event", event: { type: "notice", n, ...extra } });

	test("writes straight through while the sink has room, seq contiguous from the resync", () => {
		const sink = new FakeSink();
		const w = new LiveWriter(sink, { resync: seq => ({ t: "resync", seq }) });
		w.ctl({ t: "hello" });
		w.live(ev(0)); // not subscribed: dropped
		w.start();
		w.live(ev(1));
		w.live(() => ev(2), "k");
		w.ctl({ t: "res", id: 1 });
		const f = sink.frames();
		expect(f.map(x => x.t)).toEqual(["hello", "resync", "live", "live", "res"]);
		expect(f.filter(x => x.t !== "hello" && x.t !== "res").map(x => x.seq)).toEqual([1, 2, 3]);
	});

	test("while backed up, a cumulative frame is replaced by its newest version; nothing else is dropped or reordered", () => {
		const sink = new FakeSink();
		const w = new LiveWriter(sink, { resync: seq => ({ t: "resync", seq }) });
		w.start();
		sink.backed = 2 * 1024 * 1024;
		let partial = "v1";
		w.live(ev("start"));
		w.live(() => ev("m", { text: "v1" }), "m1");
		w.ctl({ t: "res", id: 7 });
		w.live(() => ev("m", { text: "v2" }), "m1");
		w.live(() => ev("tool", { partial }), "t1");
		partial = "v2"; // a lazily built frame is serialized when written
		w.live(() => ev("m", { text: "v3" }), "m1");
		w.live(ev("end"));
		expect(sink.lines.length).toBe(1); // only the resync went out
		sink.backed = 0;
		w.flush();
		const f = sink.frames().slice(1);
		expect(f.map(x => (x.t === "live" ? `${(x.f as Json & { event: Json }).event.n}` : `res${x.id}`))).toEqual(["start", "res7", "tool", "m", "end"]);
		const live = f.filter(x => x.t === "live") as Array<Json & { seq: number; f: { event: Json } }>;
		expect(live.map(x => x.seq)).toEqual([2, 3, 4, 5]);
		expect(live[1]!.f.event.partial).toBe("v2");
		expect(live[2]!.f.event.text).toBe("v3");
	});

	test("drop(key) removes a queued cumulative frame (its end frame supersedes it)", () => {
		const sink = new FakeSink();
		const w = new LiveWriter(sink, { resync: seq => ({ t: "resync", seq }) });
		w.start();
		sink.backed = 2 * 1024 * 1024;
		w.live(() => ev("update"), "m1");
		w.drop("m1");
		w.live(ev("end"));
		sink.backed = 0;
		w.flush();
		expect(sink.frames().slice(1).map(x => (x.f as { event: Json }).event.n)).toEqual(["end"]);
	});

	test("overflow drops the queued live frames for exactly one resync, built when written; seq stays contiguous", () => {
		const sink = new FakeSink();
		let resyncs = 0;
		let state = "before";
		const w = new LiveWriter(sink, { overflow: 1_000, resync: seq => ({ t: "resync", seq, n: ++resyncs, state }) });
		w.start();
		w.live(ev(1));
		sink.backed = 2 * 1024 * 1024;
		w.ctl({ t: "res", id: 1 });
		for (let i = 0; i < 20; i++) w.live(ev(`big${i}`, { pad: "x".repeat(100) }));
		w.live(() => ev("cumulative"), "m1"); // covered by the pending resync
		w.ctl({ t: "res", id: 2 });
		state = "after"; // the resync describes the state when it is written
		sink.backed = 0;
		w.flush();
		w.live(ev("next"));
		const f = sink.frames();
		expect(f.map(x => x.t)).toEqual(["resync", "live", "res", "resync", "res", "live"]);
		expect(f.map(x => x.seq ?? null)).toEqual([1, 2, null, 3, null, 4]);
		expect(resyncs).toBe(2);
		expect(f[3]!.state).toBe("after");
		expect((f[5]!.f as { event: Json }).event.n).toBe("next");
	});

	test("stop() drops queued live frames and keeps control frames", () => {
		const sink = new FakeSink();
		const w = new LiveWriter(sink, { resync: seq => ({ t: "resync", seq }) });
		w.start();
		sink.backed = 2 * 1024 * 1024;
		w.live(ev(1));
		w.ctl({ t: "hello", reason: "switch" });
		w.stop();
		w.live(ev(2));
		sink.backed = 0;
		w.flush();
		expect(sink.frames().map(x => x.t)).toEqual(["resync", "hello"]);
	});

	test("control frames past the stall limit report a stuck hostd", () => {
		const sink = new FakeSink();
		let stalled = 0;
		const w = new LiveWriter(sink, { stall: 100, resync: seq => ({ t: "resync", seq }), onStall: () => stalled++ });
		sink.backed = 2 * 1024 * 1024;
		w.ctl({ t: "event", data: "x".repeat(60) });
		expect(stalled).toBe(0);
		w.ctl({ t: "event", data: "x".repeat(60) });
		expect(stalled).toBe(1);
	});
});

describe("frames", () => {
	test("frameJson clips oversized strings, then falls back to a collab notice", () => {
		const big = { t: "event", event: { type: "tool_execution_end", toolCallId: "c1", result: { content: [{ type: "text", text: "y".repeat(5_000) }] } } };
		const clipped = JSON.parse(frameJson(big, 2_000)) as { event: { toolCallId: string; result: { content: Array<{ text: string }> } } };
		expect(clipped.event.toolCallId).toBe("c1");
		expect(clipped.event.result.content[0]!.text).toContain("chars elided");
		const keys: Json = {};
		for (let i = 0; i < 400; i++) keys[`key-${i}-${"k".repeat(20)}`] = 1;
		const notice = JSON.parse(frameJson({ t: "event", event: { type: "turn_end", keys } }, 2_000)) as { event: Json };
		expect(notice.event).toMatchObject({ type: "notice", level: "warning" });
		expect(String(notice.event.message)).toContain("turn_end");
		const cyclic: Json = { t: "bus", data: {} };
		(cyclic.data as Json).self = cyclic;
		expect(() => JSON.parse(frameJson(cyclic))).not.toThrow();
	});

	test("wireEvent drops the payloads that repeat other frames", () => {
		const message = { role: "assistant", content: [{ type: "text", text: "hi" }] };
		const up = wireEvent({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "hi", partial: message } });
		expect(up).toEqual({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "hi" } });
		expect(wireEvent({ type: "agent_end", messages: [message], isTerminal: true })).toEqual({ type: "agent_end", isTerminal: true });
		expect(wireEvent({ type: "turn_end", message, toolResults: [] })).toEqual({ type: "turn_end" });
	});
});

// ─── Throttle ─────────────────────────────────────────────────────────────────────────────────

describe("Throttle", () => {
	test("leading call at once, then at most one per interval with the newest trailing call", () => {
		const timers = new FakeTimers();
		const th = new Throttle(timers);
		const sent: number[] = [];
		th.run("m", 50, () => sent.push(1));
		timers.advance(10);
		th.run("m", 50, () => sent.push(2));
		timers.advance(10);
		th.run("m", 50, () => sent.push(3));
		expect(sent).toEqual([1]);
		timers.advance(30);
		expect(sent).toEqual([1, 3]);
		th.run("m", 50, () => sent.push(4));
		timers.advance(49);
		expect(sent).toEqual([1, 3]);
		timers.advance(1);
		expect(sent).toEqual([1, 3, 4]);
		th.run("other", 50, () => sent.push(9)); // keys are independent
		expect(sent).toEqual([1, 3, 4, 9]);
	});

	test("end() drops the trailing call: nothing follows a message's end", () => {
		const timers = new FakeTimers();
		const th = new Throttle(timers);
		const sent: string[] = [];
		th.run("m", 50, () => sent.push("u1"));
		th.run("m", 50, () => sent.push("u2"));
		th.end("m");
		timers.advance(100);
		expect(sent).toEqual(["u1"]);
	});
});

// ─── dialogs ──────────────────────────────────────────────────────────────────────────────────

function hubWithFrames() {
	const frames: Json[] = [];
	let id = 0;
	const hub = new DialogHub(
		() => ++id,
		f => frames.push(f),
	);
	const requests = () => frames.filter(f => f.t === "ui-request").map(f => f.request as Json & { reqId: number });
	const ends = () => frames.filter(f => f.t === "ui-request-end").map(f => f.reqId);
	return { hub, frames, requests, ends };
}

describe("dialog race", () => {
	test("hostd answers first: its value wins and omp's dialog is cancelled through its signal", async () => {
		const { hub, requests, ends } = hubWithFrames();
		const tui = fakeTui();
		const p = raceDialog(hub, { kind: "select", title: "Pick", options: ["A", "B"] }, undefined, s => tui.target.select("Pick", ["A", "B"], { signal: s }), v => v);
		expect(requests()).toEqual([{ kind: "select", title: "Pick", options: ["A", "B"], reqId: 1 }]);
		expect(tui.open[0]!.aborted).toBe(false);
		hub.answer(1, "B");
		expect(await p).toBe("B");
		expect(tui.open[0]!.aborted).toBe(true);
		expect(ends()).toEqual([1]);
		expect(hub.size).toBe(0);
	});

	test("omp's dialog answers first: the request ends for hostd and a late answer is refused", async () => {
		const { hub, ends } = hubWithFrames();
		const tui = fakeTui();
		const p = raceDialog(hub, { kind: "editor", title: "Name" }, undefined, s => tui.target.editor("Name", undefined, { signal: s }), v => v);
		tui.open[0]!.answer("local text");
		expect(await p).toBe("local text");
		expect(ends()).toEqual([1]);
		expect(hub.answer(1, "late")).toBe(false);
	});

	test("hostd's explicit cancel wins as a cancel; an unavailable hostd leaves the decision to omp", async () => {
		const a = hubWithFrames();
		const tui = fakeTui();
		const cancelled = raceDialog(a.hub, { kind: "select", title: "Q", options: ["Yes", "No"] }, undefined, s => tui.target.confirm("Q", "", { signal: s }), v => v === "Yes");
		a.hub.answer(1, undefined);
		expect(await cancelled).toBe(false);
		expect(tui.open[0]!.aborted).toBe(true);

		const b = hubWithFrames();
		const decided = raceDialog(b.hub, { kind: "editor", title: "T" }, undefined, s => tui.target.input("T", undefined, { signal: s }), v => v);
		b.hub.close(); // the bridge stood down: no answer will come from hostd
		await tick();
		expect(tui.open[1]!.aborted).toBe(false);
		tui.open[1]!.answer("typed");
		expect(await decided).toBe("typed");
	});

	test("the caller's abort settles both sides", async () => {
		const { hub, ends } = hubWithFrames();
		const tui = fakeTui();
		const ac = new AbortController();
		const p = raceDialog(hub, { kind: "editor", title: "T" }, ac.signal, s => tui.target.editor("T", undefined, { signal: s }), v => v);
		ac.abort();
		expect(await p).toBeUndefined();
		expect(ends()).toEqual([1]);
		expect(tui.open[0]!.aborted).toBe(true);
	});

	test("approve maps hostd's label back to omp's answer", async () => {
		const { hub, requests } = hubWithFrames();
		const tui = fakeTui();
		const prompt = { full: "Allow tool: bash\nCommand: ls", compact: "Allow tool: bash", session: "Approve bash for this session" };
		const p = raceMember(hub, "approve", tui.target.approve as never, tui.target, [prompt], fallbackApproval);
		expect(requests()[0]).toEqual({ kind: "select", title: prompt.full, options: ["Approve", "Approve bash for this session", "Deny"], reqId: 1 });
		hub.answer(1, "Approve bash for this session");
		expect(await p).toBe("session");
		expect(tui.open[0]!.aborted).toBe(true);
		const q = raceMember(hub, "approve", tui.target.approve as never, tui.target, [prompt], fallbackApproval);
		hub.answer(2, "Something else");
		expect(await q).toBe("deny");
	});
});

describe("ask dialog (guest flow, as omp offers it to collab guests)", () => {
	const questions = [{ id: "color", question: "Pick a color", options: [{ label: "Red" }, { label: "Blue", description: "calm" }], recommended: 1 }];

	test("single choice: one radio select with Other/Chat, the answer maps to the result", async () => {
		const { hub, requests } = hubWithFrames();
		const p = runGuestAsk(hub, questions, new AbortController().signal);
		await tick();
		expect(requests()[0]).toMatchObject({
			kind: "select",
			title: "Pick a color",
			options: ["Red", { label: "Blue", description: "calm" }, "Other (type your own)", "Chat about this"],
			initialIndex: 1,
			selectionMarker: "radio",
			markableCount: 2,
			reqId: 1,
		});
		hub.answer(1, "Blue");
		expect(await p).toEqual({
			kind: "submit",
			results: [{ id: "color", question: "Pick a color", options: ["Red", "Blue"], multi: false, selectedOptions: ["Blue"], customInput: undefined }],
		});
	});

	test("Other asks for a custom answer; cancelling that editor reopens the question", async () => {
		const { hub, requests } = hubWithFrames();
		const p = runGuestAsk(hub, questions, new AbortController().signal);
		await tick();
		hub.answer(1, "Other (type your own)");
		await tick();
		expect(requests()[1]).toEqual({ kind: "editor", title: "Custom answer: Pick a color", reqId: 2 });
		hub.answer(2, undefined);
		await tick();
		expect(requests()[2]).toMatchObject({ kind: "select", reqId: 3 });
		hub.answer(3, "Other (type your own)");
		await tick();
		hub.answer(4, "teal");
		const result = (await p) as { results: Array<Json> };
		expect(result.results[0]).toMatchObject({ selectedOptions: [], customInput: "teal" });
	});

	test("multi choice toggles one label per round; Next appears once something is checked", async () => {
		const { hub, requests } = hubWithFrames();
		const multi = [{ id: "m", question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multi: true }];
		const p = runGuestAsk(hub, multi, new AbortController().signal);
		await tick();
		expect(requests()[0]).toMatchObject({ selectionMarker: "checkbox", checkedIndices: [], options: ["A", "B", "C", "Other (type your own)", "Chat about this"] });
		hub.answer(1, "C");
		await tick();
		expect(requests()[1]).toMatchObject({ checkedIndices: [2], options: ["A", "B", "C", "Other (type your own)", "Next →", "Chat about this"] });
		hub.answer(2, "A");
		await tick();
		expect(requests()[2]).toMatchObject({ checkedIndices: [0, 2] });
		hub.answer(3, "Next →");
		const result = (await p) as { results: Array<Json> };
		expect(result.results[0]).toMatchObject({ multi: true, selectedOptions: ["A", "C"] });
	});

	test("Chat ends the ask as chat; labels that collide with the sentinels get a suffix and map back", async () => {
		const { hub, requests } = hubWithFrames();
		const tricky = [{ id: "t", question: "Q", options: [{ label: "Chat about this" }, { label: "Plain" }] }];
		const p = runGuestAsk(hub, tricky, new AbortController().signal);
		await tick();
		expect((requests()[0]!.options as unknown[]).slice(0, 2)).toEqual(["Chat about this (2)", "Plain"]);
		hub.answer(1, "Chat about this (2)");
		expect(((await p) as { results: Array<Json> }).results[0]!.selectedOptions).toEqual(["Chat about this"]);

		const second = hubWithFrames();
		const chat = runGuestAsk(second.hub, questions, new AbortController().signal);
		await tick();
		second.hub.answer(1, "Chat about this");
		expect(await chat).toEqual({ kind: "chat" });
	});
});

describe("dialog wrappers on omp's UI context", () => {
	test("wrap through the trackUserWaits proxy: calls from any proxy over the same target race hostd", async () => {
		const tui = fakeTui();
		const { hub, requests } = hubWithFrames();
		const token = {};
		const wrap = (name: Parameters<typeof raceMember>[1], original: (...a: unknown[]) => unknown) =>
			function (this: unknown, ...args: unknown[]) {
				return raceMember(hub, name, original, this, args, fallbackApproval) ?? original.apply(this, args);
			};
		expect(installDialogWrappers(tui.runnerUi, token, wrap)).toBe(true);
		// A second proxy over the same target, as omp's tool context store has.
		const toolUi = trackUserWaits(tui.target) as typeof tui.target;
		const p = toolUi.select("Pick", ["A", "B"], {});
		expect(requests()).toHaveLength(1);
		hub.answer(1, "A");
		expect(await p).toBe("A");
		expect(tui.open[0]!.aborted).toBe(true);
		// Idempotent per token; another copy's wrapper stays underneath.
		const before = Object.getOwnPropertyDescriptor(tui.target, "select")!.value;
		installDialogWrappers(tui.runnerUi, token, wrap);
		expect(Object.getOwnPropertyDescriptor(tui.target, "select")!.value).toBe(before);
		installDialogWrappers(tui.runnerUi, {}, (_n, original) =>
			function (this: unknown, ...a: unknown[]) {
				return original.apply(this, a);
			},
		);
		expect(Object.getOwnPropertyDescriptor(tui.target, "select")!.value).not.toBe(before);
		installDialogWrappers(tui.runnerUi, token, wrap);
		expect(Object.getOwnPropertyDescriptor(tui.target, "select")!.value).not.toBe(before);
		// A mode re-init hands out a new UI object: it is wrapped afresh.
		const fresh = fakeTui();
		expect(installDialogWrappers(fresh.runnerUi, token, wrap)).toBe(true);
	});
});

// ─── the whole extension against a fake hostd ─────────────────────────────────────────────────

const SLOT = Symbol.for("teleflock.bridge");
const MODEL = { id: "gpt-6-luna", name: "GPT-6 Luna", api: "openai-codex-responses", provider: "openai-codex", contextWindow: 272000, headers: { secret: "x" } };

interface Hostd {
	lines: Json[];
	send(obj: Json): void;
	live(): Array<Json & { seq: number; f: Json }>;
	close(): void;
}

let cleanups: Array<() => void> = [];
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

async function startHostd(): Promise<Hostd & { sock: string }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-bridge-test-"));
	const sock = path.join(dir, "bridge.sock");
	const secret = "ab".repeat(32);
	fs.writeFileSync(path.join(dir, "bridge.secret"), secret);
	const lines: Json[] = [];
	let conn: net.Socket | undefined;
	const server = net.createServer(c => {
		conn = c;
		c.setEncoding("utf8");
		let buf = "";
		c.on("data", (chunk: string) => {
			buf += chunk;
			let i = buf.indexOf("\n");
			while (i >= 0) {
				lines.push(JSON.parse(buf.slice(0, i)) as Json);
				buf = buf.slice(i + 1);
				i = buf.indexOf("\n");
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
	return {
		sock,
		lines,
		send: obj => conn?.write(`${JSON.stringify(obj)}\n`),
		live: () => lines.filter(l => l.t === "live" || l.t === "resync") as Array<Json & { seq: number; f: Json }>,
		close: () => conn?.destroy(),
	};
}

class FakeBus {
	#handlers = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, fn: (data: unknown) => void): () => void {
		const set = this.#handlers.get(channel) ?? new Set();
		set.add(fn);
		this.#handlers.set(channel, set);
		return () => set.delete(fn);
	}
	emit(channel: string, data: unknown): void {
		for (const fn of this.#handlers.get(channel) ?? []) fn(data);
	}
}

function fakeSessionManager(sessionId: string, file: string) {
	return {
		id: sessionId,
		file,
		onDisk: true,
		leaf: "e3" as string | null,
		entries: [
			{ type: "message", id: "e1", parentId: null, timestamp: "2026-10-28T10:00:00.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "model_change", id: "e2", parentId: "e1", timestamp: "2026-10-28T10:00:01.000Z", provider: "openai-codex", modelId: "gpt-6-luna" },
			{ type: "message", id: "e3", parentId: "e2", timestamp: "2026-10-28T10:00:02.000Z", message: { role: "assistant", content: [], timestamp: 2 } },
			{ type: "title_change", id: "e4", parentId: "e3", timestamp: "2026-10-28T10:00:03.000Z", title: "Hi" },
		] as Json[],
		getSessionId() {
			return this.id;
		},
		getSessionFile() {
			return this.file;
		},
		getLeafId() {
			return this.leaf;
		},
		getEntries() {
			return [...this.entries];
		},
		getBranch() {
			return [...this.entries];
		},
		getCwd() {
			return "/w";
		},
		getArtifactsDir() {
			return null;
		},
		getEntry(id: string) {
			return this.entries.find(e => e.id === id);
		},
		isSessionOnDisk() {
			return this.onDisk;
		},
	};
}

type SM = ReturnType<typeof fakeSessionManager>;

function fakeAgentSession(sm: SM) {
	const listeners = new Set<(e: Json) => void>();
	return {
		isStreaming: false,
		isAborting: false,
		queuedMessageCount: 0,
		sessionName: undefined as string | undefined,
		model: MODEL as unknown,
		thinkingLevel: "low",
		sessionManager: sm,
		agent: { state: { streamMessage: undefined as unknown } },
		updates: new Map<string, Json>(),
		prompts: [] as Array<[string, unknown]>,
		subscribe(fn: (e: Json) => void) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		emit(e: Json) {
			for (const fn of listeners) fn(e);
		},
		activeToolExecutionUpdates() {
			return [...this.updates.values()];
		},
		async prompt(text: string, options: unknown) {
			this.prompts.push([text, options]);
			return true;
		},
		aborted: 0,
		async abort() {
			this.aborted++;
		},
	};
}

type FakeSession = ReturnType<typeof fakeAgentSession>;

function fakeRegistry() {
	const refs = new Map<string, Json>();
	const listeners = new Set<() => void>();
	return {
		refs,
		get: (id: string) => refs.get(id),
		list: () => [...refs.values()],
		onChange(fn: () => void) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		changed() {
			for (const fn of listeners) fn();
		},
	};
}

interface Omp {
	pi: Json & { fire(name: string, event: Json, ctx?: object): void; events: FakeBus; sent: Array<[unknown, unknown]> };
	ctx: Json;
	tui: ReturnType<typeof fakeTui>;
	sm: SM;
	session: FakeSession;
	registry: ReturnType<typeof fakeRegistry>;
	/** Runs the bridge's tick now (omp runs it every second). */
	tick(): void;
}

/** A fake omp main session (or a subagent's, with `sub`) and its `pi`; `onDisk: false`: omp has not
 *  written the session file yet. */
function fakeOmp(
	opts: { sub?: string; registry?: ReturnType<typeof fakeRegistry>; lifecycle?: unknown; tui?: ReturnType<typeof fakeTui>; onDisk?: boolean } = {},
): Omp {
	const sm = fakeSessionManager(opts.sub ? `sub-${opts.sub}` : "S1", `/tmp/${opts.sub ?? "S1"}.jsonl`);
	sm.onDisk = opts.onDisk ?? true;
	const session = fakeAgentSession(sm);
	const registry = opts.registry ?? fakeRegistry();
	const agentId = opts.sub ?? "Main";
	registry.refs.set(agentId, {
		id: agentId,
		displayName: opts.sub ? "explore" : "main",
		kind: opts.sub ? "sub" : "main",
		parentId: opts.sub ? "Main" : undefined,
		status: "idle",
		session,
		sessionFile: sm.file,
		createdAt: 1,
		lastActivity: 2,
	});
	const tui = opts.tui ?? fakeTui();
	const intervals: Array<() => void> = [];
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const events = new FakeBus();
	const AgentRegistry = class {
		static global() {
			return registry;
		}
	};
	const ns: Json = { VERSION: "18.13.2", AgentRegistry };
	if (opts.lifecycle) ns.AgentLifecycleManager = class {
		static global() {
			return opts.lifecycle;
		}
	};
	const base: Json = {
		ui: tui.runnerUi,
		mode: "tui",
		hasUI: true,
		cwd: "/w",
		sessionManager: sm,
		agent: { kind: opts.sub ? "sub" : "main", id: agentId, name: opts.sub ? "explore" : "main", depth: opts.sub ? 1 : 0 },
		model: MODEL,
		isIdle: () => !session.isStreaming,
		getContextUsage: () => ({ tokens: 2720, contextWindow: 272000, percent: 1 }),
		setInterval: (fn: () => void, ms: number) => {
			intervals.push(fn);
			return setInterval(fn, ms);
		},
		clearTimer: (t: Timer) => clearInterval(t),
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		abort: () => {},
		hasPendingMessages: () => false,
		getPendingPlanReview: () => undefined,
	};
	// A handler's context: its own `ui` wraps the shared one (omp's createHandlerContext).
	const ctx = Object.create(base) as Json;
	Object.defineProperty(ctx, "ui", { value: { ...tui.target, select: (...a: unknown[]) => tui.runnerUi.select(...(a as [never, never, never])) }, enumerable: true });
	const sent: Array<[unknown, unknown]> = [];
	const pi = {
		pi: ns,
		logger: { debug: () => {} },
		events,
		sent,
		on(name: string, fn: (e: Json, c: object) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand() {},
		getServiceTiers: () => ({}),
		getThinkingLevel: () => "low",
		getSessionName: () => undefined,
		getCommands: () => [],
		sendUserMessage(content: unknown, options: unknown) {
			sent.push([content, options]);
		},
		fire(name: string, event: Json, c: object = ctx) {
			for (const fn of handlers.get(name) ?? []) fn(event, c);
		},
	};
	return { pi, ctx, tui, sm, session, registry, tick: () => intervals.at(-1)?.() };
}

async function bridged(hostd: Hostd & { sock: string }, opts: Parameters<typeof fakeOmp>[0] = {}): Promise<Omp> {
	process.env.TF_BRIDGE_SOCK = hostd.sock;
	const omp = fakeOmp(opts);
	await teleflockBridge(omp.pi as never);
	omp.pi.fire("session_start", { type: "session_start" });
	cleanups.push(() => omp.pi.fire("session_shutdown", { type: "session_shutdown" }));
	await until(() => hostd.lines.some(l => l.t === "hello"));
	return omp;
}

let reqId = 0;
async function request(hostd: Hostd, op: string, params: Json = {}): Promise<Json> {
	const id = ++reqId;
	hostd.send({ t: "req", id, op, params });
	await until(() => hostd.lines.some(l => l.t === "res" && l.id === id));
	return hostd.lines.find(l => l.t === "res" && l.id === id)!;
}

describe("extension against a fake hostd", () => {
	test("hello announces the data plane; liveSubscribe sends the resync before its res, then ordered live frames", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		const hello = hostd.lines.find(l => l.t === "hello")!;
		expect(hello.bridgeVersion).toBe("2.0.0");
		expect(hello.caps).toEqual({ live: 1, dialogs: true, subagentCtl: false, prompt: true });

		const res = await request(hostd, "liveSubscribe");
		expect(res.ok).toBe(true);
		const resyncAt = hostd.lines.findIndex(l => l.t === "resync");
		expect(resyncAt).toBeGreaterThan(-1);
		expect(resyncAt).toBeLessThan(hostd.lines.indexOf(res));
		const resync = hostd.lines[resyncAt] as Json & { live: { streaming: boolean; frames: Json[] } };
		expect(resync).toMatchObject({ seq: 1, sessionId: "S1", sessionFile: "/tmp/S1.jsonl", leafId: "e3", lastEntryId: "e3" });
		expect(resync.live.frames.map(f => f.t)).toEqual(["state", "agents"]);
		const state = resync.live.frames[0]!.state as Json;
		expect(state).toMatchObject({ isStreaming: false, queuedMessageCount: 0, cwd: "/w", thinkingLevel: "low", participants: [] });
		expect(state.model).toEqual({ id: "gpt-6-luna", name: "GPT-6 Luna", api: "openai-codex-responses", provider: "openai-codex", contextWindow: 272000 });
		expect(resync.live.frames[1]!.agents).toEqual([
			{ id: "Main", displayName: "main", kind: "main", status: "idle", hasSessionFile: true, createdAt: 1, lastActivity: 2, sessionFile: "/tmp/S1.jsonl" },
		]);

		const s = omp.session;
		const message = { role: "assistant", content: [{ type: "text", text: "" }], timestamp: 5 };
		s.isStreaming = true;
		s.emit({ type: "agent_start" });
		s.emit({ type: "turn_start" });
		s.emit({ type: "message_start", message });
		for (const text of ["He", "Hel", "Hell", "Hello"]) {
			message.content[0]!.text = text;
			s.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "x", partial: message } });
		}
		s.emit({ type: "message_end", message: { ...message } });
		s.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		s.emit({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "a" }] } });
		s.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a\n" }] }, isError: false });
		s.emit({ type: "notice", level: "info", message: "hello" });
		s.emit({ type: "agent_end", messages: [message] });
		s.isStreaming = false;
		await until(() => hostd.live().some(l => (l.f?.event as Json | undefined)?.type === "agent_end"));
		// Real time on purpose: the extension's throttle runs on the platform clock, and this checks that
		// no trailing update fires after its message's end once every throttle window has passed.
		await new Promise(r => setTimeout(r, 120));
		const live = hostd.live();
		expect(live.map(l => l.seq)).toEqual(live.map((_, i) => i + 1));
		const events = live.slice(1).filter(l => l.f.t === "event").map(l => l.f.event as Json);
		const types = events.map(e => e.type);
		expect(types.slice(0, 4)).toEqual(["agent_start", "turn_start", "message_start", "message_update"]);
		expect(types.indexOf("message_end")).toBeGreaterThan(types.lastIndexOf("message_update"));
		expect(types.filter(t => t === "message_update").length).toBeLessThan(4); // throttled at the source
		expect(types).toContain("tool_execution_update");
		expect(types.indexOf("tool_execution_end")).toBeGreaterThan(types.lastIndexOf("tool_execution_update"));
		expect(types.slice(-2)).toEqual(["notice", "agent_end"]);
		const update = events.find(e => e.type === "message_update")!;
		expect(update.assistantMessageEvent).toEqual({ type: "text_delta", delta: "x" });
		expect(events.at(-1)).toEqual({ type: "agent_end" });
		// The turn came and went within the state debounce: no state frame (it equals the resync's).
		expect(live.some(l => l.f?.t === "state")).toBe(false);
		// A state change after a state-changing event: one debounced state frame.
		s.queuedMessageCount = 2;
		s.emit({ type: "message_end", message: { role: "user", content: "queued", timestamp: 6 } });
		await until(() => hostd.live().some(l => l.f?.t === "state"));
		expect(hostd.live().filter(l => l.f?.t === "state").map(l => (l.f.state as Json).queuedMessageCount)).toEqual([2]);
	});

	test("a resync mid-turn replays everything in flight, in order", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		const s = omp.session;
		const streaming = { role: "assistant", content: [{ type: "text", text: "partial answer" }], timestamp: 9 };
		s.isStreaming = true;
		s.emit({ type: "agent_start" });
		s.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded" });
		s.emit({ type: "tool_execution_start", toolCallId: "c9", toolName: "bash", args: { command: "sleep 5" }, intent: "Waiting" });
		s.emit({ type: "tool_execution_update", toolCallId: "c9", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "old" }] } });
		s.updates.set("c9", { type: "tool_execution_update", toolCallId: "c9", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "newest" }] } });
		s.emit({ type: "message_start", message: streaming });
		s.emit({ type: "message_update", message: streaming, assistantMessageEvent: { type: "thinking_delta", partial: streaming } });
		s.agent.state.streamMessage = { ...streaming, content: [{ type: "text", text: "partial answer, further" }] };
		omp.pi.events.emit("task:subagent:lifecycle", { id: "0-Explore", agent: "explore", status: "started", index: 0 });
		omp.pi.events.emit("task:subagent:progress", { index: 0, agent: "explore", task: "t", progress: { id: "0-Explore", status: "running", toolCount: 2 } });
		const asking = (omp.tui.runnerUi as { select(t: string, o: string[], x: Json): Promise<unknown> }).select("Continue?", ["Yes", "No"], {});

		await request(hostd, "liveSubscribe");
		const resync = hostd.lines.find(l => l.t === "resync") as Json & { live: { streaming: boolean; frames: Json[] } };
		expect(resync.live.streaming).toBe(true);
		const frames = resync.live.frames;
		const label = (f: Json) =>
			f.t === "event" ? `event:${(f.event as Json).type}` : f.t === "bus" ? `bus:${String(f.channel).split(":").pop()}` : String(f.t);
		expect(frames.map(label)).toEqual([
			"state",
			"agents",
			"event:auto_retry_start",
			"event:message_update",
			"event:tool_execution_start",
			"event:tool_execution_update",
			"bus:lifecycle",
			"bus:progress",
			"ui-request",
		]);
		const msg = frames[3]!.event as Json & { message: { content: Array<{ text: string }> }; assistantMessageEvent: Json };
		expect(msg.message.content[0]!.text).toBe("partial answer, further"); // omp's live streamMessage
		expect(msg.assistantMessageEvent).toEqual({ type: "thinking_delta" });
		expect(((frames[5]!.event as Json).partialResult as { content: Array<{ text: string }> }).content[0]!.text).toBe("newest");
		expect(frames[8]!.request).toMatchObject({ kind: "select", title: "Continue?", options: ["Yes", "No"] });
		expect((frames[0]!.state as Json).isStreaming).toBe(true);

		// hostd answers the dialog: the TUI one closes, omp's caller gets hostd's answer.
		const reqIdOf = (frames[8]!.request as Json).reqId as number;
		await request(hostd, "uiResponse", { reqId: reqIdOf, value: "No" });
		expect(await asking).toBe("No");
		expect(omp.tui.open[0]!.aborted).toBe(true);
		await until(() => hostd.live().some(l => l.f?.t === "ui-request-end" && l.f.reqId === reqIdOf));
		// An answer to a dialog that is over: ok, and hostd hears it ended.
		const late = await request(hostd, "uiResponse", { reqId: 999, value: "x" });
		expect(late.ok).toBe(true);
		await until(() => hostd.live().some(l => l.f?.t === "ui-request-end" && l.f.reqId === 999));
	});

	test("before omp wrote the session file, the resync carries its entries instead of a lastEntryId", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd, { onDisk: false });
		omp.tick();
		await request(hostd, "liveSubscribe");
		const resync = hostd.lines.find(l => l.t === "resync") as Json & { live: { frames: Json[] } };
		expect(resync.lastEntryId).toBeNull();
		expect(resync.live.frames.filter(f => f.t === "entry").map(f => (f.entry as Json).id)).toEqual(["e1", "e2", "e3"]);
	});

	test("a session omp wrote names its file in every resync, also while omp moves the file", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		await request(hostd, "liveSubscribe");
		// omp's moveTo renamed the file and has not pointed the session at the new path yet: hostd
		// finds the file gone and subscribes again until it is there (no transcript inlined).
		omp.sm.onDisk = false;
		await request(hostd, "liveSubscribe");
		const resyncs = hostd.lines.filter(l => l.t === "resync") as Array<Json & { live: { frames: Json[] } }>;
		expect(resyncs.map(r => r.lastEntryId)).toEqual(["e3", "e3"]);
		expect(resyncs.flatMap(r => r.live.frames).filter(f => f.t === "entry")).toEqual([]);
	});

	test("a session omp writes after a resync counts as written from the next tick on", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd, { onDisk: false });
		await request(hostd, "liveSubscribe");
		omp.sm.onDisk = true;
		omp.tick();
		// …then omp moves it.
		omp.sm.onDisk = false;
		await request(hostd, "liveSubscribe");
		const resyncs = hostd.lines.filter(l => l.t === "resync") as Array<Json & { live: { frames: Json[] } }>;
		expect(resyncs.map(r => r.lastEntryId)).toEqual([null, "e3"]);
		expect(resyncs.map(r => r.live.frames.filter(f => f.t === "entry").length)).toEqual([3, 0]);
	});

	test("the ask tool's dialog is answered from hostd round by round; the TUI dialog closes", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		await request(hostd, "liveSubscribe");
		// The ask tool calls through its own proxy over the same UI object (omp's tool context store).
		const toolUi = trackUserWaits(omp.tui.target) as typeof omp.tui.target;
		const ac = new AbortController();
		const answer = toolUi.askDialog([{ id: "q", question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] }], { signal: ac.signal });
		await until(() => hostd.live().some(l => l.f?.t === "ui-request"));
		const req = hostd.live().find(l => l.f?.t === "ui-request")!.f.request as Json;
		expect(req).toMatchObject({ kind: "select", title: "Color?", selectionMarker: "radio" });
		await request(hostd, "uiResponse", { reqId: req.reqId, value: "Blue" });
		expect(await answer).toMatchObject({ kind: "submit", results: [{ id: "q", selectedOptions: ["Blue"] }] });
		expect(omp.tui.open.find(d => d.kind === "askDialog")!.aborted).toBe(true);

		// And the other way round: the operator answers in the TUI, hostd's request ends.
		const local = toolUi.confirm("Exit plan mode?", "Changes are kept", {});
		await until(() => hostd.live().filter(l => l.f?.t === "ui-request").length === 2);
		const confirmReq = hostd.live().filter(l => l.f?.t === "ui-request")[1]!.f.request as Json;
		expect(confirmReq).toMatchObject({ kind: "select", title: "Exit plan mode?\nChanges are kept", options: ["Yes", "No"] });
		omp.tui.open.find(d => d.kind === "confirm")!.answer(true);
		expect(await local).toBe(true);
		await until(() => hostd.live().some(l => l.f?.t === "ui-request-end" && l.f.reqId === confirmReq.reqId));
	});

	test("nested subagents: copies in subagent sessions relay their task bus to the owner, once", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		await request(hostd, "liveSubscribe");
		// Two copies loaded in the same subagent session (global install + -e copy), and one nested deeper.
		const subs: Omp[] = [];
		for (const sub of ["0-Explore", "0-Explore", "0-Explore.1-Deep"]) {
			const s = fakeOmp({ sub, registry: omp.registry });
			await teleflockBridge(s.pi as never);
			s.pi.fire("session_start", { type: "session_start" });
			subs.push(s);
		}
		// Both copies of the first subagent's session see the same payload object on that session's bus.
		const nested = { index: 0, agent: "deep", task: "t", progress: { id: "0-Explore.1-Deep", status: "running" } };
		subs[0]!.pi.events.emit("task:subagent:progress", nested);
		subs[1]!.pi.events.emit("task:subagent:progress", nested);
		subs[2]!.pi.events.emit("task:subagent:lifecycle", { id: "0-Explore.1-Deep.2-Leaf", agent: "leaf", status: "started", index: 2 });
		// Relays run synchronously and the writer is ordered: a ping's res comes after any duplicate.
		await request(hostd, "ping");
		const bus = hostd.live().filter(l => l.f?.t === "bus").map(l => l.f);
		expect(bus).toEqual([
			{ t: "bus", channel: "task:subagent:progress", data: nested },
			{ t: "bus", channel: "task:subagent:lifecycle", data: { id: "0-Explore.1-Deep.2-Leaf", agent: "leaf", status: "started", index: 2 } },
		]);
		// Subagent bindings never talk to hostd themselves.
		expect(hostd.lines.filter(l => l.t === "hello")).toHaveLength(1);
		// The roster comes from omp's registry, with every agent's session file.
		omp.registry.changed();
		await until(() => hostd.live().some(l => l.f?.t === "agents"));
		const agents = hostd.live().find(l => l.f?.t === "agents")!.f.agents as Json[];
		expect(agents.map(a => [a.id, a.kind, a.parentId, a.sessionFile])).toEqual([
			["Main", "main", undefined, "/tmp/S1.jsonl"],
			["0-Explore", "sub", "Main", "/tmp/0-Explore.jsonl"],
			["0-Explore.1-Deep", "sub", "Main", "/tmp/0-Explore.1-Deep.jsonl"],
		]);
	});

	test("prompt: starts a turn when idle, steers or follows up while streaming, with images", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		const idle = await request(hostd, "prompt", { text: "hi", delivery: "steer" });
		expect(idle.result).toEqual({ queued: false });
		expect(omp.pi.sent.at(-1)).toEqual(["hi", undefined]);
		omp.session.isStreaming = true;
		const img = { type: "image", data: "aGk=", mimeType: "image/png" };
		const steer = await request(hostd, "prompt", { text: "look", images: [{ data: "aGk=", mimeType: "image/png" }], delivery: "auto" });
		expect(steer.result).toEqual({ queued: true });
		expect(omp.pi.sent.at(-1)).toEqual([[{ type: "text", text: "look" }, img], { deliverAs: "steer" }]);
		await request(hostd, "prompt", { text: "after", delivery: "followUp" });
		expect(omp.pi.sent.at(-1)).toEqual(["after", { deliverAs: "followUp" }]);
		const bad = await request(hostd, "prompt", { text: "x", images: [{ data: "aGk=", mimeType: "text/plain" }] });
		expect(bad).toMatchObject({ ok: false, error: { code: "invalid_params" } });
		expect((await request(hostd, "prompt", { text: "x", delivery: "later" })).ok).toBe(false);
	});

	test("agentCmd: chat revives and steers, kill aborts and tombstones, unsupported without omp's manager", async () => {
		const hostdA = await startHostd();
		const omp = await bridged(hostdA);
		expect((await request(hostdA, "agentCmd", { cmd: "chat", agentId: "0-X", text: "hi" })).error).toMatchObject({ code: "unsupported" });
		omp.pi.fire("session_shutdown", { type: "session_shutdown" });
		delete (globalThis as Record<symbol, unknown>)[SLOT];

		const hostd = await startHostd();
		const sub = fakeAgentSession(fakeSessionManager("sub", "/tmp/sub.jsonl"));
		const calls: unknown[][] = [];
		const lifecycle = {
			async ensureLive(id: string) {
				calls.push(["ensureLive", id]);
				return sub;
			},
			async release(id: string, ref: unknown, options: unknown) {
				calls.push(["release", id, (ref as Json).id, options]);
				return true;
			},
		};
		const omp2 = await bridged(hostd, { lifecycle });
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).subagentCtl).toBe(true);
		omp2.registry.refs.set("0-X", { id: "0-X", kind: "sub", status: "running", session: sub });
		expect((await request(hostd, "agentCmd", { cmd: "chat", agentId: "0-X", text: " go on " })).ok).toBe(true);
		expect(sub.prompts).toEqual([["go on", { streamingBehavior: "steer" }]]);
		expect((await request(hostd, "agentCmd", { cmd: "kill", agentId: "0-X" })).ok).toBe(true);
		expect(sub.aborted).toBe(1);
		expect(calls).toEqual([
			["ensureLive", "0-X"],
			["release", "0-X", "0-X", { tombstone: true }],
		]);
		expect((await request(hostd, "agentCmd", { cmd: "chat", agentId: "0-X", text: "  " })).error).toMatchObject({ code: "invalid_params" });
	});

	test("a session switch ends the feed: the switch hello comes first, live frames resume after a new subscribe", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		await request(hostd, "liveSubscribe");
		omp.sm.id = "S2";
		omp.session.emit({ type: "agent_start" });
		await until(() => hostd.lines.some(l => l.t === "hello" && l.reason === "switch"));
		const switchAt = hostd.lines.findIndex(l => l.t === "hello" && l.reason === "switch");
		expect(hostd.lines.slice(switchAt).some(l => l.t === "live")).toBe(false);
		omp.session.emit({ type: "turn_start" });
		await request(hostd, "liveSubscribe");
		omp.session.emit({ type: "turn_end" });
		await until(() => hostd.live().some(l => (l.f?.event as Json | undefined)?.type === "turn_end"));
		const after = hostd.lines.slice(switchAt).filter(l => l.t === "live" || l.t === "resync");
		expect(after[0]!.t).toBe("resync");
		expect(after[0]!.sessionId).toBe("S2");
		expect(after.map(l => (l.f as Json | undefined)?.event).filter(Boolean).map(e => (e as Json).type)).toEqual(["turn_end"]);
	});
});

describe("LiveTracker", () => {
	test("forgets what ended: messages, tools, compaction and retry", () => {
		const t = new LiveTracker();
		t.track({ type: "agent_start" });
		t.track({ type: "message_update", message: { role: "assistant" } });
		t.track({ type: "tool_execution_start", toolCallId: "a" });
		t.track({ type: "tool_execution_start", toolCallId: "b" });
		t.track({ type: "tool_execution_end", toolCallId: "a" });
		t.track({ type: "message_end", message: { role: "assistant" } });
		expect(t.frames().map(f => (f.event as Json).type)).toEqual(["tool_execution_start"]);
		t.track({ type: "agent_end" });
		expect(t.frames()).toEqual([]);
		expect(t.streaming).toBe(false);
	});
});
