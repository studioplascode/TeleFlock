#!/usr/bin/env bun
/**
 * RenameCtx lab mock model provider for omp (OpenAI chat-completions, the API omp's `openai-completions`
 * client speaks: POST /v1/chat/completions with `stream: true`, SSE `chat.completion.chunk`s, a finish chunk,
 * a usage chunk, `data: [DONE]`). Never calls anything.
 *
 * It RECORDS every request body verbatim (system + messages + tool names) to `$MOCK_REC` (default
 * `$HOME/renamectx-requests.jsonl`, one JSON object per request: `{n, at, kind, model, stream, tools,
 * system, messages, body}`), and answers deterministically, keyed on the request:
 * - TeleFlock's "Name it again" call (`ai.complete` task `agentRename`; its system prompt says "You name
 *   long-running coding agents"): `Name: bloomworks-m0` / `Title: Bloomworks city-builder, milestone M0`.
 * - omp's own session-title call (a request without tools): a short title.
 * - the agent's turns (tools offered), by the newest user message (without omp's `<system-reminder>` blocks):
 *     `… Plan it in phases with todos` → a `todo` init call (three phases), then a short reply
 *     `Track decision …`  → a `todo` start call, then a short reply
 *     `… hud.rs …`        → a `write` call (src/hud.rs), then a short reply
 *     a goal continuation, a reminder, anything already answered, anything else → a short reply
 * Port 127.0.0.1:18741 (`MOCK_PORT`; `models.yml` next to this file points there). Log: `MOCK_LOG`, else
 * `$HOME/renamectx-mock.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18741;
const MODEL = "lab-1";
const HOME = process.env.HOME || "/tmp";
const LOG = process.env.MOCK_LOG || join(HOME, "renamectx-mock.log");
const REC = process.env.MOCK_REC || join(HOME, "renamectx-requests.jsonl");
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(p => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
	return "";
}

interface Decision {
	kind: string;
	text?: string;
	call?: { id: string; name: string; args: Json };
}

const PLAN = [
	{ phase: "Foundations", items: ["Render core on wgpu", "Asset pipeline importer", "Camera and input"] },
	{ phase: "Parallel tracks", items: ["Zoning and lot rules", "HUD and panels", "Windows build and CI"] },
	{ phase: "Ship M0", items: ["Playtest the first neighbourhood", "Tag the M0 release"] },
];

/** omp's own wrappers around a turn (`<system-reminder>` blocks: date, working directory, todo reminders). */
const bare = (m: Json): string => textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

function decide(body: Json): Decision {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	const tools: string[] = (Array.isArray(body.tools) ? body.tools : []).map((t: Json) => t?.function?.name).filter(Boolean);
	const system = messages.filter(m => m.role === "system" || m.role === "developer").map(m => textOf(m.content)).join("\n");
	// The newest user message with text of its own (omp also sends reminder-only ones).
	const lastIdx = messages.findLastIndex(m => m.role === "user" && bare(m).length > 0 && !/Hidden continuation steer|<goal_context>/.test(bare(m)));
	const last = lastIdx >= 0 ? bare(messages[lastIdx]!) : "";
	if (system.includes("You name long-running coding agents")) {
		return { kind: "agentRename", text: "Name: bloomworks-m0\nTitle: Bloomworks city-builder, milestone M0" };
	}
	if (!tools.length || last.includes("<title-request>")) return { kind: "title", text: "Bloomworks city-builder" };
	const id = `call_${seq}_${Date.now().toString(36)}`;
	if (messages.at(-1)?.role === "tool") return { kind: "done", text: "RENAMECTX done: noted, ready for the next step." };
	// Already answered (omp's goal continuation or a todo reminder asks again): a plain acknowledgement.
	if (messages.slice(lastIdx + 1).some(m => m.role === "assistant")) {
		return { kind: "followup", text: "RENAMECTX ack: carrying on with the plan." };
	}
	if (/Plan it in phases with todos/.test(last) && tools.includes("todo")) {
		return { kind: "todo-init", call: { id, name: "todo", args: { op: "init", list: PLAN.map(p => ({ phase: p.phase, items: p.items })) } } };
	}
	if (/^Track decision/.test(last) && tools.includes("todo")) {
		return { kind: "todo-start", call: { id, name: "todo", args: { op: "start", task: "Asset pipeline importer" } } };
	}
	if (/hud\.rs/.test(last) && tools.includes("write")) {
		return {
			kind: "write",
			call: { id, name: "write", args: { path: "src/hud.rs", content: "// Bloomworks HUD\npub fn draw_population(count: u32) -> String {\n    format!(\"Population: {count}\")\n}\n" } },
		};
	}
	return { kind: "answer", text: `RENAMECTX ack: ${last.replace(/\s+/g, " ").slice(0, 100)}` };
}

function chunk(id: string, created: number, delta: Json | null, finish: string | null = null, usage?: Json): string {
	const body: Json = { id, object: "chat.completion.chunk", created, model: MODEL, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }] };
	if (usage) body.usage = usage;
	return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(d: Decision, n: number): Response {
	const id = `chatcmpl-rc-${n}`;
	const created = Math.floor(Date.now() / 1000);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (s: string) => controller.enqueue(encoder.encode(s));
			await Bun.sleep(100);
			send(chunk(id, created, { role: "assistant", content: "" }));
			if (d.text) send(chunk(id, created, { content: d.text }));
			if (d.call) {
				send(chunk(id, created, { tool_calls: [{ index: 0, id: d.call.id, type: "function", function: { name: d.call.name, arguments: "" } }] }));
				send(chunk(id, created, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(d.call.args) } }] }));
			}
			send(chunk(id, created, {}, d.call ? "tool_calls" : "stop"));
			send(chunk(id, created, null, null, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }));
			send("data: [DONE]\n\n");
			controller.close();
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
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			const n = ++seq;
			const body = (await req.json()) as Json;
			const d = decide(body);
			const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
			appendFileSync(
				REC,
				`${JSON.stringify({
					n,
					at: new Date().toISOString(),
					kind: d.kind,
					model: body.model,
					stream: body.stream === true,
					tools: (Array.isArray(body.tools) ? body.tools : []).map((t: Json) => t?.function?.name),
					system: messages.filter(m => m.role === "system" || m.role === "developer").map(m => textOf(m.content)).join("\n"),
					messages: messages.map(m => ({ role: m.role, text: textOf(m.content), ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) })),
					body,
				})}\n`,
			);
			log(`#${n} ${d.kind} msgs=${messages.length} tools=${body.tools?.length ?? 0} stream=${body.stream === true}${d.call ? ` call=${d.call.name}` : ""}${d.text ? ` text=${JSON.stringify(d.text.slice(0, 100))}` : ""}`);
			if (body.stream === true) return stream(d, n);
			const message: Json = { role: "assistant", content: d.text ?? null };
			if (d.call) message.tool_calls = [{ id: d.call.id, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }];
			return Response.json({ id: `chatcmpl-rc-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: d.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "tf-lab-renamectx" }] });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
console.log(`renamectx mock on http://${HOST}:${server.port} (pid ${process.pid}), recording to ${REC}`);
