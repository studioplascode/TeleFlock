// TeleFlock companion extension for omp (architecture §4, protocol: docs/bridge-protocol.md).
//
// Loaded with `omp -e <this file>` (or installed into ~/.omp/agent/extensions/). It connects to the
// tf-hostd bridge socket and gives TeleFlock a structured control plane over the live TUI session:
// model, thinking, fast, plan, goal, compact, rename, follow-ups, tree/branch/fork/new session, plan
// review answers, btw side questions, export and handoff.
//
// Hard rule: this file must never take omp down. Every callback that can run outside omp's handler
// dispatch (socket callbacks, timers, promise chains) is wrapped, and timers go through `ctx.setInterval`.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	PlanReviewRequestedEvent,
} from "@oh-my-pi/pi-coding-agent";

const BRIDGE_VERSION = "1.0.0";
const PROTOCOL = 1;
const RETRY_MS = 5_000;
const TICK_MS = 1_000;
const SUBMIT_SETTLE_MS = 15_000;
const ATTACH_COMMAND = "teleflock-attach";
const STATUS_KEY = "teleflock";
const MAX_LINE = 64 * 1024 * 1024;

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type Params = Record<string, unknown>;

/** Error with a stable protocol code (see docs/bridge-protocol.md "Errors"). */
class BridgeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const fail = (code: string, message: string): never => {
	throw new BridgeError(code, message);
};

function str(p: Params, key: string, required: true): string;
function str(p: Params, key: string, required?: false): string | undefined;
function str(p: Params, key: string, required = false): string | undefined {
	const v = p[key];
	if (v === undefined || v === null) {
		if (required) fail("invalid_params", `missing "${key}"`);
		return undefined;
	}
	if (typeof v !== "string") return fail("invalid_params", `"${key}" must be a string`);
	if (required && !v.trim()) fail("invalid_params", `"${key}" must not be empty`);
	return v;
}

function bool(p: Params, key: string): boolean | undefined {
	const v = p[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "boolean") return fail("invalid_params", `"${key}" must be a boolean`);
	return v;
}

function num(p: Params, key: string): number | undefined {
	const v = p[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return fail("invalid_params", `"${key}" must be a non-negative number`);
	return Math.floor(v);
}

const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
};
const PLAN_CHOICES: Record<string, true> = { execute: true, compact: true, keep: true, refine: true, save: true };

interface GoalLike {
	objective: string;
	status?: unknown;
	tokensUsed?: unknown;
	tokenBudget?: unknown;
}
const isGoalLike = (g: unknown): g is GoalLike =>
	!!g && typeof g === "object" && "objective" in g && typeof g.objective === "string";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Where hostd listens. `TF_BRIDGE_SOCK` overrides (socket path or pipe name). Must match tf-hostd `Paths`. */
function bridgeEndpoint(): string {
	const explicit = process.env.TF_BRIDGE_SOCK;
	if (explicit) return explicit;
	const custom = process.env.TF_HOSTD_HOME;
	if (process.platform === "win32") {
		const raw = process.env.USERNAME || process.env.USER || "user";
		const user = raw.replace(/[^A-Za-z0-9_-]/g, "_");
		const suffix = custom ? `-${fnv1a(custom).toString(16).padStart(8, "0")}` : "";
		return `\\\\.\\pipe\\teleflock-bridge-${user}${suffix}`;
	}
	const home = custom || path.join(os.homedir(), ".teleflock");
	return path.join(home, "run", "bridge.sock");
}

