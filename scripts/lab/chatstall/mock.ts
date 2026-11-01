#!/usr/bin/env bun
/**
 * ChatStall lab mock model provider: the Anthropic Messages API (`api: anthropic-messages` in the
 * lab's models.yml; POST /v1/messages with `stream: true`, SSE `message_start` …
 * `content_block_*` … `message_delta` / `message_stop`). Keyless, never calls anything.
 *
 * Stateless: a request whose user messages hold `CHATSTALL-LAB` and that offers omp's `grep` and
 * `read` tools plays the scripted turn of turn.ts, step by step from the history it carries:
 *   1. a `redacted_thinking` block and an omitted thought (a `thinking` block without text that a
 *      `signature_delta` closes after a pause; omp 18.14.2 keeps only this one, see turn.ts), then
 *      TWO `grep` tool_use blocks whose `input_json_delta` chunks stream slowly (25 × 120 ms each);
 *   2. after both grep results: one `read` tool_use;
 *   3. after the read result: the long German Markdown answer with a table, streamed in small
 *      text deltas over ~10 s, the 🚀 split across two deltas as `\ud83d` / `\ude80` escapes.
 * Every other request (session title, side calls) gets a short text.
 *
 * 127.0.0.1:18761 (`MOCK_PORT`). Log: `MOCK_LOG`, else `$HOME/chatstall-mock.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { FINAL_MS, GREPS, MARKER, READ, REDACTED_DATA, THINK_MS, THINK_SIGNATURE, type ToolScript, finalDeltas, inputChunks } from "./turn.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18761;
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "chatstall-mock.log");
const encoder = new TextEncoder();
let seq = 0;
let toolsLogged = false;

type Json = Record<string, any>;

function log(line: string) {
	const out = `${new Date().toISOString()} ${line}\n`;
	try {
		appendFileSync(LOG, out);
	} catch {}
	process.stdout.write(out);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(p => (p?.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

interface Step {
	kind: "greps" | "read" | "final" | "side";
	note?: string;
}

interface Tools {
	grep?: string;
	read?: string;
	intent: Record<string, boolean>;
}

function toolsOf(body: Json): Tools {
	const out: Tools = { intent: {} };
	for (const t of Array.isArray(body.tools) ? body.tools : []) {
		const name: string = typeof t?.name === "string" ? t.name : "";
		const lower = name.toLowerCase();
		if (lower === "grep") out.grep = name;
		if (lower === "read") out.read = name;
		out.intent[name] = !!t?.input_schema?.properties?.i;
	}
	return out;
}

function decide(body: Json, tools: Tools): Step {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	const prompt = messages.filter(m => m.role === "user").map(m => textOf(m.content)).join("\n");
	if (!prompt.includes(MARKER)) return { kind: "side", note: "no marker" };
	if (!tools.grep || !tools.read) return { kind: "side", note: "no grep/read tools offered (a side call)" };
	const content = (role: string, type: string): Json[] =>
		messages.flatMap(m => (m.role === role && Array.isArray(m.content) ? m.content.filter((b: Json) => b?.type === type) : []));
	const uses = content("assistant", "tool_use");
	const results = new Set(content("user", "tool_result").map(b => b.tool_use_id));
	const greps = uses.filter(u => u.name === tools.grep);
	const reads = uses.filter(u => u.name === tools.read);
	if (greps.length === 0) return { kind: "greps" };
	if (reads.length === 0) return { kind: "read", note: `grep results ${greps.filter(g => results.has(g.id)).length}/${greps.length}` };
	const answered = messages.some((m, i) => i > 0 && m.role === "assistant" && textOf(m.content).length > 200);
	if (results.has(reads[reads.length - 1]!.id) && !answered) return { kind: "final" };
	return { kind: "side", note: "turn already answered" };
}

function stream(n: number, step: Step, tools: Tools, inputTokens: number): Response {
	const nonce = `${Date.now().toString(36)}${n}`;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let open = true;
			const send = (type: string, data: Json) => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
				} catch {
					open = false;
				}
			};
			const t0 = Date.now();
			let index = 0;
			let outTokens = 0;
			const toolUse = async (t: ToolScript) => {
				const name = (t.tool === "grep" ? tools.grep : tools.read)!;
				const i = index++;
				send("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${t.key}_${nonce}`, name, input: {} } });
				for (const part of inputChunks(t, tools.intent[name] === true)) {
					await Bun.sleep(t.chunkMs);
					send("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: part } });
					outTokens += 4;
				}
				send("content_block_stop", { index: i });
			};
			await Bun.sleep(150);
			send("message_start", {
				message: {
					id: `msg_chatstall_${nonce}`,
					type: "message",
					role: "assistant",
					model: "lab-1",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				},
			});
			send("ping", {});
			let stop = "end_turn";
			if (step.kind === "greps") {
				const r = index++;
				send("content_block_start", { index: r, content_block: { type: "redacted_thinking", data: REDACTED_DATA } });
				send("content_block_stop", { index: r });
				const t = index++;
				send("content_block_start", { index: t, content_block: { type: "thinking", thinking: "", signature: "" } });
				await Bun.sleep(THINK_MS);
				send("content_block_delta", { index: t, delta: { type: "signature_delta", signature: THINK_SIGNATURE } });
				send("content_block_stop", { index: t });
				for (const g of GREPS) await toolUse(g);
				stop = "tool_use";
			} else if (step.kind === "read") {
				await toolUse(READ);
				stop = "tool_use";
			} else {
				const i = index++;
				send("content_block_start", { index: i, content_block: { type: "text", text: "" } });
				const deltas = step.kind === "final" ? finalDeltas() : ["ChatStall-Labor"];
				const pause = step.kind === "final" ? FINAL_MS / deltas.length : 0;
				for (const d of deltas) {
					if (pause) await Bun.sleep(pause);
					send("content_block_delta", { index: i, delta: { type: "text_delta", text: d } });
					outTokens += 3;
				}
				send("content_block_stop", { index: i });
			}
			send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: Math.max(1, outTokens) } });
			send("message_stop", {});
			log(`#${n} ${step.kind} streamed in ${Date.now() - t0} ms${open ? "" : " (client went away)"}`);
			if (open) {
				try {
					controller.close();
				} catch {}
			}
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

const server = Bun.serve({
	hostname: HOST,
	port: PORT,
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, "");
		if (req.method === "POST" && path.endsWith("/messages/count_tokens")) {
			const body = (await req.json().catch(() => ({}))) as Json;
			return Response.json({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
		}
		if (req.method === "POST" && path.endsWith("/messages")) {
			const n = ++seq;
			const raw = await req.text();
			let body: Json;
			try {
				body = JSON.parse(raw) as Json;
			} catch {
				log(`#${n} bad json (${raw.length} bytes)`);
				return Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad json" } }, { status: 400 });
			}
			const tools = toolsOf(body);
			if (!toolsLogged && Array.isArray(body.tools) && body.tools.length > 0) {
				toolsLogged = true;
				log(`tools offered: ${body.tools.map((t: Json) => `${t.name}${tools.intent[t.name] ? "(i)" : ""}`).join(", ")}`);
			}
			const step = decide(body, tools);
			log(`#${n} ${req.method} ${url.pathname}${url.search} → ${step.kind}${step.note ? ` (${step.note})` : ""} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} stream=${body.stream === true}`);
			const inputTokens = Math.ceil(raw.length / 4);
			if (body.stream === true) return stream(n, step, tools, inputTokens);
			return Response.json({
				id: `msg_chatstall_${n}`,
				type: "message",
				role: "assistant",
				model: "lab-1",
				content: [{ type: "text", text: "ChatStall-Labor" }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: inputTokens, output_tokens: 3 },
			});
		}
		if (req.method === "GET" && path.endsWith("/models")) return Response.json({ data: [{ type: "model", id: "lab-1", display_name: "ChatStall Lab Mock", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "lab-1", last_id: "lab-1" });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		log(`404 ${req.method} ${url.pathname}`);
		return Response.json({ type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
