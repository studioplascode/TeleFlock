#!/usr/bin/env bun
/**
 * ChatTasks lab mock model provider for omp (OpenAI chat-completions, the API omp's
 * `openai-completions` client speaks: POST /v1/chat/completions with `stream: true`, SSE
 * `chat.completion.chunk`s, a finish chunk, a usage chunk, `data: [DONE]`). Never calls anything.
 *
 * Stateless, keyed on the newest user message of a request that offers tools (the agent's turn),
 * read without the `<system-reminder>` blocks omp adds to it (date, working directory):
 * - `CHAT-LAB write …`: calls omp's `write` tool once (`notes.md` in the agent's folder); once its
 *   result is in the history, answers `CHAT-LAB wrote notes.md`.
 * - anything else: a short chat-style answer naming the question (`CHAT-LAB answer: …`).
 * Side requests (omp's session title, asked without tools or as a `<title-request>` message inside
 * the turn's context; TeleFlock's `ai.complete` naming) get a kebab-case slug of the task when the
 * system prompt asks for one, else a short title.
 * Port 127.0.0.1:18771 (`MOCK_PORT`; `models.yml` next to this file points there). Log: `MOCK_LOG`,
 * else `$HOME/chattasks-mock.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18771;
const MODEL = "lab-1";
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "chattasks-mock.log");
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
	const system = messages.filter(m => m.role === "system" || m.role === "developer").map(m => textOf(m.content)).join("\n");
	const users = messages.filter(m => m.role === "user");
	// The newest user message as its author wrote it: without the `<system-reminder>` blocks omp prepends.
	const last = textOf(users[users.length - 1]?.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
	if (!tools.length || last.includes("<title-request>")) {
		if (/kebab-case/i.test(system)) {
			// The task's first long words (TeleFlock's naming asks between <task> tags).
			const task = /<task>([\s\S]*?)<\/task>/.exec(last)?.[1] ?? last;
			const slug = task.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2).slice(0, 3).join("-");
			return { kind: "name", text: slug || "lab-chat" };
		}
		return { kind: "title", text: "Lab chat about the weekend" };
	}
	const tail = messages[messages.length - 1];
	if (tail?.role === "tool") {
		return { kind: "done", text: "CHAT-LAB wrote notes.md: it holds the list you asked for." };
	}
	if (/CHAT-LAB write/.test(last) && tools.includes("write")) {
		return {
			kind: "write",
			call: {
				id: `call_write_${Date.now().toString(36)}`,
				name: "write",
				args: { path: "notes.md", content: "# Notes\n\n- pack light\n- book the train\n" },
			},
		};
	}
	const question = last.replace(/\s+/g, " ").trim().slice(0, 120);
	return {
		kind: "answer",
		text: `CHAT-LAB answer: you asked "${question}".\n\nHere is a short answer, the way a chat would give it:\n\n- one point\n- another point\n\nAsk a follow-up any time.`,
	};
}

function chunk(id: string, created: number, delta: Json | null, finish: string | null = null, usage?: Json): string {
	const body: Json = { id, object: "chat.completion.chunk", created, model: MODEL, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }] };
	if (usage) body.usage = usage;
	return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(d: Decision, n: number): Response {
	const id = `chatcmpl-ct-${n}`;
	const created = Math.floor(Date.now() / 1000);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (s: string) => controller.enqueue(encoder.encode(s));
			await Bun.sleep(150);
			send(chunk(id, created, { role: "assistant", content: "" }));
			if (d.text) {
				// A few deltas, so the app sees the reply stream.
				for (const part of d.text.match(/[\s\S]{1,40}/g) ?? []) {
					send(chunk(id, created, { content: part }));
					await Bun.sleep(60);
				}
			}
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
			log(`#${n} ${d.kind} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} stream=${body.stream === true}${d.call ? ` call=${d.call.name}` : ""}${d.text ? ` text=${JSON.stringify(d.text.slice(0, 120))}` : ""}`);
			if (body.stream === true) return stream(d, n);
			const message: Json = { role: "assistant", content: d.text ?? null };
			if (d.call) message.tool_calls = [{ id: d.call.id, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }];
			return Response.json({ id: `chatcmpl-ct-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: d.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "tf-lab-chattasks" }] });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
console.log(`chattasks mock on http://${HOST}:${server.port} (pid ${process.pid})`);
