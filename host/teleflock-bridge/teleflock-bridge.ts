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
 *         while omp compacts. */
const BRIDGE_VERSION = "1.4.0";
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

interface BridgeSlot {
	/** The active copy per hostd endpoint (socket path or pipe name): the highest `version` wins, on
	 *  equal versions the first claimant stays. A copy that takes over calls the previous owner's
	 *  `stop()` (close the socket, stop the timers, clear the status line). */
	owners: Record<string, { version: string; stop(): void }>;
	/** The session command context, stored by whichever copy's /teleflock-control handler omp ran. */
	cmdCtx?: ExtensionCommandContext;
	/** Called (and removed) by that handler right after it stored `cmdCtx`. */
	attachWaiters: Array<() => void>;
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
	const me: BridgeSlot["owners"][string] = { version: BRIDGE_VERSION, stop: () => standDown() };
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
						showStatus(true);
						sendHello("connect");
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
		s.unref();
	};

	const onTick = (): void => {
		try {
			if (!active) return;
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
			sync();
			btwTick();
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
			dropSocket();
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
		if (connected) safeSync();
		else connect();
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
			if (!adopt(ctx)) return;
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
			stopTicking(ctx);
			// The command context dies with the session; a later main session claims the slot anew.
			const slot = bridgeSlot();
			slot.cmdCtx = undefined;
			if (slot.owners[endpoint] === me) delete slot.owners[endpoint];
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
