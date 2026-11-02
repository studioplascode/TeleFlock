#!/usr/bin/env bun
/**
 * Browser lab mock model provider for omp (OpenAI chat-completions, as omp's `openai-completions`
 * client speaks it: POST /v1/chat/completions with `stream: true`, SSE `chat.completion.chunk`s, a
 * finish chunk, a usage chunk, `data: [DONE]`).
 *
 * Stateless, keyed on the newest user message of a request that offers tools (the agent's turn):
 * - `USE-BROWSER <reason>` (a line): calls the bridge's `use_user_browser {reason}` first.
 * - `BRW-EVAL` (a line) and the code after it, up to the next `BRW-EVAL` line: one call of omp's
 *   `eval {language: "js", code}` each, which runs the code with omp's `browser` global (omp's own
 *   browser tooling); after `USE-BROWSER` only when the tool's result says the user allowed it.
 * When every step has its result in the history, the answer quotes each result (`[<tool>] …`) and
 * every line starting `TeleFlock:` that reached the context since the agent's previous answer
 * (`[context] …`: what the bridge told the model between turns), and ends with `BROWSER-LAB done`.
 * A prompt without either marker gets a short answer ending the same.
 * Side requests (omp's session title, asked without tools or as a `<title-request>` message; the
 * app's naming) get a short title, or a kebab-case slug when the system prompt asks for one.
 *
 * Port 127.0.0.1:18783 (`MOCK_PORT`; `models.yml` next to this file points there). Log: `MOCK_LOG`
 * (else `$HOME/browser-mock.log`).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18783;
const MODEL = "lab-1";
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "browser-mock.log");
const encoder = new TextEncoder();
let seq = 0;

type Json = Record<string, any>;

function log(line: string) {
	appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(p => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("\n");
	return "";
}

interface Decision {
	kind: string;
	text?: string;
	call?: { id: string; name: string; args: Json };
}

interface Step {
	tool: string;
	args: Json;
	/** Runs only when this holds for the results so far. */
	when?: (results: string[]) => boolean;
}

/** The prompt's steps: `USE-BROWSER <reason>`, then one eval per `BRW-EVAL` block. */
function stepsOf(prompt: string): Step[] {
	const steps: Step[] = [];
	const ask = /^USE-BROWSER[ \t]*(.*)$/m.exec(prompt);
	if (ask) steps.push({ tool: "use_user_browser", args: { reason: ask[1]?.trim() || "Read the lab page while signed in as you" } });
	// After USE-BROWSER only when the bridge's result says omp may drive the user's browser now.
	const allowed = /allowed you to use their TeleFlock Browser|can already use the user's TeleFlock Browser/;
	const blocks = prompt.split(/^BRW-EVAL[ \t]*$/m).slice(1);
	for (const block of blocks) {
		const code = block.replace(/^\n/, "").trimEnd();
		steps.push({ tool: "eval", args: { language: "js", code, title: "browser lab" }, when: ask ? r => allowed.test(r[0] ?? "") : undefined });
	}
	return steps;
}

function decide(body: Json): Decision {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	const tools: Json[] = Array.isArray(body.tools) ? body.tools : [];
	const names: string[] = tools.map(t => t?.function?.name).filter(Boolean);
	const system = messages.filter(m => m.role === "system" || m.role === "developer").map(m => textOf(m.content)).join("\n");
	let u = messages.length - 1;
	while (u >= 0 && messages[u]?.role !== "user") u--;
	const prompt = u >= 0 ? textOf(messages[u].content) : "";
	if (!names.length || prompt.includes("<title-request>")) {
		if (/kebab-case/i.test(system)) return { kind: "name", text: "browser-lab" };
		return { kind: "title", text: "Browser lab" };
	}
	const steps = stepsOf(prompt);
	if (!steps.length) return { kind: "answer", text: `You said "${prompt.replace(/\s+/g, " ").trim().slice(0, 80)}".\n\nBROWSER-LAB done` };
	const after = messages.slice(u + 1);
	const calls: Json[] = after.flatMap(m => (m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : []));
	const results = calls.map(c => textOf(after.find(m => m.role === "tool" && m.tool_call_id === c?.id)?.content).trim());
	calls.forEach((c, k) => log(`  result ${c?.function?.name} ${c?.id}: ${JSON.stringify(results[k]!.slice(0, 600))}`));
	// The next step this turn still has to call (steps whose condition fails are skipped).
	let k = 0;
	for (const step of steps) {
		if (step.when && !step.when(results)) break;
		if (k < calls.length) {
			k++;
			continue;
		}
		if (!names.includes(step.tool)) return { kind: `no-${step.tool}`, text: `omp offers no ${step.tool} tool (offered: ${names.join(", ")}).\n\nBROWSER-LAB done` };
		const schema = tools.find(t => t?.function?.name === step.tool)?.function?.parameters;
		const args: Json = schema?.properties?.i ? { i: `Lab step ${step.tool}`, ...step.args } : { ...step.args };
		if (!schema?.properties?.title) delete args.title;
		return { kind: step.tool, text: k === 0 ? "On it." : "", call: { id: `call_${step.tool}_${Date.now().toString(36)}_${k}`, name: step.tool, args } };
	}
	// What reached the context since the agent's previous answer, besides the prompt (the bridge's notes).
	let p = u - 1;
	while (p >= 0 && messages[p]?.role !== "assistant") p--;
	const notes = messages
		.slice(p + 1, u + 1)
		.filter(m => m.role === "user")
		.flatMap(m => textOf(m.content).split("\n"))
		.filter(l => l.startsWith("TeleFlock:"))
		.map(l => `[context] ${l}`);
	const quoted = calls.map((c, i) => `[${c?.function?.name}] ${results[i]!.split("\n").join("\n    ")}`);
	return { kind: "done", text: ["BROWSER-LAB results:", ...notes, ...quoted, "BROWSER-LAB done"].join("\n\n") };
}

function chunk(id: string, created: number, delta: Json | null, finish: string | null = null, usage?: Json): string {
	const body: Json = { id, object: "chat.completion.chunk", created, model: MODEL, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }] };
	if (usage) body.usage = usage;
	return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(d: Decision, n: number): Response {
	const id = `chatcmpl-brw-${n}`;
	const created = Math.floor(Date.now() / 1000);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (s: string) => controller.enqueue(encoder.encode(s));
			await Bun.sleep(100);
			send(chunk(id, created, { role: "assistant", content: "" }));
			for (const part of d.text?.match(/[\s\S]{1,80}/g) ?? []) {
				send(chunk(id, created, { content: part }));
				await Bun.sleep(10);
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

Bun.serve({
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
			log(`#${n} ${d.kind} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0}${d.call ? ` call=${d.call.name} ${d.call.id}` : ""}${d.text ? ` text=${JSON.stringify(d.text.slice(0, 160))}` : ""}`);
			if (body.stream === true) return stream(d, n);
			const message: Json = { role: "assistant", content: d.text || null };
			if (d.call) message.tool_calls = [{ id: d.call.id, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }];
			return Response.json({ id: `chatcmpl-brw-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: d.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "tf-lab-browser" }] });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});
log(`mock on ${HOST}:${PORT}`);
