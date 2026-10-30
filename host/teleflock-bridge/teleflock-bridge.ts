// TeleFlock companion extension for omp (architecture §4, protocol: docs/bridge-protocol.md).
//
// Loaded with `omp -e <this file>` (or installed into ~/.omp/agent/extensions/). It connects to the
// tf-hostd bridge socket and gives TeleFlock a structured control plane over the live TUI session:
// model, thinking, fast, plan, goal, compact, rename, follow-ups, tree/branch/fork/new session, plan
// review answers, btw side questions, export and handoff. Since 2.0.0 it is also the session's data
// plane: a live feed shaped like omp's collab host→guest frames, prompts with images, the session's
// dialogs (ask, approvals, selects, editors) answerable from TeleFlock, and subagent control.
//
// Hard rule: this file must never take omp down. Every callback that can run outside omp's handler
// dispatch (socket callbacks, timers, promise chains, session listeners, dialog wrappers) is wrapped,
// and the ticker goes through `ctx.setInterval`.
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	PlanReviewRequestedEvent,
} from "@oh-my-pi/pi-coding-agent";

/** 1.1.0: `btw` runs omp's own /btw (follow-ups via `btwId`), `getBtwHistory`.
 *  1.2.0: schema-dump mode (`TF_OMP_SCHEMA_OUT`, used by tf-hostd `omp.settings`).
 *  1.3.0: settings-write mode (`TF_OMP_SETTINGS_IN`, used by tf-hostd `omp.settingsSet` for credentials).
 *  1.4.0: one bridge per omp process (`BridgeSlot`): only the newest copy talks to hostd; the
 *         command context (now captured through /teleflock-control) is shared; attaching fails fast
 *         while omp compacts.
 *  2.0.0: data plane (`hello.caps`): `liveSubscribe` live feed + `resync`, `prompt`, `uiResponse`
 *         (the session's dialogs race the TUI against hostd), `agentCmd`; subagent copies relay their
 *         task bus to the owner.
 *  2.1.0: new `hello.caps` flags, each with its ops/events (docs/bridge-protocol.md "2.1.0"):
 *         - `roleModels`: `getRoleModels` / `setRoleModels`, the session's own omp model roles and
 *           fallback chains as runtime overrides (needs omp's settings internals).
 *         - `notices`: what omp's TUI alone shows reaches the live feed as `notice` events (extension
 *           `ui.notify`, retry fallbacks, config warnings with a `key`); no fallback credit on messages.
 *         - `retry`: `retry`, omp's own F5 (`AgentSession.retry()`) for the main session.
 *         - `resumeTree`: `retry` for subagents, `resumeTree`, `failedTails` (omp's lifecycle manager,
 *           task executor and background jobs: a subagent resumes as a job of its parent).
 *         - `turnError`: `turn_error` events for terminal failures of the main session and subagents.
 *         - `limitGuard`: `setAutoResume` + a `context` guard that keeps provider-limit errors out of
 *           model requests while hostd's auto-resume is on.
 *         - `context`: `context`, what fills the session's context window (omp's own `/context` data).
 *         - `jobs`: `jobs` / `jobCancel` and the `jobs` event, the background jobs (bash, eval, subagent
 *           tasks) of the session and its subagents, with output tails and omp's job widgets.
 *         - `restore`: `restorable` / `restore`, omp's own `--restore` (`restoreSession`) for the live session.
 *         - `restoreSelect`: `restore {turn?, subagentIds?}`, omp's restore for the listed parts only (the
 *           session's own turn, the named subagents; a subagent's reply cut off mid-stream goes on
 *           through omp's retry), so hostd repeats nothing unsafe to run twice.
 *         - (no flag; a fix) every frame is well-formed JSON: half surrogate pairs go out as U+FFFD,
 *           and a resync too large even clipped is still a resync (hostd repairs 2.0.0's lines).
 */
const BRIDGE_VERSION = "2.1.0";
const PROTOCOL = 1;
const RETRY_MS = 5_000;
const TICK_MS = 1_000;
const SUBMIT_SETTLE_MS = 15_000;
/** Hidden command that hands the bridge omp's command context. Copies older than 1.4.0 register
 *  `teleflock-attach` and keep the context to themselves, and omp dispatches a command name to just
 *  one of its registrants (lab: not reliably the `-e` copy), so slot-aware copies use their own name. */
const ATTACH_COMMAND = "teleflock-control";
const LEGACY_ATTACH_COMMAND = "teleflock-attach";
const STATUS_KEY = "teleflock";
const MAX_LINE = 64 * 1024 * 1024;
/** hostd must send its auth frame within this window after the socket opens. */
const AUTH_TIMEOUT_MS = 5_000;
/** Cap on buffered bytes before hostd has authenticated. */
const MAX_AUTH_LINE = 4 * 1024;
const SECRET_HEX = /^[0-9a-f]{64}$/;

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

/**
 * The tf-hostd home, resolved in order: this file's own location when deployed by the app as
 * `<home>/ext/teleflock-bridge.ts` (omp runs with the herdr pane's env, which usually lacks
 * `TF_HOSTD_HOME`), then `TF_HOSTD_HOME`, then `~/.teleflock`.
 */
function hostdHome(): string {
	return deployedHome() ?? (process.env.TF_HOSTD_HOME || path.join(os.homedir(), ".teleflock"));
}

/**
 * Where hostd listens; must match tf-hostd `Paths`. `TF_BRIDGE_SOCK` (socket path or pipe name)
 * overrides verbatim. A home other than `~/.teleflock` is "custom": its Windows pipe name gets the
 * FNV-1a suffix.
 */
function bridgeEndpoint(home: string): string {
	const explicit = process.env.TF_BRIDGE_SOCK;
	if (explicit) return explicit;
	if (process.platform === "win32") {
		const raw = process.env.USERNAME || process.env.USER || "user";
		const user = raw.replace(/[^A-Za-z0-9_-]/g, "_");
		const defaultHome = path.join(os.homedir(), ".teleflock");
		const custom = path.resolve(home).toLowerCase() !== path.resolve(defaultHome).toLowerCase();
		const suffix = custom ? `-${fnv1a(home).toString(16).padStart(8, "0")}` : "";
		return `\\\\.\\pipe\\teleflock-bridge-${user}${suffix}`;
	}
	return path.join(home, "run", "bridge.sock");
}

/**
 * hostd's per-start shared secret, `<home>/run/bridge.secret` (next to an explicit unix
 * `TF_BRIDGE_SOCK`). hostd proves itself with it in the first frame before we say anything.
 */
function bridgeSecretPath(home: string): string {
	const explicit = process.env.TF_BRIDGE_SOCK;
	if (explicit && process.platform !== "win32") return path.join(path.dirname(explicit), "bridge.secret");
	return path.join(home, "run", "bridge.secret");
}

/** `<home>` when this file lives at `<home>/ext/<file>` (the app's deploy layout), else undefined. */
function deployedHome(): string | undefined {
	try {
		const dir = path.dirname(fileURLToPath(import.meta.url));
		return path.basename(dir) === "ext" ? path.dirname(dir) : undefined;
	} catch {
		return undefined;
	}
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

// ─── one bridge per omp process ────────────────────────────────────────────────────────────────
// An omp process can load several TeleFlock bridge copies: the global install in
// ~/.omp/agent/extensions/ and TeleFlock's `-e <home>/ext/` copy, possibly of different versions.
// They meet in one process-wide slot, and exactly one copy talks to each hostd (copies only resolve
// different endpoints when TF_HOSTD_HOME / TF_BRIDGE_SOCK disagree with a copy's deploy location).
// omp runs /teleflock-control in just one of the copies that register it, so the command context lives in the slot
// as well. The slot is a contract between bridge versions (docs/bridge-protocol.md "One bridge per
// omp process"): later versions keep these fields and their meaning, and only add optional ones.

const SLOT_KEY = Symbol.for("teleflock.bridge");

/** A subagent's task-bus frame as relayed by the bridge copy loaded in that subagent's session (2.0.0). */
interface RelayedBus {
	channel: string;
	data: unknown;
	/** Registry id of the session that saw it (the spawning agent). */
	from?: string;
}

/** A failed subagent turn as reported by the bridge copy loaded in that subagent's session (2.1.0). */
interface ReportedTurn {
	/** The `turn_error` event data. */
	data: Json;
	/** omp's failed assistant message: the same object for every copy watching the session. */
	message: object;
}

interface BridgeSlot {
	/** The active copy per hostd endpoint (socket path or pipe name): the highest `version` wins, on
	 *  equal versions the first claimant stays. A copy that takes over calls the previous owner's
	 *  `stop()` (close the socket, stop the timers, clear the status line). 2.0.0 owners add `relay`:
	 *  copies loaded in subagent sessions hand it the task-bus frames only their session sees. 2.1.0
	 *  owners add `report`: those copies hand it their session's failed turns (`turn_error`). */
	owners: Record<string, { version: string; stop(): void; relay?(frame: RelayedBus): void; report?(turn: ReportedTurn): void }>;
	/** The session command context, stored by whichever copy's /teleflock-control handler omp ran. */
	cmdCtx?: ExtensionCommandContext;
	/** Called (and removed) by that handler right after it stored `cmdCtx`. */
	attachWaiters: Array<() => void>;
	/** Last dialog request id handed out in this process (2.0.0): ids are never reused, even when
	 *  another copy takes over, so a late `uiResponse` can never answer an unrelated dialog. */
	uiReqSeq?: number;
	/** hostd's auto-resume is on (2.1.0, `setAutoResume`): every copy's `context` guard reads it.
	 *  Unset until a hostd said so. */
	autoResume?: boolean;
	/** One per live copy (2.1.0): registers that copy's `context` guard with omp. Run when hostd turns
	 *  auto-resume on, so a process with it off pays none of omp's per-request message clone. */
	armGuards?: Array<() => void>;
}

function bridgeSlot(): BridgeSlot {
	const g = globalThis as unknown as Record<symbol, unknown>;
	const found = g[SLOT_KEY];
	if (found && typeof found === "object") {
		const slot = found as BridgeSlot;
		if (!slot.owners || typeof slot.owners !== "object") slot.owners = {};
		if (!Array.isArray(slot.attachWaiters)) slot.attachWaiters = [];
		return slot;
	}
	const slot: BridgeSlot = { owners: {}, attachWaiters: [] };
	g[SLOT_KEY] = slot;
	return slot;
}

/** Orders dotted numeric versions (`1.10.0` > `1.9.2`); missing or non-numeric parts count as 0. */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(n => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
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
	/** Alt+Up: pops the last queued message and merges it ahead of the draft (`handleDequeue`). */
	onDequeue?: () => void;
	/** omp's Esc handler; a visible /btw panel owns it first (cancel, else close). */
	onEscape?: () => void;
	pendingImages: unknown[];
	pendingImageLinks?: unknown[];
};
type TuiLike = Component & {
	getFocused?: () => unknown;
	setFocus?: (c: unknown) => void;
	overlayStack?: Array<{ component?: unknown }>;
	/** "Tern" native rendering: /btw has no inline panel there, its history sheet streams instead. */
	nativeRendering?: boolean;
};

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

function walkAll(node: unknown, pred: (c: unknown) => boolean, out: Component[], depth = 0): void {
	if (!node || typeof node !== "object" || depth > 16) return;
	if (pred(node)) {
		out.push(node as Component);
		return;
	}
	const kids = "children" in node ? node.children : undefined;
	if (Array.isArray(kids)) for (const k of kids) walkAll(k, pred, out, depth + 1);
}

const hasMethods = (c: unknown, names: readonly string[]): boolean =>
	!!c && typeof c === "object" && names.every(n => typeof (c as Record<string, unknown>)[n] === "function");

// ─── /btw records ──────────────────────────────────────────────────────────────────────────────
// omp keeps every /btw conversation ("topic") as `<artifacts>/btw-history/entry-<id>.json`:
// `{id, leafId, question, answer, status, createdAt, updatedAt, error?, followUps?: turn[]}`,
// checkpointed when a turn starts and when it ends (omp session/btw-history.ts).

type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";
const BTW_STATUSES: Record<string, true> = { running: true, complete: true, cancelled: true, error: true, interrupted: true };

interface BtwTurnRec {
	question: string;
	answer: string;
	status: BtwStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
}
interface BtwRec extends BtwTurnRec {
	id: string;
	followUps: BtwTurnRec[];
}

function parseBtwTurn(v: unknown): BtwTurnRec | undefined {
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	if (typeof o.question !== "string" || typeof o.answer !== "string") return undefined;
	if (typeof o.status !== "string" || !BTW_STATUSES[o.status]) return undefined;
	const ms = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
	return {
		question: o.question,
		answer: o.answer,
		status: o.status as BtwStatus,
		createdAt: ms(o.createdAt),
		updatedAt: ms(o.updatedAt),
		error: typeof o.error === "string" ? o.error : undefined,
	};
}

function parseBtwRecord(v: unknown): BtwRec | undefined {
	const head = parseBtwTurn(v);
	const o = v as Record<string, unknown>;
	if (!head || typeof o.id !== "string" || !o.id) return undefined;
	const followUps: BtwTurnRec[] = [];
	for (const f of Array.isArray(o.followUps) ? o.followUps : []) {
		const turn = parseBtwTurn(f);
		if (!turn) return undefined;
		followUps.push(turn);
	}
	return { ...head, id: o.id, followUps };
}

/** Whitespace-insensitive question key: panel titles collapse whitespace. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** The error a finished turn reports to hostd (`undefined` for a complete answer). */
const btwErrorOf = (t: Pick<BtwTurnRec, "status" | "error">): string | undefined =>
	t.status === "complete" || t.status === "running" ? undefined : t.status === "error" ? t.error || "failed" : t.status;

/** pi-tui's BtwPanelComponent: the inline `/btw` answer panel above the composer. */
type BtwPanel = Component & { title?: unknown; describe?: () => unknown };
const isBtwPanel = (c: unknown): c is BtwPanel =>
	hasMethods(c, ["appendText", "setAnswer", "markComplete", "markAborted", "markError", "getCopyText", "isBranchable", "close"]);

/** pi-tui's BtwHistoryPanel: the full-screen `/btw` history overlay with its follow-up composer. */
type BtwHistoryPanel = Component & {
	update(records: readonly unknown[]): void;
	openFollowUp(recordId: string): boolean;
	showRecord(recordId: string): void;
	handleInput(data: string): void;
	pasteText?: (text: string) => void;
};
const isBtwHistoryPanel = (c: unknown): c is BtwHistoryPanel =>
	hasMethods(c, ["update", "openFollowUp", "showRecord", "handleInput", "markCopied"]);

/** The question a panel shows (`/btw <question>`, whitespace collapsed by the panel). */
function btwPanelQuestion(panel: BtwPanel): string | undefined {
	const title = typeof panel.title === "string" ? panel.title : "";
	if (!title.startsWith("/btw ")) return undefined;
	return oneLine(title.slice(5).replace(/ ✓ Copied$/, ""));
}

/** The answer a panel shows right now: its native description's markdown body. */
function btwPanelAnswer(panel: BtwPanel): string | undefined {
	try {
		const node = panel.describe?.() as { c?: Array<{ k?: unknown; p?: { text?: unknown } }> } | undefined;
		const body = node?.c?.[1];
		return body?.k === "md" && typeof body.p?.text === "string" ? body.p.text : undefined;
	} catch {
		return undefined;
	}
}

/** omp's btw-user prompt (prompts/system/btw-user.md), for the no-TUI fallback. */
const btwPrompt = (question: string): string =>
	`<btw>\nEphemeral side question for current interactive session.\nAnswer briefly, directly; use conversation context already provided.\nNEVER use tools.\nNEVER ask follow-up questions.\nQuestion:\n${question}\n</btw>`;

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

/** omp advisor notes: readable text lives in `details.notes`, `content` is the `<advisory>` envelope. */
function advisorText(details: unknown): string {
	const notes = details && typeof details === "object" && "notes" in details ? details.notes : undefined;
	if (!Array.isArray(notes)) return "";
	return notes
		.map((n) => (n && typeof n === "object" && "note" in n && typeof n.note === "string" ? n.note : ""))
		.filter(Boolean)
		.join(" ");
}

// ─── protocol v2: live feed ────────────────────────────────────────────────────────────────────
// hostd subscribes with `liveSubscribe` and then receives the session as omp's own collab
// host→guest frames, each wrapped as `{"t":"live","seq","f"}`, after a `resync` snapshot of
// everything in flight (docs/bridge-protocol.md "Live feed"). Every frame of a connection, control
// frames included, goes through one ordered writer, so nothing ever overtakes anything.

/** Transport backlog (`writableLength`) above which frames wait in the writer's own queue, where
 *  cumulative frames are replaced by their newest version instead of piling up. */
const LIVE_HIGH_WATER = 1024 * 1024;
/** Queued non-cumulative live bytes above which the queue is dropped for one `resync`. */
const LIVE_OVERFLOW = 16 * 1024 * 1024;
/** Queued control bytes above which hostd counts as stuck: the connection is dropped and redialed. */
const CTL_STALL = 64 * 1024 * 1024;
/** Largest live frame sent as is; bigger ones are clipped, else replaced by a notice (hostd closes at 64 MiB). */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Same bound for a `resync`, which carries the whole in-flight state in one line. */
const MAX_RESYNC_BYTES = 48 * 1024 * 1024;
const MESSAGE_UPDATE_MS = 50;
const TOOL_UPDATE_MS = 100;
const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const MAX_PENDING_DIALOGS = 64;
/** Subagents whose latest bus frames a `resync` replays (oldest forgotten first). */
const MAX_TRACKED_SUBAGENTS = 256;
const TASK_PROGRESS = "task:subagent:progress";
const TASK_LIFECYCLE = "task:subagent:lifecycle";
/** omp's `USER_INTERRUPT_LABEL`, used when its module cannot be imported. */
const USER_INTERRUPT = "Interrupted by user";

/** Agent events omp's collab host mirrors (`collab/host.ts` WIRE_AGENT_EVENT_TYPES). */
const WIRE_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};
/** Events after which collab refreshes its `state` frame (`collab/host.ts` STATE_TRIGGER_EVENTS). */
const STATE_TRIGGERS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
};
/** Session entry types collab replicates (`collab/host.ts` WIRE_SESSION_ENTRY_TYPES). */
const WIRE_ENTRIES: Record<string, true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const strField = (o: unknown, key: string): string | undefined => {
	const v = isObj(o) ? o[key] : undefined;
	return typeof v === "string" && v ? v : undefined;
};

/** Clip passes for an oversized payload (long strings and arrays cut, cycles and depth elided). */
const SHRINK_PASSES: ReadonlyArray<{ stringCap: number; arrayLimit: number }> = [
	{ stringCap: 256 * 1024, arrayLimit: 1024 },
	{ stringCap: 16 * 1024, arrayLimit: 256 },
	{ stringCap: 1024, arrayLimit: 32 },
	{ stringCap: 64, arrayLimit: 4 },
];

function clipValue(v: unknown, stringCap: number, arrayLimit: number, depth: number, path: WeakSet<object>): unknown {
	if (typeof v === "string") return v.length > stringCap ? `${v.slice(0, stringCap)}\n…[${v.length - stringCap} chars elided]` : v;
	if (typeof v === "bigint") return Number(v);
	if (typeof v === "function" || typeof v === "symbol") return undefined;
	if (!v || typeof v !== "object") return v;
	if (depth > 64 || path.has(v)) return "…[elided]";
	path.add(v);
	try {
		let src: object = v;
		if ("toJSON" in v && typeof v.toJSON === "function") {
			let converted: unknown;
			try {
				converted = v.toJSON();
			} catch {
				return "…[unserializable]";
			}
			if (!converted || typeof converted !== "object") return clipValue(converted, stringCap, arrayLimit, depth + 1, path);
			src = converted;
		}
		if (Array.isArray(src)) {
			const out = src.slice(0, arrayLimit).map(x => clipValue(x, stringCap, arrayLimit, depth + 1, path) ?? null);
			if (src.length > arrayLimit) out.push(`…[${src.length - arrayLimit} items elided]`);
			return out;
		}
		const out: Json = {};
		for (const [k, value] of Object.entries(src)) {
			const c = clipValue(value, stringCap, arrayLimit, depth + 1, path);
			if (c !== undefined) out[k] = c;
		}
		return out;
	} finally {
		path.delete(v);
	}
}

/** A string that holds half of a UTF-16 surrogate pair is written by `JSON.stringify` as a `\udXXX`
 *  escape (valid pairs come out as characters, never escaped). omp cuts text by UTF-16 index in
 *  places (its completion probe's 80-char `stage`, `truncate()` for job labels, the 8 KiB
 *  `recentOutput` tail), and so does `clipValue`: an emoji at the cut leaves half of it. serde_json
 *  refuses such an escape, and hostd dropped the frame, and every resync replaying it (a running
 *  `wait` repeats its jobs' stages, the tracker replays each subagent's last progress): the
 *  session stopped updating. Each lone surrogate escape (one not after an escaped backslash)
 *  becomes U+FFFD, as `String.prototype.toWellFormed` would have it. */
