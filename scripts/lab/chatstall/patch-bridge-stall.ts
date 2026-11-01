#!/usr/bin/env bun
/**
 * Writes a lab-only COPY of the TeleFlock bridge with a stuck-writer fault (never edits the bridge
 * itself). Once per omp process, in a turn whose prompt holds CHATSTALL-LAB, after the Nth live
 * `message_update` frame whose `assistantMessageEvent.type` starts with `toolcall` was written,
 * that connection's LiveWriter stops:
 *   --mode all   (fault 4a)  no frame at all goes out any more: live and control frames stay queued
 *                            in the writer (as behind a socket that stopped draining), the socket
 *                            stays open; a later connection (hostd reconnecting) writes normally.
 *   --mode live  (fault 4b2) no `live` frame goes out on that connection; control frames (`res`,
 *                            `event` state, `hello`) and `resync` frames still do.
 * The copy logs to <lab>/logs/chatstall-bridge-fault.log (next to the lab's TF_HOSTD_HOME, found
 * from where the copy is deployed).
 *
 * Usage: bun scripts/lab/chatstall/patch-bridge-stall.ts [--mode all|live] [--after N] [--src BRIDGE] <out.ts>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
let mode = "all";
let after = 1;
let src = resolve(import.meta.dir, "../../../host/teleflock-bridge/teleflock-bridge.ts");
let out = "";
for (let i = 0; i < args.length; i++) {
	const a = args[i]!;
	if (a === "--mode") mode = args[++i] ?? "";
	else if (a === "--after") after = Number(args[++i]);
	else if (a === "--src") src = resolve(args[++i] ?? "");
	else if (!a.startsWith("--") && !out) out = resolve(a);
	else throw new Error(`unknown argument ${a}`);
}
if (!out || (mode !== "all" && mode !== "live") || !Number.isInteger(after) || after < 1) {
	console.error("usage: bun patch-bridge-stall.ts [--mode all|live] [--after N] [--src BRIDGE] <out.ts>");
	process.exit(64);
}

let code = readFileSync(src, "utf8");

/** Replaces the one occurrence of `find` (fails when it is missing or ambiguous). */
function patch(what: string, find: string, replace: string): void {
	const at = code.indexOf(find);
	if (at < 0) throw new Error(`patch "${what}": anchor not found in ${src}`);
	if (code.indexOf(find, at + 1) >= 0) throw new Error(`patch "${what}": anchor is not unique in ${src}`);
	code = code.slice(0, at) + replace + code.slice(at + find.length);
}

patch(
	"fault state",
	"export class LiveWriter {",
	`// ── ChatStall lab fault: a lab-only copy written by scripts/lab/chatstall/patch-bridge-stall.ts ──
const CHATSTALL_FAULT = { mode: ${JSON.stringify(mode)} as "all" | "live", after: ${after} };
/** Once per omp process (every copy of the bridge in it shares this). */
const chatStall = ((globalThis as Record<string, unknown>).__tfChatStall ??= { armed: false, fired: false, frames: 0 }) as {
	armed: boolean;
	fired: boolean;
	frames: number;
};
function chatStallLog(msg: string): void {
	try {
		const log = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "logs", "chatstall-bridge-fault.log");
		fs.appendFileSync(log, \`\${new Date().toISOString()} pid=\${process.pid} \${msg}\\n\`);
	} catch {}
}

export class LiveWriter {`,
);

patch(
	"writer fields",
	"	/** seq of the last live/resync frame written on this connection (0 = none yet). */\n	seq = 0;\n",
	`	/** seq of the last live/resync frame written on this connection (0 = none yet). */
	seq = 0;
	/** ChatStall lab fault: this connection's writer is stuck (see CHATSTALL_FAULT). */
	chatStalled = false;
	chatHeld = 0;
	chatNoted = 0;
`,
);

patch(
	"room (mode all: nothing is written)",
	"	#room(): boolean {\n		return this.sink.backlog() <= this.#highWater;\n	}",
	`	#room(): boolean {
		if (this.chatStalled && CHATSTALL_FAULT.mode === "all") {
			if (Date.now() - this.chatNoted >= 5_000) {
				this.chatNoted = Date.now();
				chatStallLog(\`stuck writer holds \${this.pending} queued frames (seq \${this.seq})\`);
			}
			return false;
		}
		return this.sink.backlog() <= this.#highWater;
	}`,
);

patch(
	"writeLive (mode live: no live frame; the trigger)",
	'	#writeLive(json: string): void {\n		this.seq++;\n		this.sink.write(`{"t":"live","seq":${this.seq},"f":${json}}\\n`);\n	}',
	`	#writeLive(json: string): void {
		if (this.chatStalled && CHATSTALL_FAULT.mode === "live") {
			if (this.chatHeld++ % 50 === 0) chatStallLog(\`live frame not written (\${this.chatHeld} so far, seq \${this.seq})\`);
			return;
		}
		this.seq++;
		this.sink.write(\`{"t":"live","seq":\${this.seq},"f":\${json}}\\n\`);
		this.#chatStallSeen(json);
	}

	/** Arms on the CHATSTALL-LAB prompt's live message_start, fires after the Nth live toolcall update. */
	#chatStallSeen(json: string): void {
		if (chatStall.fired) return;
		if (!chatStall.armed) {
			if (json.includes('"type":"message_start"') && json.includes('"role":"user"') && json.includes("CHATSTALL-LAB")) {
				chatStall.armed = true;
				chatStallLog(\`armed by the CHATSTALL-LAB prompt (seq \${this.seq}); fires after live toolcall update #\${CHATSTALL_FAULT.after}, mode \${CHATSTALL_FAULT.mode}\`);
			}
			return;
		}
		if (!json.includes('"type":"message_update"') || !/"assistantMessageEvent":\\{"type":"toolcall/.test(json)) return;
		if (++chatStall.frames < CHATSTALL_FAULT.after) return;
		chatStall.fired = true;
		this.chatStalled = true;
		chatStallLog(\`STALLED (mode \${CHATSTALL_FAULT.mode}) after live toolcall update #\${chatStall.frames} at seq \${this.seq}: \${json.slice(0, 240)}…\`);
	}`,
);

// The copy must still be valid TypeScript.
new Bun.Transpiler({ loader: "ts" }).transformSync(code);
for (const marker of ["CHATSTALL_FAULT", "#chatStallSeen(json);", "chatStalled && CHATSTALL_FAULT.mode === \"all\"", "chatStalled && CHATSTALL_FAULT.mode === \"live\""]) {
	if (!code.includes(marker)) throw new Error(`patched copy lacks ${marker}`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, code);
const version = /BRIDGE_VERSION = "([^"]+)"/.exec(code)?.[1] ?? "?";
console.log(`wrote ${out}: bridge ${version} from ${src}, 4 patches applied and verified; fault mode ${mode}, fires after live toolcall update #${after}; log <lab>/logs/chatstall-bridge-fault.log`);
