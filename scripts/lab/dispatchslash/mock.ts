#!/usr/bin/env bun
/**
 * DispatchSlash lab mock model provider: the Anthropic Messages API (`api: anthropic-messages` in
 * the lab's models.yml; POST /v1/messages, streamed). Keyless, calls nothing, answers every request
 * with a short text (no tools), so a turn ends right away.
 *
 * Every request is recorded as one JSON line in `MOCK_LOG`: `{n, at, system, texts}` — `system`
 * cut to 400 characters around its first mention of plan mode (whole when shorter), `texts` the
 * text blocks of the user messages after the last assistant message, each cut to 600 characters.
 * 127.0.0.1:18877 (`MOCK_PORT`).
 */
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT) || 18877;
const LOG = process.env.MOCK_LOG || "/tmp/dispatchslash-mock.jsonl";
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

const textsOf = (content: unknown): string[] =>
	typeof content === "string" ? [content] : Array.isArray(content) ? content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text as string) : [];

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** The system prompt around its first mention of plan mode (what tells the model it plans). */
function systemOf(system: unknown): string {
	const text = textsOf(system).join("\n");
	const at = text.search(/plan mode/i);
	return at < 0 ? cut(text, 200) : cut(text.slice(Math.max(0, at - 100)), 400);
}

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		if (req.method !== "POST") return new Response("ok");
		const body = (await req.json().catch(() => ({}))) as Json;
		const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
		const lastAssistant = messages.findLastIndex(m => m.role === "assistant");
		const texts = messages
			.slice(lastAssistant + 1)
			.filter(m => m.role === "user")
			.flatMap(m => textsOf(m.content))
			.map(t => cut(t, 600));
		const n = ++seq;
		appendFileSync(LOG, `${JSON.stringify({ n, at: Date.now(), system: systemOf(body.system), texts })}\n`);
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const send = (type: string, data: Json) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
				await Bun.sleep(50);
				send("message_start", {
					message: { id: `msg_slash_${n}`, type: "message", role: "assistant", model: "lab-1", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
				});
				send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				send("content_block_delta", { index: 0, delta: { type: "text_delta", text: `Mock answer ${n}.` } });
				send("content_block_stop", { index: 0 });
				send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
				send("message_stop", {});
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
	},
});
console.log(`dispatchslash mock on 127.0.0.1:${PORT}, log ${LOG}`);
