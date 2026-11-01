#!/usr/bin/env bun
/**
 * AskFlow lab mock model provider (`e2e_askflow.rs`) for omp 18.13.x: OpenAI chat-completions as
 * omp's `openai-completions` client speaks it (POST /v1/chat/completions, `stream: true`, SSE
 * `chat.completion.chunk`s, a finish chunk, a usage chunk, `data: [DONE]`). Never calls anything.
 *
 * Stateless: a conversation whose first user message holds `ASKFLOW-LAB` gets one assistant message
 * that explains (Markdown text) and then calls omp's `ask` tool with three questions (a single
 * choice, a multi-select, a single choice); once the tool result is in the history it answers
 * `ASKFLOW-LAB done: <result>`. Every other request (titles, side calls) gets a short text.
 *
 * Port 127.0.0.1:18759 (`MOCK_PORT`). Log: `MOCK_LOG`, else `$HOME/askflow-mock.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18759;
const MODEL = "lab-1";
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "askflow-mock.log");
const encoder = new TextEncoder();
let seq = 0;

/** What the agent writes before asking; the lab checks the ask card carries it. */
const EXPLANATION = [
	"I compared the two stores for the **lab app**:",
	"",
	"- *SQLite* keeps everything in one file and needs nothing running.",
	"- *Postgres* scales further, but needs a server.",
	"",
	"Three things decide the setup, so I am asking them together.",
].join("\n");

const QUESTIONS = [
	{
		id: "store",
		question: "Which store should the lab app use?",
		options: [
			{ label: "SQLite", description: "One file, nothing to run" },
			{ label: "Postgres", description: "A server to run" },
		],
		recommended: 0,
	},
	{
		id: "features",
		question: "Which features ship first?",
		options: [{ label: "Auth" }, { label: "Search" }, { label: "Billing" }],
		multi: true,
	},
	{
		id: "deploy",
		question: "Where does it deploy?",
		options: [{ label: "Fly" }, { label: "Render" }],
	},
];

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
	const prompt = textOf(messages.find(m => m.role === "user")?.content);
	if (!prompt.includes("ASKFLOW-LAB") || !tools.includes("ask")) return { kind: "side", text: "Lab task" };
	const askCall = messages.flatMap(msg => (msg.role === "assistant" && Array.isArray(msg.tool_calls) ? msg.tool_calls : [])).find((c: Json) => c?.function?.name === "ask");
	if (!askCall) {
		return { kind: "ask", text: EXPLANATION, call: { id: `call_ask_${Date.now().toString(36)}`, name: "ask", args: { questions: QUESTIONS } } };
	}
	const result = messages.find(msg => msg.role === "tool" && msg.tool_call_id === askCall.id);
	return { kind: "done", text: `ASKFLOW-LAB done: ${textOf(result?.content).replace(/\s+/g, " ").trim()}` };
}

function chunk(id: string, created: number, delta: Json | null, finish: string | null = null, usage?: Json): string {
	const body: Json = { id, object: "chat.completion.chunk", created, model: MODEL, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }] };
	if (usage) body.usage = usage;
	return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(d: Decision, n: number): Response {
	const id = `chatcmpl-af-${n}`;
	const created = Math.floor(Date.now() / 1000);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (s: string) => controller.enqueue(encoder.encode(s));
			await Bun.sleep(150);
			send(chunk(id, created, { role: "assistant", content: "" }));
			// The explanation streams in a few pieces, as a model writes it.
			for (const piece of (d.text ?? "").match(/[\s\S]{1,48}/g) ?? []) {
				send(chunk(id, created, { content: piece }));
				await Bun.sleep(20);
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
			log(`#${n} ${d.kind} msgs=${body.messages?.length ?? 0} stream=${body.stream === true}${d.call ? ` call=${d.call.name}` : ""}${d.text ? ` text=${JSON.stringify(d.text.slice(0, 160))}` : ""}`);
			if (body.stream === true) return stream(d, n);
			const message: Json = { role: "assistant", content: d.text ?? null };
			if (d.call) message.tool_calls = [{ id: d.call.id, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }];
			return Response.json({ id: `chatcmpl-af-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: d.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "tf-lab-askflow" }] });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`start pid=${process.pid} port=${server.port}`);
console.log(`askflow mock on http://${HOST}:${server.port} (pid ${process.pid})`);
