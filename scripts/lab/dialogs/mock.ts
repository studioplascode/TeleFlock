#!/usr/bin/env bun
/**
 * Dialogs lab mock model provider: the Anthropic Messages API (`api: anthropic-messages` in the
 * lab's models.yml; POST /v1/messages with `stream: true`, SSE `message_start` … `content_block_*`
 * … `message_delta` / `message_stop`). Keyless, never calls anything.
 *
 * Stateless, keyed on the newest user prompt that holds a `DLG-` marker and on what follows it in
 * the history the request carries:
 *   DLG-CFG <value>  one `write` of `cfg://task/perCallModel` with <value> (off | eval | on): omp asks
 *                    "⚙️ Your agent wants to change `task.perCallModel` for this session."
 *   DLG-QA           one `write` of `xd://report_issue`: omp's report_tool_issue consent (only while
 *                    `dev.autoqaConsent` is unset in the lab's config.yml)
 *   DLG-PTY          one `bash` call with `pty: true`: omp's interactive console, a wait for the user
 *                    that only the terminal can answer. After a second (omp sizes the PTY on its first
 *                    renders) it traps SIGWINCH, reads a word and echoes it: `RESIZED` in its output
 *                    means something resized the PTY while it waited (TeleFlock reading the console)
 * Once the call's result is in the history the turn ends with `DLG-LAB <kind> done: <result>`, the
 * result's first line quoted (for DLG-PTY its `got:` and `RESIZED` lines). Every other request
 * (session title, side calls) gets a short text.
 * Also answers POST /qa (the lab's `dev.autoqaPush.endpoint`), so a granted consent never reaches
 * omp's real collector; every report it gets is logged.
 *
 * 127.0.0.1:18796 (`MOCK_PORT`). Log: `MOCK_LOG`, else `$HOME/dialogs-mock.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18796;
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "dialogs-mock.log");
const MARKER = /\bDLG-(CFG|QA|PTY)\b(?:[ \t]+([a-z]+))?/;
const PTY_COMMAND = `sleep 1; trap 'echo RESIZED' WINCH; printf 'Dialogs lab console\\n'; read -r -p 'Type a word and press Enter: ' w; echo "got: $w"`;
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

interface Tools {
	/** lower-case name → the name omp offers. */
	names: Record<string, string>;
	/** Tools whose schema has omp's `i` (intent) field. */
	intent: Record<string, boolean>;
}

function toolsOf(body: Json): Tools {
	const out: Tools = { names: {}, intent: {} };
	for (const t of Array.isArray(body.tools) ? body.tools : []) {
		const name: string = typeof t?.name === "string" ? t.name : "";
		if (!name) continue;
		out.names[name.toLowerCase()] = name;
		out.intent[name] = !!t?.input_schema?.properties?.i;
	}
	return out;
}

interface Step {
	kind: string;
	call?: { tool: string; input: Json; intent: string };
	text?: string;
	note?: string;
}

function decide(body: Json, tools: Tools): Step {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	if (!Object.keys(tools.names).length) return { kind: "side", text: "Dialogs lab", note: "no tools (a side call)" };
	let at = -1;
	let m: RegExpExecArray | null = null;
	for (let i = messages.length - 1; i >= 0 && at < 0; i--) {
		if (messages[i]?.role !== "user") continue;
		const hit = MARKER.exec(textOf(messages[i]!.content));
		if (hit) {
			at = i;
			m = hit;
		}
	}
	if (at < 0 || !m) return { kind: "side", text: "DLG-LAB: no marker in the prompt.", note: "no marker" };
	const kind = m[1]!.toLowerCase();
	const after = messages.slice(at + 1);
	const results: Json[] = [];
	const uses: Json[] = [];
	for (const x of after) {
		for (const b of Array.isArray(x.content) ? x.content : []) {
			if (x.role === "user" && b?.type === "tool_result") results.push(b);
			if (x.role === "assistant" && b?.type === "tool_use") uses.push(b);
		}
	}
	if (after.some(x => x.role === "assistant" && textOf(x.content).includes("DLG-LAB "))) return { kind: "side", text: "DLG-LAB: already answered.", note: "turn already answered" };
	if (uses.length && results.length) {
		const r = results[results.length - 1]!;
		const lines = (typeof r.content === "string" ? r.content : textOf(r.content)).split("\n").map(l => l.trim()).filter(Boolean);
		const shown = kind === "pty" ? lines.filter(l => /got:|RESIZED/.test(l)).join(" | ") : lines[0];
		return { kind: `${kind}-done`, text: `DLG-LAB ${kind} done: ${JSON.stringify((shown || "(empty)").slice(0, 200))}${r.is_error ? " (error)" : ""}` };
	}
	if (uses.length) return { kind: "side", text: "DLG-LAB: waiting for the tool result.", note: "tool_use without result" };
	const write = tools.names.write;
	const bash = tools.names.bash;
	if (kind === "cfg") {
		if (!write) return { kind: "side", text: "DLG-LAB: no write tool offered.", note: "no write" };
		return { kind, call: { tool: write, input: { path: "cfg://task/perCallModel", content: m[2] ?? "on" }, intent: "Changing a lab setting" } };
	}
	if (kind === "qa") {
		if (!write) return { kind: "side", text: "DLG-LAB: no write tool offered.", note: "no write" };
		return { kind, call: { tool: write, input: { path: "xd://report_issue", content: "write: the dialogs lab saw a stale path echoed back" }, intent: "Reporting a tool issue" } };
	}
	if (!bash) return { kind: "side", text: "DLG-LAB: no bash tool offered.", note: "no bash" };
	return { kind, call: { tool: bash, input: { command: PTY_COMMAND, pty: true }, intent: "Opening a console" } };
}