const LONE_SURROGATE_ESCAPE = /(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/g;
export function wellFormedJson(json: string): string {
	return json.includes("\\ud") ? json.replace(LONE_SURROGATE_ESCAPE, "$1\\ufffd") : json;
}

/** `frame` as JSON of at most `maxBytes` UTF-8 bytes: as is, else with long strings and arrays clipped
 *  (as omp's collab shrinks oversized payloads), else a collab-style notice saying what was omitted.
 *  Always well-formed (see wellFormedJson). */
export function frameJson(frame: unknown, maxBytes = MAX_FRAME_BYTES): string {
	const fits = (json: string | undefined): json is string =>
		json !== undefined && (json.length * 3 <= maxBytes || Buffer.byteLength(json, "utf8") <= maxBytes);
	try {
		const json = JSON.stringify(frame);
		if (fits(json)) return wellFormedJson(json);
	} catch {
		// cycles or BigInt: the clip passes below handle both
	}
	for (const pass of SHRINK_PASSES) {
		try {
			const json = JSON.stringify(clipValue(frame, pass.stringCap, pass.arrayLimit, 0, new WeakSet()));
			if (fits(json)) return wellFormedJson(json);
		} catch {
			// next pass
		}
	}
	const t = strField(frame, "t") ?? "frame";
	const what = (t === "event" && isObj(frame) ? strField(frame.event, "type") : undefined) ?? t;
	return JSON.stringify({
		t: "event",
		event: { type: "notice", level: "warning", source: "teleflock", message: `Host ${what} omitted: too large to replicate.` },
	});
}

/** An assistant message without what a refusal hands omp for its fallback-credit redemption: the
 *  credit handle (token, the frozen request body, the refused content) and the token in
 *  `stopDetails`. hostd shows refusals from `stopDetails.type/category/explanation` alone. */
export function withoutFallbackCredit(message: unknown): unknown {
	if (!isObj(message)) return message;
	const details = message.stopDetails;
	const tokenInDetails = isObj(details) && ("fallback_credit_token" in details || "fallback_has_prefill_claim" in details);
	if (!("fallbackCreditHandle" in message) && !tokenInDetails) return message;
	const { fallbackCreditHandle: _handle, ...rest } = message;
	if (isObj(details)) {
		const { fallback_credit_token: _token, fallback_has_prefill_claim: _claim, ...kept } = details;
		rest.stopDetails = kept;
	}
	return rest;
}

/** The event as the live feed sends it: collab's shape minus payloads hostd gets elsewhere
 *  (`assistantMessageEvent.partial`/`.message` repeat `message`; `agent_end.messages` and
 *  `turn_end.message`/`.toolResults` repeat the turn's `message_end` frames) and minus a refusal's
 *  fallback credit (see withoutFallbackCredit). */
export function wireEvent(ev: Json): Json {
	switch (ev.type) {
		case "message_update": {
			const ame = ev.assistantMessageEvent;
			const message = withoutFallbackCredit(ev.message);
			if (!isObj(ame) || !("partial" in ame || "message" in ame)) return message === ev.message ? ev : { ...ev, message };
			const { partial: _partial, message: _message, ...rest } = ame;
			return { ...ev, message, assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end": {
			const message = withoutFallbackCredit(ev.message);
			return message === ev.message ? ev : { ...ev, message };
		}
		case "agent_end": {
			const { messages: _messages, ...rest } = ev;
			return rest;
		}
		case "turn_end": {
			const { message: _message, toolResults: _results, ...rest } = ev;
			return rest;
		}
		default:
			return ev;
	}
}

/** Where the writer puts lines (the socket) and how much it still holds. */
export interface LiveSink {
	write(line: string): void;
	/** Bytes the transport has not flushed yet (`socket.writableLength`). */
	backlog(): number;
}

type FrameSource = unknown | (() => unknown);
type QueueItem =
	| { k: "ctl"; line: string; dead?: boolean }
	| { k: "live"; key?: string; json?: string; build?: () => unknown; bytes: number; dead?: boolean }
	| { k: "resync"; dead?: boolean };

export interface LiveWriterOptions {
	/** The `resync` frame for `seq`, built when it is written, so it covers everything dropped before it. */
	resync: (seq: number) => Json;
	highWater?: number;
	overflow?: number;
	stall?: number;
	/** Largest `resync` line (default MAX_RESYNC_BYTES; tests lower it). */
	resyncBytes?: number;
	/** Queued control frames passed `stall`: hostd stopped reading for good. */
	onStall?: () => void;
	log?: (msg: string) => void;
}

/**
 * One connection's ordered writer. Lines go straight to the sink while its backlog stays under
 * `highWater`; beyond that they queue here. A queued cumulative live frame (a `key`) is replaced by
 * the newer one (the stale one is dropped and the new one appended, so the delivered stream is
 * always a subsequence of what was produced). Control frames are never dropped. When the queued
 * non-cumulative live frames pass `overflow`, all queued live frames are dropped for one `resync`,
 * built when it is written; live frames produced while it waits are covered by it and skipped.
 * `seq` is assigned when a live or resync frame is written, so it is contiguous on the wire.
 */
export class LiveWriter {
	/** seq of the last live/resync frame written on this connection (0 = none yet). */
	seq = 0;
	#on = false;
	#q: QueueItem[] = [];
	#head = 0;
	readonly #byKey = new Map<string, Extract<QueueItem, { k: "live" }>>();
	#liveBytes = 0;
	#ctlBytes = 0;
	#resyncQueued = false;
	readonly #highWater: number;
	readonly #overflow: number;
	readonly #stall: number;

	constructor(
		readonly sink: LiveSink,
		readonly opts: LiveWriterOptions,
	) {
		this.#highWater = opts.highWater ?? LIVE_HIGH_WATER;
		this.#overflow = opts.overflow ?? LIVE_OVERFLOW;
		this.#stall = opts.stall ?? CTL_STALL;
	}

	/** The live feed is on (between `start` and `stop`). */
	get subscribed(): boolean {
		return this.#on;
	}

	/** Items waiting in the queue (dropped ones included until the next flush skips them). */
	get pending(): number {
		return this.#q.length - this.#head;
	}

	/** A control frame (`hello`, `res`, `event`, `bye`): never dropped, never reordered. */
	ctl(obj: unknown): void {
		let line: string;
		try {
			line = `${wellFormedJson(JSON.stringify(obj))}\n`;
		} catch (err) {
			this.opts.log?.(`unserializable frame: ${String(err)}`);
			return;
		}
		if (this.pending === 0 && this.#room()) {
			this.sink.write(line);
			return;
		}
		this.#q.push({ k: "ctl", line });
		this.#ctlBytes += line.length;
		if (this.#ctlBytes > this.#stall) this.opts.onStall?.();
		else if (this.#room()) this.flush();
	}

	/** Starts (or restarts) the feed: anything queued for the old one is dropped, a `resync` comes first. */
	start(): void {
		this.#dropLive();
		this.#on = true;
		this.#queueResync();
		if (this.#room()) this.flush();
	}

	/** Ends the feed; queued live frames are dropped, control frames stay. */
	stop(): void {
		this.#on = false;
		this.#dropLive();
	}

	/** A live frame (or a thunk building it). With a `key` it is cumulative: a newer frame under the same
	 *  key replaces it while it is queued, and the thunk runs only when it is written. */
	live(frame: FrameSource, key?: string): void {
		if (!this.#on || this.#resyncQueued) return;
		if (key) this.drop(key);
		if (this.pending === 0 && this.#room()) {
			this.#writeLive(frameJson(resolveFrame(frame)));
			return;
		}
		if (key) {
			const item: Extract<QueueItem, { k: "live" }> = { k: "live", key, build: () => resolveFrame(frame), bytes: 0 };
			this.#q.push(item);
			this.#byKey.set(key, item);
		} else {
			const json = frameJson(resolveFrame(frame));
			this.#q.push({ k: "live", json, bytes: json.length });
			this.#liveBytes += json.length;
			if (this.#liveBytes > this.#overflow) {
				this.opts.log?.(`live queue passed ${this.#overflow} bytes while hostd lags: one resync instead`);
				this.#dropLive();
				this.#queueResync();
			}
		}
		if (this.#room()) this.flush();
	}

	/** Drops the queued frame under `key` (its end frame supersedes it). */
	drop(key: string): void {
		const old = this.#byKey.get(key);
		if (!old) return;
		old.dead = true;
		this.#byKey.delete(key);
	}

	/** Writes queued frames while the sink has room (`force`: regardless, for a final goodbye). */
	flush(force = false): void {
		while (this.#head < this.#q.length) {
			if (!force && !this.#room()) break;
			const item = this.#q[this.#head]!;
			this.#head++;
			if (item.dead) continue;
			if (item.k === "ctl") {
				this.#ctlBytes -= item.line.length;
				this.sink.write(item.line);
			} else if (item.k === "resync") {
				this.#resyncQueued = false;
				this.#writeResync();
			} else {
				if (item.key) this.#byKey.delete(item.key);
				else this.#liveBytes -= item.bytes;
				this.#writeLive(item.json ?? frameJson(item.build?.()));
			}
		}
		if (this.#head === this.#q.length) {
			this.#q = [];
			this.#head = 0;
		} else if (this.#head > 1024 && this.#head * 2 > this.#q.length) {
			this.#q = this.#q.slice(this.#head);
			this.#head = 0;
		}
	}

	#room(): boolean {
		return this.sink.backlog() <= this.#highWater;
	}

	#dropLive(): void {
		for (let i = this.#head; i < this.#q.length; i++) {
			const item = this.#q[i]!;
			if (item.k !== "ctl") item.dead = true;
		}
		this.#byKey.clear();
		this.#liveBytes = 0;
		this.#resyncQueued = false;
	}

	#queueResync(): void {
		this.#q.push({ k: "resync" });
		this.#resyncQueued = true;
	}

	#writeLive(json: string): void {
		this.seq++;
		this.sink.write(`{"t":"live","seq":${this.seq},"f":${json}}\n`);
	}

	#writeResync(): void {
		this.seq++;
		let frame: Json;
		try {
			frame = this.opts.resync(this.seq);
		} catch (err) {
			this.opts.log?.(`resync: ${String(err)}`);
			frame = { t: "resync", seq: this.seq, live: { streaming: false, frames: [] } };
		}
		const max = this.opts.resyncBytes ?? MAX_RESYNC_BYTES;
		let json = frameJson(frame, max);
		if (!json.includes('"t":"resync"')) {
			// Too large even clipped: a notice in its place would leave hostd waiting for a resync that
			// never comes. Without its in-flight frames it still restarts the feed (the session file
			// holds every entry).
			this.opts.log?.(`resync over ${max} bytes: sent without its in-flight frames`);
			const live = isObj(frame.live) ? frame.live : {};
			json = frameJson({ ...frame, live: { streaming: live.streaming === true, frames: [] } }, max);
		}
		this.sink.write(`${json}\n`);
	}
}

/** `TF_BRIDGE_LIVE_LIMITS=<highWater>,<overflow>` (bytes): smaller flow-control limits for labs, so a
 *  paused fake hostd (probe.ts `pause`) shows backpressure and overflow with an ordinary turn. */
function liveLimits(): { highWater?: number; overflow?: number } {
	const [highWater, overflow] = (process.env.TF_BRIDGE_LIVE_LIMITS ?? "").split(",").map(s => Number.parseInt(s, 10));
	return {
		highWater: highWater !== undefined && highWater >= 0 ? highWater : undefined,
		overflow: overflow !== undefined && overflow > 0 ? overflow : undefined,
	};
}

const resolveFrame = (frame: FrameSource): unknown => (typeof frame === "function" ? frame() : frame);

/** `fn()` as a promise, a synchronous throw included (as a rejection). */
function attempt<T>(fn: () => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(fn());
	} catch (err) {
		return Promise.reject(err);
	}
}

/** Injectable clock and timers (tests drive them by hand). */
export interface Timers {
	now(): number;
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const realTimers: Timers = {
	now: () => Date.now(),
	set: (fn, ms) => {
		const t = setTimeout(fn, ms);
		t.unref?.();
		return t;
	},
	clear: handle => clearTimeout(handle as Timer),
};

/** At most one call per `ms` per key, leading edge first and the latest trailing call kept; `end`
 *  forgets a key and drops its trailing call (the key's end frame supersedes it). */
export class Throttle {
	readonly #last = new Map<string, number>();
	readonly #held = new Map<string, { fn: () => void; handle: unknown }>();

	constructor(readonly timers: Timers = realTimers) {}

	run(key: string, ms: number, fn: () => void): void {
		const held = this.#held.get(key);
		if (held) {
			held.fn = fn;
			return;
		}
		const now = this.timers.now();
		const last = this.#last.get(key);
		if (last === undefined || now - last >= ms) {
			this.#last.set(key, now);
			fn();
			return;
		}
		const entry = { fn, handle: undefined as unknown };
		entry.handle = this.timers.set(() => {
			if (this.#held.get(key) !== entry) return;
			this.#held.delete(key);
			this.#last.set(key, this.timers.now());
			try {
				entry.fn();
			} catch {
				/* the caller logs its own failures */
			}
		}, ms - (now - last));
		this.#held.set(key, entry);
	}

	end(key: string): void {
		const held = this.#held.get(key);
		if (held) this.timers.clear(held.handle);
		this.#held.delete(key);
		this.#last.delete(key);
	}

	clear(): void {
		for (const held of this.#held.values()) this.timers.clear(held.handle);
		this.#held.clear();
		this.#last.clear();
	}
}

/** What is in flight right now (from the events the feed sees), replayed by a `resync`. */
export class LiveTracker {
	streaming = false;
	/** Latest `message_start`/`message_update` of the assistant message still streaming. */
	message?: Json;
	readonly tools = new Map<string, { start?: Json; update?: Json }>();
	compaction?: Json;
	retry?: Json;
	/** Latest lifecycle and progress per subagent id (insertion order = least recently seen first). */
	readonly subs = new Map<string, { lifecycle?: Json; progress?: Json; parent?: string; first: number; at: number }>();

	track(ev: Json): void {
		const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
		switch (ev.type) {
			case "agent_start":
				this.streaming = true;
				break;
			case "agent_end":
				this.streaming = false;
				this.message = undefined;
				this.tools.clear();
				this.compaction = undefined;
				this.retry = undefined;
				break;
			case "message_start":
			case "message_update":
				if (strField(ev.message, "role") === "assistant") this.message = ev;
				break;
			case "message_end":
				this.message = undefined;
				break;
			case "tool_execution_start":
				if (id) this.tools.set(id, { start: ev });
				break;
			case "tool_execution_update":
				if (id) this.tools.set(id, { ...this.tools.get(id), update: ev });
				break;
			case "tool_execution_end":
				this.tools.delete(id);
				break;
			case "auto_compaction_start":
				this.compaction = ev;
				break;
			case "auto_compaction_end":
				this.compaction = undefined;
				break;
			case "auto_retry_start":
				this.retry = ev;
				break;
			case "auto_retry_end":
				this.retry = undefined;
				break;
		}
	}

	bus(channel: string, data: Json, parent: string | undefined, now: number): void {
		const id = channel === TASK_LIFECYCLE ? strField(data, "id") : strField(data.progress, "id");
		if (!id) return;
		const sub = this.subs.get(id) ?? { first: now, at: now };
		this.subs.delete(id);
		if (channel === TASK_LIFECYCLE) sub.lifecycle = data;
		else sub.progress = data;
		sub.parent ??= parent;
		sub.at = now;
		this.subs.set(id, sub);
		while (this.subs.size > MAX_TRACKED_SUBAGENTS) {
			const oldest = this.subs.keys().next().value;
			if (oldest === undefined) break;
			this.subs.delete(oldest);
		}
	}

	reset(): void {
		this.streaming = false;
		this.message = undefined;
		this.tools.clear();
		this.compaction = undefined;
		this.retry = undefined;
		this.subs.clear();
	}

	/**
	 * The in-flight frames in replay order: compaction / retry in progress, the streaming message
	 * (omp's live `streamMessage` when known, it can be ahead of the last throttled update), running
	 * tools (start, then the latest update), then each subagent's latest lifecycle and progress.
	 */
	frames(live?: { streamMessage?: unknown; toolUpdates?: ReadonlyMap<string, Json> }): Json[] {
		const out: Json[] = [];
		const event = (e: Json) => out.push({ t: "event", event: wireEvent(e) });
		if (this.compaction) event(this.compaction);
		if (this.retry) event(this.retry);
		const stream = live?.streamMessage;
		if (isObj(stream) && stream.role === "assistant") {
			event({ type: "message_update", message: stream, assistantMessageEvent: this.message?.assistantMessageEvent });
		} else if (this.message) {
			event(this.message.type === "message_update" ? this.message : { ...this.message, type: "message_update" });
		}
		for (const [id, tool] of this.tools) {
			if (tool.start) event(tool.start);
			const update = live?.toolUpdates?.get(id) ?? tool.update;
			if (update) event(update);
		}
		for (const sub of this.subs.values()) {
			if (sub.lifecycle) out.push({ t: "bus", channel: TASK_LIFECYCLE, data: sub.lifecycle });
			if (sub.progress) out.push({ t: "bus", channel: TASK_PROGRESS, data: sub.progress });
		}
		return out;
	}
}

// ─── protocol v2: dialogs ──────────────────────────────────────────────────────────────────────
// The dialog members of omp's shared extension UI context are wrapped so that every dialog races
// omp's own (the TUI) against hostd's answer, exactly as omp races its collab guests
// (`modes/controllers/extension-ui-controller.ts` #raceCollabDialog, #runGuestAskDialog): the first
// answer wins and the loser is cancelled through its abort signal. hostd sees each dialog as a
// collab `ui-request` (select or editor) and answers with the collab `ui-response` value.

type WireSelectItem = string | { label: string; description?: string };
export type DialogDraft =
	| {
			kind: "select";
			title: string;
			options: WireSelectItem[];
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			helpText?: string;
	  }
	| { kind: "editor"; title: string; prefill?: string };
export type DialogRequest = DialogDraft & { reqId: number };
/** `answered` carries hostd's value (`undefined` is an explicit cancel); `unavailable` means no answer
 *  will come (the dialog was settled locally, aborted, or this bridge stood down). */
export type RemoteResult = { kind: "answered"; value: string | undefined } | { kind: "unavailable" };

/** Pending dialogs offered to hostd (omp's CollabHost.requestGuestUi, minus the transport). */
export class DialogHub {
	readonly #pending = new Map<number, { request: DialogRequest; settle(result: RemoteResult): void }>();

	constructor(
		readonly nextId: () => number,
		readonly emit: (frame: Json) => void,
	) {}

	get size(): number {
		return this.#pending.size;
	}

	/** Offers a dialog (`ui-request`), settled by `answer`, an abort of `signal` or `close`; each
	 *  settlement emits `ui-request-end`. `null` when it cannot be offered (aborted, too many pending). */
	request(draft: DialogDraft, signal?: AbortSignal): Promise<RemoteResult> | null {
		if (signal?.aborted || this.#pending.size >= MAX_PENDING_DIALOGS) return null;
		const reqId = this.nextId();
		const request = { ...draft, reqId } as DialogRequest;
		const { promise, resolve } = Promise.withResolvers<RemoteResult>();
		let done = false;
		const onAbort = () => settle({ kind: "unavailable" });
		const settle = (result: RemoteResult): void => {
			if (done) return;
			done = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(reqId);
			this.emit({ t: "ui-request-end", reqId });
			resolve(result);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(reqId, { request, settle });
		this.emit({ t: "ui-request", request });
		return promise;
	}

	/** hostd's answer; false when `reqId` is not pending (already settled, or never offered). */
	answer(reqId: number, value: string | undefined): boolean {
		const pending = this.#pending.get(reqId);
		if (!pending) return false;
		pending.settle({ kind: "answered", value });
		return true;
	}

	/** Pending requests, oldest first. */
	requests(): DialogRequest[] {
		return [...this.#pending.values()].map(p => p.request).sort((a, b) => a.reqId - b.reqId);
	}

	/** Settles everything as unavailable: the local dialogs go on alone. */
	close(): void {
		for (const pending of [...this.#pending.values()]) pending.settle({ kind: "unavailable" });
	}
}

const anySignal = (a: AbortSignal | undefined, b: AbortSignal): AbortSignal => (a ? AbortSignal.any([a, b]) : b);

/**
 * omp's own dialog (`local`) against hostd's answer to `draft`: the first answer wins and aborts the
 * other side; a remote `unavailable` is no answer, the local dialog goes on and decides.
 */
export async function raceDialog<T>(
	hub: DialogHub,
	draft: DialogDraft,
	signal: AbortSignal | undefined,
	local: (signal: AbortSignal) => T | Promise<T>,
	fromRemote: (value: string | undefined) => T,
): Promise<T> {
	const localAbort = new AbortController();
	const remoteAbort = new AbortController();
	const localSignal = anySignal(signal, localAbort.signal);
	const remote = hub.request(draft, anySignal(signal, remoteAbort.signal));
	if (!remote) return local(localSignal);
	type Winner = { source: "local" | "remote"; value: T };
	const localWinner = attempt(() => local(localSignal)).then((value): Winner => ({ source: "local", value }));
	const remoteWinner = remote.then(
		(result): Winner | Promise<Winner> =>
			result.kind === "answered" ? { source: "remote", value: fromRemote(result.value) } : localWinner,
	);
	localWinner.catch(() => {});
	remoteWinner.catch(() => {});
	try {
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	} catch (err) {
		localAbort.abort();
		remoteAbort.abort();
		throw err;
	}
}

// The ask tool's dialog, offered to hostd as omp offers it to collab guests: one select per
// question (radio, or a checkbox loop toggling one label per round), "Other" followed by a
// "Custom answer:" editor, "Chat about this" ending the ask as chat.
const ASK_OTHER = "Other (type your own)";
const ASK_CHAT = "Chat about this";
const ASK_NEXT = "Next →";
const CUSTOM_ANSWER = "Custom answer: ";

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string; preview?: string }>;
	multi?: boolean;
	recommended?: number;
}
export interface AskResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}
export type AskResult = { kind: "submit"; results: AskResultItem[] } | { kind: "chat" };

/** omp's `sanitizeCarriageReturns`: CRLF → LF, CR runs → one space. */
const sanitizeCR = (text: string): string => (text.includes("\r") ? text.replaceAll("\r\n", "\n").replace(/\r+/g, " ") : text);

/** omp's `disambiguateDisplayLabels`: unique, sentinel-safe display copies of the option labels. */
function displayLabels(raw: readonly string[], reserved: readonly string[]): string[] {
	const taken = new Set<string>(reserved);
	return raw.map(label => {
		const base = sanitizeCR(label);
		let candidate = base;
		for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base} (${suffix})`;
		taken.add(candidate);
		return candidate;
	});
}

/** omp's `normalizeDialogQuestions`: untrusted ask input coerced into a safe shape. */
export function normalizeAskQuestions(questions: unknown): AskQuestion[] {
	if (!Array.isArray(questions)) return [];
	const out: AskQuestion[] = [];
	for (const entry of questions) {
		if (!isObj(entry)) continue;
		const options: AskQuestion["options"] = [];
		for (const opt of Array.isArray(entry.options) ? entry.options : []) {
			if (!isObj(opt)) continue;
			options.push({
				label: typeof opt.label === "string" ? opt.label : "",
				...(typeof opt.description === "string" ? { description: sanitizeCR(opt.description) } : {}),
			});
		}
		out.push({
			id: typeof entry.id === "string" ? entry.id : "?",
			question: typeof entry.question === "string" ? entry.question : "",
			options,
			...(typeof entry.multi === "boolean" ? { multi: entry.multi } : {}),
			...(Number.isInteger(entry.recommended) ? { recommended: entry.recommended as number } : {}),
		});
	}
	return out;
}

const askHelpText = (action: string, extra = ""): string => `↑/↓ navigate  Enter ${action}  ${extra}Esc cancel`;

type GuestString = { kind: "answered"; value: string } | { kind: "cancelled" } | { kind: "unavailable" };

async function requestString(hub: DialogHub, draft: DialogDraft, signal: AbortSignal): Promise<GuestString> {
	const remote = hub.request(draft, signal);
	if (!remote) return { kind: "unavailable" };
	const result = await remote;
	if (result.kind === "unavailable") return result;
	return typeof result.value === "string" ? { kind: "answered", value: result.value } : { kind: "cancelled" };
}

async function guestAskQuestion(
	hub: DialogHub,
	question: AskQuestion,
	signal: AbortSignal,
): Promise<AskResultItem | "chat" | "unavailable" | undefined> {
	const selected = new Set<string>();
	let customInput: string | undefined;
	const labels = question.options.map(o => o.label);
	const shown = displayLabels(labels, [ASK_OTHER, ASK_CHAT, ASK_NEXT]);
	const original = new Map<string, string>();
	shown.forEach((label, i) => original.set(label, labels[i]!));
	const resolveLabel = (value: string): string => original.get(value) ?? value;
	const title = sanitizeCR(question.question);
	// omp bounds this title to the terminal's width; hostd shows it whole.
	const customTitle = `${CUSTOM_ANSWER}${title}`.replace(/\s+/g, " ").trim();
	const base: WireSelectItem[] = question.options.map((o, i) =>
		o.description?.trim() ? { label: shown[i]!, description: sanitizeCR(o.description.trim()) } : shown[i]!,
	);
	if (question.multi) {
		for (;;) {
			const checkedIndices = labels.map((label, i) => (selected.has(label) ? i : -1)).filter(i => i >= 0);
			const hasAnswer = selected.size > 0 || customInput !== undefined;
			const options = [...base, ASK_OTHER];
			if (hasAnswer) options.push(ASK_NEXT);
			options.push(ASK_CHAT);
			const choice = await requestString(
				hub,
				{
					kind: "select",
					title,
					options,
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: question.options.length,
					helpText: askHelpText("toggle", hasAnswer ? "Next → continue  " : ""),
				},
				signal,
			);
			if (choice.kind === "unavailable") return "unavailable";
			if (choice.kind === "cancelled") return undefined;
			if (choice.value === ASK_CHAT) return "chat";
			if (choice.value === ASK_NEXT) break;
			if (choice.value === ASK_OTHER) {
				const input = await requestString(hub, { kind: "editor", title: customTitle }, signal);
				if (input.kind === "unavailable") return "unavailable";
				if (input.kind === "cancelled") continue;
				customInput = input.value;
				break;
			}
			const picked = resolveLabel(choice.value);
			if (selected.has(picked)) selected.delete(picked);
			else selected.add(picked);
		}
	} else {
		const recommended = typeof question.recommended === "number" && Number.isInteger(question.recommended) ? question.recommended : 0;
		const initialIndex = Math.max(0, Math.min(recommended, Math.max(0, question.options.length - 1)));
		for (;;) {
			const choice = await requestString(
				hub,
				{
					kind: "select",
					title,
					options: [...base, ASK_OTHER, ASK_CHAT],
					initialIndex,
					selectionMarker: "radio",
					markableCount: question.options.length,
					helpText: askHelpText("select"),
				},
				signal,
			);
			if (choice.kind === "unavailable") return "unavailable";
			if (choice.kind === "cancelled") return undefined;
			if (choice.value === ASK_CHAT) return "chat";
			if (choice.value === ASK_OTHER) {
				const input = await requestString(hub, { kind: "editor", title: customTitle }, signal);
				if (input.kind === "unavailable") return "unavailable";
				if (input.kind === "cancelled") continue;
				customInput = input.value;
			} else {
				selected.add(resolveLabel(choice.value));
			}
			break;
		}
	}
	return {
		id: question.id,
		question: question.question,
		options: labels,
		multi: question.multi ?? false,
		selectedOptions: labels.filter(label => selected.has(label)),
		customInput,
	};
}

/** The guest side of omp's ask dialog, question by question; `unavailable` when no answer came. */
export async function runGuestAsk(hub: DialogHub, questions: AskQuestion[], signal: AbortSignal): Promise<AskResult | "unavailable" | undefined> {
	const results: AskResultItem[] = [];
	for (const question of questions) {
		const result = await guestAskQuestion(hub, question, signal);
		if (result === "unavailable" || result === undefined) return result;
		if (result === "chat") return { kind: "chat" };
		results.push(result);
	}
	return { kind: "submit", results };
}

/** omp's ask dialog (`local`) against the guest flow above (omp's `showAskDialog`). */
export async function raceAsk<T>(
	hub: DialogHub,
	questions: unknown,
	signal: AbortSignal | undefined,
	local: (signal: AbortSignal) => T | Promise<T>,
): Promise<T | AskResult | undefined> {
	const normalized = normalizeAskQuestions(questions);
	const localAbort = new AbortController();
	const remoteAbort = new AbortController();
	type Winner = { source: "local" | "remote"; value: T | AskResult | undefined };
	const localWinner = attempt(() => local(anySignal(signal, localAbort.signal))).then((value): Winner => ({ source: "local", value }));
	const remoteWinner = runGuestAsk(hub, normalized, anySignal(signal, remoteAbort.signal)).then(
		(result): Winner | Promise<Winner> => (result === "unavailable" ? localWinner : { source: "remote", value: result }),
	);
	localWinner.catch(() => {});
	remoteWinner.catch(() => {});
	try {
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	} catch (err) {
		localAbort.abort();
		remoteAbort.abort();
		throw err;
	}
}

/** omp's approval prompt (`ExtensionApprovalPrompt`) and answer, and its select-menu mapping
 *  (`tools/approval.ts`), used when omp's own functions cannot be imported. */
export interface ApprovalPrompt {
	full: string;
	compact?: string;
	session?: string;
	grants?: Array<{ scope: string; label: string; alwaysLabel: string }>;
}
export type ApprovalAnswer = "once" | "session" | "deny" | { grant: string; always: boolean };
export interface ApprovalLabels {
	approvalChoiceLabels(prompt: ApprovalPrompt): string[];
	approvalAnswerForChoice(prompt: ApprovalPrompt, choice: string | undefined): ApprovalAnswer;
}

const approvalOnceLabel = (prompt: ApprovalPrompt): string => (prompt.grants?.length ? "Approve Once" : "Approve");

export const fallbackApproval: ApprovalLabels = {
	approvalChoiceLabels: prompt => {
		const grants = prompt.grants ?? [];
		return [
			...grants.map(g => g.label),
			...grants.map(g => g.alwaysLabel),
			approvalOnceLabel(prompt),
			...(prompt.session ? [prompt.session] : []),
			"Deny",
		];
	},
	approvalAnswerForChoice: (prompt, choice) => {
		if (choice === undefined) return "deny";
		if (choice === approvalOnceLabel(prompt)) return "once";
		if (prompt.session && choice === prompt.session) return "session";
		for (const grant of prompt.grants ?? []) {
			if (choice === grant.label) return { grant: grant.scope, always: false };
			if (choice === grant.alwaysLabel) return { grant: grant.scope, always: true };
		}
		return "deny";
	},
};

export const DIALOG_MEMBERS = ["askDialog", "approve", "select", "editor", "confirm", "input"] as const;
export type DialogMember = (typeof DIALOG_MEMBERS)[number];
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
const DIALOG_WRAP = Symbol.for("teleflock.bridge.dialogWrap");
type WrappedFn = AnyFn & { [DIALOG_WRAP]?: { token: object; original: AnyFn } };

/** A member's own function, read past omp's `trackUserWaits` proxy: it has no descriptor trap, so
 *  the target's descriptor comes back (a `get` would return the proxy's tracking wrapper). */
function ownMember(ui: object, name: string): PropertyDescriptor | undefined {
	let o: object | null = ui;
	for (let i = 0; o && i < 4; i++) {
		const desc = Object.getOwnPropertyDescriptor(o, name);
		if (desc) return desc;
		o = Object.getPrototypeOf(o) as object | null;
	}
	return undefined;
}

function wrappedBy(fn: unknown, token: object): boolean {
	let f = fn as WrappedFn | undefined;
	for (let i = 0; typeof f === "function" && i < 8; i++) {
		const tag = f[DIALOG_WRAP];
		if (!tag) return false;
		if (tag.token === token) return true;
		f = tag.original as WrappedFn;
	}
	return false;
}

// ─── 2.1.0: notices (`caps.notices`) ───────────────────────────────────────────────────────────
// omp's TUI shows some warnings itself only (extension `ui.notify`, its retry fallbacks, the config
// warnings in its header); the live feed carries them as collab-shaped `notice` events.

/** omp's retry fallback events as the notices its TUI shows (event-controller.ts
 *  `#handleRetryFallbackApplied` / `#handleRetryFallbackSucceeded`); `undefined` for other events. */
export function fallbackNotice(ev: Json): Json | undefined {
	if (ev.type === "retry_fallback_applied") {
		const reason = typeof ev.reason === "string" && ev.reason.trim() ? `\n${ev.reason.replace(ANSI, "").trim().slice(0, 400)}` : "";
		return { type: "notice", level: "warning", message: `Fallback: ${String(ev.from ?? "?")} → ${String(ev.to ?? "?")}${reason}`, source: "fallback" };
	}
	if (ev.type === "retry_fallback_succeeded") return { type: "notice", level: "info", message: `Fallback succeeded on ${String(ev.model ?? "?")}`, source: "fallback" };
	return undefined;
}

/** The session's standing config warnings (`configWarnings`, then WATCHDOG.yml problems) as notices
 *  keyed by their text: hostd shows each once however often a resync or a change repeats it. */
export function configNotices(session: unknown): Json[] {
	if (!isObj(session)) return [];
	const all: unknown[] = Array.isArray(session.configWarnings) ? [...session.configWarnings] : [];
	try {
		const advisor = typeof session.getAdvisorConfigWarnings === "function" ? (session.getAdvisorConfigWarnings as () => unknown).call(session) : undefined;
		if (Array.isArray(advisor)) for (const w of advisor) if (typeof w === "string") all.push(`WATCHDOG.yml: ${w}`);
	} catch {
		// an omp without advisors
	}
	const seen = new Set<string>();
	const out: Json[] = [];
	for (const w of all) {
		const message = typeof w === "string" ? w.replace(ANSI, "").trim() : "";
		if (!message || seen.has(message)) continue;
		seen.add(message);
		out.push({ type: "notice", level: "warning", message, source: "config", key: `config:${crypto.createHash("sha256").update(message).digest("hex").slice(0, 16)}` });
	}
	return out;
}

/** An extension's `ctx.ui.notify(message, type)` as a notice; omp still shows it. */
export function notifyNotice(message: unknown, type: unknown): Json | undefined {
	const text = typeof message === "string" ? message.replace(ANSI, "").trim() : "";
	if (!text) return undefined;
	return { type: "notice", level: type === "error" ? "error" : type === "warning" ? "warning" : "info", message: text, source: "extension" };
}

/** Puts `make(original)` in place of `notify` on omp's shared UI context, as installDialogWrappers
 *  does for the dialogs (another copy's wrapper stays underneath). Returns whether it is wrapped. */
export function installNotifyWrapper(ui: object, token: object, make: (original: AnyFn) => AnyFn): boolean {
	const desc = ownMember(ui, "notify");
	const original: unknown = desc?.value;
	if (typeof original !== "function") return false;
	if (wrappedBy(original, token)) return true;
	const wrapper = make(original as AnyFn) as WrappedFn;
	wrapper[DIALOG_WRAP] = { token, original: original as AnyFn };
	try {
		Object.defineProperty(ui, "notify", { value: wrapper, writable: true, configurable: true, enumerable: desc?.enumerable ?? true });
	} catch {
		return false;
	}
	return true;
}

/**
 * Puts `make(name, original)` in place of each dialog member of `ui` that does not carry this copy's
 * wrapper yet (a fresh UI context after a mode re-init, or a wrapper of another bridge copy, which
 * stays underneath). Assigning through omp's proxy lands on its target, so omp's tools and handlers
 * (which read members on every access) call the wrapper. Returns whether `select` is wrapped.
 */
export function installDialogWrappers(ui: object, token: object, make: (name: DialogMember, original: AnyFn) => AnyFn): boolean {
	for (const name of DIALOG_MEMBERS) {
		const desc = ownMember(ui, name);
		const original: unknown = desc?.value;
		if (typeof original !== "function" || wrappedBy(original, token)) continue;
		const wrapper = make(name, original as AnyFn) as WrappedFn;
		wrapper[DIALOG_WRAP] = { token, original: original as AnyFn };
		try {
			Object.defineProperty(ui, name, { value: wrapper, writable: true, configurable: true, enumerable: desc?.enumerable ?? true });
		} catch {
			// a frozen UI context: its dialogs stay local
		}
	}
	return wrappedBy(ownMember(ui, "select")?.value, token);
}

/** omp's `toWireSelectOptions`. */
const wireSelectOptions = (options: readonly unknown[]): WireSelectItem[] =>
	options.map(o => {
		if (typeof o === "string") return o;
		const label = strField(o, "label") ?? String(o);
		const description = strField(o, "description");
		return description ? { label, description } : { label };
	});

const numberField = (o: Json | undefined, key: string): number | undefined => {
	const v = o?.[key];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/**
 * One wrapped dialog call: hostd's draft for `name` and the race (omp's collab mirroring for
 * select / editor / approve / ask, the same select / editor mapping for confirm and input, which
 * omp keeps local). `undefined` when the arguments are not what omp passes: the caller runs the
 * original alone.
 */
export function raceMember(
	hub: DialogHub,
	name: DialogMember,
	original: AnyFn,
	self: unknown,
	args: unknown[],
	approval: ApprovalLabels,
): Promise<unknown> | undefined {
	const optsAt = (i: number): Json | undefined => {
		const arg = args[i];
		return isObj(arg) ? arg : undefined;
	};
	/** The original with `signal` in the options argument at `i` (the race's local side). */
	const local = (i: number) => (signal: AbortSignal) => {
		const patched = [...args];
		while (patched.length < i) patched.push(undefined);
		patched[i] = { ...optsAt(i), signal };
		return original.apply(self, patched);
	};
	const signalAt = (i: number): AbortSignal | undefined => {
		const s = optsAt(i)?.signal;
		return s instanceof AbortSignal ? s : undefined;
	};
	const same = (v: string | undefined) => v;
	switch (name) {
		case "select": {
			const [title, options] = args;
			if (typeof title !== "string" || !Array.isArray(options)) return undefined;
			const opts = optsAt(2);
			const marker = opts?.selectionMarker;
			const checked = opts?.checkedIndices;
			const draft: DialogDraft = {
				kind: "select",
				title,
				options: wireSelectOptions(options),
				initialIndex: numberField(opts, "initialIndex"),
				selectionMarker: marker === "radio" || marker === "checkbox" ? marker : undefined,
				checkedIndices: Array.isArray(checked) ? checked.filter((n): n is number => typeof n === "number") : undefined,
				markableCount: numberField(opts, "markableCount"),
				helpText: typeof opts?.helpText === "string" ? opts.helpText : undefined,
			};
			return raceDialog(hub, draft, signalAt(2), local(2), same);
		}
		case "editor": {
			const [title, prefill] = args;
			if (typeof title !== "string") return undefined;
			const draft: DialogDraft = { kind: "editor", title, prefill: typeof prefill === "string" ? prefill : undefined };
			return raceDialog(hub, draft, signalAt(2), local(2), same);
		}
		case "input": {
			const [title] = args;
			if (typeof title !== "string") return undefined;
			return raceDialog(hub, { kind: "editor", title }, signalAt(2), local(2), same);
		}
		case "confirm": {
			const [title, message] = args;
			if (typeof title !== "string") return undefined;
			const text = typeof message === "string" && message ? `${title}\n${message}` : title;
			return raceDialog(hub, { kind: "select", title: text, options: ["Yes", "No"] }, signalAt(2), local(2), v => v === "Yes");
		}
		case "approve": {
			const [prompt] = args;
			if (!isObj(prompt) || typeof prompt.full !== "string") return undefined;
			const p = prompt as unknown as ApprovalPrompt;
			const draft: DialogDraft = { kind: "select", title: p.full, options: approval.approvalChoiceLabels(p) };
			return raceDialog(hub, draft, signalAt(1), local(1), v => approval.approvalAnswerForChoice(p, v));
		}
		case "askDialog": {
			const [questions] = args;
			if (!Array.isArray(questions)) return undefined;
			return raceAsk(hub, questions, signalAt(1), local(1));
		}
	}
}

// ─── protocol v2: omp internals ────────────────────────────────────────────────────────────────
// The data plane reads a few omp internals, each feature-detected: without one, the feature it
// serves is off (`hello.caps`) or falls back to the public extension API.

/** The slice of omp's AgentSession the data plane uses (from `AgentRegistry` refs). */
interface AgentSessionLike {
	subscribe(listener: (event: Json) => void): () => void;
	readonly isStreaming?: boolean;
	readonly isAborting?: boolean;
	readonly queuedMessageCount?: number;
	readonly sessionName?: string;
	readonly model?: unknown;
	readonly thinkingLevel?: string;
	readonly sessionManager?: { getSessionId?(): string };
	readonly agent?: { state?: { streamMessage?: unknown } };
	activeToolExecutionUpdates?(): readonly Json[];
	prompt?(text: string, options?: Json): Promise<unknown>;
	abort?(options?: Json): Promise<void>;
}
interface AgentRefLike {
	id: string;
	displayName?: string;
	kind?: string;
	parentId?: string;
	status?: string;
	session?: unknown;
	sessionFile?: string | null;
	createdAt?: number;
	lastActivity?: number;
}
interface AgentRegistryLike {
	get(id: string): AgentRefLike | undefined;
	list(): AgentRefLike[];
	onChange?(listener: () => void): () => void;
}
interface LifecycleLike {
	ensureLive(id: string): Promise<unknown>;
	release(id: string, expected?: unknown, options?: { tombstone?: boolean }): Promise<boolean>;
}
interface Internals {
	/** `AgentRegistry.global()`: roster, subagent refs and the main AgentSession. */
	registry?: AgentRegistryLike;
	/** `AgentLifecycleManager` (only omp's own module instance: its registry is module state). */
	lifecycle?: { global(): LifecycleLike };
	interruptLabel: string;
	approval: ApprovalLabels;
	/** 2.1.0 `roleModels`: omp's live Settings and its `modelRoles` / `retry.fallbackChains` handles. */
	roles?: RoleSettings;
	/** 2.1.0 `retry` / `resumeTree` / `turnError` / `limitGuard`: omp's error classifier and task internals. */
	resume?: ResumeInternals;
}

const isSession = (s: unknown): s is AgentSessionLike => !!s && typeof s === "object" && "subscribe" in s && typeof s.subscribe === "function";
const hasGlobal = (v: unknown): v is { global(): unknown } => typeof v === "function" && "global" in v && typeof v.global === "function";

/** `p`, or `undefined` once it rejects or `ms` passed. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	const { promise, resolve } = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => resolve(undefined), ms);
	timer.unref?.();
	try {
		return await Promise.race([p, promise]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** The model fields hostd reads (`state.model`), without provider headers or compat flags. */
const MODEL_FIELDS = ["id", "name", "api", "provider", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens"] as const;
function modelWire(model: unknown): Json | undefined {
	if (!isObj(model)) return undefined;
	const out: Json = {};
	for (const key of MODEL_FIELDS) if (model[key] !== undefined) out[key] = model[key];
	return out;
}

/** omp materializes a fresh session's file only with its first assistant message. */
function sessionOnDisk(sm: object, file: string | undefined): boolean {
	if ("isSessionOnDisk" in sm && typeof sm.isSessionOnDisk === "function") {
		try {
			return sm.isSessionOnDisk() === true;
		} catch {
			// fall back to the file itself
		}
	}
	return !!file && fs.existsSync(file);
}

// ─── per-session model roles (2.1.0, `caps.roleModels`) ─────────────────────────────────────────
// One session's own omp model roles and retry fallback chains (docs/bridge-protocol.md "2.1.0").
// They live in omp's runtime override layer of the process's Settings (`Setting.override`, the
// layer omp itself uses for `--model` and subagent routing), above every config file; the host's
// config is never written. tf-hostd also rewrites the agent's `--config` overlay with the same
// map (what a resume starts from); `setRoleModels` reloads that file first.

/** omp's built-in roles (`config/model-roles.ts`): chat roles, then model-kind roles. */
const BUILTIN_ROLES = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor", "widget", "image", "web", "speech", "dictation", "judge"];
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Keys never copied into a result object. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The slice of omp's `Settings` (the process's live instance) the role ops use. */
export interface RoleStore {
	getModelRole(role: string): string | undefined;
	getModelRoles(): Record<string, string>;
	getModelRoleProvenance(role: string): string;
	getGlobalModelRole(role: string): string | undefined;
	getProjectModelRole(role: string): string | undefined;
	getGlobalSettings(): unknown;
	getProjectSettings(): unknown;
	getConfigFiles(): readonly string[];
	reloadFromDisk(): Promise<void>;
}
/** A registered omp setting (`config/registry` `Setting`). */
export interface SettingHandle<T> {
	get(scope: unknown): T;
	override(scope: unknown, value: T): void;
	clearOverride(scope: unknown): void;
}
export interface RoleSettings {
	store(): RoleStore;
	/** `modelRoles` (`config/model-settings`). */
	roles: SettingHandle<Record<string, string>>;
	/** `retry.fallbackChains` (`session/settings`). */
	chains: SettingHandle<Record<string, string[]>>;
}
/** `getRoleModels` / `setRoleModels` result. */
export interface RoleModelsView {
	/** Roles the session's own layers set: runtime overrides (`--model`, `PI_*_MODEL`, this op) and `--config` overlays. */
	session: Record<string, string>;
	/** What the host's config assigns (project over global). */
	host: Record<string, string>;
	sessionChains: Record<string, string[]>;
	hostChains: Record<string, string[]>;
	/** The session's model now (`provider/id`). */
	active?: string;
	/** The `--config` overlays omp was started with. */
	overlays: string[];
	warning?: string;
}

/** `layer.<path…>` of a raw settings layer. */
function at(layer: unknown, ...keys: string[]): unknown {
	let v = layer;
	for (const k of keys) v = isObj(v) ? v[k] : undefined;
	return v;
}

/** The `retry.fallbackChains` entries of a value whose chains are string lists. */
function chainsOf(v: unknown): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	if (!isObj(v)) return out;
	for (const [k, list] of Object.entries(v)) {
		if (UNSAFE_KEYS.has(k) || !Array.isArray(list)) continue;
		out[k] = list.filter((s): s is string => typeof s === "string");
	}
	return out;
}

/** The session's own and the host's roles and chains. A session chain equal to the host's chain of
 *  the same key reads as the host's. */
export function readRoleModels(rs: RoleSettings, active?: string): RoleModelsView {
	const store = rs.store();
	const global = store.getGlobalSettings();
	const project = store.getProjectSettings();
	const names = new Set<string>(BUILTIN_ROLES);
	for (const roles of [store.getModelRoles(), at(global, "modelRoles"), at(project, "modelRoles")]) {
		if (isObj(roles)) for (const k of Object.keys(roles)) if (!UNSAFE_KEYS.has(k)) names.add(k);
	}
	const session: Record<string, string> = {};
	const host: Record<string, string> = {};
	for (const role of names) {
		const hostValue = store.getProjectModelRole(role) ?? store.getGlobalModelRole(role);
		if (hostValue) host[role] = hostValue;
		const layer = store.getModelRoleProvenance(role);
		if (layer === "runtime" || layer === "overlay") {
			const value = store.getModelRole(role);
			if (value) session[role] = value;
		}
	}
	const hostChains = { ...chainsOf(at(global, "retry", "fallbackChains")), ...chainsOf(at(project, "retry", "fallbackChains")) };
	const sessionChains: Record<string, string[]> = {};
	for (const [key, chain] of Object.entries(chainsOf(rs.chains.get(store)))) {
		const hostChain = Object.hasOwn(hostChains, key) ? hostChains[key] : undefined;
		if (!hostChain || hostChain.length !== chain.length || hostChain.some((s, i) => s !== chain[i])) sessionChains[key] = chain;
	}
	return { session, host, sessionChains, hostChains, active, overlays: [...store.getConfigFiles()] };
}

/** `setRoleModels` params: the session's complete own roles and chains, and the overlay hostd rewrote. */
export interface RoleModelsRequest {
	roles: Record<string, string>;
	chains: Record<string, string[]>;
	overlay?: string;
}

const selectorOk = (s: string): boolean => s.length > 0 && s.length <= 256 && !/\s/.test(s) && /^[^/]+\/.+$/.test(s);

/** Checks and copies `setRoleModels` params (hostd validates the same rules first). */
export function roleModelsRequest(p: Params): RoleModelsRequest {
	const roles: Record<string, string> = {};
	const rawRoles = p.roles ?? {};
	if (!isObj(rawRoles)) return fail("invalid_params", '"roles" must be an object');
	for (const [role, value] of Object.entries(rawRoles)) {
		if (!ROLE_NAME.test(role)) fail("invalid_params", `bad role name ${JSON.stringify(role)}`);
		if (typeof value !== "string" || !value.split(",").every(selectorOk)) fail("invalid_params", `role ${role}: bad selector ${JSON.stringify(value)}`);
		roles[role] = value as string;
	}
	const chains: Record<string, string[]> = {};
	const rawChains = p.fallbackChains ?? {};
	if (!isObj(rawChains)) return fail("invalid_params", '"fallbackChains" must be an object');
	for (const [key, list] of Object.entries(rawChains)) {
		if (!ROLE_NAME.test(key) && !selectorOk(key)) fail("invalid_params", `bad fallback chain key ${JSON.stringify(key)}`);
		if (!Array.isArray(list) || !list.every(s => typeof s === "string" && selectorOk(s))) fail("invalid_params", `fallback chain ${key}: bad selectors`);
		chains[key] = [...(list as string[])];
	}
	return { roles, chains, overlay: str(p, "overlay") };
}

/**
 * Makes `req` the session's own roles and chains: reloads the overlay hostd rewrote (when omp was
 * started with it), then replaces omp's runtime `modelRoles` / `retry.fallbackChains` overrides
 * with them (a role or key left out falls back to the overlay, then the host's config). When the
 * effective `default` role changed, `switchDefault` moves the session onto it; returns its warning.
 */
export async function applyRoleModels(rs: RoleSettings, req: RoleModelsRequest, switchDefault: (selector: string) => Promise<string | undefined>): Promise<string | undefined> {
	const store = rs.store();
	const before = store.getModelRole("default");
	if (req.overlay) {
		const want = path.resolve(req.overlay);
		if (store.getConfigFiles().some(f => path.resolve(f) === want)) await store.reloadFromDisk();
	}
	if (Object.keys(req.roles).length > 0) rs.roles.override(store, { ...req.roles });
	else rs.roles.clearOverride(store);
	if (Object.keys(req.chains).length > 0) rs.chains.override(store, Object.fromEntries(Object.entries(req.chains).map(([k, v]) => [k, [...v]])));
	else rs.chains.clearOverride(store);
	const after = store.getModelRole("default");
	return after && after !== before ? switchDefault(after) : undefined;
}

/** `provider/id[:level]` → the thinking level it names, if any (a non-level suffix is part of the id). */
export function selectorLevel(selector: string): string | undefined {
	const first = selector.split(",")[0]?.trim() ?? "";
	const i = first.lastIndexOf(":");
	const level = i > 0 ? first.slice(i + 1) : "";
	return Object.hasOwn(THINKING_LEVELS, level) ? level : undefined;
}

const isHandle = <T>(v: unknown): v is SettingHandle<T> =>
	isObj(v) && typeof v.get === "function" && typeof v.override === "function" && typeof v.clearOverride === "function";

/** omp's live `Settings` and its `modelRoles` / `retry.fallbackChains` handles, when this omp has
 *  them and the subpath imports resolve to the modules omp runs (the root export's `Settings`). */
async function probeRoleSettings(ns: Record<string, unknown>, load: (mod: Promise<unknown>) => Promise<Json | undefined>): Promise<RoleSettings | undefined> {
	const [settingsMod, modelMod, sessionMod] = await Promise.all([
		load(import("@oh-my-pi/pi-coding-agent/config/settings")),
		load(import("@oh-my-pi/pi-coding-agent/config/model-settings")),
		load(import("@oh-my-pi/pi-coding-agent/session/settings")),
	]);
	const settings = settingsMod?.Settings;
	// Another module instance would hold its own, uninitialised Settings.
	if (!isObj(settings) && typeof settings !== "function") return undefined;
	if (ns.Settings !== undefined && ns.Settings !== settings) return undefined;
	const roles: unknown = modelMod?.cfgModelRoles;
	const chains: unknown = sessionMod?.cfgRetryFallbackChains;
	if (!isHandle<Record<string, string>>(roles) || !isHandle<Record<string, string[]>>(chains)) return undefined;
	const isStore = (s: unknown): s is RoleStore =>
		isObj(s) && ["getModelRole", "getModelRoles", "getModelRoleProvenance", "getGlobalModelRole", "getProjectModelRole", "getConfigFiles", "reloadFromDisk"].every(m => typeof s[m] === "function");
	// `Settings.instance` throws until omp initialised it (always done before extensions load).
	const store = (): RoleStore => {
		const s: unknown = "instance" in settings ? settings.instance : undefined;
		if (!isStore(s)) throw new BridgeError("unsupported", "omp's settings are not available in this omp");
		return s;
	};
	try {
		store();
	} catch {
		return undefined;
	}
	return { store, roles, chains };
}

// ─── 2.1.0: context breakdown (`caps.context`) ─────────────────────────────────────────────────
// What fills the session's context window (docs/bridge-protocol.md "Context breakdown"): the data
// of omp's own `/context` viewer (`session/context-view` `buildSessionContextView`, omp ≥ 18.13.2),
// attributed to the session's usage exactly as that viewer's overview does (`allocateUsage`). An omp
// without the viewer gets an estimate from the session's own parts; without omp's AgentSession, the
// totals of `ctx.getContextUsage()` alone.

/** omp's `ContextViewEntry` (pi-tui `chrome/context-view-model`). */
export interface ContextEntryLike {
	readonly id: string;
	readonly label: string;
	readonly text: string;
	readonly tokens: number;
	readonly info?: string;
	readonly timestamp?: number;
	readonly callId?: string;
	/** Thinking blocks of one message share one weight, held by their group. */
	readonly thinkingGroup?: { readonly id: string; readonly label: string; readonly tokens: number };
}
/** omp's `ContextViewCategory`. */
export interface ContextCategoryLike {
	readonly id: string;
	readonly label: string;
	/** omp's estimate: the weight the overview attributes usage by. */
	readonly tokens: number;
	readonly entries: readonly ContextEntryLike[];
	readonly children?: readonly ContextCategoryLike[];
}
/** omp's `ContextViewData` (`breakdown`: pi-tui `status-line/context-usage` `ContextBreakdown`). */
export interface ContextViewLike {
	readonly breakdown: {
		readonly model?: { readonly name?: string; readonly id?: string } | null;
		readonly contextWindow: number;
		readonly usedTokens: number;
		readonly autoCompactBufferTokens: number;
		readonly freeTokens: number;
		readonly thresholdTokens?: number;
		readonly snapcompact?: { readonly savedTokens?: number };
	};
	readonly categories: readonly ContextCategoryLike[];
}
/** omp's context modules, when this omp has them. */
export interface ContextModules {
	/** `session/context-view` `buildSessionContextView` (omp ≥ 18.13.2). */
	buildView?: (session: unknown) => ContextViewLike;
	/** pi-tui `overlays/context-viewer-overview`: the overview's own attribution and labels. */
	allocate?: (categories: readonly ContextCategoryLike[], usage: number) => ReadonlyMap<ContextCategoryLike, number> | undefined;
	overviewLabel?: (category: ContextCategoryLike) => string;
}
/** The slice of omp's AgentSession the estimate reads. */
export interface ContextSessionLike {
	readonly model?: { readonly name?: string; readonly id?: string; readonly contextWindow?: number } | null;
	readonly systemPrompt?: readonly string[];
	readonly messages?: readonly unknown[];
	readonly agent?: {
		readonly tokenizer?: { countTokens?(text: string): number };
		readonly state?: { readonly tools?: readonly unknown[]; readonly messages?: readonly unknown[] };
	};
	hasBuiltInTool?(name: string): boolean;
	dropImages?(): unknown;
}

/** omp's categories in viewer order, with the Overview label where it differs (pi-tui `CONTEXT_CATEGORIES`). */
const CONTEXT_CATEGORIES: readonly { id: string; label: string; overview?: string }[] = [
	{ id: "system-prompt", label: "System Prompt", overview: "System Prompt (excluding Skills)" },
	{ id: "skills", label: "Skills" },
	{ id: "built-in-tools", label: "Built-in Tools" },
	{ id: "custom-tools", label: "Custom Tools" },
	{ id: "user-messages", label: "User / Developer Messages" },
	{ id: "assistant-messages", label: "Assistant Messages" },
	{ id: "assistant-thinking", label: "Assistant Thinking" },
	{ id: "tool-calls", label: "Tool Calls" },
	{ id: "tool-output", label: "Tool Output" },
];
const CONTEXT_PREVIEW = 240;
/** Biggest entries sent per category; tool output, which usually fills a window, gets more. */
const CONTEXT_TOP = 5;
const CONTEXT_TOP_TOOL_OUTPUT = 10;

/** omp's `allocateTokens` (pi-tui `overlays/context-viewer-overview`): largest-remainder split of `total` by `weights`. */
export function allocateTokens(weights: readonly number[], total: number): number[] | undefined {
	const sum = weights.reduce((value, weight) => value + weight, 0);
	if (!(sum > 0) || !Number.isFinite(sum)) return undefined;
	const shares = weights.map((weight, index) => {
		const exact = (total * weight) / sum;
		return { index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	const remaining = total - shares.reduce((value, share) => value + share.tokens, 0);
	const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let index = 0; index < remaining && index < ranked.length; index++) ranked[index]!.tokens++;
	return shares.map(share => share.tokens);
}

/** omp's `allocateUsage`: usage to the categories by weight, then each category's share to its children. */
export function allocateUsage(categories: readonly ContextCategoryLike[], usage: number): Map<ContextCategoryLike, number> | undefined {
	const allocation = new Map<ContextCategoryLike, number>();
	const allocate = (siblings: readonly ContextCategoryLike[], total: number): boolean => {
		const shares = allocateTokens(
			siblings.map(category => category.tokens),
			total,
		);
		if (!shares) return false;
		for (const [index, category] of siblings.entries()) {
			allocation.set(category, shares[index]!);
			if (category.children) allocate(category.children, shares[index]!);
		}
		return true;
	};
	return allocate(categories, usage) ? allocation : undefined;
}

/** The start of an entry's text on one line. */
export function contextPreview(text: string): string {
	const flat = text.slice(0, CONTEXT_PREVIEW * 4).replace(/\s+/g, " ").trim();
	return flat.length > CONTEXT_PREVIEW ? `${flat.slice(0, CONTEXT_PREVIEW - 1)}…` : flat;
}

const wholeTokens = (n: number | undefined): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined);

/** A category's biggest entries, biggest first. Thinking blocks of one message count once, as their group. */
function biggestEntries(category: ContextCategoryLike, n: number): Json[] {
	const items: { entry: ContextEntryLike; label: string; tokens: number; index: number }[] = [];
	const groups = new Set<string>();
	for (const [index, entry] of category.entries.entries()) {
		const group = entry.thinkingGroup;
		if (group) {
			if (groups.has(group.id)) continue;
			groups.add(group.id);
		}
		items.push({ entry, label: group ? `Thinking · ${group.label}` : entry.label, tokens: group ? group.tokens : entry.tokens, index });
	}
	items.sort((a, b) => b.tokens - a.tokens || a.index - b.index);
	return items.slice(0, n).map(({ entry, label, tokens }) => ({
		id: entry.id,
		label,
		info: entry.info,
		tokens: wholeTokens(tokens) ?? 0,
		preview: contextPreview(entry.text),
		chars: entry.text.length,
		at: entry.timestamp,
		callId: entry.callId,
	}));
}

/** The `context` op's answer from omp's viewer data (or an estimate shaped like it). */
export function summarizeContextView(
	view: ContextViewLike,
	opts: { source: "omp" | "estimate"; images: number; dropImages: boolean; modules?: ContextModules; now?: number },
): Json {
	const b = view.breakdown;
	const allocation = (opts.modules?.allocate ?? allocateUsage)(view.categories, b.usedTokens);
	const label = (category: ContextCategoryLike): string => {
		try {
			if (opts.modules?.overviewLabel) return opts.modules.overviewLabel(category);
		} catch {
			// the table below
		}
		return CONTEXT_CATEGORIES.find(d => d.id === category.id)?.overview ?? category.label;
	};
	return {
		source: opts.source,
		model: b.model?.name || b.model?.id || undefined,
		window: wholeTokens(b.contextWindow) ?? 0,
		used: wholeTokens(b.usedTokens) ?? 0,
		buffer: wholeTokens(b.autoCompactBufferTokens) ?? 0,
		free: wholeTokens(b.freeTokens) ?? 0,
		threshold: wholeTokens(b.thresholdTokens),
		categories: view.categories.map(category => ({
			id: category.id,
			label: label(category),
			tokens: wholeTokens(allocation?.get(category)),
			weight: wholeTokens(category.tokens) ?? 0,
			entries: category.entries.length,
			children: (category.children ?? []).map(child => ({
				label: child.label,
				tokens: wholeTokens(allocation?.get(child)),
				weight: wholeTokens(child.tokens) ?? 0,
				entries: child.entries.length,
			})),
			top: biggestEntries(category, category.id === "tool-output" ? CONTEXT_TOP_TOOL_OUTPUT : CONTEXT_TOP),
		})),
		images: opts.images,
		dropImages: opts.dropImages,
		snapcompactSaved: wholeTokens(b.snapcompact?.savedTokens) || undefined,
		at: opts.now ?? Date.now(),
	};
}

/** Image blocks in a session's context messages (what omp's `/shake images` takes out of it). */
export function countContextImages(messages: readonly unknown[] | undefined): number {
	let n = 0;
	for (const m of messages ?? []) {
		if (!isObj(m) || !Array.isArray(m.content)) continue;
		for (const block of m.content) if (isObj(block) && block.type === "image") n++;
	}
	return n;
}

function contextBlockText(block: Json): string {
	switch (block.type) {
		case "text":
			return String(block.text ?? "");
		case "thinking":
			return String(block.thinking ?? "");
		case "image":
			return `[image · ${String(block.mimeType ?? "image")}]`;
		case "toolCall":
			return `${String(block.name ?? "")} ${JSON.stringify(block.arguments ?? null)}`;
		default:
			return "";
	}
}

/**
 * Data shaped like omp's viewer for an omp without it: each system prompt block, tool definition and
 * message part counted with the session's tokenizer (else 4 characters a token); the overview then
 * splits omp's reported usage by these counts. No auto-compaction buffer: its settings are omp's.
 */
export function estimateContextView(session: ContextSessionLike, usage: { tokens?: number | null; contextWindow?: number } | undefined): ContextViewLike {
	const tokenizer = session.agent?.tokenizer;
	const count = (text: string): number => {
		try {
			const n = tokenizer?.countTokens?.(text);
			if (typeof n === "number" && Number.isFinite(n)) return n;
		} catch {
			// estimated below
		}
		return Math.ceil(text.length / 4);
	};
	type Category = { id: string; label: string; tokens: number; entries: ContextEntryLike[]; children?: Category[] };
	const categories: Category[] = CONTEXT_CATEGORIES.map(d => ({ id: d.id, label: d.label, tokens: 0, entries: [] }));
	const byId = new Map(categories.map(c => [c.id, c]));
	const add = (id: string, entry: Omit<ContextEntryLike, "tokens">, tool?: string): void => {
		const category = byId.get(id)!;
		const sized = { ...entry, tokens: count(entry.text) };
		category.entries.push(sized);
		category.tokens += sized.tokens;
		if (tool === undefined) return;
		category.children ??= [];
		let group = category.children.find(g => g.label === tool);
		if (!group) {
			group = { id, label: tool, tokens: 0, entries: [] };
			category.children.push(group);
		}
		group.entries.push(sized);
		group.tokens += sized.tokens;
	};
	for (const [i, block] of (session.systemPrompt ?? []).entries()) add("system-prompt", { id: `system-prompt/${i}`, label: `System Block ${i + 1}`, text: String(block ?? "") });
	for (const [i, tool] of (session.agent?.state?.tools ?? []).entries()) {
		if (!isObj(tool)) continue;
		const name = String(tool.name ?? "tool");
		let builtIn = true;
		try {
			builtIn = session.hasBuiltInTool?.(name) ?? true;
		} catch {
			// counted as built in
		}
		const id = builtIn ? "built-in-tools" : "custom-tools";
		add(id, { id: `${id}/${i}`, label: name, text: JSON.stringify({ name, description: tool.description, parameters: tool.parameters }) });
	}
	const messages = session.agent?.state?.messages ?? session.messages ?? [];
	for (const [i, m] of messages.entries()) {
		if (!isObj(m)) continue;
		const at = typeof m.timestamp === "number" ? m.timestamp : undefined;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const [j, block] of m.content.entries()) {
				if (!isObj(block)) continue;
				const id = block.type === "toolCall" ? "tool-calls" : block.type === "thinking" || block.type === "redactedThinking" ? "assistant-thinking" : "assistant-messages";
				const label = block.type === "toolCall" ? String(block.name ?? "tool") : `${String(block.type)} · message ${i + 1}`;
				add(id, { id: `${id}/${i}/${j}`, label, text: contextBlockText(block), timestamp: at, callId: typeof block.id === "string" && block.type === "toolCall" ? block.id : undefined });
			}
			continue;
		}
		const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(isObj).map(contextBlockText).join("\n") : "";
		const tool = m.role === "toolResult" ? String(m.toolName ?? "tool") : m.role === "bashExecution" ? "bash" : m.role === "pythonExecution" ? "python" : undefined;
		if (tool !== undefined) {
			const callId = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
			add("tool-output", { id: `tool-output/${i}`, label: tool, text: text || String(m.output ?? ""), timestamp: at, callId }, tool);
		} else {
			add("user-messages", { id: `user-messages/${i}`, label: `${String(m.role ?? "user")} · message ${i + 1}`, text, timestamp: at });
		}
	}
	byId.get("tool-output")!.children?.sort((a, b) => b.tokens - a.tokens);
	const sum = categories.reduce((total, c) => total + c.tokens, 0);
	const window = usage?.contextWindow ?? session.model?.contextWindow ?? 0;
	const used = typeof usage?.tokens === "number" ? usage.tokens : sum;
	return {
		breakdown: { model: session.model, contextWindow: window, usedTokens: used, autoCompactBufferTokens: 0, freeTokens: Math.max(0, window - used) },
		categories,
	};
}

/** omp's context modules: a root export when omp has one, else the literal subpath imports omp's
 *  extension loader maps to its own modules. Loaded on the first `context` request. */
async function probeContextModules(ns: Record<string, unknown>): Promise<ContextModules> {
	const load = (mod: Promise<unknown>): Promise<Json | undefined> => settleWithin(mod, 3_000).then(m => (isObj(m) ? m : undefined));
	const fn = <T>(v: unknown): T | undefined => (typeof v === "function" ? (v as T) : undefined);
	const [viewMod, overviewMod] = await Promise.all([
		fn(ns.buildSessionContextView) ? undefined : load(import("@oh-my-pi/pi-coding-agent/session/context-view")),
		fn(ns.allocateUsage) ? undefined : load(import("@oh-my-pi/pi-tui/overlays/context-viewer-overview")),
	]);
	return {
		buildView: fn(ns.buildSessionContextView) ?? fn(viewMod?.buildSessionContextView),
		allocate: fn(ns.allocateUsage) ?? fn(overviewMod?.allocateUsage),
		overviewLabel: fn(ns.overviewLabel) ?? fn(overviewMod?.overviewLabel),
	};
}

/**
 * Schema-dump mode (`TF_OMP_SCHEMA_OUT=<file>`; docs/bridge-protocol.md "Schema dump"): tf-hostd
 * starts a throwaway headless omp with this extension to read omp's settings schema. Writes
 * `{bridgeVersion, ompVersion, settings: <definition>[] | null, error?}` atomically to the file, then
 * exits the process. Functions (validators, env parsers) are dropped by JSON serialization.
 */
async function dumpSchema(pi: ExtensionAPI, out: string): Promise<void> {
	let settings: unknown[] | null = null;
	let error: string | undefined;
	try {
		// Dynamic, not static: older omp builds lack this module (a static import would break the whole
		// bridge there) and normal sessions must not load every settings domain. The specifier stays a
		// literal: omp's extension loader only maps statically named package paths.
		const mod: { orderedSettings?: () => readonly { definition?: unknown }[] } = await import(
			"@oh-my-pi/pi-coding-agent/config/all-settings"
		);
		if (typeof mod.orderedSettings !== "function") throw new Error("orderedSettings() not exported");
		settings = mod.orderedSettings().map((s) => plainDefinition(s.definition));
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	let code = 0;
	try {
		const json = JSON.stringify({ bridgeVersion: BRIDGE_VERSION, ompVersion: ompVersion(pi), settings, error });
		const tmp = `${out}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, json, { mode: 0o600 });
		fs.renameSync(tmp, out);
	} catch {
		code = 1;
	}
	// omp refuses `process.exit` while it loads extensions: exit right after loading instead
	// (tf-hostd also kills the process once the file is in).
	setTimeout(() => process.exit(code), 0);
}

/** One definition as plain JSON (functions dropped); only `id`/`type` when it cannot be serialized. */
function plainDefinition(def: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(def, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v)));
	} catch {
		const d = (def ?? {}) as { id?: unknown; type?: unknown };
		return { id: d.id, type: d.type };
	}
}

/** One `config set|reset` of the settings-write input: `text` as `omp config set <key> <text>` takes it; absent / null resets. */
type SettingWrite = { key: string; text?: string | null };
/** The slice of omp's setting objects (`orderedSettings()`) the write mode uses. */
type WritableSetting = { id: string; parse(text: string): unknown; set(s: unknown, v: unknown): void; unset(s: unknown): void };

/**
 * Settings-write mode (`TF_OMP_SETTINGS_IN=<file>` + `TF_OMP_SETTINGS_OUT=<file>`; docs/bridge-protocol.md
 * "Settings write"): tf-hostd starts a throwaway headless omp with this extension to write settings whose
 * values must not appear in any command line (credentials). Reads `{changes: SettingWrite[]}` from the
 * owner-only input file and deletes it at once, then applies the changes in order through omp's own
 * Settings API exactly like `omp config set|reset` (`parse` → `set` / `unset`, then `flush`), stopping at
 * the first failure. Writes `{bridgeVersion, results: {key, ok, error?}[], error?}` atomically to the
 * output file and exits. Values are never echoed.
 */
async function writeSettings(input: string, out: string): Promise<void> {
	const results: { key: string; ok: boolean; error?: string }[] = [];
	let error: string | undefined;
	let changes: SettingWrite[] | undefined;
	try {
		const req = JSON.parse(fs.readFileSync(input, "utf8")) as { changes?: unknown };
		if (!Array.isArray(req.changes)) throw new Error("no `changes` array");
		changes = req.changes as SettingWrite[];
	} catch (e) {
		error = `settings input: ${e instanceof Error ? e.message : String(e)}`;
	} finally {
		try {
			fs.rmSync(input, { force: true });
		} catch {
			// tf-hostd removes it as well
		}
	}
	if (changes) {
		try {
			// Dynamic for the same reasons as the schema dump (older omp builds, literal specifiers).
			const settingsMod: { Settings?: { instance?: { flush(): Promise<void> } } } = await import(
				"@oh-my-pi/pi-coding-agent/config/settings"
			);
			const all: { orderedSettings?: () => readonly WritableSetting[] } = await import(
				"@oh-my-pi/pi-coding-agent/config/all-settings"
			);
			const store = settingsMod.Settings?.instance;
			if (!store) throw new Error("omp settings are not initialized");
			if (typeof all.orderedSettings !== "function") throw new Error("orderedSettings() not exported");
			const byId = new Map(all.orderedSettings().map((s) => [s.id, s]));
			for (const c of changes) {
				const key = typeof c?.key === "string" ? c.key : "";
				const setting = byId.get(key);
				if (!setting) {
					results.push({ key, ok: false, error: `Unknown setting: ${key}` });
					break;
				}
				try {
					if (typeof c.text === "string") setting.set(store, setting.parse(c.text));
					else setting.unset(store);
					results.push({ key, ok: true });
				} catch (e) {
					results.push({ key, ok: false, error: e instanceof Error ? e.message : String(e) });
					break;
				}
			}
			await store.flush();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
	let code = 0;
	try {
		const json = JSON.stringify({ bridgeVersion: BRIDGE_VERSION, results, error });
		const tmp = `${out}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, json, { mode: 0o600 });
		fs.renameSync(tmp, out);
	} catch {
		code = 1;
	}
	setTimeout(() => process.exit(code), 0);
}

// ─── 2.1.0: resume (omp's F5, subagent resume, turn errors, the limit guard) ─────────────────────
// docs/bridge-protocol.md "Resume". Every retry is omp's own `AgentSession.retry()` (F5, `/retry`):
// it removes the failed or aborted assistant tail (with its synthetic tool results), resets the
// retry budget and continues without a new prompt. A subagent is resumed the way `omp --restore`
// resumes one (task/restore.ts): one more `runSubagentFollowUpTurn` registered as a background job
// of its parent, so the parent receives the ordinary `async-result` under the subagent's id.

/** The parts of pi-ai's error classifier (`@oh-my-pi/pi-ai/error`) the bridge reads. */
export interface ErrorClassifier {
	classifyMessage(message: Json): number;
	is(id: number | undefined, flag: number): boolean;
	Flag: { UsageLimit: number };
	parseRateLimitReason?(message: string): string;
}
/** pi-ai's `extractProviderRetryHint`: ms until the provider says to try again, when it said. */
export type RetryHint = (provider: string | undefined, message: string | undefined) => number | undefined;

export type LimitClass = "usageLimit" | "rateLimit" | "other";

/** omp's rate-limit reasons (pi-ai `parseRateLimitReason`) that clear by themselves. */
const TRANSIENT_LIMIT_REASONS: Record<string, true> = { RATE_LIMIT_EXCEEDED: true, CONCURRENT_LIMIT: true, MODEL_CAPACITY_EXHAUSTED: true };
// Fallbacks for an omp whose classifier cannot be imported (pi-ai's own patterns are richer).
const USAGE_LIMIT_TEXT =
	/usage.?limit|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient|will reset)|insufficient.?(?:balance|quota)|balance.?exhausted|out of (?:extra )?(?:credits|usage)|spend(?:ing)?[\s_-]?(?:limit|cap)\b|exhausted your capacity|resource.?exhausted/i;
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|overloaded|over capacity|capacity (?:exceeded|exhausted)|concurrent requests?|throttl/i;

/** The HTTP status a provider error text names (`429 …`, `status 429`, `(429)`). */
function statusInText(text: string): number | undefined {
	const m = /(?:^|\bstatus[:= ]*|\(|\bHTTP\/\S+\s)([45]\d\d)\b/i.exec(text.trimStart());
	return m ? Number(m[1]) : undefined;
}

/**
 * What a failed turn ran into: an account usage limit (plan window, quota, credits), a temporary
 * rate limit (429, overload, concurrency) or anything else. omp's own classifier decides when the
 * bridge could import it; the text fallback errs toward `other`.
 */
export function classifyTurnError(
	m: { api?: unknown; provider?: unknown; model?: unknown; errorId?: unknown; errorMessage?: unknown; errorStatus?: unknown },
	ai?: ErrorClassifier,
): { class: LimitClass; reason?: string } {
	const text = typeof m.errorMessage === "string" ? m.errorMessage : "";
	const status = typeof m.errorStatus === "number" ? m.errorStatus : statusInText(text);
	if (ai) {
		try {
			// classifyMessage writes `errorId` onto the object it gets: never omp's own message.
			const id = ai.classifyMessage({
				api: m.api,
				provider: m.provider,
				model: m.model,
				errorId: typeof m.errorId === "number" ? m.errorId : undefined,
				errorMessage: text || undefined,
				errorStatus: status,
			});
			const reason = text ? ai.parseRateLimitReason?.(text) : undefined;
			if (ai.is(id, ai.Flag.UsageLimit)) return { class: "usageLimit", reason };
			if (status === 429 || status === 529 || (reason !== undefined && TRANSIENT_LIMIT_REASONS[reason])) return { class: "rateLimit", reason };
			return { class: "other", reason };
		} catch {
			// the text classifier below
		}
	}
	if (status === 402 || USAGE_LIMIT_TEXT.test(text)) return { class: "usageLimit" };
	if (status === 429 || status === 529 || RATE_LIMIT_TEXT.test(text)) return { class: "rateLimit" };
	return { class: "other" };
}

/** The longest provider retry hint kept (30 days): a longer or non-finite one is no hint at all
 *  (`retryAt` = `at` + hint must stay a plain integer hostd's `Millis` accepts). */
export const RETRY_HINT_MAX_MS = 30 * 24 * 3_600_000;

/** ms until the provider said to try again (`retry-after-ms=…`, "try again in 2 minutes", …):
 *  omp's own parser when the bridge could import it, else the common phrasings. */
export function retryHintMs(provider: string | undefined, text: string | undefined, hint?: RetryHint): number | undefined {
	if (!text) return undefined;
	const bounded = (ms: number): number | undefined => (Number.isFinite(ms) && ms >= 0 && ms <= RETRY_HINT_MAX_MS ? Math.round(ms) : undefined);
	if (hint) {
		try {
			const ms = hint(provider, text);
			return typeof ms === "number" ? bounded(ms) : undefined;
		} catch {
			// the fallback below
		}
	}
	const exact = /retry-after-ms=(\d+)/i.exec(text);
	if (exact) return bounded(Number(exact[1]));
	const m = /\b(?:try again|retry|resets?)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i.exec(text);
	if (!m) return undefined;
	const unit = m[2]!.toLowerCase();
	const scale = unit === "ms" || unit.startsWith("milli") ? 1 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
	return bounded(Number(m[1]) * scale);
}

const EVAL_STATE_CONTEXT = "eval-state-context";
/** The failed or aborted assistant message that ends `messages`, if any: omp's
 *  `retryableAssistantTurnEnd` (trailing eval snapshots and synthetic tool results don't count). */
export function failedTail(messages: readonly unknown[]): Json | undefined {
	let end = messages.length;
	while (end > 0) {
		const m = messages[end - 1];
		if (isObj(m) && m.role === "custom" && m.customType === EVAL_STATE_CONTEXT) end--;
		else if (isObj(m) && m.role === "toolResult" && isObj(m.details) && m.details.__synthetic === true) end--;
		else break;
	}
	const tail = messages[end - 1];
	if (!isObj(tail) || tail.role !== "assistant") return undefined;
	return tail.stopReason === "error" || tail.stopReason === "aborted" ? tail : undefined;
}

/** omp's `INTERRUPTED_TURN_ERROR` (session/exit-diagnostics), used when its module cannot be imported. */
const INTERRUPTED_TURN_ERROR = "Previous OMP process exited before completing the turn.";

/**
 * Whether a transcript ends in a reply cut off while it streamed: its last message is an assistant
 * reply without tool calls that stopped `aborted` and is not exit recovery's abort record. omp's
 * restore (`hasRestorableTurn`) leaves such a reply alone when no exit record follows it (a
 * subagent's transcript never gets one); omp's `retry()` goes on with it.
 */
export function endsInCutOffReply(entries: readonly unknown[], interruptedTurnError = INTERRUPTED_TURN_ERROR): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!isObj(e) || e.type !== "message") continue;
		const m = e.message;
		return (
			isObj(m) &&
			m.role === "assistant" &&
			m.stopReason === "aborted" &&
			m.errorMessage !== interruptedTurnError &&
			!(Array.isArray(m.content) && m.content.some(c => isObj(c) && c.type === "toolCall"))
		);
	}
	return false;
}

/** What a model sees instead of a subagent's provider-limit failure while auto-resume is on. Not a
 *  limit phrase itself (pi-ai's classifier and the fallback both read it as `other`). */
export const LIMIT_NEUTRAL =
	"This work was interrupted by a temporary provider limit and is resumed automatically; its result arrives as a new background job result.";

const TASK_RESULT = /<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g;
const TAGGED = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
/** Up to this much of a failed result's `<output>` is read for its error. omp's
 *  `formatTaskResultSummary` shows the stderr as the `<output>` when the run printed nothing (a
 *  provider limit hit right away), and a stderr is a line or two; a longer output is work, and work
 *  that talks about rate limits is no failure. */
const LIMIT_OUTPUT_MAX = 1_000;

/** The error text of one `<task-result>` body (omp's `task-summary.md`): `<error>` (the run printed
 *  output before it failed), else a short `<output>`/`<preview>` (the stderr). */
function taskResultError(body: string): string | undefined {
	const error = TAGGED("error").exec(body)?.[1];
	if (error !== undefined) return error;
	const output = TAGGED("output").exec(body)?.[1] ?? TAGGED("preview").exec(body)?.[1];
	return output !== undefined && output.length <= LIMIT_OUTPUT_MAX ? output : undefined;
}

/** Failed `<task-result>` envelopes (omp's `formatTaskResultSummary`) whose error is a provider
 *  limit → status `interrupted` and {@link LIMIT_NEUTRAL}. Other envelopes and text stay as they are. */
export function neutralizeTaskResults(text: string, isLimitText: (error: string) => boolean): string {
	if (!text.includes("<task-result")) return text;
	return text.replace(TASK_RESULT, (whole, attrs: string, body: string) => {
		const status = /\bstatus="([^"]*)"/.exec(attrs)?.[1] ?? "";
		const error = status.startsWith("failed") ? taskResultError(body) : undefined;
		if (error === undefined || !isLimitText(error)) return whole;
		return `<task-result${attrs.replace(/\bstatus="[^"]*"/, 'status="interrupted"')}>\n${LIMIT_NEUTRAL}\n</task-result>`;
	});
}

function neutralizeContent(content: unknown, isLimitText: (error: string) => boolean): unknown {
	if (typeof content === "string") return neutralizeTaskResults(content, isLimitText);
	if (!Array.isArray(content)) return content;
	let changed = false;
	const next = content.map(block => {
		if (!isObj(block) || block.type !== "text" || typeof block.text !== "string") return block;
		const text = neutralizeTaskResults(block.text, isLimitText);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? next : content;
}

/**
 * The `context` guard (2.1.0 `caps.limitGuard`, while hostd's auto-resume is on): provider limits
 * leave what the model sees. Assistant turns that failed on a usage or rate limit go, together with
 * every tool result paired to their tool calls (so tool-call/result pairing stays valid); a failed
 * `<task-result>` whose error is such a limit (a subagent stopped on it), in a tool result or a
 * background job's `async-result`, reads {@link LIMIT_NEUTRAL}. Other errors, aborted turns and all
 * other content stay. Works on omp's per-request copy: the session and its file are never touched.
 * `null`: nothing to change.
 */
export function guardContext(messages: readonly unknown[], isLimitTurn: (m: Json) => boolean, isLimitText: (error: string) => boolean): unknown[] | null {
	const out: unknown[] = [];
	const dropped = new Set<string>();
	let changed = false;
	for (const m of messages) {
		if (!isObj(m)) {
			out.push(m);
			continue;
		}
		if (m.role === "assistant" && m.stopReason === "error" && isLimitTurn(m)) {
			for (const block of Array.isArray(m.content) ? m.content : []) {
				if (isObj(block) && block.type === "toolCall" && typeof block.id === "string") dropped.add(block.id);
			}
			changed = true;
			continue;
		}
		if (m.role === "toolResult" && typeof m.toolCallId === "string" && dropped.has(m.toolCallId)) {
			changed = true;
			continue;
		}
		if (m.role === "toolResult" || m.role === "custom") {
			const content = neutralizeContent(m.content, isLimitText);
			if (content !== m.content) {
				out.push({ ...m, content });
				changed = true;
				continue;
			}
		}
		out.push(m);
	}
	return changed ? out : null;
}

/** How much of a subagent transcript's end `restorable`/`restore` read. */
const TRANSCRIPT_TAIL_BYTES = 4 << 20;

/** The header id and trailing messages of an omp session file (its last `maxBytes`), for a
 *  transcript no live session holds (a parked subagent). Read-only. */
export function sessionFileTail(file: string, maxBytes = 1 << 20): { sessionId?: string; messages: Json[] } {
	const out: { sessionId?: string; messages: Json[] } = { messages: [] };
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const head = Buffer.alloc(Math.min(size, 4096));
		fs.readSync(fd, head, 0, head.length, 0);
		const first = head.toString("utf8").split("\n")[0] ?? "";
		try {
			const header: unknown = JSON.parse(first);
			if (isObj(header) && header.type === "session" && typeof header.id === "string") out.sessionId = header.id;
		} catch {
			// a header cut by the 4 KiB read; the messages still count
		}
		const start = Math.max(0, size - maxBytes);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		const lines = buf.toString("utf8").split("\n");
		if (start > 0) lines.shift(); // cut mid-line
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry: unknown = JSON.parse(line);
				if (isObj(entry) && entry.type === "message" && isObj(entry.message)) out.messages.push(entry.message);
			} catch {
				// a line omp is still writing
			}
		}
	} catch {
		// unreadable: no tail
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	return out;
}

/** The live AgentSession members `retry`, `resumeTree` and the turn-error watch use. */
export interface RetrySession extends AgentSessionLike {
	retry(): Promise<boolean>;
	waitForIdle?(): Promise<void>;
	restoreInterruptedTurn?(): Promise<boolean>;
	readonly isRetrying?: boolean;
	readonly asyncJobManager?: ResumeJobs;
	readonly settings?: unknown;
	readonly sessionManager?: {
		getSessionId?(): string;
		getSessionFile?(): string | undefined;
		getEntries?(): unknown[];
		buildSessionContext?(options?: Json): { messages?: unknown[] };
	};
	readonly agent?: { state?: { streamMessage?: unknown; messages?: unknown[] } };
}
export const isRetrySession = (s: unknown): s is RetrySession => isSession(s) && "retry" in s && typeof s.retry === "function";

/** The parts of omp's `AsyncJobManager` a subagent resume uses. */
export interface ResumeJobs {
	register(type: string, label: string, run: (ctx: { jobId?: string; signal: AbortSignal }) => Promise<unknown>, options?: Json): string;
	getAllJobs?(): Array<{ id: string; status?: string; agentId?: string; ownerId?: string; startTime?: number }>;
	acknowledgeDeliveries?(jobIds: string[]): number;
}

/**
 * omp's monitor of a kept-alive subagent's turns that no executor drives (`attachIrcWakeTurnMonitor`:
 * IRC wakes, focused prompts, bare continuations such as `retry()`) also sees the retried turn and,
 * once the subagent yields, hands the result to the parent as a job of its own (same agent and
 * owner, started after `since`). The resume job `jobId` then stays silent, so the parent receives
 * the result once. True when it does.
 */
export function quietIfDelivered(jobs: ResumeJobs, jobId: string, agentId: string, ownerId: string | undefined, since: number): boolean {
	if (typeof jobs.getAllJobs !== "function" || typeof jobs.acknowledgeDeliveries !== "function") return false;
	const wake = jobs.getAllJobs().some(j => j.id !== jobId && j.agentId === agentId && j.ownerId === ownerId && (j.startTime ?? 0) >= since);
	if (wake) jobs.acknowledgeDeliveries([jobId]);
	return wake;
}

/** The failed turn `retry()` would resume: the live tail, else (a revived session drops failed turns
 *  from its provider context) the persisted display transcript, as omp's `retry()` reads it. */
export function retryableTail(s: RetrySession): Json | undefined {
	const live = failedTail(s.agent?.state?.messages ?? []);
	if (live) return live;
	const lastLive = (s.agent?.state?.messages ?? []).at(-1);
	if (isObj(lastLive) && lastLive.role === "assistant") return undefined; // a settled turn is authoritative
	try {
		return failedTail(s.sessionManager?.buildSessionContext?.({ transcript: true })?.messages ?? []);
	} catch {
		return undefined;
	}
}

/**
 * Makes the session's next `restoreInterruptedTurn()` omp's `retry()`. omp's follow-up turn
 * (`runSubagentFollowUpTurn({restore: true})`, the `--restore` path) goes on through
 * `restoreInterruptedTurn()`, which ends in `retry()` for an interrupted turn but leaves a terminal
 * failure alone (`hasRestorableTurn`); for a failed turn, `retry()` is that same last step. One shot,
 * on this instance only; `disarm` restores it.
 */
export function armRetry(session: RetrySession): { used(): boolean; disarm(): void } {
	let used = false;
	const own = Object.getOwnPropertyDescriptor(session, "restoreInterruptedTurn");
	const disarm = (): void => {
		if (own) Object.defineProperty(session, "restoreInterruptedTurn", own);
		else Reflect.deleteProperty(session, "restoreInterruptedTurn");
	};
	Object.defineProperty(session, "restoreInterruptedTurn", {
		configurable: true,
		writable: true,
		value: async (): Promise<boolean> => {
			used = true;
			disarm();
			return session.retry();
		},
	});
	return { used: () => used, disarm };
}

/** What a resumed subagent run reports (omp's `SingleResult`, the fields the job reads). */
interface FollowUpResult {
	aborted?: boolean;
	exitCode?: number;
	error?: string;
	durationMs?: number;
	structuredOutput?: unknown;
}

/** The omp internals `retry` / `resumeTree` / the turn-error watch use (2.1.0), each feature-detected. */
interface ResumeInternals {
	/** pi-ai's error classifier. */
	ai?: ErrorClassifier;
	/** pi-ai's provider retry-after / reset parser. */
	hint?: RetryHint;
	/** omp's task internals for resuming a subagent as a job of its parent (all or nothing). */
	task?: {
		runFollowUp(options: Json): Promise<FollowUpResult>;
		summary(result: FollowUpResult, options: { totalDurationMs: number }): string;
		definition(name: string, init: Json): unknown;
		sessionInit(entries: unknown[]): Json | null;
		jobError: new (message: string, structured?: unknown) => Error;
		maxRuntimeMs(settings: unknown): number;
	};
}

/** Probes {@link ResumeInternals}: omp's root exports first (they are the modules omp runs), then
 *  literal subpath imports, which omp's extension loader maps to its own loaded modules. */
async function probeResume(ns: Record<string, unknown>, load: (mod: Promise<unknown>) => Promise<Json | undefined>): Promise<ResumeInternals> {
	const fn = (v: unknown): ((...args: unknown[]) => unknown) | undefined => (typeof v === "function" ? (v as (...args: unknown[]) => unknown) : undefined);
	const [errorMod, hintMod, executorMod, summaryMod, reviveMod, sessionMod, asyncMod, taskSettingsMod] = await Promise.all([
		load(import("@oh-my-pi/pi-ai/error")),
		load(import("@oh-my-pi/pi-ai/utils/retry-after")),
		fn(ns.runSubagentFollowUpTurn) ? undefined : load(import("@oh-my-pi/pi-coding-agent/task/executor")),
		fn(ns.formatTaskResultSummary) ? undefined : load(import("@oh-my-pi/pi-coding-agent/task/result-summary")),
		fn(ns.persistedAgentDefinition) ? undefined : load(import("@oh-my-pi/pi-coding-agent/task/persisted-revive")),
		fn(ns.extractSessionInit) ? undefined : load(import("@oh-my-pi/pi-coding-agent/session/session-manager")),
		fn(ns.AsyncJobError) ? undefined : load(import("@oh-my-pi/pi-coding-agent/async")),
		load(import("@oh-my-pi/pi-coding-agent/task/settings")),
	]);
	const out: ResumeInternals = {};
	const ai = errorMod ?? (isObj(ns.AIError) ? ns.AIError : undefined);
	if (ai && fn(ai.classifyMessage) && fn(ai.is) && isObj(ai.Flag) && typeof ai.Flag.UsageLimit === "number") out.ai = ai as unknown as ErrorClassifier;
	const hint = fn(hintMod?.extractProviderRetryHint) ?? fn(ns.extractProviderRetryHint);
	if (hint) out.hint = hint as unknown as RetryHint;
	const run = fn(ns.runSubagentFollowUpTurn) ?? fn(executorMod?.runSubagentFollowUpTurn);
	const summary = fn(ns.formatTaskResultSummary) ?? fn(summaryMod?.formatTaskResultSummary);
	const sessionInit = fn(ns.extractSessionInit) ?? fn(sessionMod?.extractSessionInit);
	// omp's own (task/persisted-revive.ts `persistedAgentDefinition`) when it can be imported.
	const definition =
		fn(ns.persistedAgentDefinition) ??
		fn(reviveMod?.persistedAgentDefinition) ??
		((name: string, init: Json) => ({ name, description: "", systemPrompt: (Array.isArray(init.systemPrompt) ? init.systemPrompt : []).join("\n\n"), source: "user" }));
	// A plain Error still carries the text; omp's AsyncJobError also keeps a failed run's structured output.
	const jobError = (fn(ns.AsyncJobError) ?? fn(asyncMod?.AsyncJobError) ?? Error) as unknown as new (message: string, structured?: unknown) => Error;
	const maxRuntime = isObj(taskSettingsMod?.cfgTaskMaxRuntimeMs) ? taskSettingsMod.cfgTaskMaxRuntimeMs : undefined;
	if (run && summary && sessionInit) {
		out.task = {
			runFollowUp: run as unknown as (options: Json) => Promise<FollowUpResult>,
			summary: summary as unknown as (result: FollowUpResult, options: { totalDurationMs: number }) => string,
			definition: definition as unknown as (name: string, init: Json) => unknown,
			sessionInit: sessionInit as unknown as (entries: unknown[]) => Json | null,
			jobError,
			maxRuntimeMs: settings => {
				try {
					const get = fn(maxRuntime?.get);
					const v = get ? get.call(maxRuntime, settings) : 0;
					return typeof v === "number" && Number.isFinite(v) ? v : 0;
				} catch {
					return 0;
				}
			},
		};
	}
	return out;
}

// ─── 2.1.0: background jobs (`caps.jobs`) ──────────────────────────────────────────────────────
// The async jobs of the main session and of every subagent below it (docs/bridge-protocol.md
// "Background jobs"): background bash / eval commands and subagents running as `task` jobs, as omp's
// own jobs sheet (`/jobs`, the status line's jobs pill) lists them. Read through the main
// AgentSession (`getAsyncJobTree`, `inspectAsyncJob`, `cancelAsyncJob`, `getRunningJobWidgets`,
// `hasPendingAsyncWork`; omp ≥ 18.13), else the public `ctx.getAsyncJobSnapshot()` (the main agent's
// own jobs, no output, no cancel).

/** One job as omp snapshots it (`AsyncJobSnapshotItem`). */
export interface JobItem {
	id: string;
	type?: string;
	status?: string;
	label?: string;
	command?: string;
	startTime?: number;
	endTime?: number;
	agentId?: string;
	ownerId?: string;
}
/** omp's `AsyncJobInspection`. */
export interface JobInspection {
	command?: string;
	cwd?: string;
	pids?: readonly number[];
	exitCode?: number;
	output?: string;
	artifactId?: string;
	widget?: unknown;
}
/** The slice of omp's AgentSession the jobs ops use (each member feature-detected). */
export interface JobsSession {
	getAsyncJobTree?(options?: { recentLimit?: number }): unknown;
	getAsyncJobSnapshot?(options?: { recentLimit?: number }): unknown;
	inspectAsyncJob?(id: string): JobInspection | undefined;
	cancelAsyncJob?(id: string): boolean;
	getRunningJobWidgets?(): readonly { id: string; view?: unknown }[];
	hasPendingAsyncWork?(): boolean;
	readonly asyncJobManager?: { cancel?(id: string, filter?: { ownerId: string | undefined }): boolean };
}
/** The session's jobs: running ones oldest first, then the settled ones omp keeps, newest first. */
export interface JobsList {
	running: JobItem[];
	recent: JobItem[];
	/** The agent the tree is for (its own jobs are the top level); absent from the public snapshot. */
	rootId?: string;
}
/** `JobGlance` (tf-proto): what a glance at a job's widget reads. */
export interface JobGlanceWire {
	text: string;
	label?: string;
	trend?: string;
	trendTone?: string;
}
/** The `jobs` event (tf-proto `JobsSummary`). */
export interface JobsSummaryWire {
	running: number;
	recent: number;
	waiting: boolean;
	glance?: JobGlanceWire;
	glanceJob?: string;
}
/** One job on the wire (tf-proto `Job`). */
export interface JobWire {
	id: string;
	kind: string;
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	command?: string;
	startedAt: number;
	endedAt?: number;
	agentId?: string;
	agentName?: string;
	ownerId?: string;
	ownerName?: string;
	cancellable: boolean;
	widget?: Json;
	output?: string;
	outputCut?: boolean;
	pids?: number[];
	exitCode?: number;
	cwd?: string;
	artifactId?: string;
}
/** The `jobs` op result (tf-proto `JobsView`). */
export interface JobsViewWire {
	jobs: JobWire[];
	waiting: boolean;
	at: number;
}

/** Settled jobs listed (omp's jobs sheet shows 10). */
const RECENT_JOBS = 10;
/** Output kept per inspected job: the newest part. */
export const JOB_OUTPUT_MAX = 16 * 1024;
const JOB_COMMAND_MAX = 4_000;
const JOB_STATUSES: Record<string, JobWire["status"]> = { running: "running", completed: "completed", failed: "failed", cancelled: "cancelled" };
/** The summary of a session without jobs: hostd shows nothing, so it is never sent first. */
export const JOBS_NONE = JSON.stringify({ running: 0, recent: 0, waiting: false });

const plainLine = (v: unknown): string => (typeof v === "string" ? v.replace(ANSI, "").replace(/\s+/g, " ").trim() : "");
const jobItems = (v: unknown): JobItem[] => (Array.isArray(v) ? v.filter((j): j is JobItem => isObj(j) && typeof j.id === "string" && !!j.id) : []);

/** The jobs omp lists for the session: its job tree when the AgentSession has one, else a snapshot. */
export function listJobs(session: JobsSession | undefined, ctxSnapshot?: () => unknown): JobsList | undefined {
	const read = (f: () => unknown): unknown => {
		try {
			return f();
		} catch {
			return undefined;
		}
	};
	let raw: unknown;
	if (typeof session?.getAsyncJobTree === "function") raw = read(() => session.getAsyncJobTree!({ recentLimit: RECENT_JOBS }));
	if (!isObj(raw) && typeof session?.getAsyncJobSnapshot === "function") raw = read(() => session.getAsyncJobSnapshot!({ recentLimit: RECENT_JOBS }));
	if (!isObj(raw) && ctxSnapshot) raw = read(ctxSnapshot);
	if (!isObj(raw)) return undefined;
	const running = jobItems(raw.running).sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
	const recent = jobItems(raw.recent).sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0)).slice(0, RECENT_JOBS);
	return { running, recent, rootId: typeof raw.rootId === "string" ? raw.rootId : undefined };
}

/**
 * omp's `jobWidgetGlance` (pi-tui `tools/job-widget.ts`): the widget's headline, or a meter's
 * `140/190` when the headline only restates its numerator; else the latest figure of its first
 * chart or meter.
 */
export function jobGlance(view: unknown): JobGlanceWire | undefined {
	if (!isObj(view)) return undefined;
	const blocks = Array.isArray(view.blocks) ? view.blocks.filter(isObj) : [];
	const headline = isObj(view.headline) ? view.headline : undefined;
	const text = plainLine(headline?.text);
	if (headline && text) {
		const meter = blocks.find(b => b.kind === "meter");
		const whole = meter ? plainLine(meter.text) : "";
		const restates = whole.startsWith(text) && /^\s*\/\s*\S/.test(whole.slice(text.length));
		const label = plainLine(headline.label);
		const trend = isObj(headline.trend) ? headline.trend : undefined;
		const trendText = plainLine(trend?.text);
		return {
			text: restates ? whole : text,
			...(label ? { label } : {}),
			...(trendText ? { trend: trendText, ...(typeof trend?.tone === "string" ? { trendTone: trend.tone } : {}) } : {}),
		};
	}
	for (const b of blocks) {
		const label = plainLine(b.label);
		if (b.kind === "spark" && Array.isArray(b.values) && b.values.length > 0 && plainLine(b.last)) return { text: plainLine(b.last), ...(label ? { label } : {}) };
		if (b.kind === "meter" && plainLine(b.text)) return { text: plainLine(b.text), ...(label ? { label } : {}) };
	}
	return undefined;
}

/** A job's widget on the wire (tf-proto `JobWidget`). */
export function jobWidget(view: unknown): Json | undefined {
	if (!isObj(view)) return undefined;
	const meter = Array.isArray(view.blocks) ? view.blocks.find(b => isObj(b) && b.kind === "meter") : undefined;
	const value = isObj(meter) && typeof meter.value === "number" && Number.isFinite(meter.value) ? Math.min(1, Math.max(0, meter.value)) : undefined;
	const glance = jobGlance(view);
	const stage = plainLine(view.stage);
	const progressText = isObj(meter) ? plainLine(meter.text) : "";
	return {
		title: plainLine(view.title),
		...(glance ? { glance } : {}),
		...(stage ? { stage } : {}),
		...(value !== undefined ? { progress: value } : {}),
		...(progressText ? { progressText } : {}),
		state: typeof view.state === "string" ? view.state : "fallback",
		updatedAt: typeof view.updatedAt === "number" ? view.updatedAt : 0,
	};
}

/** omp's `latestJobWidget`: the running job whose live widget (one a spec drives) saw data last. */
export function latestLiveWidget(widgets: readonly { id: string; view?: unknown }[]): { id: string; view: Json } | undefined {
	let latest: { id: string; view: Json } | undefined;
	for (const w of widgets) {
		const view = w.view;
		if (!isObj(view) || view.state !== "live") continue;
		const at = typeof view.updatedAt === "number" ? view.updatedAt : 0;
		if (!latest || at > (latest.view.updatedAt as number)) latest = { id: w.id, view: { ...view, updatedAt: at } };
	}
	return latest;
}

/** The `jobs` event: counts, the wait, and the freshest live widget's glance. */
export function jobsSummary(list: JobsList, widgets: readonly { id: string; view?: unknown }[], waiting: boolean): JobsSummaryWire {
	const latest = latestLiveWidget(widgets.filter(w => list.running.some(j => j.id === w.id)));
	const glance = latest ? jobGlance(latest.view) : undefined;
	const label = latest ? plainLine(list.running.find(j => j.id === latest.id)?.label) : "";
	return { running: list.running.length, recent: list.recent.length, waiting, ...(glance ? { glance, glanceJob: label || latest!.id } : {}) };
}

/**
 * A job's output for a reader: ANSI removed, each line as a terminal leaves it after `\r`
 * redraws (progress bars), at most `max` characters: the newest ones, from a line start.
 */
export function jobOutput(text: string, max = JOB_OUTPUT_MAX): { output: string; cut: boolean } {
	let s = text.length > max * 4 ? text.slice(-max * 4) : text;
	let cut = s.length < text.length;
	s = s
		.replace(ANSI, "")
		.split("\n")
		.map(line => {
			const l = line.replace(/\r+$/, "");
			const i = l.lastIndexOf("\r");
			return i >= 0 ? l.slice(i + 1) : l;
		})
		.join("\n");
	if (s.length > max) {
		s = s.slice(-max);
		const nl = s.indexOf("\n");
		if (nl >= 0 && nl < s.length - 1) s = s.slice(nl + 1);
		cut = true;
	}
	return { output: s, cut };
}

/** One job on the wire; `inspection` adds what omp's jobs sheet shows for the selected job. */
export function jobWire(
	job: JobItem,
	opts: { rootId?: string; name: (id: string) => string | undefined; cancellable: boolean; widget?: unknown; inspection?: JobInspection },
): JobWire {
	const status = JOB_STATUSES[job.status ?? ""] ?? "completed";
	const top = job.ownerId === undefined || job.ownerId === opts.rootId;
	const ins = opts.inspection;
	const command = job.command ?? ins?.command;
	const widget = jobWidget(ins?.widget ?? opts.widget);
	const out: JobWire = {
		id: job.id,
		kind: job.type || "bash",
		status,
		label: typeof job.label === "string" ? job.label.slice(0, 500) : job.id,
		...(command ? { command: command.slice(0, JOB_COMMAND_MAX) } : {}),
		startedAt: typeof job.startTime === "number" ? job.startTime : 0,
		...(typeof job.endTime === "number" ? { endedAt: job.endTime } : {}),
		...(job.agentId ? { agentId: job.agentId, agentName: opts.name(job.agentId) ?? job.agentId } : {}),
		...(!top && job.ownerId ? { ownerId: job.ownerId, ownerName: opts.name(job.ownerId) ?? job.ownerId } : {}),
		cancellable: opts.cancellable && status === "running",
		...(widget ? { widget } : {}),
	};
	if (ins) {
		if (typeof ins.output === "string") {
			const { output, cut } = jobOutput(ins.output);
			out.output = output;
			if (cut) out.outputCut = true;
		}
		if (status === "running" && Array.isArray(ins.pids)) out.pids = ins.pids.filter(p => typeof p === "number");
		if (typeof ins.exitCode === "number") out.exitCode = ins.exitCode;
		if (typeof ins.cwd === "string" && ins.cwd) out.cwd = ins.cwd;
		if (typeof ins.artifactId === "string" && ins.artifactId) out.artifactId = ins.artifactId;
	}
	return out;
}

export default async function teleflockBridge(pi: ExtensionAPI) {
	const schemaOut = process.env.TF_OMP_SCHEMA_OUT;
	if (schemaOut) {
		await dumpSchema(pi, schemaOut);
		return;
	}
	const settingsIn = process.env.TF_OMP_SETTINGS_IN;
	const settingsOut = process.env.TF_OMP_SETTINGS_OUT;
	if (settingsIn && settingsOut) {
		await writeSettings(settingsIn, settingsOut);
		return;
	}
	bridge(pi);
}

function bridge(pi: ExtensionAPI) {
	const home = hostdHome();
	const endpoint = bridgeEndpoint(home);
	const secretPath = bridgeSecretPath(home);
	const bridgeLog = (msg: string) => {
		try {
			pi.logger.debug(`teleflock-bridge: ${msg}`);
		} catch {
			/* logging must never throw into omp */
		}
	};

	let ctxRef: ExtensionContext | undefined; // latest main-session context
	// This copy's entry in the process-wide slot (see "one bridge per omp process").
	const me: BridgeSlot["owners"][string] = { version: BRIDGE_VERSION, stop: () => standDown(), relay: frame => onRelay(frame), report: turn => onReportedTurn(turn) };
	let active = false; // between session_start and session_shutdown
	let sock: net.Socket | undefined;
	let connected = false;
	let connecting = false; // socket open (or opening) but hostd not yet authenticated
	let connectStartedAt = 0;
	let nextRetryAt = 0;
	let tick: Timer | undefined;
	let helloSessionId: string | undefined;
	let lastStateJson = "";
	let lastQueueJson = "";
	let tuiRef: TuiLike | undefined;
	let editorRef: MainEditor | undefined;
	let goalFromEvent: CtlState["goal"] | null | undefined; // undefined = derive from entries
	let pendingReview: ReviewInfo | undefined;
	// /btw (see "─── /btw" below). One live entry per conversation turn, keyed `<btwId>:<turn>`.
	interface BtwLive {
		sid: string;
		id: string;
		turn: number;
		question: string;
		/** The answer as far as we know it; `sent` is the prefix hostd already has. */
		text: string;
		sent: string;
		announced: boolean;
		done: boolean;
		final?: { status: BtwStatus; error?: string };
		panel?: object;
	}
	const btwLive = new Map<string, BtwLive>();
	const btwRecords = new Map<string, BtwRec>(); // omp history of `btwSid`, by topic id
	const btwFileSigs = new Map<string, string>(); // history file → `mtime:size` last parsed
	const btwHooked = new WeakSet<object>();
	let btwSid: string | undefined;
	let btwBaseline = false; // the first scan of a session only learns what is already there
	let btwScan: Promise<void> | undefined;
	// No-TUI fallback: private side turns kept in memory (not in omp's history).
	interface SideThread {
		id: string;
		at: number;
		turns: BtwTurnRec[];
		ac?: AbortController;
	}
	const sideThreads = new Map<string, SideThread>();
	let btwSeq = 0;
	let statusShown: boolean | undefined;
	// Data plane (protocol v2, see "─── data plane" below).
	/** This binding's session: every session (main and each subagent) gets its own binding of the
	 *  factory; `sub` bindings only relay their task bus to the process's owner copy. */
	let bindingKind: "main" | "sub" | undefined;
	let bindingAgentId: string | undefined;
	let startedAt = Date.now();
	let writer: LiveWriter | undefined; // the connection's ordered writer, from hostd's auth on
	const throttle = new Throttle();
	const tracker = new LiveTracker();
	let msgSeq = 0; // bumped on every message_start: keys one message's cumulative updates
	let endedMsg = -1; // msgSeq of the last message_end (no update may follow it)
	const endedTools = new Set<string>();
	let agentSession: AgentSessionLike | undefined;
	let unsubscribeSession: (() => void) | undefined;
	let unsubscribeRegistry: (() => void) | undefined;
	let stateTimer: Timer | undefined;
	let agentsTimer: Timer | undefined;
	let lastLiveState = "";
	let lastAgents = "";
	let dialogsReady = false;
	/** Marks this binding's dialog wrappers (see installDialogWrappers). */
	const dialogToken = {};
	const seenBus = new WeakSet<object>();
	const internals: Internals = { interruptLabel: USER_INTERRUPT, approval: fallbackApproval };
	const hub = new DialogHub(
		() => {
			const slot = bridgeSlot();
			slot.uiReqSeq = (slot.uiReqSeq ?? 0) + 1;
			return slot.uiReqSeq;
		},
		frame => feedLive(frame),
	);
	/** Probes the omp internals the data plane uses (`hello.caps`). The agent registry comes from omp's
	 *  root exports, synchronously; the rest are literal subpath imports, which omp's extension loader
	 *  maps to its own (already loaded) modules. */
	const internalsReady: Promise<void> = (async () => {
		const ns: Record<string, unknown> = pi.pi ?? {};
		if (hasGlobal(ns.AgentRegistry)) {
			const reg: unknown = ns.AgentRegistry.global();
			if (isObj(reg) && typeof reg.get === "function" && typeof reg.list === "function") internals.registry = reg as unknown as AgentRegistryLike;
		}
		const load = (mod: Promise<unknown>): Promise<Json | undefined> => settleWithin(mod, 3_000).then(m => (isObj(m) ? m : undefined));
		const exported = hasGlobal(ns.AgentLifecycleManager);
		const [lifecycleMod, registryMod, approvalMod, messagesMod] = await Promise.all([
			exported ? undefined : load(import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle")),
			exported ? undefined : load(import("@oh-my-pi/pi-coding-agent/registry/agent-registry")),
			load(import("@oh-my-pi/pi-coding-agent/tools/approval")),
			load(import("@oh-my-pi/pi-coding-agent/session/messages")),
		]);
		let lifecycle: unknown = ns.AgentLifecycleManager;
		// The manager keeps its registry in module state: only the module instance omp runs will do.
		if (!exported && registryMod?.AgentRegistry === ns.AgentRegistry) lifecycle = lifecycleMod?.AgentLifecycleManager;
		if (hasGlobal(lifecycle) && internals.registry) internals.lifecycle = lifecycle as { global(): LifecycleLike };
		if (typeof approvalMod?.approvalChoiceLabels === "function" && typeof approvalMod.approvalAnswerForChoice === "function") {
			internals.approval = approvalMod as unknown as ApprovalLabels;
		}
		if (typeof messagesMod?.USER_INTERRUPT_LABEL === "string") internals.interruptLabel = messagesMod.USER_INTERRUPT_LABEL;
		internals.roles = await probeRoleSettings(ns, load);
		internals.resume = await probeResume(ns, load);
	})().catch((err: unknown) => bridgeLog(`omp internals: ${String(err)}`));

	// ─── wire ─────────────────────────────────────────────────────────────────────────────────
	/** A control frame, in order with the live feed (see LiveWriter). */
	const send = (obj: Record<string, unknown>): void => {
		if (!sock || !connected || !writer) return;
		try {
			writer.ctl(obj);
		} catch (err) {
			bridgeLog(`write failed: ${String(err)}`);
		}
	};

	/** A live frame, when hostd subscribed (`key`: a cumulative frame, see LiveWriter.live). */
	const feedLive = (frame: FrameSource, key?: string): void => {
		try {
			if (writer?.subscribed) writer.live(frame, key);
		} catch (err) {
			bridgeLog(`live frame: ${String(err)}`);
		}
	};

	const sessionId = (): string | undefined => {
		try {
			return ctxRef?.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	};

	/** Ids of the sessions omp has written to disk (seen there once). A resync of one names the file's
	 *  last entry and carries none of its entries, also while omp moves the file: `moveTo` renames it
	 *  before it points the session at the new path, so `isSessionOnDisk()` is false meanwhile, and
	 *  inlining a large session would stall omp's event loop on a huge frame hostd does not need. */
	const writtenSessions = new Set<string>();
	/** omp has written the session to disk, now or before (see `writtenSessions`). */
	const sessionWritten = (sm: ExtensionContext["sessionManager"], file: string | undefined): boolean => {
		const sid = sm.getSessionId();
		if (writtenSessions.has(sid)) return true;
		if (!sessionOnDisk(sm, file)) return false;
		writtenSessions.add(sid);
		return true;
	};
	const noteWritten = (ctx: ExtensionContext): void => {
		try {
			const sm = ctx.sessionManager;
			sessionWritten(sm, sm.getSessionFile());
		} catch (err) {
			bridgeLog(`session file: ${String(err)}`);
		}
	};

	const emit = (event: string, data: unknown): void => {
		const sid = helloSessionId ?? sessionId();
		if (!sid) return;
		send({ t: "event", event, sessionId: sid, data });
	};

	const showStatus = (on: boolean): void => {
		// Only ever clear what this copy showed: other copies share the status key.
		if ((statusShown ?? false) === on) return;
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
			attached: bridgeSlot().cmdCtx !== undefined,
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
			// 2.0.0: the data plane; `dialogs` / `subagentCtl` say whether the omp internals they need are there.
			// 2.1.0: `roleModels` needs omp's settings internals (`getRoleModels` / `setRoleModels`);
			// `retry` / `resumeTree` / `turnError` / `limitGuard` (resumeCaps) omp's retry and task internals;
			// `jobs` a job list (omp's public snapshot at least).
			caps: { live: 1, dialogs: dialogsReady, subagentCtl: internals.lifecycle !== undefined, prompt: true, roleModels: internals.roles !== undefined, ...resumeCaps(ctx), notices: true, context: true, jobs: jobsReady(ctx), restore: restoreReady(ctx), restoreSelect: restoreSelectReady(ctx) },
			state: readState(ctx),
		};
	};

	const sendHello = (reason: "connect" | "switch", previous?: string): void => {
		const ctx = ctxRef;
		if (!ctx || !connected) return;
		try {
			if (reason === "switch") {
				// The live feed belonged to the previous session: hostd subscribes again after this hello.
				stopFeed();
				tracker.reset();
				endedTools.clear();
			}
			const hello = helloPayload(ctx, reason, previous);
			helloSessionId = hello.sessionId;
			lastStateJson = JSON.stringify(hello.state);
			lastQueueJson = JSON.stringify(hello.state.queue);
			lastJobsJson = JOBS_NONE; // the new session's jobs (or this connection's) go out on the next tick
			send(hello);
		} catch (err) {
			bridgeLog(`hello failed: ${String(err)}`);
		}
	};

	/** Push state/queue deltas and re-hello on a session change. Runs on every tick and after events. */
	const sync = (): void => {
		const ctx = ctxRef;
		if (!ctx || !connected || !helloSessionId) return;
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
		scheduleState();
	};

	const safeSync = (): void => {
		try {
			sync();
		} catch (err) {
			bridgeLog(`sync failed: ${String(err)}`);
		}
	};

	// ─── data plane (protocol v2) ─────────────────────────────────────────────────────────────
	// The live feed mirrors omp's AgentSession stream exactly as omp's collab host does (the
	// session comes from omp's agent registry; without it the extension events stand in), the task
	// bus at every depth, the agent roster and the session's dialogs. See docs/bridge-protocol.md.

	/** This copy is the process's bridge to its hostd and the main session runs. */
	const ownsSlot = (): boolean => active && bridgeSlot().owners[endpoint] === me;

	const isStreaming = (): boolean => {
		const live = agentSession?.isStreaming;
		if (typeof live === "boolean") return live;
		try {
			return tracker.streaming || !(ctxRef?.isIdle() ?? true);
		} catch {
			return tracker.streaming;
		}
	};

	/** Collab's `state` frame (`collab/host.ts` #buildState): the AgentSession's view, else ctx's. */
	const liveState = (ctx: ExtensionContext): Json => {
		const s = agentSession;
		let tokens = 0;
		let window = 0;
		let percent: number | undefined;
		try {
			const usage = ctx.getContextUsage();
			if (typeof usage?.tokens === "number") tokens = usage.tokens;
			if (typeof usage?.contextWindow === "number") window = usage.contextWindow;
			if (typeof usage?.percent === "number") percent = usage.percent;
		} catch {
			// no usage before the first turn
		}
		const model = s ? s.model : ctx.model;
		if (!window && isObj(model) && typeof model.contextWindow === "number") window = model.contextWindow;
		let queued = s?.queuedMessageCount;
		if (typeof queued !== "number") {
			const q = readQueue();
			queued = q.steering.length + q.followUp.length;
		}
		return {
			isStreaming: isStreaming(),
			isAborting: s?.isAborting === true,
			queuedMessageCount: queued,
			sessionName: (s ? s.sessionName : pi.getSessionName()) || undefined,
			cwd: ctx.sessionManager.getCwd() || ctx.cwd,
			model: modelWire(model),
			thinkingLevel: (s ? s.thinkingLevel : pi.getThinkingLevel()) ?? undefined,
			contextUsage: { tokens, contextWindow: window, percent: percent ?? (window > 0 ? (tokens / window) * 100 : 0) },
			participants: [],
		};
	};

	/** Debounced `state` frame (collab: 100 ms, deduplicated), after state-changing events and requests. */
	const scheduleState = (): void => {
		if (stateTimer !== undefined || !writer?.subscribed) return;
		stateTimer = setTimeout(() => {
			stateTimer = undefined;
			try {
				const ctx = ctxRef;
				if (!ctx || !writer?.subscribed) return;
				const state = liveState(ctx);
				const json = JSON.stringify(state);
				if (json === lastLiveState) return;
				lastLiveState = json;
				writer.live({ t: "state", state }, "state");
			} catch (err) {
				bridgeLog(`live state: ${String(err)}`);
			}
		}, STATE_DEBOUNCE_MS);
		stateTimer.unref?.();
	};

	/** Collab's agent roster (`#snapshotAgents`, advisors excluded) plus each agent's `sessionFile`;
	 *  without omp's registry, the main agent and the subagents lifecycle frames named. */
	const snapshotAgents = (): Json[] => {
		const reg = internals.registry;
		if (reg) {
			return reg
				.list()
				.filter(ref => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName ?? ref.id,
					kind: ref.kind === "main" ? "main" : "sub",
					parentId: ref.parentId,
					status: ref.status ?? "idle",
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt ?? 0,
					lastActivity: ref.lastActivity ?? 0,
					sessionFile: ref.sessionFile ?? null,
				}));
		}
		const ctx = ctxRef;
		const mainId = ctx?.agent?.id ?? "Main";
		const file = ctx?.sessionManager.getSessionFile() ?? null;
		const out: Json[] = [
			{
				id: mainId,
				displayName: ctx?.agent?.name ?? "main",
				kind: "main",
				status: isStreaming() ? "running" : "idle",
				hasSessionFile: !!file,
				createdAt: startedAt,
				lastActivity: startedAt,
				sessionFile: file,
			},
		];
		for (const [id, sub] of tracker.subs) {
			if (!sub.lifecycle) continue;
			const status = strField(sub.lifecycle, "status");
			const subFile = strField(sub.lifecycle, "sessionFile") ?? null;
			out.push({
				id,
				displayName: strField(sub.lifecycle, "agent") ?? id,
				kind: "sub",
				parentId: sub.parent ?? mainId,
				status: status === "started" ? "running" : status === "completed" ? "idle" : "aborted",
				hasSessionFile: !!subFile,
				createdAt: sub.first,
				lastActivity: sub.at,
				sessionFile: subFile,
			});
		}
		return out;
	};

	/** Debounced `agents` frame (collab: 100 ms after a registry change), deduplicated. */
	const scheduleAgents = (): void => {
		if (agentsTimer !== undefined || !writer?.subscribed) return;
		agentsTimer = setTimeout(() => {
			agentsTimer = undefined;
			try {
				if (!writer?.subscribed) return;
				const agents = snapshotAgents();
				const json = JSON.stringify(agents);
				if (json === lastAgents) return;
				lastAgents = json;
				writer.live({ t: "agents", agents }, "agents");
			} catch (err) {
				bridgeLog(`agents: ${String(err)}`);
			}
		}, AGENTS_DEBOUNCE_MS);
		agentsTimer.unref?.();
	};

	/** omp's AgentSession of the main session (its agent registry ref). */
	const findSession = (ctx: ExtensionContext): AgentSessionLike | undefined => {
		const reg = internals.registry;
		if (!reg) return undefined;
		try {
			const sid = ctx.sessionManager.getSessionId();
			const fits = (s: unknown): s is AgentSessionLike => isSession(s) && s.sessionManager?.getSessionId?.() === sid;
			const own = ctx.agent?.id ? reg.get(ctx.agent.id)?.session : undefined;
			if (fits(own)) return own;
			for (const ref of reg.list()) if (ref.kind === "main" && fits(ref.session)) return ref.session;
		} catch (err) {
			bridgeLog(`session lookup: ${String(err)}`);
		}
		return undefined;
	};

	/** Listens to the main AgentSession (as omp's collab host does), once found; rechecked every tick. */
	const attachSession = (ctx: ExtensionContext): void => {
		const s = findSession(ctx);
		if (!s || s === agentSession) return;
		try {
			unsubscribeSession?.();
		} catch {
			// the old session is gone
		}
		unsubscribeSession = undefined;
		agentSession = undefined;
		try {
			unsubscribeSession = s.subscribe(event => {
				try {
					onAgentEvent(event, true);
				} catch (err) {
					bridgeLog(`live event: ${String(err)}`);
				}
			});
			agentSession = s;
			for (const notice of configNotices(s)) sendNotice(notice);
		} catch (err) {
			bridgeLog(`session subscribe: ${String(err)}`);
		}
	};

	const attachRegistry = (): void => {
		const reg = internals.registry;
		if (unsubscribeRegistry || !reg?.onChange) return;
		try {
			unsubscribeRegistry = reg.onChange(() => scheduleAgents());
		} catch (err) {
			bridgeLog(`registry: ${String(err)}`);
		}
	};

	/** This copy stops bridging: let go of omp's session, registry and the pending dialogs (they go on locally). */
	const detachLive = (): void => {
		for (const off of [unsubscribeSession, unsubscribeRegistry]) {
			try {
				off?.();
			} catch {
				// already gone
			}
		}
		unsubscribeSession = undefined;
		unsubscribeRegistry = undefined;
		agentSession = undefined;
		clearTimeout(stateTimer);
		clearTimeout(agentsTimer);
		stateTimer = undefined;
		agentsTimer = undefined;
		throttle.clear();
		hub.close();
	};

	/** Ends the live feed (queued live frames dropped; the connection stays). */
	const stopFeed = (): void => {
		writer?.stop();
		throttle.clear();
		lastLiveState = "";
		lastAgents = "";
	};

	/**
	 * One agent event (the AgentSession's, else the extension event standing in for it): tracked for
	 * `resync` and, while hostd is subscribed, sent as collab's `event` frame. `message_update` and
	 * `tool_execution_update` are cumulative: throttled per message / tool call, and never sent
	 * after their end frame.
	 */
	const onAgentEvent = (ev: Json, fromSession: boolean): void => {
		if ((!fromSession && agentSession) || !ownsSlot()) return;
		const type = typeof ev.type === "string" ? ev.type : "";
		if (type === "message_start") msgSeq++;
		tracker.track(ev);
		// 2.1.0 `caps.notices`: what omp's TUI shows for these goes out as notices.
		const notice = fallbackNotice(ev);
		if (notice || type === "config_warnings_changed") {
			for (const n of notice ? [notice] : configNotices(agentSession)) sendNotice(n);
			return;
		}
		if (STATE_TRIGGERS[type]) scheduleState();
		if (!WIRE_EVENTS[type]) return;
		const msgKey = `m${msgSeq}`;
		const toolKey = `t:${typeof ev.toolCallId === "string" ? ev.toolCallId : ""}`;
		switch (type) {
			case "message_update":
				// Extension events can deliver an update after its message's end: never send that one.
				if (msgSeq !== endedMsg && writer?.subscribed)
					throttle.run(msgKey, MESSAGE_UPDATE_MS, () => feedLive(() => ({ t: "event", event: wireEvent(ev) }), msgKey));
				return;
			case "tool_execution_update":
				if (!endedTools.has(toolKey) && writer?.subscribed)
					throttle.run(toolKey, TOOL_UPDATE_MS, () => feedLive(() => ({ t: "event", event: wireEvent(ev) }), toolKey));
				return;
			case "message_end":
				endedMsg = msgSeq;
				throttle.end(msgKey);
				writer?.drop(msgKey);
				break;
			case "tool_execution_end":
				endedTools.add(toolKey);
				throttle.end(toolKey);
				writer?.drop(toolKey);
				break;
			case "agent_end":
				endedTools.clear();
				break;
		}
		if (!writer?.subscribed) return;
		// A session change ends the feed (the switch hello goes first); hostd subscribes again.
		if (helloSessionId && sessionId() !== helloSessionId) {
			safeSync();
			return;
		}
		feedLive({ t: "event", event: wireEvent(ev) });
	};

	/** A task-bus frame (direct subagents on the main bus, nested ones relayed): tracked, then sent.
	 *  Progress is cumulative per subagent; the same payload object arriving twice is sent once. */
	const onBusFrame = (channel: string, data: unknown, from: string | undefined): void => {
		if (!isObj(data) || seenBus.has(data)) return;
		seenBus.add(data);
		tracker.bus(channel, data, from ?? ctxRef?.agent?.id, Date.now());
		if (!internals.registry && channel === TASK_LIFECYCLE) scheduleAgents();
		if (!writer?.subscribed) return;
		if (channel === TASK_PROGRESS) {
			const id = strField(data.progress, "id");
			feedLive(() => ({ t: "bus", channel, data }), id ? `p:${id}` : undefined);
		} else {
			feedLive({ t: "bus", channel, data });
		}
	};

	/** `me.relay`: the copies loaded in subagent sessions hand over what only their session's bus sees. */
	const onRelay = (frame: RelayedBus): void => {
		try {
			if (ownsSlot() && isObj(frame) && typeof frame.channel === "string") onBusFrame(frame.channel, frame.data, frame.from);
		} catch (err) {
			bridgeLog(`relay: ${String(err)}`);
		}
	};

	/**
	 * The `resync` frame, taken synchronously when it is written: the file's newest entry (hostd
	 * applies the session file through it), then everything in flight as collab frames in replay
	 * order (unwritten entries, `state`, `agents`, in-flight events, subagent bus frames, pending
	 * dialogs). Live frames with a higher seq follow it.
	 */
	const buildResync = (seq: number): Json => {
		const ctx = ctxRef;
		const frames: Json[] = [];
		const out: Json = { t: "resync", seq, sessionId: null, sessionFile: null, leafId: null, lastEntryId: null, live: { streaming: false, frames } };
		if (!ctx) return out;
		const sm = ctx.sessionManager;
		try {
			const file = sm.getSessionFile();
			out.sessionId = sm.getSessionId();
			out.sessionFile = file ?? null;
			out.leafId = sm.getLeafId() ?? null;
			const entries = sm.getEntries();
			if (file && sessionWritten(sm, file)) {
				// omp writes title changes asynchronously: the newest other entry is in the file. While
				// omp moves the file it is not at `file`: hostd subscribes again until it is.
				for (let i = entries.length - 1; i >= 0; i--) {
					const entry = entries[i]!;
					if ((entry.type as string) === "title_change") continue;
					out.lastEntryId = entry.id;
					break;
				}
			} else {
				// Never written (omp writes the file with the first assistant message): the entries come along.
				for (const entry of entries) if (WIRE_ENTRIES[entry.type]) frames.push({ t: "entry", entry });
			}
		} catch (err) {
			bridgeLog(`resync entries: ${String(err)}`);
		}
		try {
			const state = liveState(ctx);
			lastLiveState = JSON.stringify(state);
			frames.push({ t: "state", state });
		} catch (err) {
			bridgeLog(`resync state: ${String(err)}`);
		}
		try {
			const agents = snapshotAgents();
			lastAgents = JSON.stringify(agents);
			frames.push({ t: "agents", agents });
			// 2.1.0 `caps.notices`: the standing config warnings (keyed: hostd shows each once).
			for (const event of configNotices(agentSession)) frames.push({ t: "event", event });
		} catch (err) {
			bridgeLog(`resync agents: ${String(err)}`);
		}
		try {
			const s = agentSession;
			const toolUpdates = new Map<string, Json>();
			for (const update of s?.activeToolExecutionUpdates?.() ?? []) {
				if (typeof update.toolCallId === "string") toolUpdates.set(update.toolCallId, update);
			}
			frames.push(...tracker.frames({ streamMessage: s?.agent?.state?.streamMessage, toolUpdates }));
		} catch (err) {
			bridgeLog(`resync live: ${String(err)}`);
		}
		for (const request of hub.requests()) frames.push({ t: "ui-request", request });
		out.live = { streaming: isStreaming(), frames };
		return out;
	};

	/** A notice event (2.1.0 `caps.notices`) on the live feed, while hostd follows this session. */
	const sendNotice = (event: Json | undefined): void => {
		if (!event || !ownsSlot() || !writer?.subscribed) return;
		if (helloSessionId && sessionId() !== helloSessionId) return;
		feedLive({ t: "event", event });
	};

	/** Wraps the dialogs of omp's shared UI context (again after a mode re-init gave it a new one). */
	const ensureDialogs = (ctx: ExtensionContext): void => {
		try {
			if (!ctx.hasUI) {
				dialogsReady = false;
				return;
			}
			const ui: object = baseContext(ctx).ui;
			dialogsReady = installDialogWrappers(ui, dialogToken, dialogWrapper);
			installNotifyWrapper(ui, dialogToken, original =>
				function (this: unknown, ...args: unknown[]): unknown {
					if (ownsSlot()) {
						try {
							sendNotice(notifyNotice(args[0], args[1]));
						} catch (err) {
							bridgeLog(`notify: ${String(err)}`);
						}
					}
					return original.apply(this, args);
				},
			);
		} catch (err) {
			dialogsReady = false;
			bridgeLog(`dialogs: ${String(err)}`);
		}
	};

	/** A dialog member's wrapper: races omp's dialog against hostd while this copy bridges, else omp's alone. */
	const dialogWrapper = (name: DialogMember, original: AnyFn): AnyFn =>
		function (this: unknown, ...args: unknown[]): unknown {
			if (ownsSlot()) {
				try {
					const raced = raceMember(hub, name, original, this, args, internals.approval);
					if (raced) return raced;
				} catch (err) {
					bridgeLog(`dialog ${name}: ${String(err)}`);
				}
			}
			return original.apply(this, args);
		};

	// ─── connection ───────────────────────────────────────────────────────────────────────────
	const dropSocket = (): void => {
		const s = sock;
		sock = undefined;
		connected = false;
		// No hostd to resume anything: the context guard must stop telling models it will.
		const owner = bridgeSlot().owners[endpoint];
		if (owner === undefined || owner === me) bridgeSlot().autoResume = undefined;
		connecting = false;
		helloSessionId = undefined;
		// The live feed is per connection: hostd subscribes again after the next hello.
		writer?.stop();
		writer = undefined;
		throttle.clear();
		lastLiveState = "";
		lastAgents = "";
		// Private fallback side turns stream only to hostd; omp's own /btw keeps running.
		for (const th of sideThreads.values()) th.ac?.abort(new Error("bridge disconnected"));
		if (s) {
			try {
				s.destroy();
			} catch {
				/* already gone */
			}
		}
		showStatus(false);
	};

	/** Checks hostd's first frame `{"t":"auth","v":1,"secret":"<64 hex>"}` against `bridge.secret` (read fresh). */
	const verifyAuth = (line: string): string | undefined => {
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return "first frame is not JSON";
		}
		if (!frame || typeof frame !== "object" || !("t" in frame) || frame.t !== "auth") return "first frame is not auth";
		const offered = "secret" in frame && typeof frame.secret === "string" ? frame.secret : "";
		if (!SECRET_HEX.test(offered)) return "malformed secret";
		let expected: string;
		try {
			expected = fs.readFileSync(secretPath, "utf8").trim();
		} catch (err) {
			return `cannot read ${secretPath}: ${String(err)}`;
		}
		if (!SECRET_HEX.test(expected)) return `malformed ${secretPath}`;
		const a = Buffer.from(offered, "hex");
		const b = Buffer.from(expected, "hex");
		return a.length === b.length && crypto.timingSafeEqual(a, b) ? undefined : "secret mismatch";
	};

	const connect = (): void => {
		if (connecting || connected || !active || bridgeSlot().owners[endpoint] !== me) return;
		if (process.platform !== "win32" && !fs.existsSync(endpoint)) {
			nextRetryAt = Date.now() + RETRY_MS;
			return;
		}
		connecting = true;
		connectStartedAt = Date.now();
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
		// Nothing is sent until hostd authenticates with the first frame (see docs/bridge-protocol.md).
		let authed = false;
		s.setEncoding("utf8");
		s.on("data", (chunk: string) => {
			try {
				if (sock !== s) return;
				buf += chunk;
				if (buf.length > (authed ? MAX_LINE : MAX_AUTH_LINE)) {
					bridgeLog(authed ? "oversized frame; reconnecting" : "oversized auth frame; reconnecting");
					dropSocket();
					nextRetryAt = Date.now() + RETRY_MS;
					return;
				}
				let i = buf.indexOf("\n");
				while (i >= 0 && sock === s) {
					const line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					i = buf.indexOf("\n");
					if (!line.trim()) continue;
					if (!authed) {
						const problem = verifyAuth(line);
						if (problem) {
							bridgeLog(`hostd auth failed: ${problem}`);
							dropSocket();
							nextRetryAt = Date.now() + RETRY_MS;
							return;
						}
						authed = true;
						connecting = false;
						connected = true;
						writer = new LiveWriter(
							{
								write: line => {
									try {
										s.write(line);
									} catch (err) {
										bridgeLog(`write failed: ${String(err)}`);
									}
								},
								backlog: () => s.writableLength,
							},
							{
								resync: buildResync,
								...liveLimits(),
								log: bridgeLog,
								onStall: () => {
									bridgeLog("hostd stopped reading; reconnecting");
									dropSocket();
									nextRetryAt = Date.now() + RETRY_MS;
								},
							},
						);
						showStatus(true);
						// `caps.restore` needs omp's restore modules as well (bounded like the probe's imports).
						void Promise.all([internalsReady, settleWithin(loadRestore(), 3_000)]).then(() => {
							if (sock === s && connected) sendHello("connect");
						});
						continue;
					}
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
		// The kernel took what was backed up: send what waited in the live writer's queue.
		s.on("drain", () => {
			try {
				if (sock === s) writer?.flush();
			} catch (err) {
				bridgeLog(`drain: ${String(err)}`);
			}
		});
		s.unref();
	};

	const onTick = (): void => {
		try {
			if (!active) return;
			// Independent of hostd: the session stream and the dialog wrappers (re-wrapped after a mode
			// re-init replaced omp's UI context) are in place before it subscribes, and a session omp
			// wrote since is known as written (a stat per tick until then).
			if (ctxRef) {
				attachSession(ctxRef);
				ensureDialogs(ctxRef);
				noteWritten(ctxRef);
			}
			if (connecting && Date.now() - connectStartedAt > AUTH_TIMEOUT_MS) {
				bridgeLog("hostd did not authenticate in time; reconnecting");
				dropSocket();
				nextRetryAt = Date.now() + RETRY_MS;
				return;
			}
			if (!connected) {
				if (!connecting && Date.now() >= nextRetryAt) connect();
				return;
			}
			writer?.flush();
			sync();
			btwTick();
			jobsTick();
		} catch (err) {
			bridgeLog(`tick: ${String(err)}`);
		}
	};

	const stopTicking = (ctx: ExtensionContext | undefined): void => {
		if (tick === undefined) return;
		try {
			ctx?.clearTimer(tick);
		} catch {
			/* stale handle */
		}
		tick = undefined;
	};

	/** Makes this copy the process's bridge to its hostd unless an equal or newer copy already is. */
	const claim = (): boolean => {
		const owners = bridgeSlot().owners;
		const owner = owners[endpoint];
		if (owner === me) return true;
		if (owner && compareVersions(String(owner.version), BRIDGE_VERSION) >= 0) return false;
		owners[endpoint] = me;
		if (owner) {
			bridgeLog(`taking over from TeleFlock bridge ${String(owner.version)}`);
			try {
				owner.stop();
			} catch (err) {
				bridgeLog(`stopping bridge ${String(owner.version)}: ${String(err)}`);
			}
		}
		return true;
	};

	/** A newer copy took over the process: stop talking to hostd (socket, timers, status line). */
	const standDown = (): void => {
		try {
			stopTicking(ctxRef);
			detachLive();
			dropSocket();
			// The new copy's hostd connection says it again; until then nothing resumes anything.
			bridgeSlot().autoResume = undefined;
			bridgeLog("a newer TeleFlock bridge took over");
		} catch (err) {
			bridgeLog(`stand down: ${String(err)}`);
		}
	};

	/** The main session started or changed: bridge it when this copy owns the process. */
	const bridgeSession = (ctx: ExtensionContext): void => {
		if (!claim()) return;
		stopTicking(ctx);
		tick = ctx.setInterval(onTick, TICK_MS);
		attachSession(ctx);
		attachRegistry();
		ensureDialogs(ctx);
		if (connected) safeSync();
		else connect();
	};

	// ─── background jobs (2.1.0, `caps.jobs`) ─────────────────────────────────────────────────
	/** JSON of the last `jobs` event; {@link JOBS_NONE} after every hello, so a session without jobs sends none. */
	let lastJobsJson = JOBS_NONE;
	const jobsSession = (): JobsSession | undefined => agentSession as JobsSession | undefined;
	/** omp's public snapshot (the main agent's own jobs) for when the AgentSession is out of reach. */
	const publicJobs = (): (() => unknown) | undefined => {
		const ctx: unknown = ctxRef;
		if (!isObj(ctx) || typeof ctx.getAsyncJobSnapshot !== "function") return undefined;
		const snapshot = ctx.getAsyncJobSnapshot;
		return () => snapshot.call(ctx);
	};
	const jobsReady = (ctx: ExtensionContext): boolean => {
		const c: unknown = ctx;
		return (isObj(c) && typeof c.getAsyncJobSnapshot === "function") || typeof jobsSession()?.getAsyncJobTree === "function";
	};
	/** omp's own async wait (its TUI: "Waiting for background jobs"): the main agent's turn is over and
	 *  only background work can resume it. */
	const jobsWaiting = (list: JobsList): boolean => {
		if (isStreaming()) return false;
		const s = jobsSession();
		if (typeof s?.hasPendingAsyncWork === "function") {
			try {
				return s.hasPendingAsyncWork() === true;
			} catch {
				// judge by the jobs
			}
		}
		const main = list.rootId ?? ctxRef?.agent?.id;
		return list.running.some(j => j.ownerId === undefined || j.ownerId === main);
	};
	/** Live widgets of the main agent's running jobs, read only in the TUI: its status line reads them
	 *  anyway, and reading one is what lets omp's cheap model write its rules. */
	const runningWidgets = (): readonly { id: string; view?: unknown }[] => {
		if (ctxRef?.mode !== "tui") return [];
		try {
			const w = jobsSession()?.getRunningJobWidgets?.();
			return Array.isArray(w) ? w : [];
		} catch {
			return [];
		}
	};
	const agentName = (id: string): string | undefined => {
		try {
			return internals.registry?.get(id)?.displayName || undefined;
		} catch {
			return undefined;
		}
	};
	/** How to cancel a job: through its owner's session (omp's `cancelAsyncJob` checks the owner), else
	 *  through the job manager with that owner. */
	const jobCanceller = (job: JobItem, rootId: string | undefined): ((id: string) => boolean) | undefined => {
		const main = jobsSession();
		const top = job.ownerId === undefined || job.ownerId === rootId || job.ownerId === ctxRef?.agent?.id;
		if (top && typeof main?.cancelAsyncJob === "function") return id => main.cancelAsyncJob!(id);
		const owner = job.ownerId ? internals.registry?.get(job.ownerId)?.session : undefined;
		if (isObj(owner) && typeof owner.cancelAsyncJob === "function") {
			const cancel = owner.cancelAsyncJob;
			return id => cancel.call(owner, id) === true;
		}
		const manager = main?.asyncJobManager;
		if (typeof manager?.cancel === "function") return id => manager.cancel!(id, { ownerId: job.ownerId });
		return undefined;
	};
	/** The `jobs` event: sent on the tick when the summary changed (so at most once a second). */
	const jobsTick = (): void => {
		if (!connected || !helloSessionId) return;
		const list = listJobs(jobsSession(), publicJobs());
		if (!list) return;
		const json = JSON.stringify(jobsSummary(list, runningWidgets(), jobsWaiting(list)));
		if (json === lastJobsJson) return;
		lastJobsJson = json;
		emit("jobs", JSON.parse(json));
	};
	/** `jobs`: every listed job; the inspected ones (or all) with output, pids, exit code, folder, artifact. */
	const jobsView = (inspect: ReadonlySet<string> | "all"): JobsViewWire => {
		const list = listJobs(jobsSession(), publicJobs()) ?? fail("unsupported", "this omp has no background jobs API");
		const s = jobsSession();
		const widgets = new Map(runningWidgets().map(w => [w.id, w.view]));
		const jobs = [...list.running, ...list.recent].map(job => {
			let inspection: JobInspection | undefined;
			if ((inspect === "all" || inspect.has(job.id)) && typeof s?.inspectAsyncJob === "function") {
				try {
					const r: unknown = s.inspectAsyncJob(job.id);
					if (isObj(r)) inspection = r as JobInspection;
				} catch (err) {
					bridgeLog(`inspect job ${job.id}: ${String(err)}`);
				}
			}
			const rootId = list.rootId ?? ctxRef?.agent?.id; // the public snapshot names no root: it is the main agent
			const cancellable = jobCanceller(job, rootId) !== undefined;
			return jobWire(job, { rootId, name: agentName, cancellable, widget: widgets.get(job.id), inspection });
		});
		return { jobs, waiting: jobsWaiting(list), at: Date.now() };
	};
	/** `jobCancel`: omp cancels the job (its process is killed, a subagent aborted); the jobs after it. */
	const jobCancel = (id: string): JobsViewWire => {
		const list = listJobs(jobsSession(), publicJobs()) ?? fail("unsupported", "this omp has no background jobs API");
		const job = [...list.running, ...list.recent].find(j => j.id === id) ?? fail("not_found", `no background job ${id}`);
		if (job.status !== "running") fail("not_found", `job ${id} already ${job.status ?? "settled"}`);
		const cancel = jobCanceller(job, list.rootId) ?? fail("unsupported", "this omp cannot cancel background jobs from an extension");
		if (!cancel(id)) fail("not_found", `job ${id} is not running any more`);
		bridgeLog(`cancelled job ${id}`);
		const view = jobsView(new Set());
		jobsTick();
		return view;
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

	/**
	 * Pull the last queued message (last steer, else last follow-up) back out of the queue, as Alt+Up
	 * does, but hand its text to the caller instead of the operator's composer: omp merges the popped
	 * text ahead of the draft, so the draft (text + images) is put back exactly as it was.
	 */
	const dequeueLast = async (ctx: ExtensionContext): Promise<{ text?: string }> => {
		const ed = await findEditor(ctx);
		if (typeof ed.onDequeue !== "function") fail("unsupported", "this omp has no dequeue action");
		// The band lags collab-guest steers (omp refreshes it before queuing them), so ask the
		// session too; a pop that finds nothing leaves the draft as is and is reported as empty.
		const queued = readQueue();
		if (queued.steering.length + queued.followUp.length === 0 && !ctx.hasPendingMessages()) return {};
		const draft = ed.getText();
		const images = [...ed.pendingImages];
		const links = Array.isArray(ed.pendingImageLinks) ? [...ed.pendingImageLinks] : undefined;
		ed.onDequeue!();
		const merged = ed.getText();
		let text = merged;
		if (draft.trim() && merged.endsWith(draft)) text = merged.slice(0, merged.length - draft.length).replace(/\n\n$/, "");
		ed.pendingImages = images;
		if (links) {
			ed.pendingImageLinks = links;
			if ("imageLinks" in ed) ed.imageLinks = links;
		}
		if (ed.setDraft) ed.setDraft(draft, images);
		else ed.setText(draft);
		return text.trim() ? { text } : {};
	};

	/**
	 * Command context for navigateTree/branch/newSession, captured once per process by submitting
	 * /teleflock-control. omp runs that command in one of the copies that register it, which may be
	 * another copy than this one, so the context and its waiters live in the process-wide slot.
	 */
	const ensureCmdCtx = async (ctx: ExtensionContext): Promise<ExtensionCommandContext> => {
		const slot = bridgeSlot();
		if (slot.cmdCtx) return slot.cmdCtx;
		requireTui(ctx);
		const attach = `/${ATTACH_COMMAND}`;
		// While omp compacts, it queues a submitted command (shown under "Steering") until compaction ends.
		const compacting = "omp is compacting the session; try again when it finishes";
		if (readQueue().steering.includes(attach)) fail("busy", compacting);
		const got = new Promise<void>(resolve => slot.attachWaiters.push(resolve));
		await submit(ctx, attach);
		if (!slot.cmdCtx && readQueue().steering.includes(attach)) fail("busy", compacting);
		let timer: Timer | undefined;
		await Promise.race([
			got,
			new Promise<void>(resolve => {
				timer = setTimeout(resolve, 5_000);
				timer.unref?.();
			}),
		]).finally(() => clearTimeout(timer));
		return slot.cmdCtx ?? fail("unsupported", "could not capture the session command context");
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
			if (e.type === "message")
				text = contentText(e.message.content) || ("stopReason" in e.message && e.message.stopReason === "aborted" ? "[aborted]" : "");
			else if (e.type === "branch_summary" || e.type === "compaction") text = e.summary;
			else if (e.type === "custom_message")
				text = (e.customType === "advisor" ? advisorText(e.details) : "") || contentText(e.content) || e.customType;
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

	// ─── /btw ─────────────────────────────────────────────────────────────────────────────────
	// A TeleFlock side question is omp's own /btw: `/btw <question>` goes through the composer and a
	// follow-up through the BTW history panel's composer, exactly as the operator would, so it shows in
	// the TUI, lands in the session's BTW history and continues the same lineage. The btw id is omp's
	// history topic id. Answers reach hostd from three sources, whichever is first: the history files
	// (turn start and end, also for /btw asked in the TUI), the inline answer panel (streaming) and the
	// history panel (streaming while it is open). Without the TUI (or an on-disk session) a private
	// ephemeral side turn answers instead (not in omp's history).

	const btwDir = (ctx: ExtensionContext): string | undefined => {
		try {
			const dir = ctx.sessionManager.getArtifactsDir();
			return dir ? path.join(dir, "btw-history") : undefined;
		} catch {
			return undefined;
		}
	};

	/** Send what hostd does not have yet: the question once, text deltas, then one final frame. */
	const pushBtw = (t: BtwLive, done: boolean, final?: { status: BtwStatus; error?: string }): void => {
		if (t.done || !connected) return;
		const data: Record<string, unknown> = { btwId: t.id, turn: t.turn };
		if (!t.announced) data.question = t.question;
		if (done) {
			t.done = true;
			t.final = final ?? { status: "complete" };
			data.text = t.text;
			data.done = true;
			const error = btwErrorOf(t.final);
			if (error) data.error = error;
		} else {
			const delta = t.text.startsWith(t.sent) ? t.text.slice(t.sent.length) : "";
			if (!delta && t.announced) return;
			data.text = delta;
			data.done = false;
			t.sent += delta;
		}
		t.announced = true;
		send({ t: "event", event: "btw_delta", sessionId: t.sid, data });
	};

	/** Fold a history record into the live turns; `announce: false` (first scan) only learns them. */
	const absorbBtw = (sid: string, rec: BtwRec, announce: boolean): void => {
		[rec, ...rec.followUps].forEach((turn, i) => {
			const key = `${rec.id}:${i}`;
			let t = btwLive.get(key);
			if (!t) {
				t = { sid, id: rec.id, turn: i, question: turn.question, text: turn.answer, sent: "", announced: false, done: false };
				btwLive.set(key, t);
				if (!announce) {
					// A turn still "running" on disk at that point belongs to an earlier process.
					t.done = t.announced = true;
					t.sent = turn.answer;
					t.final = { status: turn.status === "running" ? "interrupted" : turn.status, error: turn.error };
					return;
				}
			}
			if (t.done) return;
			if (turn.answer.length > t.text.length && turn.answer.startsWith(t.text)) t.text = turn.answer;
			if (turn.status === "running") {
				pushBtw(t, false);
				return;
			}
			if (turn.answer) t.text = turn.answer;
			pushBtw(t, true, { status: turn.status, error: turn.error });
		});
	};

	/** Read new or changed history files (all of them, silently, on a session's first scan). */
	const scanBtw = (ctx: ExtensionContext): Promise<void> => {
		btwScan ??= (async () => {
			const sid = ctx.sessionManager.getSessionId();
			if (sid !== btwSid) {
				for (const t of btwLive.values()) t.done = true; // the old session's panels stop streaming
				btwLive.clear();
				btwRecords.clear();
				btwFileSigs.clear();
				btwSid = sid;
				btwBaseline = false;
			}
			const dir = btwDir(ctx);
			const names = dir ? await fs.promises.readdir(dir).catch(() => [] as string[]) : [];
			for (const name of names.sort()) {
				if (!dir || !name.startsWith("entry-") || !name.endsWith(".json")) continue;
				const file = path.join(dir, name);
				const st = await fs.promises.stat(file).catch(() => undefined);
				if (!st) continue;
				const sig = `${st.mtimeMs}:${st.size}`;
				if (btwFileSigs.get(file) === sig) continue;
				btwFileSigs.set(file, sig);
				const raw: unknown = await fs.promises
					.readFile(file, "utf8")
					.then(JSON.parse)
					.catch(() => undefined);
				const rec = parseBtwRecord(raw);
				if (!rec || btwSid !== sid) continue;
				btwRecords.set(rec.id, rec);
				absorbBtw(sid, rec, btwBaseline);
			}
			if (btwSid === sid) btwBaseline = true;
		})()
			.catch((err: unknown) => bridgeLog(`btw scan: ${String(err)}`))
			.finally(() => {
				btwScan = undefined;
			});
		return btwScan;
	};

	/** Poll the history (and `probe`) until `probe` yields something or `ms` passes. */
	const untilBtw = async <T>(ctx: ExtensionContext, probe: () => T | undefined, ms: number): Promise<T | undefined> => {
		const end = Date.now() + ms;
		for (;;) {
			await scanBtw(ctx);
			const hit = probe();
			if (hit !== undefined || Date.now() >= end) return hit;
			await new Promise<void>(r => {
				const t = setTimeout(r, 100);
				t.unref?.();
			});
		}
	};

	const runningBtw = (): BtwLive | undefined => {
		for (const t of btwLive.values()) if (!t.done) return t;
		return undefined;
	};

	/** Stream an inline answer panel: wrap its update methods on the instance (originals run first). */
	const hookBtwPanel = (panel: BtwPanel, t: BtwLive): void => {
		btwHooked.add(panel);
		t.panel = panel;
		const shown = btwPanelAnswer(panel);
		if (shown && shown.length > t.text.length) t.text = shown;
		let closed = false;
		const methods = panel as Record<string, unknown>;
		const after = (name: string, fn: (arg: unknown) => void): void => {
			const orig = methods[name] as (...args: unknown[]) => unknown;
			methods[name] = function (this: unknown, ...args: unknown[]) {
				const result = orig.apply(this, args);
				try {
					if (!closed) fn(args[0]);
				} catch (err) {
					bridgeLog(`btw panel: ${String(err)}`);
				}
				return result;
			};
		};
		after("appendText", d => {
			if (typeof d !== "string") return;
			t.text += d;
			pushBtw(t, false);
		});
		after("setAnswer", s => {
			if (typeof s !== "string") return;
			t.text = s;
			pushBtw(t, false);
		});
		after("markComplete", () => pushBtw(t, true, { status: "complete" }));
		after("markAborted", () => pushBtw(t, true, { status: "cancelled" }));
		after("markError", m => pushBtw(t, true, { status: "error", error: typeof m === "string" ? m : undefined }));
		after("close", () => {
			closed = true;
		});
		pushBtw(t, false);
	};

	/** Attach unhooked inline panels to the running turn that asks their question. */
	const hookBtwPanels = (): void => {
		const tui = tuiRef;
		if (!tui || ![...btwLive.values()].some(t => !t.done && !t.panel)) return;
		const panels: Component[] = [];
		walkAll(tui, isBtwPanel, panels);
		for (const panel of panels as BtwPanel[]) {
			if (btwHooked.has(panel)) continue;
			const q = btwPanelQuestion(panel);
			let match: BtwLive | undefined;
			for (const t of btwLive.values()) if (!t.done && !t.panel && oneLine(t.question) === q) match = t; // newest wins
			if (match) hookBtwPanel(panel, match);
		}
	};

	/** The open BTW history overlay (hooked so its record updates stream), if any. */
	const btwHistoryPanel = (): BtwHistoryPanel | undefined => {
		const stack = tuiRef?.overlayStack;
		if (!Array.isArray(stack)) return undefined;
		for (let i = stack.length - 1; i >= 0; i--) {
			const panel = stack[i]?.component;
			if (!isBtwHistoryPanel(panel)) continue;
			if (!btwHooked.has(panel)) {
				btwHooked.add(panel);
				const methods = panel as unknown as Record<string, unknown>;
				const update = methods.update as (records: unknown) => unknown;
				methods.update = function (this: unknown, records: unknown) {
					const result = update.call(this, records);
					try {
						const sid = btwSid;
						if (sid && btwBaseline && Array.isArray(records)) {
							for (const raw of records) {
								const id: unknown = raw && typeof raw === "object" && "id" in raw ? raw.id : undefined;
								const followUps = raw && typeof raw === "object" && "followUps" in raw && Array.isArray(raw.followUps) ? raw.followUps.length : 0;
								if (typeof id !== "string" || btwLive.get(`${id}:${followUps}`)?.done) continue;
								const rec = parseBtwRecord(raw);
								if (rec) absorbBtw(sid, rec, true);
							}
						}
					} catch (err) {
						bridgeLog(`btw history panel: ${String(err)}`);
					}
					return result;
				};
			}
			return panel;
		}
		return undefined;
	};

	/** Every tick: pick up history changes, then panels for turns that stream without one yet. */
	const btwTick = (): void => {
		const ctx = ctxRef;
		if (!ctx || btwScan) return;
		void scanBtw(ctx).then(() => {
			try {
				// A /btw typed in the TUI before any TeleFlock TUI op: locate the TUI to stream it.
				if (!tuiRef && ctx.mode === "tui" && runningBtw()) void findEditor(ctx).catch(() => {});
				hookBtwPanels();
				btwHistoryPanel();
			} catch (err) {
				bridgeLog(`btw tick: ${String(err)}`);
			}
		});
	};

	const askBtw = async (ctx: ExtensionContext, question: string): Promise<{ btwId: string; turn: number }> => {
		await scanBtw(ctx);
		if (runningBtw()) fail("busy", "a /btw question is still running; wait for it or cancel it");
		const known = new Set(btwRecords.keys());
		const want = oneLine(question);
		await submit(ctx, `/btw ${want}`);
		const rec = await untilBtw(
			ctx,
			() => [...btwRecords.values()].find(r => !known.has(r.id) && oneLine(r.question) === want),
			5_000,
		);
		if (!rec) return fail("busy", "omp did not start the side question (another /btw may be running, or no model is set)");
		hookBtwPanels();
		btwHistoryPanel();
		return { btwId: rec.id, turn: 0 };
	};

	const followUpBtw = async (ctx: ExtensionContext, btwId: string, question: string): Promise<{ btwId: string; turn: number }> => {
		await scanBtw(ctx);
		const rec = btwRecords.get(btwId) ?? fail("not_found", `no side conversation ${btwId}`);
		if (runningBtw()) fail("busy", "a /btw question is still running; wait for it or cancel it");
		const turn = rec.followUps.length + 1;
		await findEditor(ctx);
		// omp follows up from its BTW history panel (`f` on an answer opens the same composer).
		let panel = btwHistoryPanel();
		if (!panel) {
			await submit(ctx, "/btw");
			panel = btwHistoryPanel() ?? fail("unsupported", "could not open omp's /btw history");
		}
		if (!panel.openFollowUp(btwId)) fail("busy", "omp cannot follow up on this side conversation right now");
		const text = oneLine(question);
		if (typeof panel.pasteText === "function") panel.pasteText(text);
		else for (const ch of text) panel.handleInput(ch);
		panel.handleInput("\n");
		const started = await untilBtw(ctx, () => btwLive.get(`${btwId}:${turn}`), 5_000);
		if (!started) fail("omp_error", "omp did not start the follow-up");
		return { btwId, turn };
	};

	const cancelBtw = async (ctx: ExtensionContext, btwId: string): Promise<Record<string, never>> => {
		const side = sideThreads.get(btwId);
		if (side) {
			(side.ac ?? fail("not_found", `no running btw ${btwId}`)).abort(new Error("cancelled"));
			return {};
		}
		await scanBtw(ctx);
		let t: BtwLive | undefined;
		for (const x of btwLive.values()) if (x.id === btwId && !x.done) t = x;
		if (!t) return fail("not_found", `no running btw ${btwId}`);
		// The operator's Esc, delivered where omp listens for it: the history panel when open, else
		// the composer, whose Esc handler gives a visible /btw panel first say (cancel).
		await findEditor(ctx);
		const history = btwHistoryPanel();
		const inline = t.panel;
		if (history) {
			history.showRecord(btwId);
			history.handleInput(tuiRef?.nativeRendering ? "x" : "\x1b");
		} else if (inline && tuiRef && walk(tuiRef, c => c === inline) && typeof editorRef?.onEscape === "function") {
			editorRef.onEscape();
		} else {
			fail("unsupported", "this side question can only be cancelled in omp's TUI (Esc)");
		}
		const live = t;
		if (!(await untilBtw(ctx, () => (live.done ? live : undefined), 3_000))) fail("omp_error", "omp did not cancel the side question");
		return {};
	};

	const btwHistory = async (ctx: ExtensionContext) => {
		await scanBtw(ctx);
		const threads = [...btwRecords.values()].map(rec => ({
			btwId: rec.id,
			at: rec.createdAt,
			turns: [rec, ...rec.followUps].map((turn, i) => {
				const live = btwLive.get(`${rec.id}:${i}`);
				if (turn.status !== "running" || !live) {
					return { question: turn.question, answer: turn.answer, status: turn.status, error: turn.error, at: turn.createdAt };
				}
				// The file still says running: the live turn knows better (streamed text, final status).
				const status = live.done ? (live.final?.status ?? "interrupted") : "running";
				return { question: turn.question, answer: live.text, status, error: live.final?.error, at: turn.createdAt };
			}),
		}));
		for (const th of sideThreads.values()) {
			threads.push({
				btwId: th.id,
				at: th.at,
				turns: th.turns.map(turn => ({ question: turn.question, answer: turn.answer, status: turn.status, error: turn.error, at: turn.createdAt })),
			});
		}
		threads.sort((a, b) => a.at - b.at);
		return { threads };
	};

	/** Fallback without omp's TUI /btw: a private ephemeral side turn, replaying the thread's turns. */
	const sideBtw = (ctx: ExtensionContext, question: string, btwId: string | undefined): { btwId: string; turn: number } => {
		const run = ctx.runEphemeralTurn ?? fail("unsupported", "this omp has no ephemeral side turns");
		const model = ctx.model ?? fail("unsupported", "no active model available for /btw");
		const sid = sessionId() ?? fail("not_ready", "session not initialised yet");
		for (const th of sideThreads.values()) if (th.ac) fail("busy", "a side question is still running; wait for it or cancel it");
		let th: SideThread;
		if (btwId) th = sideThreads.get(btwId) ?? fail("not_found", `no side conversation ${btwId}`);
		else {
			th = { id: `tf-btw-${process.pid}-${Date.now().toString(36)}-${(++btwSeq).toString(36)}`, at: Date.now(), turns: [] };
			sideThreads.set(th.id, th);
		}
		// Same shape as omp's btw-turn.ts: earlier turns replayed as context, one provider lineage
		// per run of successful turns.
		const history: unknown[] = [];
		for (const turn of th.turns) {
			history.push({ role: "user", content: [{ type: "text", text: btwPrompt(turn.question) }], attribution: "agent", timestamp: turn.createdAt });
			if (!turn.answer) continue;
			history.push({
				role: "assistant",
				content: [{ type: "text", text: turn.answer }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: turn.updatedAt,
			});
		}
		const epoch = th.turns.findLastIndex(turn => turn.status !== "complete") + 1;
		const now = Date.now();
		const turn: BtwTurnRec = { question, answer: "", status: "running", createdAt: now, updatedAt: now };
		const index = th.turns.push(turn) - 1;
		const t: BtwLive = { sid, id: th.id, turn: index, question, text: "", sent: "", announced: false, done: false };
		const ac = new AbortController();
		const thread = th;
		thread.ac = ac;
		pushBtw(t, false);
		const finish = (status: BtwStatus, error?: string) => {
			Object.assign(turn, { status, error, answer: t.text, updatedAt: Date.now() });
			thread.ac = undefined;
			pushBtw(t, true, { status, error });
		};
		Promise.resolve()
			.then(() =>
				run.call(ctx, {
					promptText: btwPrompt(question),
					history: history as never,
					conversationKey: `btw:${thread.id}:${epoch}`,
					replyMaxBytes: Number.POSITIVE_INFINITY,
					signal: ac.signal,
					onTextDelta: (delta: string) => {
						t.text += delta;
						pushBtw(t, false);
					},
				}),
			)
			.then(
				res => {
					t.text = res.replyText;
					finish("complete");
				},
				(err: unknown) =>
					ac.signal.aborted ? finish("cancelled") : finish("error", err instanceof Error ? err.message : String(err)),
			)
			.catch(() => {});
		return { btwId: thread.id, turn: index };
	};

	/** `prompt` (2.0.0): a user message with optional images. While idle it starts a turn whatever
	 *  `delivery` says; while streaming `auto` and `steer` steer, `followUp` waits for the turn's end. */
	const promptOp = (p: Params): { queued: boolean } => {
		const text = str(p, "text") ?? "";
		const raw = p.images;
		if (raw !== undefined && raw !== null && !Array.isArray(raw)) fail("invalid_params", '"images" must be an array');
		const images = (Array.isArray(raw) ? raw : []).map((img: unknown, i) => {
			const data = strField(img, "data");
			const mimeType = strField(img, "mimeType");
			if (!data || !mimeType?.startsWith("image/")) return fail("invalid_params", `images[${i}] needs base64 "data" and an image/* "mimeType"`);
			return { type: "image" as const, data, mimeType };
		});
		if (!text.trim() && images.length === 0) fail("invalid_params", 'missing "text"');
		const delivery = str(p, "delivery") ?? "auto";
		if (delivery !== "auto" && delivery !== "steer" && delivery !== "followUp") fail("invalid_params", `unknown delivery ${delivery}`);
		const content = images.length > 0 ? [{ type: "text" as const, text }, ...images] : text;
		if (!isStreaming()) {
			pi.sendUserMessage(content);
			return { queued: false };
		}
		pi.sendUserMessage(content, { deliverAs: delivery === "followUp" ? "followUp" : "steer" });
		return { queued: true };
	};

	/** `agentCmd` (2.0.0), as omp's collab host `#handleAgentCmd`: `chat` revives a parked subagent and
	 *  steers (or starts) its turn, `kill` aborts and tombstones it, `revive` brings it back. */
	const agentCmd = async (p: Params): Promise<Record<string, never>> => {
		const cmd = str(p, "cmd", true);
		const agentId = str(p, "agentId", true);
		const reg = internals.registry;
		const lifecycle = internals.lifecycle;
		if (!reg || !lifecycle) return fail("unsupported", "this omp has no agent lifecycle manager");
		const ref = reg.get(agentId);
		if (ref?.kind === "advisor") fail("invalid_params", `agent ${agentId}: advisor transcripts are read-only`);
		const manager = lifecycle.global();
		switch (cmd) {
			case "chat": {
				const text = str(p, "text")?.trim();
				if (!text) return fail("invalid_params", `agent ${agentId}: empty chat message`);
				const live: unknown = await manager.ensureLive(agentId);
				if (!isSession(live) || typeof live.prompt !== "function") return fail("unsupported", `agent ${agentId} cannot take messages`);
				// The turn outlives this request: report only a failure that comes at once.
				const run = live.prompt(text, { streamingBehavior: "steer" });
				run.catch((err: unknown) => bridgeLog(`agent ${agentId}: ${String(err)}`));
				const early = await settleWithin(
					run.then(
						() => undefined,
						(err: unknown) => err ?? new Error("prompt failed"),
					),
					1_500,
				);
				if (early !== undefined) throw early;
				return {};
			}
			case "kill": {
				if (!ref) return fail("not_found", `no agent ${agentId}`);
				const s = ref.session;
				if (ref.status === "running" && isSession(s) && typeof s.abort === "function") await s.abort({ reason: internals.interruptLabel });
				await manager.release(agentId, ref, { tombstone: true });
				return {};
			}
			case "revive":
				await manager.ensureLive(agentId);
				return {};
			default:
				return fail("invalid_params", `unknown cmd ${cmd}`);
		}
	};

	// ─── 2.1.0: continue where it stopped (`caps.restore`, `caps.restoreSelect`, docs/bridge-protocol.md "Restore") ─
	// omp's own `--restore` for the live session (task/restore.ts `restoreSession`): its subagents
	// cut off mid-turn go on as background jobs of their parents, then its own interrupted turn.
	// `restoreSelect`: the same for the parts hostd names only (the turn, chosen subagents).
	type RestoreFns = {
		restoreSession?: (session: unknown, options?: Json) => Promise<Json>;
		hasRestorableTurn?: (entries: unknown[]) => boolean;
		/** registry/persisted-agents: puts the session's persisted subagents into omp's registry. */
		ensurePersistedRoster?: (registry: unknown, sessionFile?: string | null) => Promise<unknown>;
		/** session/exit-diagnostics `INTERRUPTED_TURN_ERROR`: the text of exit recovery's abort record. */
		interruptedTurnError?: string;
	};
	let restoreFns: Promise<RestoreFns> | undefined;
	let restoreLoaded: RestoreFns = {};
	/** omp's restore functions: its root exports when it has them (the modules omp runs), else the
	 *  literal subpath imports, which omp's extension loader maps to its own loaded modules. Once. */
	const loadRestore = (): Promise<RestoreFns> => {
		if (restoreFns) return restoreFns;
		const ns = (isObj((pi as unknown as { pi?: unknown }).pi) ? (pi as unknown as { pi: Json }).pi : {}) as Json;
		const fnOf = <T>(v: unknown): T | undefined => (typeof v === "function" ? (v as T) : undefined);
		const own: RestoreFns = {
			restoreSession: fnOf(ns.restoreSession),
			hasRestorableTurn: fnOf(ns.hasRestorableTurn),
			ensurePersistedRoster: fnOf(ns.ensurePersistedRoster),
			interruptedTurnError: typeof ns.INTERRUPTED_TURN_ERROR === "string" ? ns.INTERRUPTED_TURN_ERROR : undefined,
		};
		restoreLoaded = own;
		if (own.restoreSession && own.hasRestorableTurn && own.ensurePersistedRoster) return (restoreFns = Promise.resolve(own));
		return (restoreFns = (async () => {
			const [task, diag, roster] = await Promise.all([
				own.restoreSession ? undefined : import("@oh-my-pi/pi-coding-agent/task/restore").catch(() => undefined),
				own.hasRestorableTurn ? undefined : import("@oh-my-pi/pi-coding-agent/session/exit-diagnostics").catch(() => undefined),
				own.ensurePersistedRoster ? undefined : import("@oh-my-pi/pi-coding-agent/registry/persisted-agents").catch(() => undefined),
			]);
			restoreLoaded = {
				restoreSession: own.restoreSession ?? fnOf(task?.restoreSession),
				hasRestorableTurn: own.hasRestorableTurn ?? fnOf(diag?.hasRestorableTurn),
				ensurePersistedRoster: own.ensurePersistedRoster ?? fnOf(roster?.ensurePersistedRoster),
				interruptedTurnError: own.interruptedTurnError ?? (typeof diag?.INTERRUPTED_TURN_ERROR === "string" ? diag.INTERRUPTED_TURN_ERROR : undefined),
			};
			return restoreLoaded;
		})());
	};
	void loadRestore();
	/** `caps.restore`: omp's restore functions and the live session's restore entry point. */
	const restoreReady = (ctx: ExtensionContext): boolean =>
		restoreLoaded.restoreSession !== undefined && restoreLoaded.hasRestorableTurn !== undefined && typeof mainRetry(ctx)?.restoreInterruptedTurn === "function";
	/** `caps.restoreSelect`: `restore {turn?, subagentIds?}` also needs what omp's `restoreSubagents`
	 *  uses: its persisted roster, task internals, agent registry and the session's background jobs. */
	const restoreSelectReady = (ctx: ExtensionContext): boolean =>
		restoreReady(ctx) &&
		restoreLoaded.ensurePersistedRoster !== undefined &&
		internals.resume?.task !== undefined &&
		internals.registry !== undefined &&
		mainRetry(ctx)?.asyncJobManager !== undefined;
	/** A subagent transcript's entries as omp's restore reads them (the header left out), or
	 *  `undefined` when the file cannot be read. Only the last {@link TRANSCRIPT_TAIL_BYTES} are read:
	 *  whether a turn is restorable depends on how the transcript ends, and this runs on omp's loop. */
	const transcriptEntries = (file: string): unknown[] | undefined => {
		let fd: number | undefined;
		try {
			fd = fs.openSync(file, "r");
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
			const buf = Buffer.alloc(size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			const lines = buf.toString("utf8").split("\n");
			if (start > 0) lines.shift(); // cut mid-line
			return lines
				.flatMap(l => {
					try {
						return l ? [JSON.parse(l)] : [];
					} catch {
						return [];
					}
				})
				.filter(e => isObj(e) && e.type !== "session");
		} catch {
			return undefined;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	};
	/** Puts the session's persisted subagents into omp's registry, as omp's restore does first (a
	 *  freshly `--resume`d omp has not read them yet). A failure leaves the registry as it is. */
	const loadPersistedRoster = async (ctx: ExtensionContext): Promise<void> => {
		const { ensurePersistedRoster } = await loadRestore();
		const sessionFile = mainRetry(ctx)?.sessionManager?.getSessionFile?.();
		if (!ensurePersistedRoster || !internals.registry || !sessionFile) return;
		try {
			await ensurePersistedRoster(internals.registry, sessionFile);
		} catch (err) {
			bridgeLog(`persisted roster: ${String(err)}`);
		}
	};
	/** `restorable`: what `restore` would go on with (`{turn, subagents}`), by omp's own rules. */
	const restorableOp = async (ctx: ExtensionContext): Promise<Json> => {
		const { hasRestorableTurn } = await loadRestore();
		const main = mainRetry(ctx) ?? fail("unsupported", "this omp has no session to restore");
		if (!hasRestorableTurn) return fail("unsupported", "this omp has no --restore");
		await loadPersistedRoster(ctx);
		const branch = (main.sessionManager as { getBranch?(): unknown[] } | undefined)?.getBranch?.() ?? [];
		const turn = !main.isStreaming && hasRestorableTurn(branch);
		const subagents: string[] = [];
		for (const ref of internals.registry?.list() ?? []) {
			if (ref.kind !== "sub" || ref.status === "running" || !ref.sessionFile) continue;
			try {
				if (fs.existsSync(`${ref.sessionFile}.tombstone`)) continue;
				// an unreadable transcript: omp's restore skips it too
				const entries = transcriptEntries(ref.sessionFile);
				if (entries && hasRestorableTurn(entries)) subagents.push(ref.id);
			} catch {
				// omp's rules failed on it: not restorable
			}
		}
		return { turn, subagents };
	};
	/** `restore`: omp's `restoreSession` (the `--restore` path) on the live session, now; with `turn` or
	 *  `subagentIds` (`caps.restoreSelect`) only those parts ({@link restoreChosen}). */
	const restoreOp = async (ctx: ExtensionContext, p: Params): Promise<Json> => {
		// A selection (`turn` and/or `subagentIds`) restores only those parts.
		if ((p.turn ?? p.subagentIds ?? null) !== null) return restoreChosen(ctx, p);
		const { restoreSession } = await loadRestore();
		const main = mainRetry(ctx) ?? fail("unsupported", "this omp has no session to restore");
		if (!restoreSession) return fail("unsupported", "this omp has no --restore");
		if (main.isStreaming) return fail("busy", "the agent is working");
		const out = await restoreSession(main, { eventBus: pi.events });
		return { turn: out?.turn === true, subagents: Array.isArray(out?.subagents) ? out.subagents : [] };
	};
	/**
	 * `restore {turn?, subagentIds?}`: omp's restore for the listed parts only. Once the session's
	 * persisted subagents are in omp's registry (`ensurePersistedRoster`, as omp's restore does first;
	 * a freshly `--resume`d omp has not read them yet), each listed subagent, parents before children,
	 * goes on exactly as omp's `restoreSubagents` (task/restore.ts) revives one: a background job of
	 * its parent runs omp's follow-up turn with `restore`, which continues through the subagent's own
	 * `restoreInterruptedTurn()`. A listed subagent whose reply was cut off while it streamed (omp's
	 * restore leaves it alone) goes on through omp's retry instead, as `retry {agentId}` resumes one.
	 * Then, with `turn`, the session's own `restoreInterruptedTurn()`. A listed subagent that neither
	 * revives is `skipped` with the reason; nothing unlisted is touched.
	 */
	const restoreChosen = async (ctx: ExtensionContext, p: Params): Promise<Json> => {
		const raw = p.subagentIds ?? [];
		if (!Array.isArray(raw) || raw.some(v => typeof v !== "string")) return fail("invalid_params", '"subagentIds" must be an array of strings');
		const turn = bool(p, "turn") === true;
		const { hasRestorableTurn, ensurePersistedRoster, interruptedTurnError } = await loadRestore();
		const main = mainRetry(ctx) ?? fail("unsupported", "this omp has no session to restore");
		const reg = internals.registry;
		const task = internals.resume?.task;
		const jobs = main.asyncJobManager;
		if (!hasRestorableTurn || !ensurePersistedRoster || !reg || !task || !jobs || typeof main.restoreInterruptedTurn !== "function") {
			return fail("unsupported", "this omp cannot restore parts of a session (omp's restore, task internals or background jobs are missing)");
		}
		if (turn && main.isStreaming) return fail("busy", "the agent is working");
		const sessionFile = main.sessionManager?.getSessionFile?.();
		if (raw.length > 0) await loadPersistedRoster(ctx);
		const running = new Set((jobs.getAllJobs?.() ?? []).flatMap(j => (j.status === "running" && j.agentId ? [j.agentId] : [])));
		/** Why omp's restore leaves subagent `id` alone; `undefined`: it goes on as a job of its parent. */
		const revive = async (id: string): Promise<string | undefined> => {
			const ref = reg.get(id);
			if (!ref) return "omp does not know this agent";
			if (ref.kind !== "sub") return "it is not a subagent";
			const file = ref.sessionFile;
			if (!file) return "it has no transcript";
			if (ref.status === "running" || running.has(id)) return "it is running";
			if (fs.existsSync(`${file}.tombstone`)) return "it was killed";
			const entries = transcriptEntries(file);
			if (!entries) return "its transcript cannot be read";
			const restorable = hasRestorableTurn(entries);
			const cutReply = !restorable && endsInCutOffReply(entries, interruptedTurnError);
			if (!restorable && !cutReply) return "its turn was not cut off";
			const init = task.sessionInit(entries);
			if (!init) return "its transcript has no session_init to revive it from";
			if (init.isolated) return "it ran isolated; its worktree is gone";
			// omp's retry goes on with a cut-off reply: a job of its parent under its id, as `retry {agentId}` runs one.
			if (cutReply) return (await retrySubagent(ctx, id)) ? undefined : "its turn was not cut off";
			jobs.register("task", id, async ({ signal }) => restoreJobResult(task, await restoreRun(task, id, ref.displayName ?? id, init, file, signal, main)), {
				id,
				agentId: id,
				ownerId: ref.parentId,
			});
			return undefined;
		};
		const subagents: string[] = [];
		const skipped: Array<{ agentId: string; reason: string }> = [];
		for (const id of parentsFirst(raw as string[])) {
			let reason: string | undefined = "the session has no file";
			if (sessionFile) {
				try {
					reason = await revive(id);
				} catch (err) {
					// e.g. omp's background job limit
					reason = err instanceof Error ? err.message : String(err);
				}
			}
			if (reason === undefined) subagents.push(id);
			else skipped.push({ agentId: id, reason });
		}
		return { turn: turn && (await main.restoreInterruptedTurn()) === true, subagents, skipped };
	};
	/** omp's follow-up turn of subagent `id` that goes on with its cut-off turn (`restore`), with the
	 *  options omp's `restoreSubagents` gives it (task/restore.ts). */
	const restoreRun = (
		task: NonNullable<ResumeInternals["task"]>,
		id: string,
		name: string,
		init: Json,
		file: string | undefined,
		signal: AbortSignal,
		main: RetrySession,
	): Promise<FollowUpResult> =>
		task.runFollowUp({
			id,
			agent: task.definition(name, init),
			message: typeof init.task === "string" ? init.task : name,
			restore: true,
			structured: Array.isArray(init.tools) && init.tools.includes("yield"),
			workPoolYieldItems: init.workPoolYieldItems,
			outputSchema: init.outputSchema,
			outputSchemaMode: init.outputSchemaMode,
			signal,
			eventBus: pi.events,
			artifactsDir: file ? path.dirname(file) : undefined,
			maxRuntimeMs: task.maxRuntimeMs(main.settings),
		});
	/** A follow-up run's result as omp's task job hands it to the parent (task/restore.ts): the summary,
	 *  with its structured output; a failed run throws omp's `AsyncJobError`. */
	const restoreJobResult = (task: NonNullable<ResumeInternals["task"]>, result: FollowUpResult): unknown => {
		const text = task.summary(result, { totalDurationMs: result.durationMs ?? 0 });
		if (result.aborted || result.exitCode !== 0 || result.error !== undefined) throw new task.jobError(text, result.structuredOutput);
		return result.structuredOutput ? { text, structured: result.structuredOutput } : text;
	};

	// ─── 2.1.0: resume (docs/bridge-protocol.md "Resume") ──────────────────────────────────────
	/** The main AgentSession, when it has omp's retry (`caps.retry`). */
	const mainRetry = (ctx: ExtensionContext): RetrySession | undefined => {
		const s = agentSession ?? findSession(ctx);
		return isRetrySession(s) ? s : undefined;
	};

	/** `hello.caps` of the resume features. */
	const resumeCaps = (ctx: ExtensionContext): { retry: boolean; resumeTree: boolean; turnError: boolean; limitGuard: boolean } => {
		const main = mainRetry(ctx);
		return {
			retry: main !== undefined,
			resumeTree: main?.asyncJobManager !== undefined && internals.resume?.task !== undefined && internals.lifecycle !== undefined,
			turnError: internals.registry !== undefined,
			limitGuard: true,
		};
	};

	/** `turn_error` data for the failed `tail` of agent `agentId` (also the entries of `failedTails`). */
	const turnInfo = (agentId: string, main: boolean, tail: Json, session: RetrySession | undefined, ref: AgentRefLike | undefined, sessionId?: string): Json => {
		const text = typeof tail.errorMessage === "string" ? tail.errorMessage : "";
		const provider = typeof tail.provider === "string" ? tail.provider : undefined;
		const verdict = tail.stopReason === "error" ? classifyTurnError(tail, internals.resume?.ai) : { class: "other" as const };
		const hint = tail.stopReason === "error" ? retryHintMs(provider, text, internals.resume?.hint) : undefined;
		const at = typeof tail.timestamp === "number" ? tail.timestamp : Date.now();
		return {
			agentId,
			parentId: main ? null : (ref?.parentId ?? null),
			main,
			sessionId: session?.sessionManager?.getSessionId?.() ?? sessionId ?? null,
			sessionFile: session?.sessionManager?.getSessionFile?.() ?? ref?.sessionFile ?? null,
			stopReason: tail.stopReason,
			kind: verdict.class,
			reason: ("reason" in verdict ? verdict.reason : undefined) ?? null,
			provider: provider ?? null,
			model: typeof tail.model === "string" ? tail.model : null,
			errorStatus: typeof tail.errorStatus === "number" && Number.isInteger(tail.errorStatus) && tail.errorStatus >= 0 && tail.errorStatus <= 65_535 ? tail.errorStatus : null,
			message: text.slice(0, 500),
			retryAt: hint === undefined ? null : at + hint,
			at,
		};
	};

	/** Failed messages already sent as `turn_error` (both bridge copies in a session report them). */
	const reportedTurns = new WeakSet<object>();
	/** Agents whose ended turn is watched until omp settled it (omp's own retries may still run). */
	const watchedTurns = new Set<string>();

	const sendTurnError = (turn: ReportedTurn): void => {
		if (reportedTurns.has(turn.message)) return;
		reportedTurns.add(turn.message);
		emit("turn_error", turn.data);
	};

	/** `me.report`: a copy in a subagent's session hands over that session's terminal failure. */
	const onReportedTurn = (turn: ReportedTurn): void => {
		try {
			if (ownsSlot() && isObj(turn) && isObj(turn.data) && isObj(turn.message)) sendTurnError(turn);
		} catch (err) {
			bridgeLog(`turn report: ${String(err)}`);
		}
	};

	/**
	 * A turn of `agentId` ended (`agent_end`) on an error: once omp settled it (`waitForIdle` also
	 * waits out omp's auto-retry saga), a failed tail no retry is pending for is terminal and goes to
	 * hostd as `turn_error`: the main session's directly, a subagent's through the owner copy.
	 */
	const watchTurn = (agentId: string, main: boolean): void => {
		if (watchedTurns.has(agentId)) return;
		const session = main ? (agentSession ?? (ctxRef ? findSession(ctxRef) : undefined)) : internals.registry?.get(agentId)?.session;
		if (!isRetrySession(session) || failedTail(session.agent?.state?.messages ?? [])?.stopReason !== "error") return;
		watchedTurns.add(agentId);
		void (async () => {
			try {
				await session.waitForIdle?.();
				// A retry (omp's own, or a new turn) runs: its own end decides.
				if (session.isStreaming || session.isRetrying) return;
				const tail = failedTail(session.agent?.state?.messages ?? []);
				if (tail?.stopReason !== "error") return;
				const turn: ReportedTurn = { data: turnInfo(agentId, main, tail, session, internals.registry?.get(agentId)), message: tail };
				if (main) sendTurnError(turn);
				else bridgeSlot().owners[endpoint]?.report?.(turn);
			} catch (err) {
				bridgeLog(`turn watch ${agentId}: ${String(err)}`);
			} finally {
				watchedTurns.delete(agentId);
			}
		})();
	};

	/**
	 * One follow-up turn of subagent `id` that resumes its failed turn through omp's `retry()`
	 * ({@link armRetry}). When omp parked and revived the session in between, the run never reached
	 * the retry (it found the terminal failure and stopped): it runs once more on the live session.
	 */
	const driveRetry = async (id: string, name: string, init: Json, file: string | undefined, signal: AbortSignal, main: RetrySession): Promise<FollowUpResult> => {
		const task = internals.resume?.task;
		const lifecycle = internals.lifecycle;
		if (!task || !lifecycle) throw new Error("omp's task internals are gone");
		for (let attempt = 0; ; attempt++) {
			const live = await lifecycle.global().ensureLive(id);
			if (!isRetrySession(live)) throw new Error(`agent ${id} cannot be retried`);
			const armed = armRetry(live);
			try {
				const result = await restoreRun(task, id, name, init, file, signal, main);
				if (armed.used() || attempt > 0 || signal.aborted) return result;
			} finally {
				armed.disarm();
			}
		}
	};

	/**
	 * Resumes subagent `id` from its failed or stopped last turn the way `omp --restore` resumes one
	 * (task/restore.ts): a background job of its parent runs omp's follow-up turn ({@link driveRetry})
	 * and hands the result to the parent as the `async-result` of a job with the subagent's id, unless
	 * omp's own wake monitor already did ({@link quietIfDelivered}).
	 * False: it runs, or its last turn neither failed nor was stopped.
	 */
	const retrySubagent = async (ctx: ExtensionContext, id: string): Promise<boolean> => {
		const reg = internals.registry;
		const lifecycle = internals.lifecycle;
		const task = internals.resume?.task;
		const main = mainRetry(ctx);
		const jobs = main?.asyncJobManager;
		if (!reg || !lifecycle || !task || !main || !jobs) {
			return fail("unsupported", "this omp cannot resume subagents from TeleFlock (omp's task internals or background jobs are missing)");
		}
		const ref = reg.get(id) ?? fail("not_found", `no agent ${id}`);
		if (ref.kind !== "sub") return fail("invalid_params", `agent ${id} is not a subagent`);
		if (ref.status === "running") return false;
		const live = await lifecycle.global().ensureLive(id);
		if (!isRetrySession(live)) return fail("unsupported", `agent ${id} cannot be retried`);
		if (live.isStreaming || !retryableTail(live)) return false;
		const init = task.sessionInit(live.sessionManager?.getEntries?.() ?? []) ?? fail("unsupported", `agent ${id} has no session contract to resume from`);
		if (init.isolated === true) return fail("unsupported", `agent ${id} ran isolated; its worktree is gone`);
		const file = ref.sessionFile ?? live.sessionManager?.getSessionFile?.() ?? undefined;
		const owner = ref.parentId ?? ctx.agent?.id;
		jobs.register(
			"task",
			id,
			async ({ jobId, signal }) => {
				const since = Date.now();
				const result = await driveRetry(id, ref.displayName ?? id, init, file, signal, main);
				if (jobId) quietIfDelivered(jobs, jobId, id, owner, since);
				return restoreJobResult(task, result);
			},
			{ id, agentId: id, ownerId: owner },
		);
		return true;
	};

	/** `retry`: omp's F5 for the main session (no `agentId`, or its own), else for that subagent (once
	 *  omp's registry has the session's persisted subagents: a freshly `--resume`d omp lacks them). */
	const retryOp = async (ctx: ExtensionContext, p: Params): Promise<{ started: boolean }> => {
		const agentId = str(p, "agentId");
		if (agentId && agentId !== ctx.agent?.id) {
			await loadPersistedRoster(ctx);
			return { started: await retrySubagent(ctx, agentId) };
		}
		const main = mainRetry(ctx) ?? fail("unsupported", "this omp has no retry for its session");
		return { started: await main.retry() };
	};

	/** `ids` without repeats, parents before their children (their depth in omp's registry). */
	const parentsFirst = (ids: readonly string[]): string[] => {
		const reg = internals.registry;
		const depth = (id: string): number => {
			let d = 0;
			for (let ref = reg?.get(id); ref?.parentId && d < 64; ref = reg?.get(ref.parentId)) d++;
			return d;
		};
		return [...new Set(ids)].sort((a, b) => depth(a) - depth(b));
	};

	/** `resumeTree`: the subagents first (once omp's registry has the session's persisted ones), parents
	 *  before their children (a child's result goes to its parent's session), then the main session
	 *  when its own last turn failed or was stopped. */
	const resumeTreeOp = async (ctx: ExtensionContext, p: Params): Promise<Json> => {
		const raw = p.subagentIds ?? [];
		if (!Array.isArray(raw) || raw.some(v => typeof v !== "string")) return fail("invalid_params", '"subagentIds" must be an array of strings');
		if (raw.length > 0) await loadPersistedRoster(ctx);
		const subagents: Json[] = [];
		for (const id of parentsFirst(raw as string[])) {
			try {
				subagents.push({ agentId: id, started: await retrySubagent(ctx, id) });
			} catch (err) {
				subagents.push({ agentId: id, started: false, error: err instanceof Error ? err.message : String(err) });
			}
		}
		const main = bool(p, "root") ? mainRetry(ctx) : undefined;
		const root = main !== undefined && !main.isStreaming && retryableTail(main) !== undefined && (await main.retry());
		return { root, subagents };
	};

	/** `failedTails`: the sessions of this process whose last turn failed or was stopped: the main one
	 *  and every subagent (its live session, else its transcript file). */
	const failedTailsOp = (ctx: ExtensionContext): Json => {
		const tails: Json[] = [];
		const main = mainRetry(ctx);
		const mainTail = main && !main.isStreaming ? retryableTail(main) : undefined;
		if (main && mainTail) tails.push({ ...turnInfo(ctx.agent?.id ?? "", true, mainTail, main, undefined), status: main.isRetrying ? "retrying" : "idle" });
		for (const ref of internals.registry?.list() ?? []) {
			if (ref.kind !== "sub") continue;
			const s = ref.session;
			if (isRetrySession(s)) {
				const tail = s.isStreaming ? undefined : retryableTail(s);
				if (tail) tails.push({ ...turnInfo(ref.id, false, tail, s, ref), status: ref.status ?? null });
			} else if (ref.sessionFile && ref.status !== "running") {
				const file = sessionFileTail(ref.sessionFile, 256 * 1024);
				const tail = failedTail(file.messages);
				if (tail) tails.push({ ...turnInfo(ref.id, false, tail, undefined, ref, file.sessionId), status: ref.status ?? null });
			}
		}
		return { mainId: ctx.agent?.id ?? null, tails };
	};

	/** omp's context modules (2.1.0 `context`), loaded on the first request. */
	let contextModules: Promise<ContextModules> | undefined;
	/** `context`: what fills the session's context window (docs/bridge-protocol.md "Context breakdown"). */
	const contextOp = async (ctx: ExtensionContext): Promise<Json> => {
		const session = findSession(ctx) as unknown as ContextSessionLike | undefined;
		const usage = ctx.getContextUsage();
		const images = countContextImages(session?.agent?.state?.messages ?? session?.messages);
		const dropImages = typeof session?.dropImages === "function";
		if (session) {
			const modules = await (contextModules ??= probeContextModules(pi.pi ?? {}));
			if (modules.buildView) {
				try {
					return summarizeContextView(modules.buildView(session), { source: "omp", images, dropImages, modules });
				} catch (err) {
					bridgeLog(`context view: ${String(err)}`);
				}
			}
			return summarizeContextView(estimateContextView(session, usage), { source: "estimate", images, dropImages });
		}
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const used = typeof usage?.tokens === "number" ? usage.tokens : 0;
		return { source: "usage", model: ctx.model?.name || ctx.model?.id, window, used, buffer: 0, free: Math.max(0, window - used), categories: [], images, dropImages, at: Date.now() };
	};

	/** `provider/id` of the session's model now. */
	const activeModel = (ctx: ExtensionContext): string | undefined => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

	/** `setRoleModels`: the session follows a changed `default` role (session only, like `setModel`). */
	const followDefault = async (ctx: ExtensionContext, selector: string): Promise<string | undefined> => {
		const label = selector.split(",")[0]?.trim() || selector;
		const stays = `the session stays on ${activeModel(ctx) ?? "its model"}`;
		const model = ctx.models.resolve("@default");
		if (!model) return `the default role's model ${label} is not available; ${stays}`;
		if (!(await pi.setModel(model))) return `no credentials for ${model.provider}/${model.id}; ${stays}`;
		const level = selectorLevel(selector);
		if (level) pi.setThinkingLevel(level as ThinkingLevel);
		return undefined;
	};

	async function handle(op: string, p: Params): Promise<unknown> {
		const ctx = ctxRef ?? fail("not_ready", "session not initialised yet");
		switch (op) {
			case "ping":
				return { pong: Date.now() };
			case "getState":
				return readState(ctx);
			case "context":
				return contextOp(ctx);
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
			case "getRoleModels": {
				const rs = internals.roles ?? fail("unsupported", "this omp lacks the settings internals that model roles need");
				return readRoleModels(rs, activeModel(ctx));
			}
			case "setRoleModels": {
				const rs = internals.roles ?? fail("unsupported", "this omp lacks the settings internals that model roles need");
				const warning = await applyRoleModels(rs, roleModelsRequest(p), selector => followDefault(ctx, selector));
				return { ...readRoleModels(rs, activeModel(ctx)), warning };
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
				const question = str(p, "question", true).trim();
				const btwId = str(p, "btwId");
				if ((btwId && sideThreads.has(btwId)) || ctx.mode !== "tui" || !btwDir(ctx)) return sideBtw(ctx, question, btwId);
				return btwId ? followUpBtw(ctx, btwId, question) : askBtw(ctx, question);
			}
			case "btwCancel":
				return cancelBtw(ctx, str(p, "btwId", true));
			case "getBtwHistory":
				return btwHistory(ctx);
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
			case "jobs": {
				// 2.1.0 `caps.jobs`: the session's background jobs; `inspect` ids (or `inspectAll`) with output.
				const ids = Array.isArray(p.inspect) ? p.inspect.filter((v): v is string => typeof v === "string").slice(0, 64) : [];
				return jobsView(bool(p, "inspectAll") === true ? "all" : new Set(ids));
			}
			case "jobCancel":
				return jobCancel(str(p, "id", true));
			case "getQueue":
				return readQueue();
			case "getCommands":
				// Extension, prompt-template and skill commands (builtins are excluded by omp).
				return {
					commands: pi
						.getCommands()
						.filter(c => c.name !== ATTACH_COMMAND && c.name !== LEGACY_ATTACH_COMMAND)
						.map(c => ({ name: c.name, description: c.description, source: c.source })),
				};
			case "dequeue":
				return dequeueLast(ctx);
			case "liveSubscribe": {
				const w = writer ?? fail("not_ready", "not connected");
				attachSession(ctx);
				attachRegistry();
				ensureDialogs(ctx);
				throttle.clear();
				w.start(); // its resync goes out before this request's `res`
				return {};
			}
			case "liveUnsubscribe":
				stopFeed();
				return {};
			case "prompt":
				return promptOp(p);
			case "uiResponse": {
				const reqId = num(p, "reqId") ?? fail("invalid_params", 'missing "reqId"');
				const value = p.value;
				if (value !== undefined && value !== null && typeof value !== "string") fail("invalid_params", '"value" must be a string or null');
				// An answer to a settled (or unknown) dialog: say it is over, as omp's collab host does.
				if (!hub.answer(reqId, typeof value === "string" ? value : undefined)) feedLive({ t: "ui-request-end", reqId });
				return {};
			}
			case "agentCmd":
				return agentCmd(p);
			case "retry":
				return retryOp(ctx, p);
			case "resumeTree":
				return resumeTreeOp(ctx, p);
			case "failedTails":
				return failedTailsOp(ctx);
			case "restorable":
				return restorableOp(ctx);
			case "restore":
				return restoreOp(ctx, p);
			case "setAutoResume": {
				// Process-wide: the context guard of every copy and session reads it.
				const on = bool(p, "on") ?? fail("invalid_params", 'missing "on"');
				const slot = bridgeSlot();
				slot.autoResume = on;
				if (on) for (const arm of [...(slot.armGuards ?? [])]) arm();
				return {};
			}
			default:
				return fail("unknown_op", `unknown op ${op}`);
		}
	}

	// ─── omp wiring ───────────────────────────────────────────────────────────────────────────
	pi.registerCommand(ATTACH_COMMAND, {
		description: "TeleFlock: enable remote session control (run automatically by the bridge)",
		handler: async (_args, ctx) => {
			try {
				// Whichever copy omp runs this in, the context is the process's (see ensureCmdCtx).
				const slot = bridgeSlot();
				slot.cmdCtx = ctx;
				for (const w of slot.attachWaiters.splice(0)) w();
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
			if (ctx.agent?.kind === "sub") {
				// A subagent's binding only relays its task bus to the owner copy (see below).
				bindingKind = "sub";
				bindingAgentId = ctx.agent.id;
				return;
			}
			if (!adopt(ctx)) return;
			bindingKind = "main";
			bindingAgentId = ctx.agent?.id;
			startedAt = Date.now();
			active = true;
			goalFromEvent = undefined;
			try {
				const pending = ctx.getPendingPlanReview();
				pendingReview = pending ? reviewInfo(pending) : undefined;
			} catch {
				pendingReview = undefined;
			}
			bridgeSession(ctx);
		} catch (err) {
			bridgeLog(`session_start: ${String(err)}`);
		}
	});

	const onSessionChange = (ctx: ExtensionContext) => {
		try {
			if (!adopt(ctx)) return;
			active = true;
			goalFromEvent = undefined;
			bridgeSession(ctx);
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

	// Live events come from omp's AgentSession stream (attachSession); these extension events stand
	// in while it cannot be reached. With omp's agent registry present the per-delta ones stay
	// unsubscribed: any handler for them makes omp build an extension context per streamed token.
	const omp: Record<string, unknown> = pi.pi ?? {};
	const standIns = [
		"agent_start",
		"agent_end",
		"turn_start",
		"turn_end",
		"message_start",
		"message_end",
		"tool_execution_start",
		"tool_execution_end",
		"auto_compaction_start",
		"auto_compaction_end",
		"auto_retry_start",
		"auto_retry_end",
		"retry_fallback_applied",
		"retry_fallback_succeeded",
	];
	if (!hasGlobal(omp.AgentRegistry)) standIns.push("message_update", "tool_execution_update");
	for (const name of standIns) {
		pi.on(name as "agent_start", (event, ctx) => {
			try {
				if (ctx.agent?.kind !== "sub") onAgentEvent(event as unknown as Json, false);
			} catch (err) {
				bridgeLog(`${name}: ${String(err)}`);
			}
		});
	}

	// Task bus: the main binding mirrors its session's bus (direct subagents); a subagent's binding
	// hands its own bus (that subagent's children, which no other bus carries) to the owner copy.
	for (const channel of [TASK_PROGRESS, TASK_LIFECYCLE]) {
		try {
			pi.events.on(channel, (data: unknown) => {
				try {
					if (bindingKind === "sub") bridgeSlot().owners[endpoint]?.relay?.({ channel, data, from: bindingAgentId });
					else if (bindingKind === "main" && ownsSlot()) onBusFrame(channel, data, undefined);
				} catch (err) {
					bridgeLog(`task bus: ${String(err)}`);
				}
			});
		} catch (err) {
			bridgeLog(`task bus: ${String(err)}`);
		}
	}

	// 2.1.0 `turnError`: every binding watches its own session's turns; a subagent's copies report a
	// terminal failure to the owner copy, which sends it with the main session's ones.
	pi.on("agent_end", (_event, ctx) => {
		try {
			if (ctx.agent?.kind === "sub") watchTurn(ctx.agent.id, false);
			else if (adopt(ctx) && ownsSlot() && ctx.agent?.id) watchTurn(ctx.agent.id, true);
		} catch (err) {
			bridgeLog(`turn watch: ${String(err)}`);
		}
	});

	// 2.1.0 `limitGuard`: while hostd's auto-resume is on, provider limits leave what the model sees
	// (guardContext), in every session the bridge is loaded in (main and subagents, every copy).
	// It changes the request's copy only, and does nothing once it already changed (idempotent).
	// omp structuredClones every session's messages on each model call as soon as any `context`
	// handler exists, so the handler is registered only once hostd turned auto-resume on (omp reads
	// an extension's handler list on every emit, so a late `pi.on` takes effect at once). It stays
	// registered afterwards and returns early while the flag is off.
	let guardArmed = false;
	const armGuard = (): void => {
		if (guardArmed) return;
		guardArmed = true;
		pi.on("context", event => {
			try {
				if (bridgeSlot().autoResume !== true) return undefined;
				const ai = internals.resume?.ai;
				const next = guardContext(
					event.messages,
					m => classifyTurnError(m, ai).class !== "other",
					text => classifyTurnError({ errorMessage: text }, ai).class !== "other",
				);
				return next ? { messages: next as typeof event.messages } : undefined;
			} catch (err) {
				bridgeLog(`context guard: ${String(err)}`);
				return undefined;
			}
		});
	};
	{
		const slot = bridgeSlot();
		(slot.armGuards ??= []).push(armGuard);
		if (slot.autoResume === true) armGuard(); // loaded (a subagent session) while hostd's auto-resume is on
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
			const arms = bridgeSlot().armGuards;
			const at = arms?.indexOf(armGuard) ?? -1;
			if (arms && at >= 0) arms.splice(at, 1);
			if (ctx.agent && ctx.agent.kind !== "main") return;
			active = false;
			stopTicking(ctx);
			detachLive();
			// The command context dies with the session; a later main session claims the slot anew.
			const slot = bridgeSlot();
			slot.cmdCtx = undefined;
			if (slot.owners[endpoint] === me) delete slot.owners[endpoint];
			writer?.stop();
			send({ t: "bye", sessionId: helloSessionId ?? sessionId() ?? null });
			writer?.flush(true);
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
