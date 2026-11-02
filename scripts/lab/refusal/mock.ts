#!/usr/bin/env bun
/**
 * Refusal fallback lab mock model provider: the Anthropic Messages API (`api: anthropic-messages`
 * in the lab's models.yml; POST /v1/messages with `stream: true`, SSE `message_start` …
 * `content_block_*` … `message_delta` / `message_stop`). Keyless, never calls anything.
 *
 * A request that offers tools is a turn of the agent under test; the model it names decides:
 *   lab-opus-5-5     refuses: `message_delta` with `stop_reason: "refusal"` and
 *                    `stop_details {type: "refusal", category: "cyber", explanation: …}`, no content
 *                    (what Anthropic's classifier does to a request it will not serve)
 *   lab-sonnet-5-5   answers: a short text naming itself and the message it answers, `end_turn`
 *   lab-haiku-5-5    refuses too, as `cyber` (the model a second refusal of one turn comes from)
 * A request without tools (omp's session titles and other side calls) gets a short text from
 * whichever model asks: only the agent's turns are scripted.
 *
 * Every request is logged with the model, the number of messages it carries and the last user
 * message (so a log shows that a turn continued on another model asks the same question again, with
 * no new prompt) to `MOCK_LOG`, else `$HOME/refusal-mock.log`. 127.0.0.1:18781 (`MOCK_PORT`).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18781;
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "refusal-mock.log");
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

const EXPLANATION = "The request asks for working exploit code.";

const NAMES: Record<string, string> = {
	"lab-opus-5-5": "Opus 5.5",
	"lab-sonnet-5-5": "Sonnet 5.5",
	"lab-haiku-5-5": "Haiku 5.5",
};

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

/** The user messages as omp sends them: a turn's prompt, plus any later user message (a new prompt). */
function userMessages(body: Json): string[] {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	return messages
		.filter(m => m.role === "user")
		.map(m => textOf(m.content))
		.filter(t => t.trim().length > 0);
}

type Verdict = { kind: "refuse"; category: string } | { kind: "answer" } | { kind: "side" };

function decide(body: Json): Verdict {
	if (!Array.isArray(body.tools) || body.tools.length === 0) return { kind: "side" };
	// omp also asks the main model for the session's title, in a request of its own (`<title-request>`).
	if ((userMessages(body).at(-1) ?? "").startsWith("<title-request>")) return { kind: "side" };
	const model = String(body.model ?? "");
	if (model === "lab-opus-5-5" || model === "lab-haiku-5-5") return { kind: "refuse", category: "cyber" };
	return { kind: "answer" };
}

function answerText(model: string, body: Json): string {
	const asked = userMessages(body).at(-1) ?? "";
	return `${NAMES[model] ?? model} (lab) answered: ${asked.replace(/\s+/g, " ").slice(0, 80)}`;
}

function stream(n: number, model: string, verdict: Verdict, body: Json, inputTokens: number): Response {
	const nonce = `${Date.now().toString(36)}${n}`;
	const out = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (type: string, data: Json) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
			await Bun.sleep(150);
			send("message_start", {
				message: {
					id: `msg_refusal_${nonce}`,
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				},
			});
			send("ping", {});
			if (verdict.kind === "refuse") {
				await Bun.sleep(250);
				send("message_delta", {
					delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: verdict.category, explanation: EXPLANATION } },
					usage: { output_tokens: 1 },
				});
			} else {
				const text = verdict.kind === "answer" ? answerText(model, body) : "Refusal-Labor";
				send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				for (const part of text.match(/.{1,16}/gs) ?? []) {
					await Bun.sleep(40);
					send("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } });
				}
				send("content_block_stop", { index: 0 });
				send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(text.length / 4)) } });
			}
			send("message_stop", {});
			controller.close();
		},
	});
	return new Response(out, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

function plain(n: number, model: string, verdict: Verdict, body: Json, inputTokens: number): Response {
	const refuse = verdict.kind === "refuse";
	return Response.json({
		id: `msg_refusal_${n}`,
		type: "message",
		role: "assistant",
		model,
		content: refuse ? [] : [{ type: "text", text: verdict.kind === "answer" ? answerText(model, body) : "Refusal-Labor" }],
		stop_reason: refuse ? "refusal" : "end_turn",
		stop_sequence: null,
		...(refuse ? { stop_details: { type: "refusal", category: verdict.category, explanation: EXPLANATION } } : {}),
		usage: { input_tokens: inputTokens, output_tokens: 3 },
	});
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
			const model = String(body.model ?? "?");
			const verdict = decide(body);
			const users = userMessages(body);
			const what = verdict.kind === "refuse" ? `REFUSES (${verdict.category})` : verdict.kind === "answer" ? "ANSWERS" : "side call";
			log(
				`#${n} model=${model} ${what} tools=${body.tools?.length ?? 0} msgs=${body.messages?.length ?? 0} users=${users.length} last-user=${JSON.stringify(
					(users.at(-1) ?? "").replace(/\s+/g, " ").slice(0, 70),
				)} stream=${body.stream === true}`,
			);
			const inputTokens = Math.ceil(raw.length / 4);
			return body.stream === true ? stream(n, model, verdict, body, inputTokens) : plain(n, model, verdict, body, inputTokens);
		}
		if (req.method === "GET" && path.endsWith("/models")) {
			const data = Object.entries(NAMES).map(([id, name]) => ({ type: "model", id, display_name: `Claude ${name}`, created_at: "2026-01-01T00:00:00Z" }));
			return Response.json({ data, has_more: false, first_id: data[0]!.id, last_id: data.at(-1)!.id });
		}
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		log(`404 ${req.method} ${url.pathname}`);
		return Response.json({ type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
