// TeleFlock lab probe: a per-process omp extension (loaded with `omp -e <this file>`)
// that exposes structured control over a newline-JSON unix socket.
// Not production code — it exists to prove which ExtensionAPI calls work from outside the TUI.
// Socket: $TF_BRIDGE_DIR/omp-<pid>.sock (default /tmp). One JSON object per line in, one per line out.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type DeliverAs = "steer" | "followUp" | "nextTurn" | "aside";

/** One request line. Fields are validated per op in `handle`. */
interface BridgeRequest {
	id?: string;
	op: string;
	level?: string;
	spec?: string;
	tier?: string;
	name?: string;
	text?: string;
	deliverAs?: DeliverAs;
	focus?: string;
	entryId?: string;
	targetId?: string;
}

function parseRequest(line: string): BridgeRequest | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || !("op" in value) || typeof value.op !== "string") return undefined;
	// Shape checked above (object with string `op`); remaining fields are optional and re-checked per op.
	return value as BridgeRequest;
}

export default function (pi: ExtensionAPI) {
	const dir = process.env.TF_BRIDGE_DIR || "/tmp";
	const sockPath = path.join(dir, `omp-${process.pid}.sock`);
	let ctxRef: ExtensionContext | undefined; // latest context seen in an event
	let cmdCtx: ExtensionCommandContext | undefined; // captured from one `/tf-attach` invocation
	const clients = new Set<net.Socket>();
	const emit = (obj: unknown) => {
		const line = `${JSON.stringify(obj)}\n`;
		for (const c of clients) c.write(line);
	};

	pi.registerCommand("tf-attach", {
		description: "TeleFlock: capture command context for remote session control",
		handler: async (_args, ctx) => {
			cmdCtx = ctx;
			ctxRef = ctx;
			emit({ t: "attached" });
		},
	});

	const forwarded = ["session_start", "agent_start", "agent_end", "turn_end", "tool_execution_start", "tool_execution_end", "session_switch"] as const;
	for (const ev of forwarded) {
		pi.on(ev, (event: unknown, ctx: ExtensionContext) => {
			ctxRef = ctx;
			const toolName = event && typeof event === "object" && "toolName" in event ? event.toolName : undefined;
			const willContinue = event && typeof event === "object" && "willContinue" in event ? event.willContinue : undefined;
			emit({ t: "event", type: ev, toolName, willContinue });
		});
	}

	async function handle(req: BridgeRequest): Promise<unknown> {
		const ctx = cmdCtx ?? ctxRef;
		if (!ctx) return { error: "no context yet" };
		switch (req.op) {
			case "state":
				return {
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
					thinking: pi.getThinkingLevel(),
					idle: ctx.isIdle(),
					sessionName: pi.getSessionName(),
					sessionFile: ctx.sessionManager.getSessionFile(),
					leafId: ctx.sessionManager.getLeafId(),
					context: ctx.getContextUsage(),
					serviceTiers: pi.getServiceTiers(),
					hasCmdCtx: cmdCtx !== undefined,
				};
			case "thinking":
				// Level string comes from the trusted local client; omp validates/clamps it.
				pi.setThinkingLevel(req.level as ThinkingLevel);
				return { thinking: pi.getThinkingLevel() };
			case "model": {
				const m = req.spec ? ctx.models.resolve(req.spec) : undefined;
				if (!m) return { error: `unknown model ${req.spec}` };
				return { ok: await pi.setModel(m) };
			}
			case "fast":
				pi.setServiceTier("openai", req.tier === "off" ? undefined : req.tier);
				return { serviceTiers: pi.getServiceTiers() };
			case "rename":
				if (!req.name) return { error: "name required" };
				await pi.setSessionName(req.name);
				return { name: pi.getSessionName() };
			case "send":
				if (!req.text) return { error: "text required" };
				pi.sendUserMessage(req.text, req.deliverAs ? { deliverAs: req.deliverAs } : undefined);
				return { ok: true };
			case "abort":
				ctx.abort();
				return { ok: true };
			case "compact":
				ctx.compact(req.focus);
				return { ok: true };
			case "branch":
				if (!cmdCtx) return { error: "run /tf-attach once first" };
				if (!req.entryId) return { error: "entryId required" };
				return { result: await cmdCtx.branch(req.entryId) };
			case "tree":
				if (!cmdCtx) return { error: "run /tf-attach once first" };
				if (!req.targetId) return { error: "targetId required" };
				return { result: await cmdCtx.navigateTree(req.targetId, { summarize: false }) };
			default:
				return { error: `unknown op ${req.op}` };
		}
	}

	fs.rmSync(sockPath, { force: true });
	const server = net.createServer(sock => {
		clients.add(sock);
		let buf = "";
		sock.on("data", d => {
			buf += d.toString();
			let i = buf.indexOf("\n");
			while (i >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				i = buf.indexOf("\n");
				if (!line.trim()) continue;
				const req = parseRequest(line);
				if (!req) {
					sock.write(`${JSON.stringify({ t: "error", error: "bad request" })}\n`);
					continue;
				}
				handle(req).then(
					res => sock.write(`${JSON.stringify({ t: "response", id: req.id, res })}\n`),
					err => sock.write(`${JSON.stringify({ t: "response", id: req.id, error: String(err) })}\n`),
				);
			}
		});
		sock.on("close", () => clients.delete(sock));
		sock.on("error", () => clients.delete(sock));
	});
	server.listen(sockPath);
	server.unref();
	pi.on("session_shutdown", () => {
		server.close();
		fs.rmSync(sockPath, { force: true });
	});
}
