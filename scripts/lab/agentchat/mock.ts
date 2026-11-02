#!/usr/bin/env bun
/**
 * Agent chat lab mock model provider: the Anthropic Messages API (`api: anthropic-messages` in the
 * lab's models.yml; POST /v1/messages with `stream: true`, SSE `message_start` … `content_block_*`
 * … `message_delta` / `message_stop`). Keyless, never calls anything.
 *
 * It plays one agent tree whose agents talk over omp's IRC (`write agent://…`, `wait`); every
 * message text starts with `ACB <from>→<to>`:
 *   Main (prompt `ACB-TREE`)        spawns Orchestrator and waits; answers the Orchestrator's plan
 *                                   (`ACB main→orch`); ends with `ACB-LAB tree done` once the
 *                                   Orchestrator's result is in
 *   Orchestrator (`ACB-ROLE orchestrator`)  spawns WorkerA and WorkerB, broadcasts the plan
 *                                   (`agent://all`: omp sends it to every running or idle agent:
 *                                   Main and both workers), waits until both results are in
 *   WorkerB (`ACB-ROLE worker-b`)   polls (`bash sleep 1`) until the plan arrived, then finishes;
 *                                   woken later by WorkerA's question, it answers in its wake turn,
 *                                   which omp relays back to WorkerA (`wakeRelay`, `replyTo`)
 *   WorkerA (`ACB-ROLE worker-a`)   polls until the plan arrived; a progress note to the
 *                                   Orchestrator (`?progress`); once WorkerB finished, asks it and
 *                                   waits for the relay; writes to `Nobody` (omp: unknown agent,
 *                                   failed) and to itself (refused before delivery); tells the
 *                                   Orchestrator the ports; finishes
 * Later prompts to Main:
 *   `ACB-PING`  Main asks the idle Orchestrator `ACB main→orch: Still there…`; woken, the
 *               Orchestrator writes back `ACB orch→main: Still here.` (omp relays no wake turn to
 *               the agent that spawned it), which wakes Main: `ACB-LAB ping done`
 * What the user sends a subagent from TeleFlock (`ACB user→…`) gets a one-line answer.
 * A subagent finishes through omp's `yield` tool when it is offered one, else with its last text.
 *
 * Each request is decided from what it carries: which agent asks (the marker in its first prompt),
 * which of its scripted tool calls the history holds (the mock's tool_use ids name the step), and
 * what reached it (texts of user messages and tool results). Two gates hold a response (pinging the
 * stream meanwhile) until something happened elsewhere; the mock serves the whole tree, so it knows:
 *   the Orchestrator's broadcast waits until both workers asked for their first step (their
 *   sessions exist and stream, so omp injects the plan into both);
 *   WorkerA's question to WorkerB waits until WorkerB's final step went out 2 s ago (it is idle, so
 *   omp wakes it).
 * A new tree (Main's first `ACB-TREE` step) clears the gates. Every other request (session title,
 * side calls) gets a short text.
 *
 * 127.0.0.1:18791 (`MOCK_PORT`). Log: `MOCK_LOG`, else `$HOME/agentchat-mock.log`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18791;
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "agentchat-mock.log");
const STEP_ID = /^toolu_acb_([a-z0-9-]+)_/;
/** Polls and waits an agent makes at most before it gives up (a broken run still ends). */
const MAX_LOOPS = 60;
const encoder = new TextEncoder();
let seq = 0;
const toolsLogged = new Set<string>();

type Json = Record<string, any>;

/** When the gates' events happened, per tree (agent role → ms). */
const firstAsked = new Map<string, number>();
const finishedAt = new Map<string, number>();

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
	return content
		.map(p => {
			if (p?.type === "text" && typeof p.text === "string") return p.text;
			if (p?.type === "tool_result") return textOf(p.content);
			return "";
		})
		.join("\n");
}

interface Tools {
	/** lower-case name → the name omp offers. */
	names: Record<string, string>;
	/** Tools whose schema has omp's `i` (intent) field. */
	intent: Record<string, boolean>;
	/** omp's `task` takes a batch (`context`, `tasks[]`). */
	batch: boolean;
}

function toolsOf(body: Json): Tools {
	const out: Tools = { names: {}, intent: {}, batch: false };
	for (const t of Array.isArray(body.tools) ? body.tools : []) {
		const name: string = typeof t?.name === "string" ? t.name : "";
		if (!name) continue;
		out.names[name.toLowerCase()] = name;
		out.intent[name] = !!t?.input_schema?.properties?.i;
		if (name.toLowerCase() === "task") out.batch = !!t?.input_schema?.properties?.tasks;
	}
	return out;
}