function stream(n: number, step: Step, tools: Tools, inputTokens: number): Response {
	const nonce = `${Date.now().toString(36)}${n}`;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (type: string, data: Json) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
			await Bun.sleep(120);
			send("message_start", {
				message: {
					id: `msg_dialogs_${nonce}`,
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
			let index = 0;
			if (step.text) {
				const i = index++;
				send("content_block_start", { index: i, content_block: { type: "text", text: "" } });
				for (const part of step.text.match(/[\s\S]{1,40}/g) ?? []) {
					send("content_block_delta", { index: i, delta: { type: "text_delta", text: part } });
					await Bun.sleep(40);
				}
				send("content_block_stop", { index: i });
			}
			if (step.call) {
				const i = index++;
				const input = tools.intent[step.call.tool] ? { i: step.call.intent, ...step.call.input } : step.call.input;
				send("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${step.kind}_${nonce}`, name: step.call.tool, input: {} } });
				const json = JSON.stringify(input);
				for (const part of json.match(/[\s\S]{1,48}/g) ?? []) {
					send("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: part } });
					await Bun.sleep(30);
				}
				send("content_block_stop", { index: i });
			}
			send("message_delta", { delta: { stop_reason: step.call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			send("message_stop", {});
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

if (import.meta.main) {
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
				if (!toolsLogged && Object.keys(tools.names).length) {
					toolsLogged = true;
					log(`tools offered: ${Object.values(tools.names).join(", ")}`);
				}
				const step = decide(body, tools);
				const shape = (body.messages ?? []).map((m: Json) => `${m.role}(${Array.isArray(m.content) ? m.content.map((b: Json) => b?.type).join("+") : "text"})`).join(" ");
				log(`#${n} → ${step.kind}${step.note ? ` (${step.note})` : ""}${step.call ? ` call=${step.call.tool} ${JSON.stringify(step.call.input)}` : ""}${step.text ? ` text=${JSON.stringify(step.text.slice(0, 160))}` : ""} model=${body.model} msgs=${shape}`);
				const inputTokens = Math.ceil(raw.length / 4);
				if (body.stream === true) return stream(n, step, tools, inputTokens);
				return Response.json({
					id: `msg_dialogs_${n}`,
					type: "message",
					role: "assistant",
					model: "lab-1",
					content: [{ type: "text", text: step.text ?? "Dialogs lab" }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: inputTokens, output_tokens: 3 },
				});
			}
			if (req.method === "POST" && path === "/qa") {
				log(`qa report: ${(await req.text()).slice(0, 400)}`);
				return Response.json({ ok: true });
			}
			if (req.method === "GET" && path.endsWith("/models")) return Response.json({ data: [{ type: "model", id: "lab-1", display_name: "Dialogs Lab Mock", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "lab-1", last_id: "lab-1" });
			if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
			log(`404 ${req.method} ${url.pathname}`);
			return Response.json({ type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
		},
	});
	log(`start pid=${process.pid} port=${server.port}`);
}
