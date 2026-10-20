/**
 * Speak omp's collab host registry IPC directly (what `omp collab list/link` do).
 *
 *   bun .research/poc/registry.ts                       # snapshot every host
 *   bun .research/poc/registry.ts link <instanceId> [control|view] [generation]
 *
 * Protocol: discovery files ~/.omp/run/collab-hosts/<entryId>.json
 *   {version:1, instanceId, pid, endpoint, createdAt, token}
 * Endpoint: unix socket (POSIX) / named pipe (Windows), newline-delimited JSON,
 * ONE request per connection: {"v":1,"token":"<hex>","op":"snapshot"} or
 * {"v":1,"token":"…","op":"link","access":"control"|"view","generation":N}
 * → {"ok":true,"v":1,"snapshot":{…}} | {"ok":true,"v":1,"url":"…"} | {"ok":false,"v":1,"error":"<code>"}
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".omp", "run", "collab-hosts");

interface Meta {
	version: number;
	instanceId: string;
	pid: number;
	endpoint: string;
	createdAt: number;
	token: string;
}

async function query(meta: Meta, request: Record<string, unknown>, timeoutMs = 1500): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let buf = "";
	const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
	await Bun.connect({
		unix: meta.endpoint,
		socket: {
			open(s) {
				s.write(`${JSON.stringify({ v: 1, token: meta.token, ...request })}\n`);
			},
			data(s, chunk) {
				buf += chunk.toString();
				const nl = buf.indexOf("\n");
				const line = nl >= 0 ? buf.slice(0, nl) : buf;
				try {
					const parsed = JSON.parse(line);
					clearTimeout(timer);
					resolve(parsed);
					s.end();
				} catch {
					/* wait for more */
				}
			},
			close() {
				if (buf) {
					clearTimeout(timer);
					try {
						resolve(JSON.parse(buf));
					} catch (err) {
						reject(err);
					}
				}
			},
			error(_s, err) {
				reject(err);
			},
		},
	});
	return promise;
}

const metas: Meta[] = readdirSync(DIR)
	.filter(n => n.endsWith(".json"))
	.map(n => JSON.parse(readFileSync(join(DIR, n), "utf8")) as Meta);

const [cmd, selector, access = "control", generation] = Bun.argv.slice(2);
if (cmd === "link") {
	const meta = metas.find(m => m.instanceId === selector);
	if (!meta) throw new Error(`no host ${selector}`);
	const snap = (await query(meta, { op: "snapshot" })) as { snapshot: { generation: number } };
	const gen = generation !== undefined ? Number(generation) : snap.snapshot.generation;
	console.log(JSON.stringify(await query(meta, { op: "link", access, generation: gen }), null, 2));
} else {
	for (const meta of metas) {
		const t0 = performance.now();
		const res = await query(meta, { op: "snapshot" }).catch(err => ({ error: String(err) }));
		console.log(JSON.stringify({ entry: meta.endpoint, ms: +(performance.now() - t0).toFixed(1), res }, null, 2));
	}
	// Bad token → authentication_failed; wrong version → unsupported_protocol.
	if (metas[0]) {
		console.log(JSON.stringify({ badToken: await query({ ...metas[0], token: "nope" }, { op: "snapshot" }) }));
		console.log(JSON.stringify({ badOp: await query(metas[0], { op: "frobnicate" }) }));
	}
}
