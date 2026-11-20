#!/usr/bin/env bun
/**
 * Model access lab mock (architecture §3.22 "Model access"): the Anthropic Messages API and its OAuth
 * usage endpoint for two signed-in accounts, told apart by their bearer token (fake tokens imported
 * into the lab's own omp, setup.sh; the lab runs in a network namespace with nothing but loopback, so
 * no token can leave it). Keyless otherwise, never calls anything.
 *
 *   lab-token-no    an account whose organization has no access to Claude Mythos: a request for
 *                   `claude-mythos-5-2` gets Anthropic's 404 `not_found_error` "model: claude-mythos-5-2";
 *                   every other model answers
 *   lab-token-yes   an account that serves every model, Mythos included; while the phase is `yes-out`
 *                   its 5-hour window is used up: every request gets a usage-limit 429 and its usage
 *                   report says exhausted, resetting when the phase ends
 *
 * `POST /lab/phase {phase: "normal"|"yes-out", seconds?}` switches the phase (`yes-out` ends by itself
 * after `seconds`, default 90). Every request is logged with the account, model and verdict to
 * `MOCK_LOG`. 127.0.0.1:18791 (`MOCK_PORT`).
 */
import { appendFileSync } from "node:fs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18791;
const LOG = process.env.MOCK_LOG || "/tmp/models-mock.log";
const MYTHOS = "claude-mythos-5-2";
const encoder = new TextEncoder();
let seq = 0;
let phase: { name: "normal" | "yes-out"; until: number } = { name: "normal", until: 0 };

type Json = Record<string, any>;

function log(line: string) {
	const out = `${new Date().toISOString()} ${line}\n`;
	try {
		appendFileSync(LOG, out);
	} catch {}
	process.stdout.write(out);
}

function account(req: Request): "no" | "yes" | "?" {
	const auth = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
	return auth.includes("lab-token-no") ? "no" : auth.includes("lab-token-yes") ? "yes" : "?";
}

function yesOut(): boolean {
	if (phase.name === "yes-out" && Date.now() >= phase.until) phase = { name: "normal", until: 0 };
	return phase.name === "yes-out";
}

function lastUser(body: Json): string {
	const users = (Array.isArray(body.messages) ? body.messages : []).filter((m: Json) => m.role === "user");
	const c = users.at(-1)?.content;
	const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: Json) => (p?.type === "text" ? p.text : "")).join("") : "";
	return text.replace(/\s+/g, " ").slice(0, 70);
}

function answer(model: string, who: string, body: Json, stream: boolean): Response {
	const text = `${model} on ${who} (lab) answered: ${lastUser(body)}`;
	const usage = { input_tokens: 10, output_tokens: Math.max(1, Math.ceil(text.length / 4)), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
	if (!stream) return Response.json({ id: `msg_lab_${seq}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage });
	const out = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (type: string, data: Json) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
			send("message_start", { message: { id: `msg_lab_${seq}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
			send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			for (const part of text.match(/.{1,24}/gs) ?? []) {
				await Bun.sleep(20);
				send("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } });
			}
			send("content_block_stop", { index: 0 });
			send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
			send("message_stop", {});
			controller.close();
		},
	});
	return new Response(out, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The OAuth usage report (`/api/oauth/usage`): percent used and reset times, as Anthropic reports them. */
function usage(who: "no" | "yes" | "?"): Response {
	const now = Date.now();
	const out = who === "yes" && yesOut();
	const five = out ? { utilization: 100, resets_at: iso(phase.until) } : { utilization: who === "no" ? 5 : 20, resets_at: iso(now + 3 * 3_600_000) };
	return Response.json({ five_hour: five, seven_day: { utilization: who === "no" ? 10 : 30, resets_at: iso(now + 5 * 86_400_000) } });
}

const server = Bun.serve({
	hostname: HOST,
	port: PORT,
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, "");
		const who = account(req);
		if (req.method === "POST" && path === "/lab/phase") {
			const p = (await req.json().catch(() => ({}))) as Json;
			phase = p.phase === "yes-out" ? { name: "yes-out", until: Date.now() + 1000 * (Number(p.seconds) || 90) } : { name: "normal", until: 0 };
			log(`phase ${phase.name}${phase.until ? ` until ${iso(phase.until)}` : ""}`);
			return Response.json({ phase: phase.name, until: phase.until });
		}
		if (req.method === "GET" && path.endsWith("/api/oauth/usage")) {
			log(`usage account=${who}${who === "yes" && yesOut() ? " (exhausted)" : ""}`);
			return usage(who);
		}
		if (req.method === "POST" && path.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 10 });
		if (req.method === "POST" && path.endsWith("/messages")) {
			const n = ++seq;
			const body = (await req.json().catch(() => ({}))) as Json;
			const model = String(body.model ?? "?");
			const side = !Array.isArray(body.tools) || body.tools.length === 0;
			if (model === MYTHOS && who === "no") {
				log(`#${n} account=no model=${model} 404 not_found side=${side} last-user=${JSON.stringify(lastUser(body))}`);
				return Response.json({ type: "error", error: { type: "not_found_error", message: `model: ${MYTHOS}` }, request_id: `req_lab_${n}` }, { status: 404 });
			}
			if (who === "yes" && yesOut()) {
				log(`#${n} account=yes model=${model} 429 usage side=${side} last-user=${JSON.stringify(lastUser(body))}`);
				const retry = Math.max(1, Math.ceil((phase.until - Date.now()) / 1000));
				return Response.json(
					{ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." }, request_id: `req_lab_${n}` },
					{ status: 429, headers: { "retry-after": String(retry), "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-5h-utilization": "1.0", "anthropic-ratelimit-unified-5h-reset": String(Math.ceil(phase.until / 1000)) } },
				);
			}
			log(`#${n} account=${who} model=${model} ANSWERS side=${side} last-user=${JSON.stringify(lastUser(body))}`);
			return answer(model, who, body, body.stream === true);
		}
		log(`404 ${req.method} ${url.pathname} account=${who}`);
		return Response.json({ type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