/** What one request tells about the agent that makes it. */
interface View {
	/** main | orchestrator | worker-a | worker-b; undefined: not one of the tree's agents. */
	role?: string;
	/** Its scripted steps so far, in order (from the mock's tool_use ids). */
	steps: string[];
	/** Everything that reached it: user texts and tool results. */
	heard: string;
	/** What reached it since its last answer. */
	latest: string;
	/** Its own texts and tool inputs. */
	said: string;
}

function viewOf(body: Json): View {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	const v: View = { steps: [], heard: "", latest: "", said: "" };
	let lastAssistant = -1;
	messages.forEach((m, i) => {
		if (m?.role === "assistant") lastAssistant = i;
	});
	messages.forEach((m, i) => {
		if (m?.role === "user") {
			const text = textOf(m.content);
			v.heard += `${text}\n`;
			if (i > lastAssistant) v.latest += `${text}\n`;
			if (!v.role) {
				const own = Array.isArray(m.content) ? m.content.filter((b: Json) => b?.type === "text").map((b: Json) => b.text).join("\n") : String(m.content ?? "");
				const role = /\bACB-ROLE ([a-z-]+)/.exec(own)?.[1];
				if (role) v.role = role;
				else if (/\bACB-TREE\b/.test(own)) v.role = "main";
			}
		}
		if (m?.role === "assistant") {
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "text") v.said += `${b.text}\n`;
				if (b?.type === "tool_use") {
					v.said += `${JSON.stringify(b.input ?? {})}\n`;
					const step = STEP_ID.exec(String(b.id ?? ""))?.[1];
					if (step) v.steps.push(step);
				}
			}
		}
	});
	return v;
}

interface Step {
	kind: string;
	call?: { tool: string; input: Json; intent: string };
	text?: string;
	note?: string;
	/** Hold the answer until this holds (at most `gateMs`). */
	gate?: () => boolean;
	gateMs?: number;
	/** Runs once the answer went out. */
	sent?: () => void;
}

const WORKER_TASK = (role: string, name: string, does: string) =>
	`ACB-ROLE ${role}\nYou are ${name} of the agent chat lab. ${does} Talk to the other agents with \`write agent://<id>\`; finish with your result.`;
const ORCH_TASK = "ACB-ROLE orchestrator\nYou orchestrate the agent chat lab: spawn WorkerA (the API) and WorkerB (the UI), broadcast the plan, wait for both results and report them.";

