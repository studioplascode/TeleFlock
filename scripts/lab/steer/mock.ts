#!/usr/bin/env bun
/**
 * Steer lab mock model provider: the Anthropic Messages API (`api: anthropic-messages` in the lab's
 * models.yml; POST /v1/messages with `stream: true`). Keyless, never calls anything.
 *
 * A request whose user messages hold `STEER-LAB` and that offers omp's `bash` tool: with no bash
 * call in the history yet, one `bash` call (`sleep 12`, the slow tool steers arrive during); after
 * it, a short text answer naming the user texts it was sent after the last assistant message.
 * Every other request (session title, side calls) gets a short text.
 *
 * Every request is recorded as one JSON line in `MOCK_LOG` (default `$HOME/steer-mock.jsonl`):
 * `{n, at, kind, texts}`, `texts` being the text blocks of the user messages after the last
 * assistant message (the tool result's text left out), each cut to 200 characters.
 * 127.0.0.1:18866 (`MOCK_PORT`).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MOCK_PORT) || 18866;
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "steer-mock.jsonl");
const MARKER = "STEER-LAB";
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

const textsOf = (content: unknown): string[] =>
	typeof content === "string" ? [content] : Array.isArray(content) ? content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text as string) : [];

function stream(kind: string, bashName: string | undefined, intent: boolean, answer: string): Response {
	const nonce = `${Date.now().toString(36)}${seq}`;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (type: string, data: Json) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
			await Bun.sleep(100);
			send("message_start", {
				message: { id: `msg_steer_${nonce}`, type: "message", role: "assistant", model: "lab-1", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
			});
			let stop = "end_turn";
			if (kind === "tool" && bashName) {
				send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_steer_${nonce}`, name: bashName, input: {} } });
				const input = intent ? { command: "sleep 12", i: "Waiting for the slow step" } : { command: "sleep 12" };
				send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
				send("content_block_stop", { index: 0 });
				stop = "tool_use";
			} else {
				send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				send("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer } });
				send("content_block_stop", { index: 0 });
			}
			send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } });
			send("message_stop", {});
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 255,
	async fetch(req) {
		if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/messages")) return new Response("not found", { status: 404 });
		const body = (await req.json()) as Json;
		const n = ++seq;
		const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
		const bash = (Array.isArray(body.tools) ? body.tools : []).find((t: Json) => String(t?.name).toLowerCase() === "bash");
		const lastAssistant = messages.findLastIndex(m => m.role === "assistant");
		const texts = messages
			.slice(lastAssistant + 1)
			.filter(m => m.role === "user")
			.flatMap(m => textsOf(m.content))
			.map(t => t.slice(0, 200));
		const marked = messages.some(m => m.role === "user" && textsOf(m.content).some(t => t.includes(MARKER)));
		const called = messages.some(m => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: Json) => b?.type === "tool_use"));
		const kind = !marked || !bash ? "side" : called ? "answer" : "tool";
		appendFileSync(LOG, `${JSON.stringify({ n, at: new Date().toISOString(), kind, texts })}\n`);
		const answer = kind === "answer" ? `Seen ${texts.length} message(s).` : "steer lab";
		return stream(kind, bash?.name, !!bash?.input_schema?.properties?.i, answer);
	},
});
console.log(`steer mock on 127.0.0.1:${PORT}, log ${LOG}`);
