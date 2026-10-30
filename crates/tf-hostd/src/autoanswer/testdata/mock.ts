#!/usr/bin/env bun
/**
 * AutoAnswer lab mock model provider for omp 18.13.3 (OpenAI chat-completions, the API omp's
 * `openai-completions` client speaks: POST /v1/chat/completions with `stream: true`, SSE
 * `chat.completion.chunk`s, a finish chunk, a usage chunk, `data: [DONE]`). Never calls anything.
 *
 * Stateless: a conversation whose first user message holds `AUTOANSWER-LAB q=<question>` makes
 * the agent call omp's `ask` tool once with that question, two options and `recommended: 0`
 * ("Use SQLite"); once the tool result is in the history it answers `AUTOANSWER-LAB done: <result>`.
 * Every other request (titles, side calls) gets a short text.
 *
 * Port 127.0.0.1:18758 (`MOCK_PORT`; `models.yml` next to this file points there). Log: `MOCK_LOG`, else
 * `$HOME/autoanswer-mock.log` (inside `scripts/lab/run`, the lab's home).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18758;
const MODEL = "lab-1";
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "autoanswer-mock.log");
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

function log(line: string) {
	appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

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

function decide(body: Json): Decision {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	const tools: string[] = (Array.isArray(body.tools) ? body.tools : []).map((t: Json) => t?.function?.name).filter(Boolean);
	const firstUser = messages.find(m => m.role === "user");
	const prompt = textOf(firstUser?.content);
	const m = /AUTOANSWER-LAB q=([^\n]+)/.exec(prompt);
	if (!m || !tools.includes("ask")) return { kind: "side", text: "Lab task" };
	const question = m[1]!.trim();
	const askCall = messages.flatMap(msg => (msg.role === "assistant" && Array.isArray(msg.tool_calls) ? msg.tool_calls : [])).find((c: Json) => c?.function?.name === "ask");
	if (!askCall) {
		return {
			kind: "ask",
			call: {
				id: `call_ask_${Date.now().toString(36)}`,
				name: "ask",
				args: {
					questions: [
						{
							id: "db",
							question,
							options: [
								{ label: "Use SQLite", description: "One file, nothing to run" },
								{ label: "Use Postgres", description: "A server to run" },
							],
							recommended: 0,
						},
					],
				},
			},
		};
	}
	const result = messages.find(msg => msg.role === "tool" && msg.tool_call_id === askCall.id);
	return { kind: "done", text: `AUTOANSWER-LAB done: ${textOf(result?.content).replace(/\s+/g, " ").trim()}` };
}

function chunk(id: string, created: number, delta: Json | null, finish: string | null = null, usage?: Json): string {
	const body: Json = { id, object: "chat.completion.chunk", created, model: MODEL, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }] };
	if (usage) body.usage = usage;
	return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(d: Decision, n: number): Response {
	const id = `chatcmpl-aa-${n}`;
	const created = Math.floor(Date.now() / 1000);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (s: string) => controller.enqueue(encoder.encode(s));
			await Bun.sleep(150);
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
			log(`#${n} ${d.kind} msgs=${body.messages?.length ?? 0} stream=${body.stream === true}${d.call ? ` call=${d.call.name}` : ""}${d.text ? ` text=${JSON.stringify(d.text.slice(0, 120))}` : ""}`);
			if (body.stream === true) return stream(d, n);
			const message: Json = { role: "assistant", content: d.text ?? null };
			if (d.call) message.tool_calls = [{ id: d.call.id, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }];
			return Response.json({ id: `chatcmpl-aa-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: d.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "tf-lab-autoanswer" }] });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
console.log(`autoanswer mock on http://${HOST}:${server.port} (pid ${process.pid})`);
