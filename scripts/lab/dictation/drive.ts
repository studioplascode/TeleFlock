#!/usr/bin/env bun
/**
 * Dictation lab driver: does over the lab devserver's /ws what the app does (`{id, hostId?, method, params}` →
 * `{id, result | error}`, `{event}` frames for `AppEvent::Dictation` / `DictationSession`) and checks the results.
 * Run it after setup.sh, outside the lab (it only talks to 127.0.0.1 and reads the lab's files):
 *
 *   bun scripts/lab/dictation/drive.ts <lab> [--no-download]
 *
 * 1. `dictation.models`: the engine is built in, Parakeet and Canary are installed (setup's --install),
 *    Parakeet is chosen; `dictation.microphones` lists the fake microphone.
 * 2. Sessions with Parakeet (language `auto`), then Canary (`auto` with the file's locale, then the file's
 *    language chosen), one per fake-microphone file (`…-de.wav` is German, others English): `listening`
 *    first, partials while the file plays, finals, `end` last after `dictation.stop`. Word error rate
 *    against the file's .txt, and how long after the file's speech ends its last final arrives.
 * 3. No model chosen: `dictation.start` answers `no_model` and nothing listens.
 * 4. Download (without --no-download; from the lab's mirror, else Hugging Face): Canary deleted and downloaded
 *    again, progress as `dictation` events (at most ~4 a second, growing), cancelled at ~30 % (paused, bytes
 *    kept), resumed from those bytes (with a mirror: a range request in mirror.log), installed.
 * 5. Rambler: `ai.complete` task `ramble` (system prompt from src/core/ai.ts) with the English transcript, role
 *    tiny on host `lab`: the mock's lab-tiny answers with the tidied transcript.
 * Writes <logs>/drive.json (transcripts, timings, word error rates). Exit 0 when every check passed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const lab = args[0]?.startsWith("-") ? undefined : args[0];
if (!lab || args.includes("--help") || args.includes("-h")) {
	console.error("usage: bun scripts/lab/dictation/drive.ts <lab> [--no-download]");
	process.exit(64);
}
const download = !args.includes("--no-download");
const envFile = `/tmp/tf-lab-${lab}/lab.env`;
if (!existsSync(envFile)) {
	console.error(`drive: no ${envFile}; run scripts/lab/dictation/setup.sh ${lab} first`);
	process.exit(66);
}
const env = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split("\n")
		.filter(l => l.includes("="))
		.map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
const HOST = "lab";
const PARAKEET = "parakeet-tdt-0.6b-v3";
const CANARY = "canary-180m-flash";
const repo = join(import.meta.dir, "../../..");

// ─── wire ───────────────────────────────────────────────────────────────────────────────────────

const sock = new WebSocket(env.WS!);
const pending = new Map<number, PromiseWithResolvers<Json>>();
const sessions = new Map<string, (e: Json) => void>();
const stateWatchers = new Set<(s: Json) => void>();
let nextId = 1;
const opened = Promise.withResolvers<void>();
sock.onopen = () => opened.resolve();
sock.onerror = () => opened.reject(new Error(`cannot open ${env.WS}`));
await opened.promise;
sock.onmessage = m => {
	const msg = JSON.parse(String(m.data));
	if (msg.event) {
		const e = msg.event;
		if (e.type === "dictationSession") sessions.get(e.session)?.(e.event);
		else if (e.type === "dictation") for (const w of stateWatchers) w(e.state);
		return;
	}
	if (typeof msg.id !== "number") return;
	const p = pending.get(msg.id);
	pending.delete(msg.id);
	if (msg.error) p?.reject(Object.assign(new Error(`${msg.error.code}: ${msg.error.message}`), { code: msg.error.code, hint: msg.error.hint }));
	else p?.resolve(msg.result);
};
sock.onclose = () => {
	for (const p of pending.values()) p.reject(new Error("devserver closed the connection"));
};

/** An app method (`host` absent) or a host method. */
async function call(method: string, params: Json, timeoutMs = 30_000, host?: string): Promise<Json> {
	const id = nextId++;
	const answer = Promise.withResolvers<Json>();
	pending.set(id, answer);
	const timer = setTimeout(() => {
		pending.delete(id);
		answer.reject(new Error(`${method}: no answer within ${timeoutMs / 1000}s`));
	}, timeoutMs);
	sock.send(JSON.stringify(host ? { id, hostId: host, method, params } : { id, method, params }));
	try {
		return await answer.promise;
	} finally {
		clearTimeout(timer);
	}
}

