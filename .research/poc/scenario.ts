/**
 * Drive one capture scenario through the running PoC guest (guest.ts control API)
 * and save the decrypted frame slice as a golden sample, alongside a herdr state
 * timeline for the lab agent and latency numbers.
 *
 *   bun .research/poc/scenario.ts <name> '<guest frame JSON>' [--timeout 120] [--settle 1500]
 *       [--abort-after-ms N]     send {"t":"abort"} N ms after the first assistant message_update
 *       [--answer '<json>']      on the first ui-request, reply {"t":"ui-response","reqId",…<json>}
 *       [--no-send]              only watch (e.g. a prompt injected into the TUI through herdr)
 *
 * Output: docs/research/omp-collab-samples/<name>.jsonl (frames) and <name>.summary.json.
 * Environment: TF_GUEST=http://127.0.0.1:7467, TF_AGENT=collabhost.
 */
import { writeFileSync } from "node:fs";

const GUEST = process.env.TF_GUEST ?? "http://127.0.0.1:7467";
const AGENT = process.env.TF_AGENT ?? "collabhost";
const OUT = new URL("../../docs/research/omp-collab-samples/", import.meta.url).pathname;
const HL = new URL("./hl", import.meta.url).pathname;

/** Loose view of a decrypted frame: only the fields this driver reads. */
interface Frame {
	t: string;
	event?: { type: string; message?: { role?: string } };
	state?: { isStreaming: boolean };
	request?: { reqId: number; options?: (string | { label: string })[] };
}
interface Logged {
	seq: number;
	recvAt: number;
	dir: string;
	bytes: number;
	decryptMs?: number;
	frame: Frame;
}
interface GuestState {
	frames: number;
	state: { isStreaming: boolean } | null;
}

/** Our own guest.ts control API is the only producer of these bodies. */
async function getJson<T>(path: string, body?: string): Promise<T> {
	const res = await fetch(`${GUEST}${path}`, body === undefined ? undefined : { method: "POST", body });
	const json: T = await res.json();
	return json;
}

const argv = Bun.argv.slice(2);
const opt = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const [name, frameJson] = argv;
if (!name) throw new Error("usage: scenario.ts <name> '<frame json>' …");
const timeoutMs = Number(opt("timeout") ?? "120") * 1000;
const settleMs = Number(opt("settle") ?? "1500");
const abortAfter = opt("abort-after-ms");
const answer = opt("answer");
const answerDelayMs = Number(opt("answer-delay-ms") ?? "0");
const noSend = argv.includes("--no-send");

const herdrTimeline: { at: number; status: string }[] = [];
let herdrPolling = true;
const pollHerdr = async (): Promise<void> => {
	while (herdrPolling) {
		const proc = Bun.spawn([HL, "agent", "get", AGENT], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		try {
			const status: string = JSON.parse(text).result.agent.agent_status;
			if (herdrTimeline.at(-1)?.status !== status) herdrTimeline.push({ at: Date.now(), status });
		} catch {
			/* transient */
		}
		await Bun.sleep(150);
	}
};

const startSeq = (await getJson<GuestState>("/state")).frames;
void pollHerdr();
const t0 = Date.now();
let sentAt = t0;
if (!noSend && frameJson) sentAt = (await getJson<{ sentAt: number }>("/send", frameJson)).sentAt;

let sawStreaming = false;
let idleSince: number | undefined;
let abortSent = false;
let answered = false;
const marks: Record<string, number> = {};
let frames: Logged[] = [];
while (Date.now() - t0 < timeoutMs) {
	frames = await getJson<Logged[]>(`/frames?since=${startSeq}`);
	for (const f of frames) {
		if (f.dir !== "h2g") continue;
		const fr = f.frame;
		marks.firstFrame ??= f.recvAt;
		if (fr.event) {
			marks[`first_${fr.event.type}`] ??= f.recvAt;
			if (fr.event.type === "message_update" && fr.event.message?.role === "assistant") {
				marks.firstAssistantUpdate ??= f.recvAt;
			}
		} else {
			marks[`first_${fr.t}`] ??= f.recvAt;
		}
		if (fr.state?.isStreaming) sawStreaming = true;
		if (fr.t === "ui-request" && fr.request && answer && !answered && Date.now() - f.recvAt >= answerDelayMs) {
			answered = true;
			// --answer '{"value":"Blue"}' sends verbatim; '{"match":"^Approve"}' picks the first matching option label.
			const spec: { value?: string; match?: string } = JSON.parse(answer);
			const options = fr.request.options ?? [];
			const match = spec.match ? new RegExp(spec.match) : undefined;
			const picked = match
				? options.map(o => (typeof o === "string" ? o : o.label)).find(l => match.test(l))
				: spec.value;
			const body = JSON.stringify({ t: "ui-response", reqId: fr.request.reqId, value: picked });
			marks.uiResponseSentAt = (await getJson<{ sentAt: number }>("/send", body)).sentAt;
		}
	}
	if (abortAfter && !abortSent && marks.firstAssistantUpdate && Date.now() - marks.firstAssistantUpdate >= Number(abortAfter)) {
		abortSent = true;
		marks.abortSentAt = (await getJson<{ sentAt: number }>("/send", '{"t":"abort"}')).sentAt;
	}
	const ended = frames.some(f => f.dir === "h2g" && f.frame.event?.type === "agent_end");
	const st = (await getJson<GuestState>("/state")).state;
	if ((ended || sawStreaming) && !st?.isStreaming) {
		idleSince ??= Date.now();
		if (Date.now() - idleSince >= settleMs) break;
	} else idleSince = undefined;
	await Bun.sleep(100);
}
herdrPolling = false;

writeFileSync(`${OUT}${name}.jsonl`, `${frames.map(f => JSON.stringify(f)).join("\n")}\n`);
const counts: Record<string, number> = {};
let bytes = 0;
for (const f of frames) {
	const key = f.frame.event ? `event:${f.frame.event.type}` : `${f.dir}:${f.frame.t}`;
	counts[key] = (counts[key] ?? 0) + 1;
	if (f.dir === "h2g") bytes += f.bytes;
}
const decrypt = frames.flatMap(f => (f.decryptMs === undefined ? [] : [f.decryptMs]));
const summary = {
	name,
	sent: noSend || !frameJson ? null : JSON.parse(frameJson),
	sentAt,
	latencyMsFromSend: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v - sentAt])),
	frameCounts: counts,
	h2gBytes: bytes,
	decryptMs: decrypt.length
		? { n: decrypt.length, max: Math.max(...decrypt), avg: decrypt.reduce((a, b) => a + b, 0) / decrypt.length }
		: null,
	herdrTimeline: herdrTimeline.map(h => ({ tMs: h.at - sentAt, status: h.status })),
};
writeFileSync(`${OUT}${name}.summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
