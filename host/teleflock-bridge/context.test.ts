// Tests for the bridge's 2.1.0 context breakdown (docs/bridge-protocol.md "Context breakdown"): omp's
// overview attribution (`allocateTokens` / `allocateUsage`), the answer built from omp's viewer data,
// the estimate for an omp without that viewer, image counts, and the `context` op with its
// `caps.context` flag of the whole extension against a fake hostd socket with a fake omp.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import teleflockBridge, {
	allocateTokens,
	allocateUsage,
	type ContextCategoryLike,
	type ContextEntryLike,
	contextPreview,
	type ContextViewLike,
	countContextImages,
	estimateContextView,
	summarizeContextView,
} from "./teleflock-bridge";

type Json = Record<string, unknown>;
const SLOT = Symbol.for("teleflock.bridge");

const entry = (id: string, tokens: number, text = id, extra: Partial<ContextEntryLike> = {}): ContextEntryLike => ({ id, label: id, text, tokens, ...extra });
const category = (id: string, label: string, entries: ContextEntryLike[], extra: Partial<ContextCategoryLike> = {}): ContextCategoryLike => ({
	id,
	label,
	tokens: entries.reduce((sum, e) => sum + e.tokens, 0),
	entries,
	...extra,
});

/** omp-shaped viewer data (session/context-view `buildSessionContextView`). */
function ompView(): ContextViewLike {
	const bash = [entry("tool-output/4/4", 1500, "line one\n\n   line two", { label: "bash", callId: "c1", timestamp: 40 }), entry("tool-output/9/9", 90, "ok", { label: "bash", callId: "c3" })];
	const read = [entry("tool-output/6/6", 600, "file text", { label: "read", callId: "c2", timestamp: 60 })];
	const group = { id: "assistant-thinking/3/3", label: "Message 4", tokens: 300 };
	return {
		breakdown: { model: { name: "Lab Mock", id: "mock-1" }, contextWindow: 200_000, usedTokens: 23_117, autoCompactBufferTokens: 30_000, freeTokens: 146_883, thresholdTokens: 170_000, snapcompact: { savedTokens: 0 } },
		categories: [
			{ ...category("system-prompt", "System Prompt", [entry("system-prompt/0", 10_102, `You are a  coding\nagent ${"x".repeat(2000)}`), entry("system-prompt/1", 400)]), tokens: 10_256 },
			{ id: "skills", label: "Skills", tokens: 246, entries: [] },
			category("built-in-tools", "Built-in Tools", Array.from({ length: 8 }, (_, i) => entry(`built-in-tools/${i}`, 100 + i))),
			category("custom-tools", "Custom Tools", []),
			category("user-messages", "User / Developer Messages", [entry("user-messages/0/0", 40)]),
			category("assistant-messages", "Assistant Messages", [entry("assistant-messages/1/1/0", 120)]),
			{
				...category("assistant-thinking", "Assistant Thinking", [
					entry("assistant-thinking/3/3/0", 0, "first", { thinkingGroup: group }),
					entry("assistant-thinking/3/3/1", 0, "second", { thinkingGroup: group }),
					entry("assistant-thinking/5/5/0", 80, "solo"),
				]),
				tokens: 380,
			},
			category("tool-calls", "Tool Calls", [entry("tool-calls/1/1/1", 30, "{}", { label: "bash", callId: "c1" })]),
			{ ...category("tool-output", "Tool Output", [...bash, ...read]), children: [category("tool-output", "bash", bash), category("tool-output", "read", read)] },
		],
	};
}

describe("omp's overview attribution", () => {
	test("allocateTokens: largest remainder, ties to the earlier weight", () => {
		expect(allocateTokens([1, 1, 1], 10)).toEqual([4, 3, 3]);
		expect(allocateTokens([700, 300], 1001)).toEqual([701, 300]);
		expect(allocateTokens([5, 0, 5], 0)).toEqual([0, 0, 0]);
		expect(allocateTokens([0, 0], 100)).toBeUndefined();
		expect(allocateTokens([Number.NaN, 1], 100)).toBeUndefined();
	});

	test("allocateUsage: every category's share, then each one's children from it", () => {
		const bash = category("tool-output", "bash", [entry("b", 200)]);
		const read = category("tool-output", "read", [entry("r", 100)]);
		const out = { ...category("tool-output", "Tool Output", [entry("b", 200), entry("r", 100)]), children: [bash, read] };
		const sp = category("system-prompt", "System Prompt", [entry("s", 700)]);
		const a = allocateUsage([sp, out], 1001)!;
		expect([a.get(sp), a.get(out), a.get(bash), a.get(read)]).toEqual([701, 300, 200, 100]);
		expect(allocateUsage([category("x", "x", [])], 50)).toBeUndefined();
	});
});