const t0 = Date.now();
const say = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
	if (!ok) failed++;
};
const report: Json = { lab, sessions: [] as Json[] };

// ─── audio and text ─────────────────────────────────────────────────────────────────────────────

/** Seconds of audio in a PCM WAV file. */
function wavSeconds(path: string): number {
	const b = readFileSync(path);
	let byteRate = 0;
	for (let i = 12; i + 8 <= b.length; ) {
		const id = b.toString("ascii", i, i + 4);
		const size = b.readUInt32LE(i + 4);
		if (id === "fmt ") byteRate = b.readUInt32LE(i + 16);
		if (id === "data") return size / byteRate;
		i += 8 + size + (size & 1);
	}
	throw new Error(`${path}: no data chunk`);
}

const words = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}' ]+/gu, " ")
		.split(/\s+/)
		.filter(Boolean);

/** Word error rate of `hyp` against `ref` (word-level edit distance over the reference's words). */
function wer(ref: string, hyp: string): number {
	const r = words(ref);
	const h = words(hyp);
	let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
	for (let i = 1; i <= r.length; i++) {
		const cur = [i];
		for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[h.length]! / Math.max(1, r.length);
}

const micFiles = env.MIC!.split(":");
const devLog = join(env.LOGS!, "devserver.log");
const plays = () => [...readFileSync(devLog, "utf8").matchAll(/fake microphone plays (\S+) \(/g)].map(m => m[1]!);

async function until<T>(what: string, secs: number, probe: () => Promise<T | undefined> | T | undefined, everyMs = 250): Promise<T> {
	let last = "";
	for (const end = Date.now() + secs * 1000; Date.now() < end; await Bun.sleep(everyMs)) {
		try {
			const v = await probe();
			if (v !== undefined) return v;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
	}
	throw new Error(`${what} within ${secs}s${last ? ` (last error: ${last})` : ""}`);
}

// ─── sessions ───────────────────────────────────────────────────────────────────────────────────

/** One dictation session over the next fake-microphone file; checks its event sequence and scores it. */
async function dictate(model: string, language: string): Promise<Json> {
	const file = micFiles[plays().length % micFiles.length]!;
	const lang = /-de\b|_de\b|\bde-/.test(file.split("/").pop()!) ? "de" : "en";
	const locale = lang === "de" ? "de-DE" : "en-US";
	const ref = readFileSync(file.replace(/\.wav$/, ".txt"), "utf8").trim();
	const secs = wavSeconds(file);
	const id = crypto.randomUUID();
	const events: { at: number; e: Json }[] = [];
	const ended = Promise.withResolvers<void>();
	const start = performance.now();
	sessions.set(id, e => {
		events.push({ at: (performance.now() - start) / 1000, e });
		if (e.type === "end") ended.resolve();
	});
	const label = `${model} (${language}) on ${file.split("/").pop()}`;
	say(`dictating: ${label}, ${secs.toFixed(1)} s of speech`);
	await call("dictation.start", { session: id, locale }, 60_000);
	const heard = await until("the fake microphone plays", 10, () => plays().length > 0 && plays().at(-1) === file ? true : undefined).catch(() => false);
	check(`${label}: the fake microphone plays the expected file`, heard === true, plays().at(-1) ?? "nothing played");
	// The file plays in real time from the capture's start; then silence ends its last utterance.
	await Bun.sleep(secs * 1000 + 3500);
	const stopAt = (performance.now() - start) / 1000;
	await call("dictation.stop", { session: id });
	await Promise.race([ended.promise, Bun.sleep(20_000).then(() => { throw new Error(`${label}: no end within 20 s of dictation.stop`); })]);
	sessions.delete(id);

	const kinds = events.map(x => x.e.type);
	const partials = events.filter(x => x.e.type === "partial");
	const finals = events.filter(x => x.e.type === "final");
	const errors = events.filter(x => x.e.type === "error");
	const text = finals.map(x => x.e.text).join(" ");
	const score = wer(ref, text);
	const lastFinal = finals.at(-1)?.at ?? NaN;
	check(`${label}: listening first, end last, once each`, kinds[0] === "listening" && kinds.at(-1) === "end" && kinds.filter(k => k === "end").length === 1 && kinds.filter(k => k === "listening").length === 1, kinds.join(","));
	check(`${label}: no error`, errors.length === 0, errors.map(x => `${x.e.code}: ${x.e.message}`).join("; "));
	check(`${label}: partials while speaking`, partials.length >= 3 && partials[0]!.at < secs, `${partials.length} partials, first at ${partials[0]?.at.toFixed(2)} s`);
	check(`${label}: several finals, in order, before the stop`, finals.length >= 2 && lastFinal < stopAt, `${finals.length} finals, last at ${lastFinal.toFixed(2)} s (speech ends at ${secs.toFixed(2)} s, stop at ${stopAt.toFixed(2)} s)`);
	check(`${label}: the last final arrives within 2.5 s of the end of speech`, lastFinal - secs <= 2.5, `${(lastFinal - secs).toFixed(2)} s`);
	check(`${label}: word error rate under 25 %`, score < 0.25, `${(score * 100).toFixed(1)} %`);
	say(`  heard: ${text}`);
	const out = { model, language, file: file.split("/").pop(), seconds: secs, reference: ref, transcript: text, wer: score, partials: partials.length, firstPartial: partials[0]?.at, finals: finals.map(x => ({ at: x.at, text: x.e.text })), lastFinalAfterSpeech: lastFinal - secs };
	report.sessions.push(out);
	return out;
}

// ─── 1. state ───────────────────────────────────────────────────────────────────────────────────

let state = await call("dictation.models", {});
const model = (s: Json, id: string) => s.models.find((m: Json) => m.id === id);
check("the engine is built in", state.supported === true, `${state.engine}, device ${state.device}`);
check("Parakeet and Canary are installed", model(state, PARAKEET)?.phase === "installed" && model(state, CANARY)?.phase === "installed", state.models.map((m: Json) => `${m.id}=${m.phase}`).join(" "));
check("Parakeet is chosen and recommended here", state.selected === PARAKEET && model(state, PARAKEET)?.recommended === true, `selected ${state.selected}`);
const mics = await call("dictation.microphones", {});
check("the fake microphone is listed (as the default)", mics.microphones.length === 1 && mics.microphones[0].default === true && mics.microphones[0].name.includes("session-"), JSON.stringify(mics.microphones));
await call("dictation.setLanguage", { language: "auto" });

// ─── 2. sessions ────────────────────────────────────────────────────────────────────────────────

const english: Json[] = [];
for (let i = 0; i < micFiles.length; i++) {
	const s = await dictate(PARAKEET, "auto");
	if (s.file.includes("-en")) english.push(s);
}
state = await call("dictation.select", { modelId: CANARY });
check("Canary chosen", state.selected === CANARY);
for (let i = 0; i < micFiles.length; i++) {
	// First `auto` (the session's locale decides), then the file's language chosen in Settings.
	const next = micFiles[plays().length % micFiles.length]!;
	const lang = /-de\b/.test(next) ? "de" : "en";
	const language = i === 0 ? "auto" : lang;
	await call("dictation.setLanguage", { language });
	await dictate(CANARY, language);
}
await call("dictation.setLanguage", { language: "auto" });

// ─── 3. no model ────────────────────────────────────────────────────────────────────────────────

await call("dictation.select", {});
const before = plays().length;
// `call` rejects with the core's code and hint on the Error (a timeout: a plain Error).
const refused = await call("dictation.start", { session: crypto.randomUUID() }).then(
	() => null,
	(e: unknown) => e as Error & { code?: string; hint?: string },
);
check("without a chosen model, dictation.start answers no_model", refused?.code === "no_model", refused ? `${refused.message}${refused.hint ? ` (hint: ${refused.hint})` : ""}` : "it started");
await Bun.sleep(500);
check("… and no microphone opened", plays().length === before);
state = await call("dictation.select", { modelId: PARAKEET });
check("Parakeet chosen again", state.selected === PARAKEET);

// ─── 4. download (from the lab's mirror, else Hugging Face) ─────────────────────────────────────

if (download) {
	const mirrorLog = join(env.LOGS!, "mirror.log");
	const mirrorLines = () => (env.MIRROR && existsSync(mirrorLog) ? readFileSync(mirrorLog, "utf8").split("\n") : []);
	state = await call("dictation.remove", { modelId: CANARY });
	const size: number = model(state, CANARY).size;
	check("Canary deleted", model(state, CANARY).phase === "available" && !existsSync(join(env.DATA!, "dictation/models", CANARY)));
	const seen: { at: number; phase: string; downloaded: number }[] = [];
	const t = performance.now();
	const watch = (s: Json) => {
		const m = model(s, CANARY);
		seen.push({ at: (performance.now() - t) / 1000, phase: m.phase, downloaded: m.downloaded ?? 0 });
	};
	stateWatchers.add(watch);
	const mirrorBefore = mirrorLines().length;
	await call("dictation.install", { modelId: CANARY });
	await until("30 % of Canary downloaded", 300, () => (seen.at(-1)?.downloaded ?? 0) >= size * 0.3 || undefined);
	state = await call("dictation.cancelInstall", { modelId: CANARY });
	const paused = await until("the download paused", 10, async () => {
		const m = model(await call("dictation.models", {}), CANARY);
		return m.phase === "available" ? m : undefined;
	});
	check("cancelled: paused with its bytes kept", (paused.downloaded ?? 0) >= size * 0.3, `${paused.downloaded} of ${size} bytes`);
	const resumedFrom = seen.length;
	await call("dictation.install", { modelId: CANARY });
	await until("Canary installed", 600, () => (seen.at(-1)?.phase === "installed" ? true : undefined));
	stateWatchers.delete(watch);
	const progress = seen.filter(x => x.phase === "downloading");
	const span = progress.length > 1 ? progress.at(-1)!.at - progress[0]!.at : 0;
	const rate = span > 0 ? (progress.length - 1) / span : 0;
	const drops = progress.filter((x, i) => i > 0 && x.downloaded < progress[i - 1]!.downloaded);
	check("progress came as dictation events, growing", progress.length >= 5 && drops.length === 0, `${progress.length} progress events over ${span.toFixed(1)} s${drops.length ? `, ${drops.length} went back` : ""}`);
	check("at most ~4 progress events a second", rate <= 4.5, `${rate.toFixed(2)} per second`);
	const firstResumed = seen.slice(resumedFrom).find(x => x.phase === "downloading");
	check("the resume went on from the bytes kept", (firstResumed?.downloaded ?? 0) >= (paused.downloaded ?? 0), `first progress after it: ${firstResumed?.downloaded} bytes`);
	const ranged = mirrorLines().slice(Math.max(0, mirrorBefore - 1)).filter(l => / from \d+ → 206/.test(l));
	if (env.MIRROR) check("… asking the mirror for the rest only (a range request)", ranged.length >= 1, ranged[0]?.replace(/^\S+ /, ""));
	state = await call("dictation.models", {});
	check("Canary installed again (sha256 checked by the core)", model(state, CANARY).phase === "installed" && state.selected === PARAKEET);
	report.download = { from: env.MIRROR || "Hugging Face", size, events: progress.length, seconds: span, perSecond: rate, ranged: ranged.map(l => l.replace(/^\S+ /, "")) };
}

// ─── 5. Rambler on the host ─────────────────────────────────────────────────────────────────────

const src = readFileSync(join(repo, "src/core/ai.ts"), "utf8");
const system = /^ {2}ramble:\n {4}"((?:[^"\\]|\\.)*)",$/m.exec(src)?.[1];
if (!system) {
	check("ramble system prompt found in src/core/ai.ts", false);
} else {
	const transcript = english[0]?.transcript ?? "um so add a retry to the uploader";
	const prompt = `<context>\nRepository: notes\n</context>\n\n<transcript>\n${transcript}\n</transcript>\n\nRewritten prompt for the whole transcript above:`;
	const t = performance.now();
	const r = await until("ai.complete (ramble) on host lab", 90, () => call("ai.complete", { task: "ramble", system: JSON.parse(`"${system}"`), prompt, role: "tiny", timeoutMs: 12_000 }, 30_000, HOST), 2000);
	check("Rambler: the host's tiny role (the mock's lab-tiny) rewrote the transcript", typeof r.text === "string" && r.text.startsWith("[lab-tiny]") && r.text.length > 40, `${Math.round(performance.now() - t)} ms: ${String(r.text).slice(0, 140)}`);
	report.ramble = { text: r.text, model: r.model, ms: r.ms };
}

writeFileSync(join(env.LOGS!, "drive.json"), `${JSON.stringify(report, null, 2)}\n`);
say(`report: ${join(env.LOGS!, "drive.json")}`);
sock.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