/** FNV-1a over UTF-8 bytes, identical to tf-hostd `paths::fnv1a` (lab pipe-name suffix). */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (const b of Buffer.from(s, "utf8")) {
		h ^= b;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function ompVersion(pi: ExtensionAPI): string | null {
	try {
		const exports: Record<string, unknown> = pi.pi;
		const v = exports.VERSION;
		return typeof v === "string" ? v : null;
	} catch {
		return null;
	}
}

/** The unscoped base context: handler contexts are `Object.create(base)` with a handler-bound `ui`. */
function baseContext(ctx: ExtensionContext): ExtensionContext {
	let c: ExtensionContext = ctx;
	for (let i = 0; i < 4; i++) {
		const proto = Object.getPrototypeOf(c) as ExtensionContext | null;
		if (!proto || !Object.hasOwn(c, "ui") || !("ui" in proto)) break;
		c = proto;
	}
	return c;
}

// ─── TUI access ────────────────────────────────────────────────────────────────────────────────
// Selector-only and TUI-only commands (/plan, /goal, /fork, /handoff, /export, /fast, /queue) and the
// one-time command-context capture run through the composer's own submit handler, exactly as if the
// operator had pressed Enter, without touching the operator's draft.

type Component = { children?: unknown; render?: (width: number) => string[] } & Record<string, unknown>;
type MainEditor = Component & {
	onSubmit: (text: string) => unknown;
	getText(): string;
	setText(text: string): void;
	setDraft?: (text: string, images?: readonly unknown[]) => void;
	pendingImages: unknown[];
	pendingImageLinks?: unknown[];
};
type TuiLike = Component & { getFocused?: () => unknown; setFocus?: (c: unknown) => void };

const isMainEditor = (c: unknown): c is MainEditor =>
	!!c &&
	typeof c === "object" &&
	"onSubmit" in c &&
	typeof c.onSubmit === "function" &&
	"getText" in c &&
	typeof c.getText === "function" &&
	"setText" in c &&
	typeof c.setText === "function" &&
	"pendingImages" in c &&
	Array.isArray(c.pendingImages);

/** pi-tui's QueuedMessagesBand (the "Steering" / "After yield" chip above the composer). */
const isQueueBand = (c: unknown): c is Component =>
	!!c &&
	typeof c === "object" &&
	"onEdit" in c &&
	typeof c.onEdit === "function" &&
	"describe" in c &&
	typeof c.describe === "function" &&
	"render" in c &&
	typeof c.render === "function";

function walk(node: unknown, pred: (c: unknown) => boolean, depth = 0): Component | undefined {
	if (!node || typeof node !== "object" || depth > 16) return undefined;
	if (pred(node)) return node as Component;
	const kids = "children" in node ? node.children : undefined;
	if (!Array.isArray(kids)) return undefined;
	for (const k of kids) {
		const hit = walk(k, pred, depth + 1);
		if (hit) return hit;
	}
	return undefined;
}

interface CtlState {
	model?: { provider: string; id: string; label?: string };
	thinking?: string;
	fast: boolean;
	mode: "normal" | "plan" | "planPaused";
	goal?: { objective: string; status: string; tokensUsed?: number; budget?: number };
	title?: string;
	idle: boolean;
	context?: { tokens: number; window: number; pct: number };
	leafId?: string;
	queue: { steering: string[]; followUp: string[] };
	planReview?: ReviewInfo;
	attached: boolean;
}

interface ReviewInfo {
	reviewId: string;
	title: string | null;
	planPath: string | null;
	content: string;
	choices: Array<{ id: string; label: string; disabled: boolean }>;
	tiers: Array<{ role: string; provider: string; model: string; thinkingLevel: string | null }>;
}

interface TreeNodeOut {
	id: string;
	parentId: string | null;
	kind: "user" | "assistant" | "summary" | "compaction" | "other";
	label: string;
	at: number;
	onPath: boolean;
	children: number;
}

interface TreeInfo {
	nodes: TreeNodeOut[];
	leafId: string | null;
}

/** First text block of a message's content, or a placeholder for tool-call/image-only content. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let toolCall = false;
	let image = false;
	for (const b of content) {
		if (!b || typeof b !== "object" || !("type" in b)) continue;
		if (b.type === "text" && "text" in b && typeof b.text === "string") return b.text;
		if (b.type === "toolCall") toolCall = true;
		if (b.type === "image") image = true;
	}
	return toolCall ? "[tool calls]" : image ? "[image]" : "";
}

export default function teleflockBridge(pi: ExtensionAPI) {
	const endpoint = bridgeEndpoint();
	const bridgeLog = (msg: string) => {
		try {
			pi.logger.debug(`teleflock-bridge: ${msg}`);
		} catch {
			/* logging must never throw into omp */
		}
	};

	let ctxRef: ExtensionContext | undefined; // latest main-session context
	let cmdCtx: ExtensionCommandContext | undefined; // captured once through /teleflock-attach
	let attachWaiters: Array<() => void> = [];
	let active = false; // between session_start and session_shutdown
	let sock: net.Socket | undefined;
	let connected = false;
	let connecting = false;
	let nextRetryAt = 0;
	let tick: Timer | undefined;
	let helloSessionId: string | undefined;
	let lastStateJson = "";
	let lastQueueJson = "";
	let tuiRef: TuiLike | undefined;
	let editorRef: MainEditor | undefined;
	let goalFromEvent: CtlState["goal"] | null | undefined; // undefined = derive from entries
	let pendingReview: ReviewInfo | undefined;
	const btws = new Map<string, AbortController>();
	let btwSeq = 0;
	let statusShown: boolean | undefined;

	// ─── wire ─────────────────────────────────────────────────────────────────────────────────
	const send = (obj: Record<string, unknown>): void => {
		if (!sock || !connected) return;
		try {
			sock.write(`${JSON.stringify(obj)}\n`);
		} catch (err) {
			bridgeLog(`write failed: ${String(err)}`);
		}
	};

	const sessionId = (): string | undefined => {
		try {
			return ctxRef?.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	};

	const emit = (event: string, data: unknown): void => {
		const sid = helloSessionId ?? sessionId();
		if (!sid) return;
		send({ t: "event", event, sessionId: sid, data });
	};

	const showStatus = (on: boolean): void => {
		if (statusShown === on) return;
		statusShown = on;
		try {
			const ui = ctxRef?.ui;
			if (!ui) return;
			ui.setStatus(STATUS_KEY, on ? ui.theme.fg("dim", "⇄ teleflock") : undefined);
		} catch {
			/* status line is cosmetic */
		}
	};

	// ─── state ────────────────────────────────────────────────────────────────────────────────
	const readMode = (ctx: ExtensionContext): { mode: CtlState["mode"]; goal?: CtlState["goal"] } => {
		let mode: CtlState["mode"] = "normal";
		let goal: CtlState["goal"];
		let seenPlan = false;
		let seenGoal = false;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0 && !(seenPlan && seenGoal); i--) {
			const e = branch[i];
			if (e?.type !== "mode_change") continue;
			const m = e.mode;
			if (!seenPlan && (m === "plan" || m === "plan_paused" || m === "none")) {
				seenPlan = true;
				mode = m === "plan" ? "plan" : m === "plan_paused" ? "planPaused" : "normal";
			}
			if (!seenGoal && (m === "goal" || m === "none")) {
				seenGoal = true;
				const g = e.data?.goal;
				if (m === "goal" && isGoalLike(g)) goal = toGoal(g);
			}
		}
		return { mode, goal };
	};

	const toGoal = (g: GoalLike): CtlState["goal"] => {
		const status = typeof g.status === "string" ? g.status : "active";
		if (status === "complete" || status === "dropped") return undefined;
		return {
			objective: g.objective,
			status,
			tokensUsed: typeof g.tokensUsed === "number" ? g.tokensUsed : undefined,
			budget: typeof g.tokenBudget === "number" ? g.tokenBudget : undefined,
		};
	};

	const readFast = (): boolean => {
		const tiers = pi.getServiceTiers() as Record<string, string | undefined>;
		return Object.values(tiers).some(t => t === "priority" || t === "ultrafast");
	};

	const readQueue = (): CtlState["queue"] => {
		const queue = { steering: [] as string[], followUp: [] as string[] };
		const band = tuiRef ? walk(tuiRef, isQueueBand) : undefined;
		if (!band?.render) return queue;
		let group: string[] | undefined;
		for (const raw of band.render(4000)) {
			const line = raw.replace(ANSI, "");
			const head = /^\s*(Steering|After yield)\b/.exec(line);
			if (head) {
				group = head[1] === "Steering" ? queue.steering : queue.followUp;
				continue;
			}
			const item = /^\s*\d+\.\s(.*?)\s*$/.exec(line);
			if (item && group) group.push(item[1]);
		}
		return queue;
	};

	const readState = (ctx: ExtensionContext): CtlState => {
		const model = ctx.model;
		const { mode, goal } = readMode(ctx);
		const usage = ctx.getContextUsage();
		const thinking = pi.getThinkingLevel();
		return {
			model: model ? { provider: model.provider, id: model.id, label: model.name || undefined } : undefined,
			thinking: thinking ?? undefined,
			fast: readFast(),
			mode,
			goal: goalFromEvent === undefined ? goal : (goalFromEvent ?? undefined),
			title: pi.getSessionName() || undefined,
			idle: ctx.isIdle(),
			context:
				usage && typeof usage.tokens === "number" && typeof usage.contextWindow === "number"
					? {
							tokens: usage.tokens,
							window: usage.contextWindow,
							pct: typeof usage.percent === "number" ? usage.percent : 0,
						}
					: undefined,
			leafId: ctx.sessionManager.getLeafId() ?? undefined,
			queue: readQueue(),
			planReview: pendingReview,
			attached: cmdCtx !== undefined,
		};
	};

	const reviewInfo = (ev: PlanReviewRequestedEvent): ReviewInfo => ({
		reviewId: ev.reviewId,
		title: ev.title || null,
		planPath: ev.planFilePath || null,
		content: ev.planContent ?? "",
		choices: (ev.options ?? []).map(o => ({ id: o.id, label: o.label, disabled: o.disabled === true })),
		tiers: (ev.tiers ?? []).map(t => ({
			role: t.role,
			provider: t.provider,
			model: t.model,
			thinkingLevel: t.thinkingLevel ?? null,
		})),
	});

	const helloPayload = (ctx: ExtensionContext, reason: "connect" | "switch", previous?: string) => {
		const sm = ctx.sessionManager;
		return {
			t: "hello",
			v: PROTOCOL,
			reason,
			previousSessionId: previous ?? null,
			pid: process.pid,
			sessionId: sm.getSessionId(),
			sessionFile: sm.getSessionFile() ?? null,
			cwd: ctx.cwd,
			ompVersion: ompVersion(pi),
			bridgeVersion: BRIDGE_VERSION,
			tui: ctx.mode === "tui",
			state: readState(ctx),
		};
	};

	const sendHello = (reason: "connect" | "switch", previous?: string): void => {
		const ctx = ctxRef;
		if (!ctx || !connected) return;
		try {
			const hello = helloPayload(ctx, reason, previous);
			helloSessionId = hello.sessionId;
			lastStateJson = JSON.stringify(hello.state);
			lastQueueJson = JSON.stringify(hello.state.queue);
			send(hello);
		} catch (err) {
			bridgeLog(`hello failed: ${String(err)}`);
		}
	};

	/** Push state/queue deltas and re-hello on a session change. Runs on every tick and after events. */
	const sync = (): void => {
		const ctx = ctxRef;
		if (!ctx || !connected) return;
		const sid = sessionId();
		if (sid && helloSessionId && sid !== helloSessionId) {
			const prev = helloSessionId;
			goalFromEvent = undefined;
			sendHello("switch", prev);
			return;
		}
		const state = readState(ctx);
		const queueJson = JSON.stringify(state.queue);
		if (queueJson !== lastQueueJson) {
			lastQueueJson = queueJson;
			emit("queue_update", state.queue);
		}
		const stateJson = JSON.stringify(state);
		if (stateJson !== lastStateJson) {
			lastStateJson = stateJson;
			emit("state", state);
		}
	};

	const safeSync = (): void => {
		try {
			sync();
		} catch (err) {
			bridgeLog(`sync failed: ${String(err)}`);
		}
	};

	// ─── connection ───────────────────────────────────────────────────────────────────────────
	const dropSocket = (): void => {
		const s = sock;
		sock = undefined;
		connected = false;
		connecting = false;
		helloSessionId = undefined;
		for (const ac of btws.values()) ac.abort(new Error("bridge disconnected"));
		btws.clear();
		if (s) {
			try {
				s.destroy();
			} catch {
				/* already gone */
			}
		}
		showStatus(false);
	};

	const connect = (): void => {
		if (connecting || connected || !active) return;
		if (process.platform !== "win32" && !fs.existsSync(endpoint)) {
			nextRetryAt = Date.now() + RETRY_MS;
			return;
		}
		connecting = true;
		let s: net.Socket;
		try {
			s = net.createConnection(endpoint);
		} catch (err) {
			connecting = false;
			nextRetryAt = Date.now() + RETRY_MS;
			bridgeLog(`connect threw: ${String(err)}`);
			return;
		}
		sock = s;
		let buf = "";
		s.setEncoding("utf8");
		s.on("connect", () => {
			try {
				if (sock !== s) return;
				connecting = false;
				connected = true;
				showStatus(true);
				sendHello("connect");
			} catch (err) {
				bridgeLog(`on connect: ${String(err)}`);
			}
		});
		s.on("data", (chunk: string) => {
			try {
				buf += chunk;
				if (buf.length > MAX_LINE) {
					bridgeLog("oversized frame; reconnecting");
					dropSocket();
					nextRetryAt = Date.now() + RETRY_MS;
					return;
				}
				let i = buf.indexOf("\n");
				while (i >= 0) {
					const line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					i = buf.indexOf("\n");
					if (!line.trim()) continue;
					try {
						onLine(line);
					} catch (err) {
						bridgeLog(`bad frame: ${String(err)}`);
					}
				}
			} catch (err) {
				bridgeLog(`on data: ${String(err)}`);
			}
		});
		const onGone = (why: unknown) => {
			try {
				if (sock !== s) return;
				bridgeLog(`socket closed: ${String(why ?? "eof")}`);
				dropSocket();
				nextRetryAt = Date.now() + RETRY_MS;
			} catch {
				/* never throw from socket callbacks */
			}
		};
		s.on("error", onGone);
		s.on("close", () => onGone(undefined));
		s.unref();
	};

	const onTick = (): void => {
		try {
			if (!active) return;
			if (!connected) {
				if (!connecting && Date.now() >= nextRetryAt) connect();
				return;
			}
			sync();
		} catch (err) {
			bridgeLog(`tick: ${String(err)}`);
		}
	};

	const startTicking = (ctx: ExtensionContext): void => {
		if (tick !== undefined) {
			try {
				ctx.clearTimer(tick);
			} catch {
				/* stale handle */
			}
		}
		tick = ctx.setInterval(onTick, TICK_MS);
	};

	// ─── requests ─────────────────────────────────────────────────────────────────────────────
	const onLine = (line: string): void => {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			bridgeLog("bad json from hostd");
			return;
		}
		// `welcome`, non-objects and unknown frame types are ignored.
		if (!raw || typeof raw !== "object" || !("t" in raw) || raw.t !== "req") return;
		const id = "id" in raw ? raw.id : undefined;
		const op = "op" in raw && typeof raw.op === "string" ? raw.op : "";
		const rawParams = "params" in raw ? raw.params : undefined;
		const params: Params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams) ? { ...rawParams } : {};
		Promise.resolve()
			.then(() => handle(op, params))
			.then(
				result => {
					send({ t: "res", id, ok: true, result: result ?? {} });
					safeSync();
				},
				(err: unknown) => {
					const code = err instanceof BridgeError ? err.code : "omp_error";
					const message = err instanceof Error ? err.message : String(err);
					send({ t: "res", id, ok: false, error: { code, message } });
					safeSync();
				},
			)
			.catch(() => {
				/* send() never throws, but stay defensive */
			});
	};

	const requireTui = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") fail("unsupported", `needs the interactive TUI (mode is ${ctx.mode})`);
	};

	/** Locate the TUI and its main composer. The first call borrows `ui.custom()` for one tick to get the TUI. */
	const findEditor = async (ctx: ExtensionContext): Promise<MainEditor> => {
		requireTui(ctx);
		if (!tuiRef) {
			const ui = baseContext(ctx).ui;
			await ui.custom<undefined>((tui, _theme, _keys, done) => {
				// Structural view of pi-tui's TUI: only getFocused/setFocus/children are used.
				const t = tui as unknown as TuiLike;
				tuiRef = t;
				const before = t.getFocused?.();
				done(undefined); // closes immediately: cleanup focuses the main editor
				const after = t.getFocused?.();
				if (isMainEditor(after)) editorRef = after;
				if (before && before !== after) t.setFocus?.(before);
				return { render: () => [], invalidate: () => {}, handleInput: () => {} } as never;
			});
		}
		const live = tuiRef ? walk(tuiRef, isMainEditor) : undefined;
		if (live && isMainEditor(live)) editorRef = live;
		return editorRef ?? fail("unsupported", "could not locate the TUI composer");
	};

	/**
	 * Submit `text` through the composer's Enter handler. The operator's draft (text + pasted images) is
	 * kept out of the submission and restored if the command cleared it. Resolves once the command
	 * finished, or after SUBMIT_SETTLE_MS when it is waiting on a TUI dialog (`settled: false`).
	 */
	const submit = async (ctx: ExtensionContext, text: string): Promise<{ settled: boolean }> => {
		const ed = await findEditor(ctx);
		const draft = ed.getText();
		const images = ed.pendingImages;
		const links = ed.pendingImageLinks;
		ed.pendingImages = [];
		if (Array.isArray(links)) ed.pendingImageLinks = [];
		let run: Promise<unknown>;
		try {
			run = Promise.resolve(ed.onSubmit(text));
		} finally {
			// onSubmit reads the attachments synchronously; give them straight back.
			if (ed.pendingImages.length === 0) ed.pendingImages = images;
			if (Array.isArray(links) && (ed.pendingImageLinks?.length ?? 0) === 0) ed.pendingImageLinks = links;
		}
		const restore = () => {
			try {
				const lostText = draft !== "" && ed.getText() === "";
				const lostImages = images.length > 0 && ed.pendingImages.length === 0;
				if (!lostText && !lostImages) return;
				if (ed.setDraft) ed.setDraft(lostText ? draft : ed.getText(), images);
				else if (lostText) ed.setText(draft);
			} catch {
				/* best effort */
			}
		};
		let timer: Timer | undefined;
		const settled = await Promise.race([
			run.then(
				() => true,
				(err: unknown) => {
					throw new BridgeError("omp_error", err instanceof Error ? err.message : String(err));
				},
			),
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(false), SUBMIT_SETTLE_MS);
				timer.unref?.();
			}),
		]).finally(() => {
			clearTimeout(timer);
			restore();
		});
		if (!settled) {
			run.then(restore, restore).catch(() => {});
		}
		return { settled };
	};

	/** Command context for navigateTree/branch/newSession; captured once by submitting /teleflock-attach. */
	const ensureCmdCtx = async (ctx: ExtensionContext): Promise<ExtensionCommandContext> => {
		if (cmdCtx) return cmdCtx;
		requireTui(ctx);
		const got = new Promise<void>(resolve => attachWaiters.push(resolve));
		await submit(ctx, `/${ATTACH_COMMAND}`);
		let timer: Timer | undefined;
		await Promise.race([
			got,
			new Promise<void>(resolve => {
				timer = setTimeout(resolve, 5_000);
				timer.unref?.();
			}),
		]).finally(() => clearTimeout(timer));
		return cmdCtx ?? fail("unsupported", "could not capture the session command context");
	};

	const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (pred()) return true;
			await new Promise<void>(r => {
				const t = setTimeout(r, 100);
				t.unref?.();
			});
		}
		return pred();
	};

	const requireIdle = (ctx: ExtensionContext, what: string): void => {
		if (!ctx.isIdle()) fail("busy", `${what} needs the agent to be idle`);
	};

	const treeInfo = (ctx: ExtensionContext): TreeInfo => {
		const sm = ctx.sessionManager;
		const entries = sm.getEntries();
		const parentOf = new Map<string, string | null>();
		for (const e of entries) parentOf.set(e.id, e.parentId);
		// Only conversational entries are tree nodes; housekeeping entries (model/thinking/title changes,
		// custom state) collapse into their nearest conversational ancestor.
		const kinds = new Map<string, TreeNodeOut["kind"]>();
		for (const e of entries) {
			if (e.type === "message") {
				const role = e.message.role;
				if (role === "user" || role === "assistant") kinds.set(e.id, role);
			} else if (e.type === "branch_summary") kinds.set(e.id, "summary");
			else if (e.type === "compaction") kinds.set(e.id, "compaction");
			else if (e.type === "custom_message") kinds.set(e.id, "other");
		}
		const nearestIncluded = (start: string | null): string | null => {
			let cur = start;
			for (let guard = 0; cur && guard < 1_000_000; guard++) {
				if (kinds.has(cur)) return cur;
				cur = parentOf.get(cur) ?? null;
			}
			return null;
		};
		const leafId = sm.getLeafId() ?? null;
		const onPath = new Set<string>();
		for (let cur = leafId, guard = 0; cur && guard < 1_000_000; guard++) {
			onPath.add(cur);
			cur = parentOf.get(cur) ?? null;
		}
		const nodes: TreeNodeOut[] = [];
		const childCount = new Map<string, number>();
		for (const e of entries) {
			const kind = kinds.get(e.id);
			if (!kind) continue;
			const parentId = nearestIncluded(e.parentId);
			if (parentId) childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
			let text = "";
			if (e.type === "message") text = contentText(e.message.content);
			else if (e.type === "branch_summary" || e.type === "compaction") text = e.summary;
			else if (e.type === "custom_message") text = contentText(e.content) || e.customType;
			text = text.replace(/\s+/g, " ").trim();
			const ts = Date.parse(e.timestamp);
			nodes.push({
				id: e.id,
				parentId,
				kind,
				label: (text.length > 120 ? `${text.slice(0, 119)}…` : text) || e.type,
				at: Number.isFinite(ts) ? ts : 0,
				onPath: onPath.has(e.id),
				children: 0,
			});
		}
		for (const n of nodes) n.children = childCount.get(n.id) ?? 0;
		return { nodes, leafId: nearestIncluded(leafId) };
	};

	async function handle(op: string, p: Params): Promise<unknown> {
		const ctx = ctxRef ?? fail("not_ready", "session not initialised yet");
		switch (op) {
			case "ping":
				return { pong: Date.now() };
			case "getState":
				return readState(ctx);
			case "setModel": {
				const spec = str(p, "model", true);
				const thinking = str(p, "thinking");
				if (thinking !== undefined && !THINKING_LEVELS[thinking]) fail("invalid_params", `unknown thinking level ${thinking}`);
				const model = ctx.models.resolve(spec);
				if (!model) fail("not_found", `unknown model ${spec}`);
				if (!(await pi.setModel(model!))) fail("auth_required", `no credentials for ${model!.provider}/${model!.id}`);
				if (thinking) pi.setThinkingLevel(thinking as ThinkingLevel);
				return readState(ctx);
			}
			case "setThinking": {
				const level = str(p, "level", true);
				if (!THINKING_LEVELS[level]) fail("invalid_params", `unknown thinking level ${level}`);
				pi.setThinkingLevel(level as ThinkingLevel);
				return readState(ctx);
			}
			case "setFast": {
				const on = bool(p, "on") ?? fail("invalid_params", 'missing "on"');
				if (ctx.mode === "tui") {
					await submit(ctx, on ? "/fast on" : "/fast off");
				} else {
					const provider = ctx.model?.provider ?? "openai";
					const family = provider.startsWith("openai") ? "openai" : provider.startsWith("google") ? "google" : provider;
					pi.setServiceTier(family as never, (on ? "priority" : undefined) as never);
				}
				const ok = await waitFor(() => readFast() === on, 2_000);
				if (!ok) fail("unsupported", `fast mode is not available for ${ctx.model?.provider ?? "this model"}`);
				return readState(ctx);
			}
			case "setPlan": {
				const on = bool(p, "on") ?? fail("invalid_params", 'missing "on"');
				requireTui(ctx);
				// /plan cycles normal → plan → planPaused → normal; walk it to the target (≤ 2 steps).
				const target = on ? "plan" : "normal";
				for (let step = 0; step < 3 && readMode(ctx).mode !== target; step++) {
					const before = readMode(ctx).mode;
					const { settled } = await submit(ctx, "/plan");
					if (!settled) fail("busy", "plan mode is waiting for a confirmation in the terminal");
					if (readMode(ctx).mode === before) break; // refused (goal/vibe mode active, plan disabled)
				}
				const { mode } = readMode(ctx);
				if (mode !== target)
					fail(on ? "unsupported" : "busy", on ? "plan mode did not turn on (goal/vibe mode active, or plan.enabled is off)" : "plan mode did not turn off");
				return readState(ctx);
			}
			case "goal": {
				requireTui(ctx);
				const goalOp = str(p, "op", true);
				const objective = str(p, "objective");
				const budget = num(p, "budget");
				switch (goalOp) {
					case "set":
						if (!objective?.trim()) fail("invalid_params", 'goal "set" needs an objective');
						await submit(ctx, `/goal set ${objective!.replace(/\s*\r?\n\s*/g, " ").trim()}`);
						if (budget !== undefined) await submit(ctx, `/goal budget ${budget}`);
						break;
					case "pause":
					case "resume":
					case "drop":
						await submit(ctx, `/goal ${goalOp}`);
						break;
					case "budget":
						await submit(ctx, `/goal budget ${budget === undefined ? "off" : budget}`);
						break;
					default:
						fail("invalid_params", `unknown goal op ${goalOp}`);
				}
				return {};
			}
			case "compact": {
				const instructions = str(p, "instructions")?.trim();
				// In the TUI, ctx.compact reports failures on screen and resolves; detect them through
				// onError (no focus text) and by checking that a compaction entry was actually written.
				const compactions = () => ctx.sessionManager.getEntries().filter(e => e.type === "compaction").length;
				const before = compactions();
				let failure: string | undefined;
				try {
					if (instructions) await ctx.compact(instructions);
					else await ctx.compact({ onError: err => (failure = err.message) });
				} catch (err) {
					failure = err instanceof Error ? err.message : String(err);
				}
				if (failure === undefined && compactions() > before) return {};
				failure ??= "Nothing to compact";
				return fail(/nothing to compact|already compacted/i.test(failure) ? "nothing_to_compact" : "omp_error", failure);
			}
			case "rename": {
				const title = str(p, "title", true).trim();
				await pi.setSessionName(title);
				return { title: pi.getSessionName() ?? title };
			}
			case "followUp": {
				const text = str(p, "text", true);
				if (ctx.mode === "tui") {
					// TUI queue: shows in the "After yield" chip and survives Esc (restored to the composer).
					await submit(ctx, `/queue ${text}`);
				} else {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
				}
				return readQueue();
			}
			case "navigateTree": {
				const entryId = str(p, "entryId", true);
				if (!ctx.sessionManager.getEntry(entryId)) fail("not_found", `no entry ${entryId}`);
				const c = await ensureCmdCtx(ctx);
				const r = await c.navigateTree(entryId, { summarize: bool(p, "summarize") ?? false });
				if (r.cancelled) fail("cancelled", "navigation was cancelled");
				return { leafId: ctx.sessionManager.getLeafId() ?? null };
			}
			case "branch": {
				const entryId = str(p, "entryId", true);
				if (!ctx.sessionManager.getEntry(entryId)) fail("not_found", `no entry ${entryId}`);
				const c = await ensureCmdCtx(ctx);
				const r = await c.branch(entryId);
				if (r.cancelled) fail("cancelled", "branch was cancelled");
				return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null };
			}
			case "fork": {
				requireTui(ctx);
				requireIdle(ctx, "fork");
				const entryId = str(p, "entryId");
				const placement = str(p, "placement") ?? "inPlace";
				if (placement !== "inPlace" && placement !== "pane") fail("invalid_params", `unknown placement ${placement}`);
				if (entryId) {
					if (!ctx.sessionManager.getEntry(entryId)) fail("not_found", `no entry ${entryId}`);
					const c = await ensureCmdCtx(ctx);
					const r = await c.navigateTree(entryId, { summarize: false });
					if (r.cancelled) fail("cancelled", "navigation was cancelled");
				}
				const before = ctx.sessionManager.getSessionId();
				await submit(ctx, placement === "pane" ? "/fork pane" : "/fork");
				if (placement === "inPlace" && !(await waitFor(() => ctx.sessionManager.getSessionId() !== before, 5_000)))
					fail("omp_error", "fork did not switch sessions");
				return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null };
			}
			case "newSession": {
				const c = await ensureCmdCtx(ctx);
				const r = await c.newSession();
				if (r.cancelled) fail("cancelled", "new session was cancelled");
				return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null };
			}
			case "resolvePlanReview": {
				const reviewId = str(p, "reviewId", true);
				const choice = str(p, "choice", true);
				if (!PLAN_CHOICES[choice]) fail("invalid_params", `unknown choice ${choice}`);
				const feedback = str(p, "feedback");
				const role = str(p, "role");
				const input: { feedback?: string; role?: string } = {};
				if (feedback !== undefined) input.feedback = feedback;
				if (role !== undefined) input.role = role;
				const ok = ctx.resolvePlanReview(reviewId, choice as never, Object.keys(input).length ? input : undefined);
				if (!ok) fail("not_found", "plan review is not open, or the choice/role/feedback is invalid");
				return {};
			}
			case "btw": {
				const question = str(p, "question", true);
				const run = ctx.runEphemeralTurn ?? fail("unsupported", "this omp has no ephemeral side turns");
				const btwId = `btw-${process.pid}-${Date.now().toString(36)}-${(++btwSeq).toString(36)}`;
				const ac = new AbortController();
				btws.set(btwId, ac);
				const sid = sessionId();
				const emitBtw = (data: Record<string, unknown>) => {
					if (sid) send({ t: "event", event: "btw_delta", sessionId: sid, data: { btwId, ...data } });
				};
				Promise.resolve()
					.then(() =>
						run.call(ctx, {
							promptText: question,
							signal: ac.signal,
							onTextDelta: (delta: string) => emitBtw({ text: delta, done: false }),
						}),
					)
					.then(
						res => emitBtw({ text: res.replyText, done: true }),
						(err: unknown) =>
							emitBtw({ text: "", done: true, error: err instanceof Error ? err.message : String(err) }),
					)
					.catch(() => {})
					.finally(() => btws.delete(btwId));
				return { btwId };
			}
			case "btwCancel": {
				const btwId = str(p, "btwId", true);
				const ac = btws.get(btwId) ?? fail("not_found", `no running btw ${btwId}`);
				ac.abort(new Error("cancelled"));
				return {};
			}
			case "export": {
				requireTui(ctx);
				let out = str(p, "path");
				if (!out) {
					let dir: string | undefined;
					try {
						dir = ctx.sessionManager.getArtifactsDir() ?? undefined;
					} catch {
						dir = undefined;
					}
					dir = dir || os.tmpdir();
					out = path.join(dir, `teleflock-export-${ctx.sessionManager.getSessionId()}-${Date.now()}.html`);
				}
				if (/\s/.test(out)) fail("invalid_params", "export path must not contain whitespace");
				fs.mkdirSync(path.dirname(out), { recursive: true });
				const since = Date.now() - 1_000;
				await submit(ctx, `/export ${out}`);
				const ok = await waitFor(() => {
					try {
						return fs.statSync(out!).mtimeMs >= since;
					} catch {
						return false;
					}
				}, 15_000);
				if (!ok) fail("omp_error", `export did not produce ${out}`);
				return { path: out };
			}
			case "handoff": {
				requireTui(ctx);
				requireIdle(ctx, "handoff");
				const focus = str(p, "focus");
				const { settled } = await submit(ctx, focus?.trim() ? `/handoff ${focus.replace(/\s*\r?\n\s*/g, " ").trim()}` : "/handoff");
				return { settled };
			}
			case "slash": {
				const command = str(p, "command", true).trim();
				if (!command.startsWith("/")) fail("invalid_params", "command must start with /");
				if (/\r|\n/.test(command)) fail("invalid_params", "command must be a single line");
				const { settled } = await submit(ctx, command);
				return { settled };
			}
			case "abort":
				ctx.abort();
				return {};
			case "getTree":
				return treeInfo(ctx);
			case "getQueue":
				return readQueue();
			default:
				return fail("unknown_op", `unknown op ${op}`);
		}
	}

	// ─── omp wiring ───────────────────────────────────────────────────────────────────────────
	pi.registerCommand(ATTACH_COMMAND, {
		description: "TeleFlock: enable remote session control (run automatically by the bridge)",
		handler: async (_args, ctx) => {
			try {
				cmdCtx = ctx;
				const waiters = attachWaiters;
				attachWaiters = [];
				for (const w of waiters) w();
			} catch (err) {
				bridgeLog(`attach: ${String(err)}`);
			}
		},
	});

	const adopt = (ctx: ExtensionContext): boolean => {
		try {
			// Each session (main and every subagent) gets its own binding of this factory; bridge only main.
			if (ctx.agent && ctx.agent.kind !== "main") return false;
			ctxRef = ctx;
			return true;
		} catch {
			return false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			if (!adopt(ctx)) return;
			active = true;
			goalFromEvent = undefined;
			try {
				const pending = ctx.getPendingPlanReview();
				pendingReview = pending ? reviewInfo(pending) : undefined;
			} catch {
				pendingReview = undefined;
			}
			startTicking(ctx);
			connect();
		} catch (err) {
			bridgeLog(`session_start: ${String(err)}`);
		}
	});

	const onSessionChange = (ctx: ExtensionContext) => {
		try {
			if (!adopt(ctx)) return;
			active = true;
			goalFromEvent = undefined;
			startTicking(ctx);
			if (connected) safeSync();
			else connect();
		} catch (err) {
			bridgeLog(`session change: ${String(err)}`);
		}
	};
	pi.on("session_switch", (_event, ctx) => onSessionChange(ctx));
	pi.on("session_branch", (_event, ctx) => onSessionChange(ctx));
	pi.on("session_tree", (_event, ctx) => onSessionChange(ctx));
	pi.on("session_compact", (_event, ctx) => onSessionChange(ctx));

	for (const ev of ["agent_start", "agent_end", "turn_end", "input"] as const) {
		pi.on(ev as "agent_start", (_event, ctx) => {
			try {
				if (adopt(ctx) && connected) ctx.setTimeout(safeSync, 0);
			} catch {
				/* ignore */
			}
		});
	}

	pi.on("goal_updated", (event, ctx) => {
		try {
			if (!adopt(ctx)) return;
			goalFromEvent = isGoalLike(event.goal) ? (toGoal(event.goal) ?? null) : null;
			safeSync();
		} catch (err) {
			bridgeLog(`goal_updated: ${String(err)}`);
		}
	});

	pi.on("plan_review_requested", (event, ctx) => {
		try {
			if (!adopt(ctx)) return;
			pendingReview = reviewInfo(event);
			emit("plan_review_requested", pendingReview);
			safeSync();
		} catch (err) {
			bridgeLog(`plan_review_requested: ${String(err)}`);
		}
	});

	pi.on("plan_review_resolved", (event, ctx) => {
		try {
			if (!adopt(ctx)) return;
			if (pendingReview?.reviewId === event.reviewId) pendingReview = undefined;
			emit("plan_review_resolved", { reviewId: event.reviewId, choice: event.choice ?? null, by: event.by });
			safeSync();
		} catch (err) {
			bridgeLog(`plan_review_resolved: ${String(err)}`);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			if (ctx.agent && ctx.agent.kind !== "main") return;
			active = false;
			if (tick !== undefined) {
				try {
					ctx.clearTimer(tick);
				} catch {
					/* already cleared */
				}
				tick = undefined;
			}
			send({ t: "bye", sessionId: helloSessionId ?? sessionId() ?? null });
			if (sock) {
				try {
					sock.end();
				} catch {
					/* closing anyway */
				}
			}
			dropSocket();
		} catch (err) {
			bridgeLog(`session_shutdown: ${String(err)}`);
		}
	});
}
