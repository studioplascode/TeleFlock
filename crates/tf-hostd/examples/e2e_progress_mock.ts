#!/usr/bin/env bun
/**
 * Progress lab mock model provider (`e2e_progress.rs`) for omp ≥ 18.20: OpenAI chat-completions as
 * omp's `openai-completions` client speaks it (POST /v1/chat/completions, `stream: true`, SSE
 * `chat.completion.chunk`s, a finish chunk, a usage chunk, `data: [DONE]`). Never calls anything.
 *
 * Stateless, by the request's latest user message: a side turn (omp's `runEphemeralTurn`: the
 * session's history and tools, then a prompt of its own) whose prompt is TeleFlock's progress
 * question (`<progress-check>`) gets `{"pct":40,"stage":"checking the parser"}`. A conversation
 * whose latest user message holds `PROGRESS-LAB <run>:` gets a short text and one `bash` call
 * `sleep 20` (the run stays busy while the bridge asks); once that call's result is in the history
 * it answers `PROGRESS-LAB done`. Every other request (omp's title, forked like the progress
 * question or not; other side calls) gets a short text.
 *
 * Every request is one JSON line in `MOCK_LOG` (default `$HOME/progress-mock.jsonl`):
 * `{n, at, kind, run, previous}`: `at` epoch milliseconds, `kind` `progress` | `work` | `done` |
 * `side`, `run` the word after `PROGRESS-LAB` (a side turn carries the session's history, so it
 * names its run too), `previous` whether a progress question quoted an earlier estimate.
 *
 * Port 127.0.0.1:18771 (`MOCK_PORT`).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18771;
const MODEL = "lab-1";
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "progress-mock.jsonl");
/** The agent's answer to every progress question (`e2e_progress.rs` checks it on the agent). */
const ESTIMATE = '{"pct":40,"stage":"checking the parser"}';
/** How long the agent's one tool call keeps its run busy (`e2e_progress.rs`: `WORK_SECS`). */
const WORK = "sleep 20";
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(p => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
	return "";
}

interface Decision {
	kind: string;
	run: string | null;
	previous?: boolean;
	text?: string;
	call?: { id: string; name: string; args: Json };
}

function decide(body: Json): Decision {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	const tools: Json[] = Array.isArray(body.tools) ? body.tools : [];
	const users = messages.filter(m => m.role === "user").map(m => textOf(m.content));
	const run = users.map(t => /PROGRESS-LAB (\w+):/.exec(t)?.[1]).find(r => r !== undefined) ?? null;
	const latest = users.at(-1) ?? "";
	if (latest.includes("<progress-check>")) return { kind: "progress", run, previous: latest.includes("Your previous estimate"), text: ESTIMATE };
	const bash = tools.find(t => t?.function?.name === "bash");
	if (!latest.includes("PROGRESS-LAB") || !bash) return { kind: "side", run, text: "Lab task" };
	const called = messages.flatMap(m => (m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : [])).find((c: Json) => c?.function?.name === "bash");
	if (!called) {
		// omp's intent tracing adds a required `i` to every tool.
		const args: Json = bash.function.parameters?.properties?.i ? { command: WORK, i: "Checking the parser" } : { command: WORK };
		return { kind: "work", run, text: "Checking the parser.", call: { id: `call_bash_${Date.now().toString(36)}`, name: "bash", args } };
	}
	return { kind: "done", run, text: "PROGRESS-LAB done" };
}

function chunk(id: string, created: number, delta: Json | null, finish: string | null = null, usage?: Json): string {
	const body: Json = { id, object: "chat.completion.chunk", created, model: MODEL, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }] };
	if (usage) body.usage = usage;
	return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(d: Decision, n: number): Response {
	const id = `chatcmpl-pg-${n}`;
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
			appendFileSync(LOG, `${JSON.stringify({ n, at: Date.now(), kind: d.kind, run: d.run, ...(d.previous !== undefined ? { previous: d.previous } : {}) })}\n`);
			if (body.stream === true) return stream(d, n);
			const message: Json = { role: "assistant", content: d.text ?? null };
			if (d.call) message.tool_calls = [{ id: d.call.id, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }];
			return Response.json({ id: `chatcmpl-pg-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: d.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "tf-lab-progresslab" }] });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
console.log(`progress mock on http://${HOST}:${server.port} (pid ${process.pid}), log ${LOG}`);
