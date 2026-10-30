#!/usr/bin/env bun
/**
 * HostSync lab mock model provider (OpenAI chat-completions, omp's `openai-completions` client:
 * POST /v1/chat/completions with `stream: true`, SSE chunks, `data: [DONE]`). Never calls anything.
 *
 * Lab mock for `e2e_hostsync.rs` (run it with `scripts/lab/run`). Provider `labmock` in both labs'
 * models.yml points here. Each request is logged with WHICH of the lab's made-up API keys it
 * carried (`key=A`, `key=B`, `key=other`, `key=none`), never the key itself: after "make B like A"
 * copies A's sign-in, B's omp must answer with key A.
 *
 * Port 127.0.0.1:47646. Log: `$HOME/hostsync-mock.log` (inside a lab: the lab's HOME).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = 47646;
const LOG = join(process.env.HOME ?? "/tmp", "hostsync-mock.log");
const KEYS: Record<string, string> = { "LAB-MOCK-KEY-A": "A", "LAB-B-OWN-KEY": "B" };
const encoder = new TextEncoder();
let seq = 0;

function log(line: string) {
	appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

function whichKey(req: Request): string {
	const auth = req.headers.get("authorization") ?? "";
	const key = auth.replace(/^Bearer\s+/i, "");
	if (!key) return "none";
	return KEYS[key] ?? "other";
}

function stream(text: string, model: string, n: number): Response {
	const id = `chatcmpl-hs-${n}`;
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
	hostname: HOST,
	port: PORT,
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, "");
		const key = whichKey(req);
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			const n = ++seq;
			const body = (await req.json()) as { model?: string; stream?: boolean };
			const model = body.model ?? "lab-sync";
			log(`#${n} chat model=${model} key=${key}`);
			if (key !== "A" && key !== "B") return Response.json({ error: { message: "invalid api key (lab mock)" } }, { status: 401 });
			const text = `HOSTSYNC-LAB answered with key ${key}`;
			if (body.stream === true) return stream(text, model, n);
			return Response.json({ id: `chatcmpl-hs-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
			log(`models key=${key}`);
			return Response.json({ object: "list", data: [{ id: "lab-sync", object: "model", created: 0, owned_by: "tf-lab-hostsync" }] });
		}
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
console.log(`hostsync mock on http://${HOST}:${server.port} (pid ${process.pid})`);
