#!/usr/bin/env bun
/**
 * Dictation lab: a local stand-in for Hugging Face's file URLs, for `TF_DICTATION_MIRROR` (debug builds of
 * tf-dictation download `<mirror>/<repo>/resolve/<commit>/<file>` from it). Serves
 * `GET /<owner>/<repo>/resolve/<commit>/<file>` from `<models dir>/<repo>/<file>` (sherpa-onnx's release
 * directories are named after the repository), honours `Range: bytes=N-` (206) the way Hugging Face does, and
 * sends at `MIRROR_RATE` MB/s (default 25) so the download progress in Settings → Dictation can be watched.
 * The commit is not checked: tf-dictation checks every file's sha256 itself.
 *
 * Usage: bun scripts/lab/dictation/mirror.ts <models dir> [port]   (default 18790; log: MIRROR_LOG or stdout)
 */
import { appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const [dir, portArg = "18790"] = process.argv.slice(2);
if (!dir || !existsSync(dir)) {
	console.error("usage: mirror.ts <models dir> [port]");
	process.exit(64);
}
const RATE = (Number(process.env.MIRROR_RATE) || 25) * 1024 * 1024;
const CHUNK = 256 * 1024;
const LOG = process.env.MIRROR_LOG;
const log = (line: string) => {
	const l = `${new Date().toISOString()} ${line}`;
	if (LOG) appendFileSync(LOG, `${l}\n`);
	else console.log(l);
};

/** The bytes of `path` from `from` on, at RATE; stops reading when the client goes away. */
function paced(path: string, from: number, size: number, tag: string): ReadableStream<Uint8Array> {
	const file = Bun.file(path);
	const t0 = performance.now();
	let pos = from;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (pos >= size) {
				log(`${tag} done (${size - from} bytes in ${Math.round(performance.now() - t0)} ms)`);
				controller.close();
				return;
			}
			const end = Math.min(size, pos + CHUNK);
			const bytes = new Uint8Array(await file.slice(pos, end).arrayBuffer());
			const due = ((end - from) / RATE) * 1000 - (performance.now() - t0);
			if (due > 0) await Bun.sleep(due);
			pos = end;
			controller.enqueue(bytes);
		},
		cancel() {
			log(`${tag} closed by the client at byte ${pos}`);
		},
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(portArg),
	idleTimeout: 120,
	fetch(req) {
		const path = decodeURIComponent(new URL(req.url).pathname);
		const m = /^\/[^/]+\/([^/]+)\/resolve\/[^/]+\/([^/]+)$/.exec(path);
		if (req.method !== "GET" || !m || m[1]!.startsWith(".") || m[2]!.startsWith(".")) {
			log(`${req.method} ${path} → 404`);
			return new Response("not found\n", { status: 404 });
		}
		const file = join(dir, m[1]!, m[2]!);
		if (!existsSync(file)) {
			log(`GET ${path} → 404 (no ${file})`);
			return new Response("not found\n", { status: 404 });
		}
		const size = statSync(file).size;
		const range = /^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "");
		const from = range ? Number(range[1]) : 0;
		if (from > size) return new Response("range not satisfiable\n", { status: 416, headers: { "content-range": `bytes */${size}` } });
		const tag = `GET ${m[1]}/${m[2]}${range ? ` from ${from}` : ""}`;
		log(`${tag} → ${range ? 206 : 200} (${size - from} bytes)`);
		const headers: Record<string, string> = { "content-length": String(size - from), "accept-ranges": "bytes", "content-type": "application/octet-stream" };
		if (range) headers["content-range"] = `bytes ${from}-${size - 1}/${size}`;
		return new Response(paced(file, from, size, tag), { status: range ? 206 : 200, headers });
	},
});
log(`mirror of ${dir} on http://127.0.0.1:${server.port} at ${RATE / 1024 / 1024} MB/s (pid ${process.pid})`);
