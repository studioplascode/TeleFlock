/**
 * TeleFlock PoC collab guest (bun + WebCrypto). Joins an omp collab room as a
 * full-control guest, decrypts every frame, and exposes a tiny local control API.
 *
 *   bun .research/poc/guest.ts --link '<collab link or http(s) deep link>' [--out frames.jsonl]
 *   bun .research/poc/guest.ts --instance <instanceId|pid>   # resolves via `omp collab list/link --json`
 *                              [--relay-override ws://127.0.0.1:7466] [--name teleflock] [--control 7467]
 *
 * Control API (127.0.0.1:<control>):
 *   POST /send        body = a guest frame JSON ({"t":"prompt","text":"hi"} …); returns {sentAt}
 *   GET  /state       latest state/welcome summary + pending ui-requests
 *   GET  /frames?since=<seq>   decrypted frames received so far (array)
 * Every decrypted frame is appended to --out as {seq, recvAt, dir, bytes, frame}.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const COLLAB_PROTO = 3;
const ENVELOPE_HEADER_LENGTH = 4;
const IV_LENGTH = 12;
const ROOM_KEY_BYTES = 32;
const WRITE_TOKEN_BYTES = 16;

function arg(name: string): string | undefined {
	const argv = Bun.argv.slice(2);
	const i = argv.indexOf(`--${name}`);
	if (i >= 0) return argv[i + 1];
	const eq = argv.find(a => a.startsWith(`--${name}=`));
	return eq?.slice(name.length + 3);
}

// ── link parsing (subset of protocol.ts parseCollabLink, enough for our relay) ──
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;

export interface ParsedLink {
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	writeToken?: Uint8Array;
}

export function parseLink(link: string): ParsedLink {
	let text = link.trim().replace(/%23/gi, "#");
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `wss://my.omp.sh/r/${bare[1]}.${bare[2]}`;
	else if (!text.includes("://")) text = `wss://${text}`;
	const url = new URL(text);
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash.length > 1) {
		try {
			return parseLink(url.hash.slice(1));
		} catch {
			/* fall through to direct relay form */
		}
	}
	const scheme = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
	const m = ROOM_PATH_RE.exec(url.pathname);
	if (!m) throw new Error(`not a collab link: ${link}`);
	const secret = new Uint8Array(Buffer.from(m[2] ?? url.hash.slice(1), "base64url"));
	if (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES) {
		throw new Error("key must be 32 (view) or 48 (full) bytes");
	}
	return {
		wsUrl: `${scheme}//${url.host}/r/${m[1]}`,
		roomId: m[1]!,
		key: secret.subarray(0, ROOM_KEY_BYTES),
		writeToken: secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined,
	};
}

// ── crypto: [12B random IV][AES-256-GCM ciphertext ‖ 16B tag], no AAD ──
async function seal(key: CryptoKey, frame: unknown): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(frame))),
	);
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + IV_LENGTH + ct.byteLength);
	// envelope peerId stays 0 for guests; the relay rewrites it to our id
	out.set(iv, ENVELOPE_HEADER_LENGTH);
	out.set(ct, ENVELOPE_HEADER_LENGTH + IV_LENGTH);
	return out;
}
async function open(key: CryptoKey, envelope: Uint8Array): Promise<unknown> {
	const sealed = envelope.subarray(ENVELOPE_HEADER_LENGTH);
	const iv = sealed.slice(0, IV_LENGTH);
	const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed.slice(IV_LENGTH));
	return JSON.parse(new TextDecoder().decode(pt));
}