describe("the context answer", () => {
	test("from omp's viewer data: the overview's numbers, labels and biggest entries", () => {
		const view = ompView();
		const x = summarizeContextView(view, { source: "omp", images: 2, dropImages: true, now: 7 }) as Json & { categories: Json[] };
		expect(x).toMatchObject({ source: "omp", model: "Lab Mock", window: 200_000, used: 23_117, buffer: 30_000, free: 146_883, threshold: 170_000, images: 2, dropImages: true, at: 7 });
		expect(x.snapcompactSaved).toBeUndefined();
		// in omp's order, labels as its overview shows them, shares adding up to what is used
		expect(x.categories.map(c => c.id)).toEqual(view.categories.map(c => c.id));
		expect(x.categories[0]!.label).toBe("System Prompt (excluding Skills)");
		expect(x.categories.reduce((sum, c) => sum + Number(c.tokens ?? 0), 0)).toBe(23_117);
		expect(x.categories[3]).toMatchObject({ id: "custom-tools", tokens: 0, weight: 0, entries: 0, children: [], top: [] });
		const tools = x.categories[2]!;
		expect((tools.top as Json[]).map(e => e.id)).toEqual(["built-in-tools/7", "built-in-tools/6", "built-in-tools/5", "built-in-tools/4", "built-in-tools/3"]);
		// system prompt preview: one line, clipped
		const sp = (x.categories[0]!.top as Json[])[0]!;
		expect(sp).toMatchObject({ id: "system-prompt/0", tokens: 10_102, chars: 2024 });
		expect(String(sp.preview).startsWith("You are a coding agent xxx")).toBe(true);
		expect(String(sp.preview).length).toBe(240);
		// thinking blocks of one message count once, with the message's weight
		const thinking = (x.categories[6]!.top as Json[]).map(e => [e.label, e.tokens]);
		expect(thinking).toEqual([
			["Thinking · Message 4", 300],
			["assistant-thinking/5/5/0", 80],
		]);
		// tool output: per tool, and the biggest outputs with their calls
		const out = x.categories[8]!;
		const children = out.children as Json[];
		expect(children.map(c => [c.label, c.weight, c.entries])).toEqual([
			["bash", 1590, 2],
			["read", 600, 1],
		]);
		expect(Number(children[0]!.tokens) + Number(children[1]!.tokens)).toBe(out.tokens);
		expect((out.top as Json[])[0]).toEqual({ id: "tool-output/4/4", label: "bash", tokens: 1500, preview: "line one line two", chars: 21, at: 40, callId: "c1", info: undefined });
	});

	test("omp's own attribution and labels win when this omp has them", () => {
		const view = ompView();
		const seen: number[] = [];
		const x = summarizeContextView(view, {
			source: "omp",
			images: 0,
			dropImages: false,
			modules: {
				allocate: (categories, usage) => {
					seen.push(usage);
					return new Map(categories.map(c => [c, 1]));
				},
				overviewLabel: c => `omp:${c.id}`,
			},
		}) as Json & { categories: Json[] };
		expect(seen).toEqual([23_117]);
		expect(x.categories[0]).toMatchObject({ label: "omp:system-prompt", tokens: 1 });
	});

	test("previews and image counts", () => {
		expect(contextPreview("  a\n\tb  ")).toBe("a b");
		expect(contextPreview("y".repeat(5000))).toBe(`${"y".repeat(239)}…`);
		const messages = [
			{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
			{ role: "toolResult", toolName: "read", content: [{ type: "image", data: "BB", mimeType: "image/jpeg" }] },
			{ role: "assistant", content: "plain" },
			null,
		];
		expect(countContextImages(messages)).toBe(2);
		expect(countContextImages(undefined)).toBe(0);
	});

	test("an estimate for an omp without the viewer: each part counted, the reported usage split by it", () => {
		const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
		const session = {
			model: { name: "Old", id: "old-1", contextWindow: 100_000 },
			systemPrompt: ["one two three four", "five six"],
			agent: {
				tokenizer: { countTokens: words },
				state: {
					tools: [
						{ name: "bash", description: "run it", parameters: {} },
						{ name: "lab_tool", description: "custom", parameters: {} },
					],
					messages: [
						{ role: "user", content: "fix the bug please", timestamp: 1 },
						{ role: "assistant", content: [{ type: "thinking", thinking: "hmm let me see" }, { type: "text", text: "on it" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], timestamp: 2 },
						{ role: "toolResult", toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "a b c d e f g h" }], timestamp: 3 },
						{ role: "bashExecution", command: "pwd", output: "/w", timestamp: 4 },
					],
				},
			},
			hasBuiltInTool: (name: string) => name !== "lab_tool",
		};
		const view = estimateContextView(session, { tokens: 1000, contextWindow: 120_000 });
		const weights = Object.fromEntries(view.categories.map(c => [c.id, c.tokens]));
		// tool definitions count as JSON (`{"name":"bash","description":"run it",…}` is two "words" here)
		expect(weights).toEqual({ "system-prompt": 6, skills: 0, "built-in-tools": 2, "custom-tools": 1, "user-messages": 4, "assistant-thinking": 4, "assistant-messages": 2, "tool-calls": 2, "tool-output": 9 });
		const out = view.categories.find(c => c.id === "tool-output")!;
		expect(out.children!.map(c => [c.label, c.tokens])).toEqual([
			["bash", 9],
		]);
		expect(view.breakdown).toMatchObject({ contextWindow: 120_000, usedTokens: 1000, autoCompactBufferTokens: 0, freeTokens: 119_000 });
		const x = summarizeContextView(view, { source: "estimate", images: 0, dropImages: false }) as Json & { categories: Json[] };
		expect(x.categories.reduce((sum, c) => sum + Number(c.tokens ?? 0), 0)).toBe(1000);
		expect((x.categories.find(c => c.id === "tool-output")!.top as Json[]).map(e => e.callId)).toEqual(["c1", undefined]);
		// no usage reported (after a compaction): the counted total, the model's window
		const bare = estimateContextView({ ...session, agent: { state: session.agent.state } }, { tokens: null });
		expect(bare.breakdown.contextWindow).toBe(100_000);
		expect(bare.breakdown.usedTokens).toBe(bare.categories.reduce((sum, c) => sum + c.tokens, 0));
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

/** Frames cross a real unix socket (the extension's own I/O), so the condition is polled. */
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-context-hostd-"));
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

/** A fake omp whose main AgentSession holds `messages`; `ns` is omp's root export namespace. */
async function bridgedOmp(hostd: FakeHostd, opts: { ns?: Json; registry?: boolean } = {}) {
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
	const session = {
		sessionManager: sm,
		model: { name: "Lab Mock", id: "mock-1", contextWindow: 200_000 },
		systemPrompt: ["you are a lab agent"],
		agent: { state: { tools: [], messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AA", mimeType: "image/png" }] }] } },
		subscribe: () => () => {},
		dropImages: async () => ({ removed: 1, tokensFreed: 10 }),
	};
	const main: Json = { id: "Main", kind: "main", status: "idle", session, sessionFile: "/tmp/S1.jsonl" };
	const ns: Json = { VERSION: "18.13.3", ...opts.ns };
	if (opts.registry !== false)
		ns.AgentRegistry = class {
			static global() {
				return { get: (id: string) => (id === "Main" ? main : undefined), list: () => [main], onChange: () => () => {} };
			}
		};
	const handlers = new Map<string, Array<(e: Json, c: object) => unknown>>();
	const ctx: Json = {
		mode: "rpc",
		hasUI: false,
		cwd: "/w",
		sessionManager: sm,
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		model: { provider: "mocklab", id: "mock-1", name: "Lab Mock", contextWindow: 200_000 },
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 900, contextWindow: 200_000, percent: 0.45 }),
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
	const fire = (name: string, event: Json) => (handlers.get(name) ?? []).map(fn => fn(event, ctx));
	await teleflockBridge(pi as never);
	fire("session_start", { type: "session_start" });
	cleanups.push(() => fire("session_shutdown", { type: "session_shutdown" }));
	await until(() => hostd.lines.some(l => l.t === "hello"), 10_000);
	return { session };
}

describe("context op against a fake hostd", () => {
	test("hello announces caps.context; the answer is omp's viewer data when omp has it", async () => {
		const hostd = await startHostd();
		const built: unknown[] = [];
		const { session } = await bridgedOmp(hostd, {
			ns: {
				buildSessionContextView: (s: unknown) => {
					built.push(s);
					return ompView();
				},
			},
		});
		expect((hostd.lines.find(l => l.t === "hello")!.caps as Json).context).toBe(true);
		const res = await hostd.request("context");
		expect(res.ok).toBe(true);
		expect(built).toEqual([session]); // omp's own AgentSession
		const x = res.result as Json & { categories: Json[] };
		expect(x).toMatchObject({ source: "omp", used: 23_117, window: 200_000, images: 1, dropImages: true });
		expect(x.categories).toHaveLength(9);
	}, 20_000);

	test("without omp's viewer: an estimate; without the AgentSession: the reported totals", async () => {
		const hostd = await startHostd();
		await bridgedOmp(hostd);
		const est = (await hostd.request("context")).result as Json & { categories: Json[] };
		expect(est).toMatchObject({ source: "estimate", used: 900, window: 200_000, buffer: 0, free: 199_100, images: 1, dropImages: true });
		expect(est.categories.reduce((sum, c) => sum + Number(c.tokens ?? 0), 0)).toBe(900);

		cleanups.splice(0).reverse().forEach(c => c());
		delete (globalThis as Record<symbol, unknown>)[SLOT];
		const bare = await startHostd();
		await bridgedOmp(bare, { registry: false });
		const usage = (await bare.request("context")).result as Json;
		expect(usage).toMatchObject({ source: "usage", model: "Lab Mock", window: 200_000, used: 900, free: 199_100, categories: [], images: 0, dropImages: false });
	}, 20_000);
});