function decide(v: View, tools: Tools): Step {
	const has = (step: string) => v.steps.includes(step);
	const count = (step: string) => v.steps.filter(s => s === step).length;
	const heard = (text: string) => v.heard.includes(text);
	const call = (kind: string, tool: string | undefined, input: Json, intent: string, extra: Partial<Step> = {}): Step =>
		tool ? { kind, call: { tool, input, intent }, ...extra } : { kind: "side", text: `ACB-LAB: no ${kind} tool offered.`, note: `no tool for ${kind}` };
	const write = (kind: string, to: string, content: string, extra: Partial<Step> = {}) => call(kind, tools.names.write, { path: `agent://${to}`, content }, `Messaging ${to.split("?")[0]}`, extra);
	const wait = (kind: string) => call(kind, tools.names.wait, {}, "Waiting for the others");
	const poll = (kind: string) => call(kind, tools.names.bash, { command: "sleep 1" }, "Waiting for the plan");
	/** A subagent's result: omp's `yield` when offered, else its last text. */
	const finish = (role: string, result: string, extra: Partial<Step> = {}): Step =>
		tools.names.yield && !has(`${role}-done`)
			? call(`${role}-done`, tools.names.yield, { data: result }, "Submitting the result", extra)
			: { kind: `${role}-done`, text: result, ...extra };
	const finished = (role: string, result: string) => has(`${role}-done`) || v.said.includes(result.slice(0, 24));

	// What the user sent from TeleFlock: a one-line answer.
	if (v.latest.includes("ACB user→") && v.role && v.role !== "main") return { kind: `${v.role}-user`, text: `ACB ${v.role}→user: noted.` };

	switch (v.role) {
		case "main": {
			if (v.latest.includes("ACB orch→main: Still here")) return { kind: "main-ping-done", text: "ACB-LAB ping done" };
			if (v.latest.includes("ACB-PING") && !has("main-ping")) return write("main-ping", "Orchestrator", "ACB main→orch: Still there after the restart?");
			if (v.steps.at(-1) === "main-ping") return { kind: "main-ping-sent", text: "ACB-LAB ping sent" };
			if (!has("main-task")) {
				const task = { name: "Orchestrator", agent: "task", task: ORCH_TASK, solutionSpace: "scripted lab run; the mock decides every step" };
				return call("main-task", tools.names.task, tools.batch ? { context: "# Goal\nThe agent chat lab's scripted tree.", tasks: [task] } : task, "Starting the orchestrator", {
					sent: () => {
						firstAsked.clear();
						finishedAt.clear();
					},
				});
			}
			if (heard("ACB-RESULT orchestrator")) return { kind: "main-done", text: "ACB-LAB tree done: the Orchestrator reported both workers." };
			if (heard("ACB orch→all") && !has("main-reply")) return write("main-reply", "Orchestrator", "ACB main→orch: Got the plan. Report when both workers are done.");
			if (count("main-wait") >= MAX_LOOPS) return { kind: "main-done", text: "ACB-LAB gave up waiting for the Orchestrator." };
			return wait("main-wait");
		}
		case "orchestrator": {
			if (v.latest.includes("ACB main→orch: Still there")) return write("orch-pong", "Main", "ACB orch→main: Still here.");
			if (v.steps.at(-1) === "orch-pong") return { kind: "orch-pong-sent", text: "ACB orch: answered Main." };
			if (!has("orch-task")) {
				const a = { name: "WorkerA", agent: "task", task: WORKER_TASK("worker-a", "WorkerA", "Build the API."), solutionSpace: "scripted lab run" };
				const b = { name: "WorkerB", agent: "task", task: WORKER_TASK("worker-b", "WorkerB", "Build the UI."), solutionSpace: "scripted lab run" };
				if (tools.batch) return call("orch-task", tools.names.task, { context: "# Goal\nThe agent chat lab's workers.", tasks: [a, b] }, "Starting the workers");
				return has("orch-task-a") ? call("orch-task", tools.names.task, b, "Starting WorkerB") : call("orch-task-a", tools.names.task, a, "Starting WorkerA");
			}
			if (!has("orch-all"))
				return write("orch-all", "all", "ACB orch→all: Plan: WorkerA builds the API, WorkerB the UI. Tell each other your ports and report to me.", {
					gate: () => firstAsked.has("worker-a") && firstAsked.has("worker-b"),
					gateMs: 60_000,
				});
			const result = "ACB-RESULT orchestrator: the API runs on port 7421, the UI on 7420.";
			// Its last text is its result (a later notice, a background job's end, must not replace it).
			if (finished("orch", result)) return { kind: "orch-again", text: result };
			if (heard("ACB-RESULT worker-a") && heard("ACB-RESULT worker-b")) return finish("orch", result);
			if (count("orch-wait") >= MAX_LOOPS || v.latest.includes("Nothing to wait for")) return finish("orch", "ACB-RESULT orchestrator: a worker never reported its result.");
			return wait("orch-wait");
		}
		case "worker-b": {
			const result = "ACB-RESULT worker-b: the UI runs on port 7420.";
			if (finished("b", result)) {
				// A wake turn: omp relays its text to whoever woke it.
				if (v.latest.includes("ACB a→b")) return { kind: "b-answer", text: "ACB b→a: The UI uses port 7420." };
				return { kind: "b-again", text: result };
			}
			if (!heard("ACB orch→all") && count("b-poll") < MAX_LOOPS) return poll("b-poll");
			return finish("b", result, { sent: () => finishedAt.set("worker-b", Date.now()) });
		}
		case "worker-a": {
			const result = "ACB-RESULT worker-a: the API runs on port 7421.";
			if (finished("a", result)) return { kind: "a-again", text: result };
			if (!heard("ACB orch→all") && count("a-poll") < MAX_LOOPS) return poll("a-poll");
			if (!has("a-progress")) return write("a-progress", "Orchestrator?progress", "ACB a→orch (progress): API scaffolded; asking WorkerB for the UI port next.");
			if (!has("a-ask"))
				return write("a-ask", "Orchestrator.WorkerB", "ACB a→b: Which port does the UI use?", {
					gate: () => (finishedAt.get("worker-b") ?? Number.POSITIVE_INFINITY) + 2_000 <= Date.now(),
					gateMs: 90_000,
				});
			if (!heard("ACB b→a") && count("a-wait") < MAX_LOOPS) return wait("a-wait");
			if (!has("a-nobody")) return write("a-nobody", "Nobody", "ACB a→nobody: Is anyone there?");
			if (!has("a-self")) return write("a-self", "Orchestrator.WorkerA", "ACB a→a: Note to self: the UI is on 7420.");
			if (!has("a-orch")) return write("a-orch", "Orchestrator", "ACB a→orch: The API is up on port 7421; the UI is on 7420.");
			return finish("a", result);
		}
	}
	return { kind: "side", text: "Agent chat lab", note: v.role ? `unknown role ${v.role}` : "no role marker" };
}