// ── link resolution through the local registry CLI ──
async function resolveInstance(selector: string, view: boolean): Promise<string> {
	const cmd = ["omp", "collab", "link", selector, "--json", ...(view ? ["--view"] : [])];
	const proc = Bun.spawnSync(cmd);
	if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${proc.stderr.toString()}`);
	const out = JSON.parse(proc.stdout.toString()) as { url: string; generation: number };
	console.error(`[guest] resolved ${selector} generation=${out.generation}`);
	return out.url;
}

const linkArg = arg("link");
const instance = arg("instance");
const outPath = arg("out") ?? "/tmp/tf-guest-frames.jsonl";
const name = arg("name") ?? "teleflock";
const controlPort = Number(arg("control") ?? "7467");
const link = linkArg ?? (instance ? await resolveInstance(instance, Bun.argv.includes("--view")) : undefined);
if (!link) throw new Error("--link or --instance required");
const parsed = parseLink(link);
const relayOverride = arg("relay-override");
const wsUrl = relayOverride ? `${relayOverride.replace(/\/$/, "")}/r/${parsed.roomId}` : parsed.wsUrl;
const key = await crypto.subtle.importKey("raw", parsed.key, "AES-GCM", false, ["encrypt", "decrypt"]);
const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;

writeFileSync(outPath, "");
interface Logged {
	seq: number;
	recvAt: number;
	dir: "h2g" | "g2h" | "ctl";
	bytes: number;
	decryptMs?: number;
	frame: unknown;
}
const frames: Logged[] = [];
let seq = 0;
const record = (entry: Omit<Logged, "seq">): void => {
	const logged = { seq: ++seq, ...entry };
	frames.push(logged);
	appendFileSync(outPath, `${JSON.stringify(logged)}\n`);
};
let lastState: unknown = null;
let welcome: unknown = null;
const pendingUi = new Map<number, unknown>();
const transcriptWaiters = new Map<number, (recvAt: number) => void>();

let ws: WebSocket;
let recvChain: Promise<void> = Promise.resolve();
const sendFrame = async (frame: Record<string, unknown>): Promise<number> => {
	const env = await seal(key, frame);
	const sentAt = Date.now();
	ws.send(env);
	record({ recvAt: sentAt, dir: "g2h", bytes: env.byteLength, frame });
	return sentAt;
};

function connect(attempt = 0): void {
	ws = new WebSocket(`${wsUrl}?role=guest`);
	ws.binaryType = "arraybuffer";
	ws.onopen = () => {
		console.error(`[guest] open ${wsUrl}`);
		void sendFrame({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	};
	ws.onmessage = ev => {
		const recvAt = Date.now();
		if (typeof ev.data === "string") {
			record({ recvAt, dir: "ctl", bytes: ev.data.length, frame: JSON.parse(ev.data) });
			return;
		}
		const bytes = new Uint8Array(ev.data as ArrayBuffer);
		recvChain = recvChain.then(async () => {
			const t0 = performance.now();
			let frame: Record<string, unknown>;
			try {
				frame = (await open(key, bytes)) as Record<string, unknown>;
			} catch (err) {
				console.error("[guest] decrypt failed (bad key) — fatal per protocol", err);
				process.exit(2);
			}
			const decryptMs = performance.now() - t0;
			record({ recvAt, dir: "h2g", bytes: bytes.byteLength, decryptMs, frame });
			switch (frame.t) {
				case "welcome":
					welcome = frame;
					lastState = frame.state;
					break;
				case "state":
					lastState = frame.state;
					break;
				case "ui-request": {
					const req = frame.request;
					if (req && typeof req === "object" && "reqId" in req && typeof req.reqId === "number") {
						pendingUi.set(req.reqId, req);
					}
					break;
				}
				case "ui-request-end":
					if (typeof frame.reqId === "number") pendingUi.delete(frame.reqId);
					break;
				case "transcript": {
					const reqId = frame.reqId;
					if (typeof reqId === "number") transcriptWaiters.get(reqId)?.(recvAt);
					break;
				}
				case "bye":
					console.error(`[guest] bye: ${frame.reason}`);
					break;
				case "error":
					console.error(`[guest] host error: ${frame.message}`);
					break;
			}
		});
	};
	ws.onclose = ev => {
		console.error(`[guest] close code=${ev.code} reason=${ev.reason}`);
		record({ recvAt: Date.now(), dir: "ctl", bytes: 0, frame: { t: "ws-close", code: ev.code, reason: ev.reason } });
		// 4001 room closed: the host may recreate the room (same roomId) — retry like omp's guest.
		if (ev.code === 4001 || ev.code === 1006 || ev.code === 4004) {
			const delay = Math.min(1000 * 2 ** attempt, 30_000);
			setTimeout(() => connect(attempt + 1), delay);
		}
	};
}
connect();

Bun.serve({
	port: controlPort,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/send") {
			const frame = (await req.json()) as Record<string, unknown>;
			const sentAt = await sendFrame(frame);
			return Response.json({ sentAt, seq });
		}
		if (url.pathname === "/state") {
			const w = welcome as { header?: unknown; entryCount?: number; readOnly?: boolean } | null;
			return Response.json({
				header: w?.header,
				entryCount: w?.entryCount,
				readOnly: w?.readOnly ?? false,
				state: lastState,
				pendingUi: [...pendingUi.values()],
				frames: seq,
			});
		}
		if (url.pathname === "/rtt") {
			// Pure round trip: guest seal → relay → host (fetch-transcript for an unknown agent
			// is answered immediately with an error frame) → relay → guest open.
			const n = Number(url.searchParams.get("n") ?? "20");
			const samples: number[] = [];
			for (let i = 0; i < n; i++) {
				const reqId = 1_000_000 + seq + i;
				const done = Promise.withResolvers<number>();
				transcriptWaiters.set(reqId, done.resolve);
				const t0 = performance.now();
				await sendFrame({ t: "fetch-transcript", reqId, agentId: "__rtt_probe__", fromByte: 0 });
				await done.promise;
				samples.push(performance.now() - t0);
				transcriptWaiters.delete(reqId);
			}
			samples.sort((a, b) => a - b);
			return Response.json({
				n,
				minMs: samples[0],
				p50Ms: samples[Math.floor(n / 2)],
				p95Ms: samples[Math.floor(n * 0.95)],
				maxMs: samples.at(-1),
			});
		}
		if (url.pathname === "/frames") {
			const since = Number(url.searchParams.get("since") ?? "0");
			return Response.json(frames.filter(f => f.seq > since));
		}
		return new Response("not found", { status: 404 });
	},
});
console.error(`[guest] control api on http://127.0.0.1:${controlPort}, frames → ${outPath}`);
