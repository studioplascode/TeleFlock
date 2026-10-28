// Fake tf-hostd for working on the bridge against a real omp (README "Verifying").
//
//   bun host/teleflock-bridge/probe.ts <dir> [--out <frames.jsonl>] [--subscribe]
//
// Listens on <dir>/bridge.sock with a fresh <dir>/bridge.secret (start omp with
// `TF_BRIDGE_SOCK=<dir>/bridge.sock … -e host/teleflock-bridge/teleflock-bridge.ts`), authenticates
// each connection as hostd does, prints one summary line per frame and appends every frame the
// extension sends, verbatim, to --out. `--subscribe` sends `liveSubscribe` after each hello.
//
// stdin, one command per line:
//   <op> [<json params>]   a request, e.g. `prompt {"text":"hi"}`; its res is printed
//   answer <value>         uiResponse for the oldest pending ui-request (`answer` alone cancels)
//   pause | resume         stop / restart reading the socket (backpressure, overflow)
//   {…}                    any raw frame
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith("--"));
if (!dir) {
	console.error("usage: bun host/teleflock-bridge/probe.ts <dir> [--out <frames.jsonl>] [--subscribe]");
	process.exit(2);
}
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const subscribe = args.includes("--subscribe");

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const sockPath = path.join(dir, "bridge.sock");
const secret = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(path.join(dir, "bridge.secret"), secret, { mode: 0o600 });
fs.rmSync(sockPath, { force: true });

let conn: net.Socket | undefined;
let nextId = 0;
const pending = new Map<number, Json>(); // ui-requests hostd has not seen end
const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(3).padStart(8)}s`;
const say = (line: string) => console.log(`${stamp()} ${line}`);
const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s);

const sendFrame = (frame: Json): void => {
	if (!conn) return say("! not connected");
	conn.write(`${JSON.stringify(frame)}\n`);
};

/** One line per frame: enough to follow a session, the full frame goes to --out. */
function summarize(f: Json, bytes: number): string {
	const t = String(f.t);
	if (t === "hello") return `< hello ${f.reason} ${f.sessionId} bridge ${f.bridgeVersion} caps ${JSON.stringify(f.caps ?? null)}`;
	if (t === "res") return `< res ${f.id} ${f.ok ? "ok" : "ERR"} ${clip(JSON.stringify(f.ok ? f.result : f.error))}`;
	if (t === "event") return `< event ${f.event} ${clip(JSON.stringify(f.data), 80)}`;
	if (t === "resync") {
		const live = (f.live ?? {}) as { streaming?: boolean; frames?: Json[] };
		const kinds = (live.frames ?? []).map(x => (x.t === "event" ? (x.event as Json).type : x.t === "bus" ? `bus:${String(x.channel).split(":").pop()}` : x.t));
		return `< #${f.seq} resync session ${f.sessionId} lastEntryId ${f.lastEntryId} streaming ${live.streaming} [${kinds.join(", ")}] (${bytes} B)`;
	}
	if (t === "live") {
		const g = (f.f ?? {}) as Json;
		let what = String(g.t);
		if (g.t === "event") {
			const e = g.event as Json;
			what = `event ${e.type}${e.toolName ? ` ${e.toolName}` : ""}${e.type === "notice" ? ` "${clip(String(e.message), 60)}"` : ""}`;
		} else if (g.t === "bus") {
			const d = g.data as Json;
			const id = g.channel === "task:subagent:lifecycle" ? `${d.id} ${d.status}` : `${(d.progress as Json | undefined)?.id} ${(d.progress as Json | undefined)?.status}`;
			what = `bus ${String(g.channel).split(":").pop()} ${id}`;
		} else if (g.t === "ui-request") {
			const r = g.request as Json;
			what = `ui-request ${r.reqId} ${r.kind} ${JSON.stringify(clip(String(r.title), 60))}${Array.isArray(r.options) ? ` [${r.options.map(o => (typeof o === "string" ? o : (o as Json).label)).join(" | ")}]` : ""}`;
		} else if (g.t === "ui-request-end") what = `ui-request-end ${g.reqId}`;
		else if (g.t === "agents") what = `agents [${(g.agents as Json[]).map(a => `${a.id}:${a.status}`).join(", ")}]`;
		else if (g.t === "state") {
			const s = g.state as Json;
			what = `state streaming=${s.isStreaming} queued=${s.queuedMessageCount}`;
		}
		return `< #${f.seq} ${what} (${bytes} B)`;
	}
	return `< ${clip(JSON.stringify(f))}`;
}

function track(f: Json): void {
	const frames: Json[] = f.t === "live" ? [f.f as Json] : f.t === "resync" ? (((f.live as Json | undefined)?.frames as Json[] | undefined) ?? []) : [];
	if (f.t === "resync") pending.clear();
	for (const g of frames) {
		if (g.t === "ui-request") pending.set(Number((g.request as Json).reqId), g.request as Json);
		if (g.t === "ui-request-end") pending.delete(Number(g.reqId));
	}
}

const server = net.createServer(socket => {
	conn?.destroy();
	conn = socket;
	say("connected");
	socket.setEncoding("utf8");
	let buf = "";
	socket.on("data", (chunk: string) => {
		buf += chunk;
		let i = buf.indexOf("\n");
		while (i >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
			if (!line.trim()) continue;
			if (out) fs.appendFileSync(out, `${line}\n`);
			let f: Json;
			try {
				f = JSON.parse(line) as Json;
			} catch {
				say(`< (not json) ${clip(line)}`);
				continue;
			}
			track(f);
			say(summarize(f, Buffer.byteLength(line)));
			if (f.t === "hello") {
				sendFrame({ t: "welcome", v: 1, hostd: "probe" });
				if (subscribe) sendFrame({ t: "req", id: ++nextId, op: "liveSubscribe", params: {} });
			}
		}
	});
	socket.on("close", () => {
		if (conn === socket) conn = undefined;
		say("disconnected");
	});
	socket.on("error", err => say(`! ${String(err)}`));
	socket.write(`${JSON.stringify({ t: "auth", v: 1, secret })}\n`);
});
server.listen(sockPath, () => say(`listening on ${sockPath}${out ? `, frames → ${out}` : ""}`));

readline.createInterface({ input: process.stdin }).on("line", raw => {
	const line = raw.trim();
	if (!line) return;
	if (line.startsWith("{")) {
		try {
			sendFrame(JSON.parse(line) as Json);
		} catch (err) {
			say(`! ${String(err)}`);
		}
		return;
	}
	const [cmd, ...rest] = line.split(" ");
	const tail = rest.join(" ").trim();
	if (cmd === "pause" || cmd === "resume") {
		if (cmd === "pause") conn?.pause();
		else conn?.resume();
		return say(`${cmd}d reading`);
	}
	if (cmd === "answer") {
		const reqId = [...pending.keys()].sort((a, b) => a - b)[0];
		if (reqId === undefined) return say("! no pending ui-request");
		return sendFrame({ t: "req", id: ++nextId, op: "uiResponse", params: { reqId, value: tail || null } });
	}
	let params: Json = {};
	if (tail) {
		try {
			params = JSON.parse(tail) as Json;
		} catch (err) {
			return say(`! params: ${String(err)}`);
		}
	}
	sendFrame({ t: "req", id: ++nextId, op: cmd, params });
	say(`> req ${nextId} ${cmd} ${clip(tail, 80)}`);
});