function stream(n: number, step: Step, tools: Tools, inputTokens: number): Response {
	const nonce = `${Date.now().toString(36)}${n}`;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (type: string, data: Json) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
			send("message_start", {
				message: {
					id: `msg_agentchat_${nonce}`,
					type: "message",
					role: "assistant",
					model: "lab-1",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				},
			});
			send("ping", {});
			if (step.gate) {
				const until = Date.now() + (step.gateMs ?? 60_000);
				const held = Date.now();
				while (!step.gate() && Date.now() < until) {
					await Bun.sleep(250);
					if ((Date.now() - held) % 2_000 < 250) send("ping", {});
				}
				log(`#${n} ${step.kind}: gate ${step.gate() ? "opened" : "timed out"} after ${Date.now() - held} ms`);
			}
			await Bun.sleep(80);
			let index = 0;
			if (step.text) {
				const i = index++;
				send("content_block_start", { index: i, content_block: { type: "text", text: "" } });
				for (const part of step.text.match(/[\s\S]{1,40}/g) ?? []) {
					send("content_block_delta", { index: i, delta: { type: "text_delta", text: part } });
					await Bun.sleep(20);
				}
				send("content_block_stop", { index: i });
			}
			if (step.call) {
				const i = index++;
				const input = tools.intent[step.call.tool] ? { i: step.call.intent, ...step.call.input } : step.call.input;
				send("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_acb_${step.kind}_${nonce}`, name: step.call.tool, input: {} } });
				const json = JSON.stringify(input);
				for (const part of json.match(/[\s\S]{1,64}/g) ?? []) {
					send("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: part } });
					await Bun.sleep(10);
				}
				send("content_block_stop", { index: i });
			}
			send("message_delta", { delta: { stop_reason: step.call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			send("message_stop", {});
			controller.close();
			step.sent?.();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

if (import.meta.main) {
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
				const tools = toolsOf(body);
				const v = viewOf(body);
				if (v.role && !firstAsked.has(v.role)) firstAsked.set(v.role, Date.now());
				if (v.role && !toolsLogged.has(v.role) && Object.keys(tools.names).length) {
					toolsLogged.add(v.role);
					log(`tools offered to ${v.role}: ${Object.values(tools.names).join(", ")} (task batch: ${tools.batch})`);
				}
				const step = Object.keys(tools.names).length ? decide(v, tools) : { kind: "side", text: "Agent chat lab", note: "no tools (a side call)" };
				const latest = v.latest.replace(/\s+/g, " ").trim().slice(0, 140);
				log(
					`#${n} ${v.role ?? "-"} → ${step.kind}${step.note ? ` (${step.note})` : ""}${step.call ? ` call=${step.call.tool} ${JSON.stringify(step.call.input).slice(0, 200)}` : ""}${step.text ? ` text=${JSON.stringify(step.text.slice(0, 120))}` : ""} steps=[${v.steps.join(",")}] latest=${JSON.stringify(latest)}`,
				);
				const inputTokens = Math.ceil(raw.length / 4);
				if (body.stream === true) return stream(n, step, tools, inputTokens);
				return Response.json({
					id: `msg_agentchat_${n}`,
					type: "message",
					role: "assistant",
					model: "lab-1",
					content: [{ type: "text", text: step.text ?? "Agent chat lab" }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: inputTokens, output_tokens: 3 },
				});
			}
			if (req.method === "GET" && path.endsWith("/models")) return Response.json({ data: [{ type: "model", id: "lab-1", display_name: "Agent Chat Lab Mock", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "lab-1", last_id: "lab-1" });
			if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
			log(`404 ${req.method} ${url.pathname}`);
			return Response.json({ type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
		},
	});
	log(`start pid=${process.pid} port=${server.port}`);
}
