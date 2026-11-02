// Tests for the protocol v2 data plane of the TeleFlock bridge (docs/bridge-protocol.md "Live feed",
// "Dialogs", "Subagents"): the ordered writer's flow control, source throttling, the dialog race,
// the ask-dialog guest flow, the wrappers on omp's UI context, and the whole extension against a
// fake hostd socket with a fake omp (`pi`, contexts, AgentSession, agent registry).
import { afterEach, describe, expect, jest, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, {
	applyRoleModels,
	DialogHub,
	fallbackApproval,
	frameJson,
	installDialogWrappers,
	LiveTracker,
	LiveWriter,
	raceDialog,
	raceMember,
	readRoleModels,
	type RoleSettings,
	type RoleStore,
	roleModelsRequest,
	runGuestAsk,
	selectorLevel,
	Throttle,
	type Timers,
	wireEvent,
	wellFormedJson,
	configNotices,
	fallbackNotice,
	installNotifyWrapper,
	notifyNotice,
	dialogText,
	installOmpDialogWrappers,
	installUserWaitCounter,
	type OmpDialogMethod,
	type OmpDialogPolicy,
	raceOmpDialog,
	shownText,
	typedInput,
	installIrcTap,
	type IrcLeg,
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
		notified: [] as unknown[][],
		notify(...args: unknown[]) {
			this.notified.push(args);
		},
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

	test("a resync too large even clipped still goes out as a resync, without its in-flight frames", () => {
		const sink = new FakeSink();
		const keys: Json = {};
		for (let i = 0; i < 400; i++) keys[`key-${i}-${"k".repeat(20)}`] = 1;
		const logs: string[] = [];
		const w = new LiveWriter(sink, {
			resyncBytes: 2_000,
			log: m => logs.push(m),
			resync: seq => ({ t: "resync", seq, sessionId: "s1", lastEntryId: "e9", live: { streaming: true, frames: [{ t: "agents", keys }] } }),
		});
		w.start();
		const [resync] = sink.frames();
		// Before, a notice took its place and hostd waited for a resync that never came.
		expect(resync).toEqual({ t: "resync", seq: 1, sessionId: "s1", lastEntryId: "e9", live: { streaming: true, frames: [] } });
		expect(logs.some(l => l.includes("without its in-flight frames"))).toBe(true);
	});

	test("control frames with half a surrogate pair are written well-formed", () => {
		const sink = new FakeSink();
		const w = new LiveWriter(sink, { resync: seq => ({ t: "resync", seq }) });
		// A session title cut inside an emoji (omp cuts text by UTF-16 index).
		w.ctl({ t: "hello", state: { title: "Abgleich 🔍".slice(0, 10) } });
		expect(sink.lines[0]).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/);
		expect((sink.frames()[0]!.state as Json).title).toBe("Abgleich \ufffd");
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

	test("half a surrogate pair goes out as U+FFFD: hostd's serde_json refuses lone surrogate escapes", () => {
		// What omp 18.13.3 sends while a `wait` runs: its completion probe cuts a subagent's `stage`
		// to 80 UTF-16 units (`slice(0, 79)` + "…"), its progress keeps an 8 KiB `recentOutput` tail.
		const stage = `${"Querverweise prüfen 🔍 und die Eingriffe abgleichen".slice(0, 21)}…`;
		const tail = "🚀 weiter mit den Karten".slice(1);
		const progress = { id: "QuerEingriffe", stage, recentOutput: [tail], completionPercent: 70 };
		const frame = { t: "bus", channel: "task:subagent:progress", data: { progress } };
		expect(JSON.stringify(frame)).toMatch(/\\ud83d/); // what bridge 2.0.0 wrote
		const json = frameJson(frame);
		expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/);
		const sent = JSON.parse(json) as { data: { progress: typeof progress } };
		expect(sent.data.progress.stage).toBe("Querverweise prüfen \ufffd…");
		expect(sent.data.progress.recentOutput).toEqual(["\ufffd weiter mit den Karten"]);
		// Whole pairs, other escapes and text that only looks like an escape stay as they are.
		const kept = JSON.stringify({ a: "🚀 ok", b: "C:\\udir \\ud83d", c: "\u0001 \"q\"" });
		expect(wellFormedJson(kept)).toBe(kept);
		// After an escaped backslash a lone surrogate is still repaired.
		expect(JSON.parse(wellFormedJson(JSON.stringify({ x: "\\🔍".slice(0, 2) })))).toEqual({ x: "\\\ufffd" });
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

	// 2.2.0: Back between the questions of a multi-question ask (omp's TUI: ←).
	const BACK = "\u0000back";
	const OTHER = "Other (type your own)";
	const three = [
		{ id: "store", question: "Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
		{ id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Search" }, { label: "Billing" }], multi: true },
		{ id: "deploy", question: "Where?", options: [{ label: "Fly" }, { label: "Render" }] },
	];

	test("every question of a multi-question ask carries nav; Back reopens the previous one with its answer", async () => {
		const { hub, requests } = hubWithFrames();
		const p = runGuestAsk(hub, three, new AbortController().signal);
		const last = () => requests().at(-1)!;
		await tick();
		expect(last()).toMatchObject({ reqId: 1, title: "Which store?", initialIndex: 0, nav: { index: 0, total: 3 } });
		expect(last().nav).toEqual({ index: 0, total: 3 });
		hub.answer(1, "Postgres");
		await tick();
		expect(last()).toMatchObject({ reqId: 2, selectionMarker: "checkbox", checkedIndices: [], nav: { index: 1, total: 3, back: BACK } });
		hub.answer(2, "Search");
		await tick();
		expect(last()).toMatchObject({ reqId: 3, checkedIndices: [1], nav: { index: 1, back: BACK, answer: { choices: ["Search"] } } });
		// Back: the first question again, on its answer; it has no Back of its own.
		hub.answer(3, BACK);
		await tick();
		expect(last()).toMatchObject({ reqId: 4, title: "Which store?", initialIndex: 1, nav: { index: 0, total: 3, answer: { choices: ["Postgres"] } } });
		expect(last().nav).not.toHaveProperty("back");
		hub.answer(4, "SQLite");
		await tick();
		// The multi-select kept its ticks.
		expect(last()).toMatchObject({ reqId: 5, checkedIndices: [1], nav: { index: 1, answer: { choices: ["Search"] } } });
		hub.answer(5, "Auth");
		await tick();
		hub.answer(6, "Next →");
		await tick();
		expect(last()).toMatchObject({ reqId: 7, title: "Where?", nav: { index: 2, total: 3, back: BACK } });
		// The Other editor goes back too.
		hub.answer(7, OTHER);
		await tick();
		expect(last()).toEqual({ kind: "editor", title: "Custom answer: Where?", nav: { index: 2, total: 3, back: BACK }, reqId: 8 });
		hub.answer(8, BACK);
		await tick();
		expect(last()).toMatchObject({ reqId: 9, checkedIndices: [0, 1], nav: { index: 1, answer: { choices: ["Auth", "Search"] } } });
		hub.answer(9, "Next →");
		await tick();
		expect(last()).toMatchObject({ reqId: 10, title: "Where?", initialIndex: 0 });
		expect(last().nav).toEqual({ index: 2, total: 3, back: BACK });
		hub.answer(10, OTHER);
		await tick();
		hub.answer(11, "Fly.io in fra");
		expect(await p).toEqual({
			kind: "submit",
			results: [
				{ id: "store", question: "Which store?", options: ["SQLite", "Postgres"], multi: false, selectedOptions: ["SQLite"], customInput: undefined },
				{ id: "features", question: "Which features?", options: ["Auth", "Search", "Billing"], multi: true, selectedOptions: ["Auth", "Search"], customInput: undefined },
				{ id: "deploy", question: "Where?", options: ["Fly", "Render"], multi: false, selectedOptions: [], customInput: "Fly.io in fra" },
			],
		});
	});

	test("a typed answer comes back prefilled: on the Other row of a single choice, in the editor", async () => {
		const { hub, requests } = hubWithFrames();
		const two = [three[0]!, three[2]!];
		const p = runGuestAsk(hub, two, new AbortController().signal);
		const last = () => requests().at(-1)!;
		await tick();
		hub.answer(1, OTHER);
		await tick();
		hub.answer(2, "MySQL");
		await tick();
		hub.answer(3, BACK);
		await tick();
		expect(last()).toMatchObject({ reqId: 4, initialIndex: 2, nav: { index: 0, answer: { choices: [], text: "MySQL" } } });
		hub.answer(4, OTHER);
		await tick();
		expect(last()).toMatchObject({ kind: "editor", reqId: 5, prefill: "MySQL" });
		hub.answer(5, "MySQL 8");
		await tick();
		hub.answer(6, "Render");
		const results = ((await p) as { results: Array<Json> }).results;
		expect(results[0]).toMatchObject({ selectedOptions: [], customInput: "MySQL 8" });
		expect(results[1]).toMatchObject({ selectedOptions: ["Render"] });
	});

	test("a multi-select reopens with its ticks and its typed text for the editor; new ticks alone drop the text", async () => {
		const { hub, requests } = hubWithFrames();
		const two = [three[1]!, three[2]!];
		const p = runGuestAsk(hub, two, new AbortController().signal);
		const last = () => requests().at(-1)!;
		await tick();
		hub.answer(1, "Billing");
		await tick();
		hub.answer(2, OTHER);
		await tick();
		hub.answer(3, "SSO");
		await tick();
		hub.answer(4, BACK);
		await tick();
		expect(last()).toMatchObject({
			reqId: 5,
			checkedIndices: [2],
			options: ["Auth", "Search", "Billing", OTHER, "Next →", "Chat about this"],
			nav: { index: 0, answer: { choices: ["Billing"], text: "SSO" } },
		});
		hub.answer(5, OTHER);
		await tick();
		expect(last()).toMatchObject({ kind: "editor", reqId: 6, prefill: "SSO" });
		hub.answer(6, undefined); // cancel: back to the checkboxes
		await tick();
		hub.answer(7, "Next →");
		await tick();
		hub.answer(8, "Fly");
		const results = ((await p) as { results: Array<Json> }).results;
		expect(results[0]).toMatchObject({ selectedOptions: ["Billing"], customInput: undefined });
	});

	test("no nav on a single question, no Back on the first; Back's value is no option label", async () => {
		const { hub, requests } = hubWithFrames();
		const tricky = [{ id: "t", question: "Q", options: [{ label: BACK }, { label: "Plain" }] }];
		const p = runGuestAsk(hub, tricky, new AbortController().signal);
		await tick();
		expect(requests()[0]).not.toHaveProperty("nav");
		expect((requests()[0]!.options as unknown[]).slice(0, 2)).toEqual([`${BACK} (2)`, "Plain"]);
		hub.answer(1, `${BACK} (2)`);
		expect(((await p) as { results: Array<Json> }).results[0]!.selectedOptions).toEqual([BACK]);

		const second = hubWithFrames();
		const two = runGuestAsk(second.hub, [three[0]!, three[2]!], new AbortController().signal);
		await tick();
		second.hub.answer(1, BACK); // the first question cannot go back: an unknown label, as before
		await tick();
		expect(second.requests().at(-1)).toMatchObject({ reqId: 2, title: "Where?" });
		second.hub.answer(2, "Fly");
		expect(((await two) as { results: Array<Json> }).results[0]!.selectedOptions).toEqual([]);
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

	test("an extension's secret input and a selector with disabled rows stay in the TUI, as omp's own do", async () => {
		const tui = fakeTui();
		const { hub, requests } = hubWithFrames();
		const wrap = (name: Parameters<typeof raceMember>[1], original: (...a: unknown[]) => unknown) =>
			function (this: unknown, ...args: unknown[]) {
				return raceMember(hub, name, original, this, args, fallbackApproval) ?? original.apply(this, args);
			};
		installDialogWrappers(tui.runnerUi, {}, wrap);
		// `ctx.ui.input(title, placeholder, {secret: true})`: the TUI masks it; hostd never sees it.
		const key = tui.runnerUi.input("API key", "sk-…", { secret: true });
		// hostd could pick a row omp disabled.
		const pick = tui.runnerUi.select("Model", ["fast", "smart (no credentials)"], { disabledIndices: [1] });
		expect(requests()).toEqual([]);
		expect(tui.open.map(d => d.kind)).toEqual(["input", "select"]);
		tui.open[0]!.answer("sk-secret");
		tui.open[1]!.answer("fast");
		expect([await key, await pick]).toEqual(["sk-secret", "fast"]);
		// No disabled row, no secret: offered as before.
		void tui.runnerUi.select("Model", ["fast", "smart"], { disabledIndices: [] });
		void tui.runnerUi.input("Name", undefined, { secret: false });
		expect(requests().map(r => r.kind)).toEqual(["select", "editor"]);
	});
});

// ─── the whole extension against a fake hostd ─────────────────────────────────────────────────

const SLOT = Symbol.for("teleflock.bridge");
const MODEL = { id: "gpt-6-luna", name: "GPT-6 Luna", api: "openai-codex-responses", provider: "openai-codex", contextWindow: 272000, headers: { secret: "x" } };

interface Hostd {
	lines: Json[];
	send(obj: Json): void;
	live(): Array<Json & { seq: number; f: Json }>;
	/** The next line that arrives and matches `pred` (driven by the socket alone, no timer). */
	next(pred: (line: Json) => boolean): Promise<Json>;
	close(): void;
}

let cleanups: Array<() => void> = [];
afterEach(() => {
	// A test that ran on fake time and failed leaves it on.
	jest.useRealTimers();
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
	const waiters = new Set<{ pred: (line: Json) => boolean; resolve: (line: Json) => void }>();
	let conn: net.Socket | undefined;
	const server = net.createServer(c => {
		conn = c;
		c.setEncoding("utf8");
		let buf = "";
		c.on("data", (chunk: string) => {
			buf += chunk;
			let i = buf.indexOf("\n");
			while (i >= 0) {
				const line = JSON.parse(buf.slice(0, i)) as Json;
				lines.push(line);
				for (const w of waiters) {
					if (!w.pred(line)) continue;
					waiters.delete(w);
					w.resolve(line);
				}
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
		next: pred => {
			const { promise, resolve } = Promise.withResolvers<Json>();
			waiters.add({ pred, resolve });
			return promise;
		},
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
 *  written the session file yet; `waits`: its AgentSession class has omp's `waitForUser`;
 *  `manualTicks`: the bridge's tick runs only through `tick()`. */
function fakeOmp(
	opts: {
		sub?: string;
		registry?: ReturnType<typeof fakeRegistry>;
		lifecycle?: unknown;
		tui?: ReturnType<typeof fakeTui>;
		onDisk?: boolean;
		irc?: object;
		runtimeOptions?: Json[];
		waits?: boolean;
		manualTicks?: boolean;
	} = {},
): Omp {
	const sm = fakeSessionManager(opts.sub ? `sub-${opts.sub}` : "S1", `/tmp/${opts.sub ?? "S1"}.jsonl`);
	sm.onDisk = opts.onDisk ?? true;
	const session = fakeAgentSession(sm);
	if (opts.waits) {
		Object.setPrototypeOf(session, {
			waitForUser<T>(dialog: () => Promise<T>): Promise<T> {
				return dialog();
			},
		});
	}
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
	// omp's Agent Hub runtime (`modes/agent-hub-runtime`), whose dependencies hold the IRC bus.
	if (opts.irc) ns.createAgentHubRuntime = (options: Json) => {
		opts.runtimeOptions?.push(options);
		return { irc: opts.irc };
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
			return opts.manualTicks ? undefined : setInterval(fn, ms);
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
		expect(hello.bridgeVersion).toBe("2.3.0");
		expect(hello.caps).toMatchObject({ live: 1, dialogs: true, subagentCtl: false, prompt: true });

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

// ─── per-session model roles (2.1.0 `caps.roleModels`) ─────────────────────────────────────────

/** omp's settings layers as the role ops see them: global → project → `--config` overlays →
 *  runtime overrides; `disk` is what the overlay files hold now (hostd rewrote them). */
function fakeRoleSettings(init: { global?: Json; project?: Json; overlay?: Json; runtime?: Json; files?: string[]; disk?: Json } = {}) {
	const state = { global: init.global ?? {}, project: init.project ?? {}, overlay: init.overlay ?? {}, runtime: init.runtime ?? {}, disk: init.disk ?? {}, reloads: 0 };
	const layers = (): Json[] => [state.runtime, state.overlay, state.project, state.global];
	const roleIn = (layer: Json, role: string): string | undefined => {
		const v = (layer.modelRoles as Json | undefined)?.[role];
		return typeof v === "string" ? v : undefined;
	};
	const chainsIn = (layer: Json): Json => ((layer.retry as Json | undefined)?.fallbackChains as Json | undefined) ?? {};
	const store: RoleStore = {
		getModelRole: role => layers().map(l => roleIn(l, role)).find(v => v !== undefined),
		getModelRoles: () => Object.assign({}, ...layers().reverse().map(l => (l.modelRoles as Json | undefined) ?? {})),
		getModelRoleProvenance: role => ["runtime", "overlay", "project", "global"][layers().findIndex(l => roleIn(l, role) !== undefined)] ?? "default",
		getGlobalModelRole: role => roleIn(state.global, role),
		getProjectModelRole: role => roleIn(state.project, role),
		getGlobalSettings: () => structuredClone(state.global),
		getProjectSettings: () => structuredClone(state.project),
		getConfigFiles: () => init.files ?? [],
		reloadFromDisk: async () => {
			state.reloads++;
			state.overlay = structuredClone(state.disk);
		},
	};
	const rs: RoleSettings = {
		store: () => store,
		roles: {
			get: () => store.getModelRoles(),
			override: (_scope, value) => void (state.runtime.modelRoles = value),
			clearOverride: () => void delete state.runtime.modelRoles,
		},
		chains: {
			get: () => Object.assign({}, ...layers().reverse().map(chainsIn)),
			override: (_scope, value) => void (state.runtime.retry = { ...(state.runtime.retry as Json | undefined), fallbackChains: value }),
			clearOverride: () => void delete state.runtime.retry,
		},
	};
	return { rs, state };
}

describe("per-session model roles", () => {
	const host = {
		global: { modelRoles: { default: "a/g", smol: "a/s" }, retry: { fallbackChains: { default: ["a/x"] } } },
		project: { modelRoles: { smol: "p/s" } },
	};

	test("the session's own roles and chains read apart from the host's", () => {
		const { rs } = fakeRoleSettings({
			...host,
			overlay: { modelRoles: { task: "o/t" }, retry: { fallbackChains: { task: ["o/y"], default: ["a/x"] } } },
			runtime: { modelRoles: { default: "r/d:high" } },
			files: ["/h/omp-overlay.yml", "/h/agent-config/a1.yml"],
		});
		const view = readRoleModels(rs, "r/d");
		expect(view.session).toEqual({ default: "r/d:high", task: "o/t" });
		expect(view.host).toEqual({ default: "a/g", smol: "p/s" });
		expect(view.hostChains).toEqual({ default: ["a/x"] });
		// An overlay chain equal to the host's chain of that key reads as the host's.
		expect(view.sessionChains).toEqual({ task: ["o/y"] });
		expect(view).toMatchObject({ active: "r/d", overlays: ["/h/omp-overlay.yml", "/h/agent-config/a1.yml"] });
	});

	test("set reloads the agent's overlay, replaces the runtime layer and follows a changed default", async () => {
		const file = "/h/agent-config/a1.yml";
		const { rs, state } = fakeRoleSettings({
			...host,
			overlay: { modelRoles: { task: "o/t" } },
			runtime: { modelRoles: { default: "r/d:high" } },
			files: ["/h/omp-overlay.yml", file],
			disk: { modelRoles: { smol: "n/s:low" } },
		});
		const followed: string[] = [];
		const warning = await applyRoleModels(rs, { roles: { smol: "n/s:low" }, chains: { default: ["n/z:off"] }, overlay: file }, async selector => {
			followed.push(selector);
			return "no credentials for a/g";
		});
		expect(state.reloads).toBe(1);
		const view = readRoleModels(rs);
		// `task` (gone from the rewritten overlay) and `default` (gone from the runtime layer) are the host's again.
		expect(view.session).toEqual({ smol: "n/s:low" });
		expect(rs.store().getModelRole("default")).toBe("a/g");
		expect(view.sessionChains).toEqual({ default: ["n/z:off"] });
		expect(followed).toEqual(["a/g"]);
		expect(warning).toBe("no credentials for a/g");
	});

	test("a session without that overlay reloads nothing; an unchanged default switches nothing; empty maps clear", async () => {
		const { rs, state } = fakeRoleSettings({ ...host, files: ["/h/omp-overlay.yml"] });
		let followed = 0;
		const follow = async () => {
			followed++;
			return undefined;
		};
		await applyRoleModels(rs, { roles: { smol: "x/y" }, chains: {}, overlay: "/h/agent-config/other.yml" }, follow);
		expect(state.reloads).toBe(0);
		expect(followed).toBe(0);
		expect(readRoleModels(rs).session).toEqual({ smol: "x/y" });
		await applyRoleModels(rs, { roles: {}, chains: {} }, follow);
		expect(readRoleModels(rs).session).toEqual({});
		expect(state.runtime).toEqual({});
	});

	test("set params are checked", () => {
		expect(roleModelsRequest({ roles: { smol: "a/b:low", designer: "x/y,z/w" }, fallbackChains: { "a/*": ["b/*"], task: [] }, overlay: "/f.yml" })).toEqual({
			roles: { smol: "a/b:low", designer: "x/y,z/w" },
			chains: { "a/*": ["b/*"], task: [] },
			overlay: "/f.yml",
		});
		expect(roleModelsRequest({})).toEqual({ roles: {}, chains: {}, overlay: undefined });
		const code = (p: Json): string | undefined => {
			try {
				roleModelsRequest(p);
				return undefined;
			} catch (e) {
				return (e as { code?: string }).code;
			}
		};
		expect(code({ roles: { "1st": "a/b" } })).toBe("invalid_params");
		expect(code({ roles: JSON.parse('{"__proto__":"a/b"}') as Json })).toBe("invalid_params");
		expect(code({ roles: { smol: "gpt-5" } })).toBe("invalid_params");
		expect(code({ roles: { smol: "a/b c" } })).toBe("invalid_params");
		expect(code({ roles: [] })).toBe("invalid_params");
		expect(code({ fallbackChains: { "bad key": ["a/b"] } })).toBe("invalid_params");
		expect(code({ fallbackChains: { default: "a/b" } })).toBe("invalid_params");
	});

	test("thinking suffixes", () => {
		expect(selectorLevel("a/b:high")).toBe("high");
		expect(selectorLevel("a/b:low,c/d")).toBe("low");
		expect(selectorLevel("ollama/llama3:8b")).toBeUndefined();
		expect(selectorLevel("a/b:constructor")).toBeUndefined();
		expect(selectorLevel("a/b")).toBeUndefined();
	});

	test("a bridge without omp's settings internals announces no roleModels and refuses the ops", async () => {
		const hostd = await startHostd();
		await bridged(hostd);
		const hello = hostd.lines.find(l => l.t === "hello")!;
		expect((hello.caps as Json).roleModels).toBe(false);
		const res = await request(hostd, "getRoleModels");
		expect(res).toMatchObject({ ok: false, error: { code: "unsupported" } });
	});
});

describe("refusals on the live feed", () => {
	test("assistant messages leave without the fallback credit omp keeps for itself", () => {
		const message = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "Refusal (cyber): exploit code",
			stopDetails: { type: "refusal", category: "cyber", explanation: "exploit code", fallback_credit_token: "fct_secret", fallback_has_prefill_claim: true },
			fallbackCreditHandle: { token: "fct_secret", params: { messages: ["the whole request"] } },
		};
		for (const type of ["message_start", "message_update", "message_end"]) {
			const ev = type === "message_update" ? { type, message, assistantMessageEvent: { type: "done", partial: message } } : { type, message };
			const sent = JSON.stringify(wireEvent(ev));
			expect(sent).not.toContain("fct_secret");
			expect(sent).not.toContain("the whole request");
			expect(JSON.parse(sent).message.stopDetails).toEqual({ type: "refusal", category: "cyber", explanation: "exploit code" });
		}
		// omp's own object is untouched, and messages without credit go out as they are.
		expect(message.fallbackCreditHandle.token).toBe("fct_secret");
		const plain = { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } };
		expect(wireEvent(plain)).toBe(plain);
	});
});

describe("notices (caps.notices)", () => {
	test("omp's TUI-only warnings map to notice events", () => {
		expect(fallbackNotice({ type: "retry_fallback_applied", from: "anthropic/claude-opus-5", to: "openai/gpt-6-luna", role: "default", reason: "Refusal (cyber): x" })).toEqual({
			type: "notice",
			level: "warning",
			message: "Fallback: anthropic/claude-opus-5 → openai/gpt-6-luna\nRefusal (cyber): x",
			source: "fallback",
		});
		expect(fallbackNotice({ type: "retry_fallback_succeeded", model: "openai/gpt-6-luna", role: "default" })).toMatchObject({ level: "info", message: "Fallback succeeded on openai/gpt-6-luna" });
		expect(fallbackNotice({ type: "agent_end" })).toBeUndefined();
		expect(notifyNotice("\x1b[33mDeploy failed\x1b[0m", "error")).toEqual({ type: "notice", level: "error", message: "Deploy failed", source: "extension" });
		expect(notifyNotice("hi", undefined)).toMatchObject({ level: "info" });
		expect(notifyNotice("  ", "warning")).toBeUndefined();
		const session = { configWarnings: ["unknown model foo/bar", "unknown model foo/bar"], getAdvisorConfigWarnings: () => ["no advisor model"] };
		const notices = configNotices(session);
		expect(notices.map(n => n.message)).toEqual(["unknown model foo/bar", "WATCHDOG.yml: no advisor model"]);
		expect(notices[0]!.key).toBe(configNotices({ configWarnings: ["unknown model foo/bar"] })[0]!.key);
		expect(String(notices[0]!.key)).toMatch(/^config:[0-9a-f]{16}$/);
	});

	test("the notify wrapper sends the notice and omp still shows it", () => {
		const tui = fakeTui();
		const sent: unknown[] = [];
		const make = (original: (...a: unknown[]) => unknown) =>
			function (this: unknown, ...args: unknown[]) {
				sent.push(notifyNotice(args[0], args[1]));
				return original.apply(this, args);
			};
		const token = {};
		expect(installNotifyWrapper(tui.runnerUi, token, make)).toBe(true);
		const before = Object.getOwnPropertyDescriptor(tui.target, "notify")!.value;
		expect(installNotifyWrapper(tui.runnerUi, token, make)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(tui.target, "notify")!.value).toBe(before);
		// Any proxy over the shared context (extensions, tools) calls it.
		(trackUserWaits(tui.target) as typeof tui.target).notify("MCP server github failed to start", "warning");
		expect(sent).toEqual([{ type: "notice", level: "warning", message: "MCP server github failed to start", source: "extension" }]);
		expect(tui.target.notified).toEqual([["MCP server github failed to start", "warning"]]);
		expect(installNotifyWrapper({ select() {} }, token, make)).toBe(false);
	});

	test("the live feed carries them: fallbacks and notify live, config warnings in every resync", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd);
		const hello = hostd.lines.find(l => l.t === "hello")!;
		expect((hello.caps as Json).notices).toBe(true);
		(omp.session as unknown as Json).configWarnings = ["retry.fallbackChains: unknown model foo/bar"];
		await request(hostd, "liveSubscribe");
		const resync = hostd.lines.find(l => l.t === "resync") as Json & { live: { frames: Json[] } };
		const keyed = resync.live.frames.filter(f => f.t === "event" && (f.event as Json).type === "notice");
		expect(keyed).toEqual([{ t: "event", event: expect.objectContaining({ level: "warning", source: "config", message: "retry.fallbackChains: unknown model foo/bar" }) }]);
		omp.session.emit({ type: "retry_fallback_applied", from: "a/x", to: "b/y", role: "default" });
		omp.tui.runnerUi.notify("Lab warning", "warning");
		omp.session.emit({ type: "config_warnings_changed" });
		await until(() => hostd.live().filter(l => l.t === "live" && (l.f.event as Json | undefined)?.type === "notice").length >= 3);
		const notices = hostd.live().filter(l => l.t === "live").map(l => l.f.event as Json);
		expect(notices.map(n => [n.source, n.message])).toEqual([
			["fallback", "Fallback: a/x → b/y"],
			["extension", "Lab warning"],
			["config", "retry.fallbackChains: unknown model foo/bar"],
		]);
		expect(notices[2]!.key).toBe((keyed[0]!.event as Json).key);
	});
});

// ─── 2.3.0: omp's own dialogs and waits (`caps.ompDialogs`, `caps.userWaits`) ─────────────────

/** omp's ExtensionUiController, reduced to its dialog methods: the collab-aware ones run the hook
 *  ones, as omp's `showCollabAwareSelector` runs `showHookSelector` for its local side. */
function fakeController() {
	const tui = fakeTui();
	class Controller {
		showHookSelector(title: string, options: unknown[], opts?: Json): Promise<unknown> {
			return tui.target.select(title, options, opts);
		}
		showHookInput(title: string, placeholder?: string, opts?: Json): Promise<unknown> {
			return tui.target.input(title, placeholder, opts);
		}
		showHookEditor(title: string, prefill?: string, opts?: Json): Promise<unknown> {
			return tui.target.editor(title, prefill, opts);
		}
		showCollabAwareSelector(title: string, options: unknown[], opts?: Json): Promise<unknown> {
			return this.showHookSelector(title, options, opts);
		}
		showCollabAwareEditor(title: string, prefill?: string, opts?: Json): Promise<unknown> {
			return this.showHookEditor(title, prefill, opts);
		}
		setHookStatus(_key: string, _text: string | undefined): void {}
	}
	return { tui, Controller };
}

const ENDPOINT = "/run/teleflock/bridge.sock";

/** The process slot (as the bridge copies share it). */
const processSlot = () => ((globalThis as Record<symbol, unknown>)[SLOT] ??= { owners: {}, attachWaiters: [] }) as { owners: Record<string, Json>; ompController?: object };

/** omp's controller wrappers (once per process), with a copy bridging ENDPOINT that races `hub`. */
function wrapController(proto: object, hub: DialogHub, policy: OmpDialogPolicy) {
	processSlot().owners[ENDPOINT] = {
		version: "2.3.0",
		stop() {},
		ompDialog: (name: OmpDialogMethod, original: (...a: unknown[]) => unknown, self: unknown, args: unknown[]) => raceOmpDialog(hub, name, original, self, args, policy),
	};
	return installOmpDialogWrappers(proto);
}

const CFG = ["Always for this session", "Allow once", "Deny"];

describe("omp's own dialogs", () => {
	test("the cfg:// approval reaches hostd once with omp's text and choices; hostd's answer wins and closes omp's dialog", async () => {
		const { tui, Controller } = fakeController();
		const { hub, requests, ends } = hubWithFrames();
		const always: OmpDialogPolicy = { waiting: () => true, commanding: () => true, unattended: () => true };
		expect(wrapController(Controller.prototype, hub, always)).toBe(true);
		const c = new Controller();
		const title = "⚙️ Your agent wants to change `task.perCallModel` for this session.\noff → on";
		const p = c.showCollabAwareSelector(title, CFG, { initialIndex: 1 });
		// One offer: the hook selector the collab-aware one runs locally is not offered again.
		expect(requests()).toHaveLength(1);
		expect(requests()[0]).toMatchObject({ kind: "select", title, options: CFG, initialIndex: 1 });
		expect(tui.open.map(d => d.kind)).toEqual(["select"]);
		hub.answer(requests()[0]!.reqId, "Allow once");
		expect(await p).toBe("Allow once");
		expect(tui.open[0]!.aborted).toBe(true);
		// Answered in the terminal instead: hostd's request ends.
		const q = c.showCollabAwareSelector(title, CFG, { initialIndex: 1 });
		tui.open[1]!.answer("Deny");
		expect(await q).toBe("Deny");
		expect(ends()).toContain(requests()[1]!.reqId);
		expect(hub.size).toBe(0);
	});

	test("hook dialogs reach hostd while omp waits for the user; otherwise, and for secrets and disabled rows, the TUI alone", async () => {
		const { tui, Controller } = fakeController();
		const { hub, requests } = hubWithFrames();
		let waiting = false;
		wrapController(Controller.prototype, hub, { waiting: () => waiting, commanding: () => false, unattended: () => false });
		const c = new Controller();
		// The operator's own dialog (a /goal drop, say): the TUI's.
		const own = c.showHookSelector("Drop goal?\nThis removes the goal record.", ["Yes", "No"]);
		expect(requests()).toHaveLength(0);
		tui.open[0]!.answer("No");
		expect(await own).toBe("No");
		// omp waits for the user (the coding-plan reserve question runs under waitForUser).
		waiting = true;
		const reserve = c.showHookSelector("Coding-plan reserve reached\nSwitch to anthropic?", ["Yes", "No"], {});
		expect(requests()).toHaveLength(1);
		hub.answer(requests()[0]!.reqId, "Yes");
		expect(await reserve).toBe("Yes");
		void c.showHookInput("API key", undefined, { secret: true });
		void c.showHookSelector("Pick", ["A", "B"], { disabledIndices: [1] });
		expect(requests()).toHaveLength(1);
		const input = c.showHookInput("Describe what to detect and fix", "e.g.");
		expect(requests()[1]).toMatchObject({ kind: "editor", title: "Describe what to detect and fix" });
		hub.answer(requests()[1]!.reqId, "ts errors");
		expect(await input).toBe("ts errors");
	});

	test("one set of wrappers per process: a later copy stacks none, the copy bridging now answers, a status write names omp's controller", async () => {
		const { tui, Controller } = fakeController();
		const always: OmpDialogPolicy = { waiting: () => true, commanding: () => true, unattended: () => true };
		const first = hubWithFrames();
		expect(wrapController(Controller.prototype, first.hub, always)).toBe(true);
		const wrapped = Controller.prototype.showHookSelector;
		// A newer copy takes the process over (an extension reload): nothing more on omp's methods.
		const second = hubWithFrames();
		expect(wrapController(Controller.prototype, second.hub, always)).toBe(true);
		expect(Controller.prototype.showHookSelector).toBe(wrapped);
		const c = new Controller();
		const p = c.showHookSelector("Switch to anthropic?", ["Yes", "No"]);
		expect([first.requests().length, second.requests().length]).toEqual([0, 1]);
		second.hub.answer(second.requests()[0]!.reqId, "Yes");
		expect(await p).toBe("Yes");
		// No copy bridges any more (the session ended): omp's dialog alone.
		delete processSlot().owners[ENDPOINT];
		const q = c.showHookSelector("Switch to anthropic?", ["Yes", "No"]);
		expect(second.requests()).toHaveLength(1);
		tui.open.at(-1)!.answer("No");
		expect(await q).toBe("No");
		// A status write through the wrapper names omp's controller to every copy.
		c.setHookStatus("teleflock-probe", undefined);
		expect(processSlot().ompController).toBe(c);
	});
});

describe("omp's waits for the user", () => {
	test("waitForUser is counted once per process, settled or failed, with the same result", async () => {
		class Session {
			async waitForUser<T>(dialog: () => Promise<T>): Promise<T> {
				return await dialog();
			}
		}
		const waits = { count: 0, since: 0, listeners: new Set<() => void>() };
		let changes = 0;
		waits.listeners.add(() => changes++);
		expect(installUserWaitCounter(Session.prototype, () => waits)).toBe(true);
		expect(installUserWaitCounter(Session.prototype, () => waits)).toBe(true);
		const s = new Session();
		const { promise, resolve } = Promise.withResolvers<string>();
		const p = s.waitForUser(() => promise);
		expect(waits.count).toBe(1);
		expect(waits.since).toBeGreaterThan(0);
		resolve("Allow once");
		expect(await p).toBe("Allow once");
		await tick();
		expect([waits.count, changes]).toEqual([0, 2]);
		await expect(s.waitForUser(() => Promise.reject(new Error("aborted")))).rejects.toThrow("aborted");
		await tick();
		expect(waits.count).toBe(0);
	});

	test("a wait goes to hostd 1.5 s after it began, or after the offered dialog that covered it ended", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd, { waits: true, manualTicks: true });
		const waitShown = (l: Json) => l.event === "state" && (l.data as Json).userWait !== undefined;
		const waitGone = (l: Json) => l.event === "state" && (l.data as Json).userWait === undefined;
		// The bridge's grace timer runs on the clock (fake here); the socket to hostd stays real I/O,
		// so every wait below is on a frame hostd receives, not on time.
		jest.useFakeTimers();
		const answer = Promise.withResolvers<string>();
		const session: { waitForUser(dialog: () => Promise<string>): Promise<string> } = omp.session as never;
		const waited = session.waitForUser(() => answer.promise);
		const began = Date.now();
		// A tick computes the state half a second in: the grace still counts from the wait's start.
		jest.advanceTimersByTime(500);
		omp.tick();
		const shown = hostd.next(waitShown);
		jest.advanceTimersByTime(1_100);
		expect((await shown).data).toMatchObject({ userWait: { since: began } });
		// An offered dialog covers the wait: it leaves hostd's state.
		const gone = hostd.next(waitGone);
		const picked = omp.tui.runnerUi.select("Pick", ["A", "B"], {});
		omp.tick();
		await gone;
		jest.advanceTimersByTime(3_000);
		// Answered in the TUI with the wait still open: 1.5 s from the dialog's end, not from the wait's start.
		omp.tui.open[0]!.answer("A");
		expect(await picked).toBe("A");
		const again = hostd.next(waitShown);
		jest.advanceTimersByTime(1_400);
		omp.tick();
		const pong = hostd.next(l => l.t === "res" && l.id === 9_001);
		hostd.send({ t: "req", id: 9_001, op: "ping", params: {} });
		await pong;
		expect(hostd.lines.filter(waitShown)).toHaveLength(1);
		jest.advanceTimersByTime(200);
		expect((await again).data).toMatchObject({ userWait: { since: began } });
		jest.useRealTimers();
		answer.resolve("done");
		await waited;
	});

	test("a session_shutdown takes the copy's wait listener with it", async () => {
		const hostd = await startHostd();
		const omp = await bridged(hostd, { waits: true });
		const waits = () => ((globalThis as Record<symbol, unknown>)[SLOT] as { userWaits?: { listeners: Set<unknown> } }).userWaits;
		expect(waits()?.listeners.size).toBe(1);
		omp.pi.fire("session_shutdown", { type: "session_shutdown" });
		expect(waits()?.listeners.size).toBe(0);
	});

	test("only keystrokes count as typing, not terminal reports", () => {
		for (const report of ["\x1b[12;40R", "\x1b[I", "\x1b[O", "\x1b[?62;4c", "\x1b[8;24;80t", "\x1b]11;rgb:0000/0000/0000\x1b\\"]) expect(typedInput(report)).toBe(false);
		for (const key of ["a", "\r", "\x1b", "\x1b[A", "\x1b[97u"]) expect(typedInput(key)).toBe(true);
	});

	test("what the TUI shows in the composer's place: the dialog's rows without ANSI, borders or the composer", () => {
		const editor = { render: () => ["╰─ a draft ─╯"] };
		const dialog = {
			render: () => ["╭────────╮", "\x1b[1m⚙️ Your agent wants to change `task.perCallModel` for this session.\x1b[0m", "off → on", "", "│ → Allow once │", "    Deny", "╰────────╯"],
		};
		expect(dialogText({ children: [dialog, editor] }, editor, 80)).toBe(
			"⚙️ Your agent wants to change `task.perCallModel` for this session.\noff → on\n→ Allow once\n    Deny",
		);
		expect(dialogText({ children: [editor] }, editor, 80)).toBeUndefined();
	});

	test("an overlay on top (omp's interactive console) is what the TUI shows, rendered only at omp's own width", () => {
		const editor = { render: () => ["╰─ a draft ─╯"] };
		// omp's console (`ui.custom` with `overlay: true`): its render resizes its PTY to the width it gets.
		const widths: number[] = [];
		const pty = {
			render: (width: number) => {
				widths.push(width);
				return ["╭──────╮", "│▶ Console read -r -p 'Word: ' w [running]│", "│Word: │", "│      │", "│esc force-kill · input forwarded to PTY│", "╰──────╯"];
			},
		};
		const picker = { render: () => ["Hidden picker"] };
		const mode = {
			ui: {
				terminal: { columns: 132, rows: 40 },
				overlayStack: [
					{ component: pty, options: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 }, hidden: false },
					{ component: picker, options: {}, hidden: true },
					{ component: picker, options: { visible: () => false }, hidden: false },
				],
			},
			editorContainer: { children: [editor] },
			editor,
		};
		expect(shownText(mode)).toBe("▶ Console read -r -p 'Word: ' w [running]\nWord:\nesc force-kill · input forwarded to PTY");
		expect(widths).toEqual([132]);
		// pi-tui's overlay widths: 80 columns by default, numbers and percentages, minWidth, side margins.
		const width = (options: Json, columns = 132) => {
			const seen: number[] = [];
			shownText({ ui: { terminal: { columns, rows: 40 }, overlayStack: [{ component: { render: (w: number) => (seen.push(w), ["x"]) }, options }] } });
			return seen[0];
		};
		expect([width({}), width({ width: 60 }), width({ width: "50%" }), width({ width: 30, minWidth: 50 }), width({ width: "100%", margin: { left: 2, right: 4 } }), width({}, 60)]).toEqual([80, 60, 66, 50, 126, 60]);
		// No overlay: what replaced the composer, as before; nothing but the composer: nothing.
		const dialog = { render: () => ["Create a worktree for this session?", "→ Yes", "  No"] };
		expect(shownText({ ...mode, ui: { terminal: { columns: 132, rows: 40 }, overlayStack: [] }, editorContainer: { children: [dialog] } })).toBe("Create a worktree for this session?\n→ Yes\n  No");
		expect(shownText({ ...mode, ui: { terminal: { columns: 132, rows: 40 }, overlayStack: [] } })).toBeUndefined();
	});

	test("a console taller than the text keeps: its title and its bottom (the program's prompt, the footer)", () => {
		// omp's console has 0.8 × terminal rows − 4 rows of output: 44 log lines on a 60-row terminal.
		const log = Array.from({ length: 44 }, (_, i) => `│setup step ${i + 1} done│`);
		const pty = { render: () => ["╭──────╮", "│▶ Console ./install.sh [running]│", ...log, "│Do you want to continue? [Y/n] │", "│esc force-kill · input forwarded to PTY│", "╰──────╯"] };
		const shown = (component: object, columns = 132) => shownText({ ui: { terminal: { columns, rows: 60 }, overlayStack: [{ component, options: { width: "100%" } }] } })!;
		const rows = shown(pty).split("\n");
		expect(rows).toHaveLength(40);
		expect(rows[0]).toBe("▶ Console ./install.sh [running]");
		expect(rows.slice(-3)).toEqual(["setup step 44 done", "Do you want to continue? [Y/n]", "esc force-kill · input forwarded to PTY"]);
		expect(rows).not.toContain("setup step 1 done");
		// A wide console's rows run past the character limit too: its bottom stays.
		const wide = { render: () => ["▶ Console ./build.sh [running]", ...Array.from({ length: 36 }, (_, i) => `${i} ${"x".repeat(196)}`), "Overwrite dist/? [y/N]", "esc force-kill"] };
		const text = shown(wide, 220);
		expect(text.length).toBeLessThanOrEqual(4_000);
		expect(text.startsWith("▶ Console ./build.sh [running]\n")).toBe(true);
		expect(text.endsWith("Overwrite dist/? [y/N]\nesc force-kill")).toBe(true);
		// What replaced the composer keeps its top: a dialog's question comes first.
		const tall = { render: () => ["Pick a model", ...Array.from({ length: 50 }, (_, i) => `  option ${i + 1}`)] };
		const composer = dialogText({ children: [tall] }, undefined, 80)!.split("\n");
		expect([composer.length, composer[0], composer.at(-1)]).toEqual([40, "Pick a model", "  option 39"]);
	});
});

// ─── the agent chat (caps.agentChat) ──────────────────────────────────────────────────────────

/** A fresh class shaped like omp's IRC bus (`irc/bus.ts` `IrcBus`): `send(msg, options)` stamps
 *  omp's id and time, delivers after a tick and resolves with omp's receipt (`Nobody` is unknown,
 *  `Boom` rejects). Its state is private, so a wrapper that loses `this` breaks it. */
function ircBusClass() {
	return class IrcBus {
		#seq = 0;
		sent: Array<[Json, unknown]> = [];
		async send(msg: Json | undefined, options?: unknown): Promise<Json> {
			this.sent.push([{ ...msg, id: `omp${++this.#seq}`, ts: Date.now() }, options]);
			await tick();
			const to = msg?.to;
			if (to === "Boom") throw new Error("mailbox gone");
			if (to === "Nobody") return { to, outcome: "failed", error: 'Unknown agent "Nobody"' };
			return { to, outcome: to === "Orch.B" ? "woken" : "injected" };
		}
	};
}

describe("the agent chat (caps.agentChat)", () => {
	test("installIrcTap reports every leg omp's IRC bus sends when it starts and once omp settled it; the send stays omp's", async () => {
		const Bus = ircBusClass();
		const legs: IrcLeg[] = [];
		expect(installIrcTap(Bus.prototype, leg => legs.push(leg))).toBe(true);
		const bus = new Bus();
		const t0 = Date.now();
		// Same arguments, same `this`, same receipt.
		expect(await bus.send({ from: "Orch.A", to: "Orch.B", body: "Which port?" }, { suppressRelay: true })).toEqual({ to: "Orch.B", outcome: "woken" });
		expect(bus.sent[0]![1]).toEqual({ suppressRelay: true });
		const [start, end] = legs;
		expect(legs).toHaveLength(2);
		expect(start).toEqual({ id: start!.id, from: "Orch.A", to: "Orch.B", body: "Which port?", ts: start!.ts });
		expect(start!.ts).toBeGreaterThanOrEqual(t0);
		expect(end).toEqual({ ...start!, outcome: "woken" });

		// omp's flags pass through: a broadcast's leg, a wake relay answering omp's message id, a progress note.
		await Promise.all([
			bus.send({ from: "Orch", to: "Orch.A", body: "Plan: A owns the API.", broadcast: true }),
			bus.send({ from: "Orch.B", to: "Orch.A", body: "7420", replyTo: "omp1", wakeRelay: true }),
			bus.send({ from: "Orch.A", to: "Orch", body: "halfway", progress: true }),
		]);
		const settled = (body: string) => legs.find(l => l.body === body && l.outcome)!;
		const plan = settled("Plan: A owns the API.");
		expect(plan).toEqual({ id: plan.id, from: "Orch", to: "Orch.A", body: "Plan: A owns the API.", ts: plan.ts, broadcast: true, outcome: "injected" });
		expect(settled("7420")).toMatchObject({ from: "Orch.B", to: "Orch.A", replyTo: "omp1", wakeRelay: true, outcome: "injected" });
		expect(settled("halfway")).toMatchObject({ from: "Orch.A", to: "Orch", progress: true, outcome: "injected" });

		// Undeliverable: omp's failed receipt; a send that rejects still rejects for omp, reported as failed.
		expect(await bus.send({ from: "Orch.A", to: "Nobody", body: "hello?" })).toEqual({ to: "Nobody", outcome: "failed", error: 'Unknown agent "Nobody"' });
		await expect(bus.send({ from: "Orch.A", to: "Boom", body: "hello?" })).rejects.toThrow("mailbox gone");
		expect(legs.filter(l => l.outcome === "failed").map(l => [l.to, l.error])).toEqual([
			["Nobody", 'Unknown agent "Nobody"'],
			["Boom", "mailbox gone"],
		]);

		// Every leg has its own id, `<process tag>.<n>` counting up; its settled report repeats it.
		const starts = legs.filter(l => !l.outcome);
		expect(starts).toHaveLength(6);
		const tag = starts[0]!.id.split(".")[0];
		expect(starts.map(l => l.id)).toEqual(starts.map((_, i) => `${tag}.${Number(starts[0]!.id.split(".")[1]) + i}`));
		expect(new Set(legs.filter(l => l.outcome).map(l => l.id))).toEqual(new Set(starts.map(l => l.id)));

		// No leg for what is not a message; omp still gets it. A huge body is clipped for hostd only.
		legs.length = 0;
		await bus.send({ from: "Orch.A", body: "no recipient" });
		await bus.send(undefined);
		expect(legs).toEqual([]);
		expect(bus.sent).toHaveLength(8);
		const big = "x".repeat(256 * 1024 + 10);
		await bus.send({ from: "Orch.A", to: "Orch", body: big });
		expect(legs[0]!.body).toBe(`${"x".repeat(256 * 1024)}\n\n…`);
		expect(bus.sent.at(-1)![0].body).toBe(big);
	});

	test("one wrapper per process, whichever copy comes first; a report can never fail a send", async () => {
		const Bus = ircBusClass();
		expect(
			installIrcTap(Bus.prototype, () => {
				throw new Error("a copy's handler broke");
			}),
		).toBe(true);
		const wrapped = Bus.prototype.send;
		const second: IrcLeg[] = [];
		expect(installIrcTap(Bus.prototype, leg => second.push(leg))).toBe(true);
		expect(Bus.prototype.send).toBe(wrapped);
		expect(await new Bus().send({ from: "Main", to: "Orch", body: "go" })).toEqual({ to: "Orch", outcome: "injected" });
		expect(second).toEqual([]);
		// Nothing to wrap, or a bus omp froze: no tap (the flag stays off).
		expect(installIrcTap({}, () => {})).toBe(false);
		expect(installIrcTap(Object.freeze(ircBusClass().prototype), () => {})).toBe(false);
	});

	test("the owner copy sends hostd every leg as an `irc` event and announces caps.agentChat; subagent copies add nothing", async () => {
		const hostd = await startHostd();
		const bus = new (ircBusClass())();
		const runtimeOptions: Json[] = [];
		const omp = await bridged(hostd, { irc: bus, runtimeOptions });
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).agentChat).toBe(true);
		// A stand-in activity index: the runtime would build omp's own otherwise.
		expect(runtimeOptions).toEqual([{ activity: {} }]);
		// A copy in a subagent session finds the same bus: still one wrapper, one report per leg.
		const sub = fakeOmp({ sub: "Orch", registry: omp.registry, irc: bus, runtimeOptions });
		await teleflockBridge(sub.pi as never);
		sub.pi.fire("session_start", { type: "session_start" });
		await until(() => runtimeOptions.length === 2);
		await bus.send({ from: "Orch", to: "Main", body: "Plan: A owns the API.", broadcast: true });
		await bus.send({ from: "Orch", to: "Nobody", body: "anyone?" });
		// Control frames are ordered: the ping's res comes after every event before it.
		await request(hostd, "ping");
		const irc = hostd.lines.filter(l => l.t === "event" && l.event === "irc");
		expect(irc.map(l => [l.sessionId, (l.data as Json).to, (l.data as Json).outcome ?? null])).toEqual([
			["S1", "Main", null],
			["S1", "Main", "injected"],
			["S1", "Nobody", null],
			["S1", "Nobody", "failed"],
		]);
		expect(irc[1]!.data).toEqual({ ...(irc[0]!.data as Json), outcome: "injected" });
		expect(irc[1]!.data).toMatchObject({ from: "Orch", body: "Plan: A owns the API.", broadcast: true });
		expect(irc[3]!.data).toMatchObject({ error: 'Unknown agent "Nobody"' });
		expect(hostd.lines.filter(l => l.t === "hello")).toHaveLength(1);
	});

	test("an omp whose IRC bus is not found announces no agentChat (hostd reads the transcripts instead)", async () => {
		const hostd = await startHostd();
		await bridged(hostd);
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).agentChat).toBe(false);
	});
});
