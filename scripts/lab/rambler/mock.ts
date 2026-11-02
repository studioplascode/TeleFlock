#!/usr/bin/env bun
/**
 * Rambler lab mock model provider for omp (OpenAI chat-completions, the API omp's `openai-completions`
 * client speaks: POST /v1/chat/completions with `stream: true`, SSE `chat.completion.chunk`s, a finish
 * chunk, a usage chunk, `data: [DONE]`). Never calls anything.
 *
 * Answers like a (very simple) Rambler model: the text between <transcript> and </transcript> of the
 * newest user message with fillers dropped and sentences capitalised, prefixed with `[<model>]` so the
 * lab sees which role answered. Each model sleeps `MOCK_DELAY_<MODEL>` ms first (defaults: lab-tiny
 * 150, lab-smol 400, lab-big 900), standing in for model time. Every request is logged with its
 * system-prompt length and the model's own processing time.
 *
 * Port 127.0.0.1:18781 (`MOCK_PORT`; `models.yml` next to this file points there). Log: `MOCK_LOG`, else
 * `$HOME/rambler-mock.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MOCK_PORT) || 18781;
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "rambler-mock.log");
const DELAY: Record<string, number> = {
	"lab-tiny": Number(process.env.MOCK_DELAY_TINY) || 150,
	"lab-smol": Number(process.env.MOCK_DELAY_SMOL) || 400,
	"lab-big": Number(process.env.MOCK_DELAY_BIG) || 900,
};
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(p => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
	return "";
}

function ramble(prompt: string): string {
	const said = /<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(prompt)?.[1];
	if (said === undefined) return "Lab task";
	return said
		.replace(/\b(?:u+m+|u+h+|you know|basically|like)\b,?\s*/gi, "")
		.replace(/\s+/g, " ")
		.trim()
		.split(/(?<=[.!?])\s+/)
		.map(s => s.charAt(0).toUpperCase() + s.slice(1))
		.join(" ");
}

function stream(text: string, model: string, n: number): Response {
	const id = `chatcmpl-rl-${n}`;
	const created = Math.floor(Date.now() / 1000);
	const chunk = (delta: object | null, finish: string | null = null, usage?: object) =>
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (s: string) => controller.enqueue(encoder.encode(s));
			send(chunk({ role: "assistant", content: "" }));
			send(chunk({ content: text }));
			send(chunk({}, "stop"));
			send(chunk(null, null, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
			send("data: [DONE]\n\n");
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 255,
	async fetch(req) {
		const path = new URL(req.url).pathname.replace(/\/+$/, "");
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			const started = performance.now();
			const n = ++seq;
			const body = (await req.json()) as Json;
			const model: string = body.model ?? "lab-tiny";
			const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
			const user = [...messages].reverse().find(m => m.role === "user");
			const system = messages.filter(m => m.role === "system" || m.role === "developer").map(m => textOf(m.content)).join("\n");
			await Bun.sleep(DELAY[model] ?? 150);
			const text = `[${model}] ${ramble(textOf(user?.content))}`;
			log(`#${n} model=${model} tools=${Array.isArray(body.tools) ? body.tools.length : 0} system=${system.length}ch ramble-prompt=${system.includes("spoken ramble")} took=${Math.round(performance.now() - started)}ms`);
			if (body.stream === true) return stream(text, model, n);
			return Response.json({ id: `chatcmpl-rl-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: Object.keys(DELAY).map(id => ({ id, object: "model", created: 0, owned_by: "tf-lab-rambler" })) });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${path}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
console.log(`rambler mock on http://127.0.0.1:${server.port} (pid ${process.pid})`);
