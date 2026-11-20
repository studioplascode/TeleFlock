#!/usr/bin/env bun
/**
 * Cleanup lab driver (architecture §3.17 "Background scans", "Incremental scans"): plays the app
 * against the lab tf-hostd (setup.sh) through `tf-hostd attach` and checks what the host does by
 * itself, reading its scans from `hostd.log` (the `cleanup scan` line) and the report's `stats`:
 *
 *   first     a background scan runs by itself (nothing asked for one), below the agents (gh at nice 19)
 *   answer    `cleanup.worktrees {latest}` answers at once from it, no new scan
 *   quiet     the next scheduled scan, past the size TTL, with nothing changed: no git status, no
 *             listing, no gh, no session bytes
 *   remove    `cleanup.remove` of a clean worktree acts at once, no scan
 *   changes   a commit, a staged change, an agent session, a new file deep in node_modules, each in
 *             one worktree: only that one is worked out again
 *   forget    a folder the report saw gone came back: Forget refuses, the checkout stays
 *
 * Usage: scripts/lab/run cleanup -- env TF_HOSTD_CLEANUP_PACE=30 bun scripts/lab/cleanup/drive.ts
 * Exit 0: every check held; 2: a check failed; 1: error.
 */
import { existsSync, readFileSync, renameSync, appendFileSync, writeFileSync } from "node:fs";
import { sleep } from "bun";

type Json = Record<string, any>;
const L: Record<string, string> = {};
for (const line of readFileSync("/tmp/tf-lab-cleanup/lab.env", "utf8").split("\n")) {
	const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
	if (m) L[m[1]!] = m[2]!;
}
const { HOSTD, SESSION, RELAY_PORT, HOSTD_HOME, LOGS, SRC, SESSION_FILE } = L as Record<string, string>;
const failures: string[] = [];
const t0 = Date.now();
const note = (kind: string, text: string) => console.log(`${`+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8)} ${kind.padEnd(6)} ${text}`);
function check(ok: boolean, what: string, detail?: unknown) {
	if (ok) note("ok", what);
	else {
		failures.push(what);
		note("FAIL", `${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
const git = (cwd: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", "-c", "user.name=lab", "-c", "user.email=lab@example.invalid", ...args], { cwd });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
	return p.stdout.toString().trim();
};

// ── tf-hostd attach ─────────────────────────────────────────────────────────────────────────────
const attach = Bun.spawn([HOSTD!, "--relay-port", RELAY_PORT!, "attach", "--session", SESSION!], { stdin: "pipe", stdout: "pipe", stderr: Bun.file(`${LOGS}/drive.attach.stderr`) });
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error & { code?: string }) => void }>();
let nextId = 1;
const welcome = Promise.withResolvers<void>();
function call(method: string, params: Json): Promise<Json> {
	const id = nextId++;
	const { promise, resolve, reject } = Promise.withResolvers<Json>();
	pending.set(id, { resolve, reject });
	attach.stdin.write(`${JSON.stringify({ t: "req", id, method, params })}\n`);
	attach.stdin.flush();
	return promise;
}
(async () => {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of attach.stdout) {
		buf += dec.decode(chunk, { stream: true });
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			let m: Json;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			if (m.t === "welcome") welcome.resolve();
			else if (m.t === "res") {
				const p = pending.get(m.id);
				pending.delete(m.id);
				if (m.error) p?.reject(Object.assign(new Error(`${m.error.code}: ${m.error.message}`), { code: m.error.code }));
				else p?.resolve(m.result);
			}
		}
	}
})();

// ── the host's scans, from its log ──────────────────────────────────────────────────────────────
function scans(): Json[] {
	const file = `${HOSTD_HOME}/hostd.log`;
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => / cleanup scan (?!facts)/.test(l) && l.includes(`session=${SESSION}`))
		.map((l) => Object.fromEntries([...l.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], /^\d+$/.test(m[2]!) ? Number(m[2]) : m[2]])));
}
async function nextScan(after: number, what: string, ms = 150_000): Promise<Json> {
	const end = Date.now() + ms;
	for (;;) {
		const s = scans();
		if (s.length > after) return s[after]!;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(500);
	}
}
const fmt = (s: Json) =>
	`kind=${s.kind} low=${s.low} ms=${s.ms} repos_listed=${s.repos_listed} statuses=${s.statuses} kept=${s.statuses_kept} git_calls=${s.git_calls} walks=${s.size_walks} checks=${s.size_checks} sizes_kept=${s.sizes_kept} deferred=${s.sizes_deferred} dir_stats=${s.dir_stats} dir_reads=${s.dir_reads} dir_entries=${s.dir_entries} pr_lookups=${s.pr_lookups} prs_kept=${s.prs_kept} session_files=${s.session_files} session_bytes=${s.session_bytes}`;
const rows = (r: Json): Json[] => (r.repos as Json[]).flatMap((x) => x.worktrees as Json[]);
const table: string[] = [];

try {
	await welcome.promise;
	note("info", `attached to ${SESSION}`);

	// first: a background scan by itself.
	const first = await nextScan(0, "the first background scan");
	check(first.kind === "Background" && first.low === "true", "a background scan ran by itself, below the agents", first);
	table.push(`first scan:     ${fmt(first)}`);
	const ghLog = existsSync(`${LOGS}/gh.log`) ? readFileSync(`${LOGS}/gh.log`, "utf8").trim().split("\n") : [];
	check(ghLog.length > 0 && ghLog.every((l) => l.includes("nice=19")), `its gh children ran at nice 19 (${ghLog.length} calls; cgroup ${/cgroup=(\S+)/.exec(ghLog[0] ?? "")?.[1]})`);

	// answer: at once, no new scan.
	let t = Date.now();
	const r = await call("cleanup.worktrees", { refresh: false, waitMs: 1500, latest: true });
	const took = Date.now() - t;
	await sleep(2000);
	check(took < 1000 && !r.scanning && r.background?.everyMs > 0 && r.stats?.kind === "background", `cleanup.worktrees answered in ${took} ms from the background report`, { scanning: r.scanning, background: r.background });
	check(scans().length === 1, "…and started no scan");
	check(rows(r).length === 20, `the report lists the 20 worktrees (${rows(r).length})`);

	// quiet: the next scheduled scan, past the size TTL, nothing changed.
	const quiet = await nextScan(1, "the next scheduled scan");
	table.push(`quiet scan:     ${fmt(quiet)}`);
	check(quiet.statuses === 0 && quiet.size_walks === 0 && quiet.dir_reads === 0 && quiet.pr_lookups === 0 && quiet.session_bytes === 0 && quiet.git_calls === 0, "a quiet scan: no git status, no listing, no gh, no session bytes", quiet);
	check(quiet.size_checks === 20 && quiet.dir_stats > 0, `…its size checks only stat folders (${quiet.dir_stats} stats)`);

	// remove: a clean worktree, at once, no scan.
	const report = await call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true });
	const w = rows(report).find((x) => x.path.endsWith("alpha-wt/w4"))!;
	const before = scans().length;
	t = Date.now();
	await call("cleanup.remove", { path: w.path, force: false, trust: false, forget: false, expect: { head: w.head, branch: w.branch, unpushed: w.unpushed, agents: w.agents, workspaceId: w.workspaceId } });
	const removeMs = Date.now() - t;
	check(!existsSync(w.path) && !git(`${SRC}/alpha`, "worktree", "list").includes("alpha-wt/w4"), `cleanup.remove deleted a clean worktree in ${removeMs} ms`);
	check(scans().length === before, "…without waiting for a scan");

	// changes, one at a time: only the worktree touched is worked out again.
	const steps: [string, () => void, (s: Json) => boolean][] = [
		["a commit in beta w3", () => { writeFileSync(`${SRC}/beta-wt/w3/work.txt`, "w"); git(`${SRC}/beta-wt/w3`, "add", "work.txt"); git(`${SRC}/beta-wt/w3`, "commit", "-qm", "work"); }, (s) => s.statuses === 1 && s.pr_lookups <= 1 && s.size_walks === 0],
		["a staged change in beta w4", () => { writeFileSync(`${SRC}/beta-wt/w4/staged.txt`, "s"); git(`${SRC}/beta-wt/w4`, "add", "staged.txt"); }, (s) => s.statuses === 1 && s.size_walks === 0],
		["an agent session working in beta w5", () => appendFileSync(SESSION_FILE!, `${JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls", cwd: `${SRC}/beta-wt/w5` } }] } })}\n`), (s) => s.statuses === 1 && s.session_files === 1 && s.session_bytes > 0],
		["a new file deep in alpha w0's node_modules", () => writeFileSync(`${SRC}/alpha-wt/w0/node_modules/pkg3/lib33/new.js`, "n"), (s) => s.statuses === 0 && s.dir_reads === 1 && s.size_walks === 0],
	];
	for (const [what, act, ok] of steps) {
		const n = scans().length;
		act();
		const s = await nextScan(n, `the scan after ${what}`);
		table.push(`${what}:`.padEnd(46) + fmt(s));
		check(ok(s), `after ${what}: only that worktree worked out again`, s);
	}

	// forget: the report saw a folder gone, it came back.
	const gone = `${SRC}/beta-wt/w8`;
	renameSync(gone, `${gone}.away`);
	const n = scans().length;
	await call("cleanup.worktrees", { refresh: true, waitMs: 20000, latest: true });
	await nextScan(n, "the Rescan");
	const seen = rows(await call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true })).find((x) => x.path === gone);
	renameSync(`${gone}.away`, gone);
	writeFileSync(`${gone}/.env.local`, "SECRET=1\n");
	const refused = await call("cleanup.remove", { path: gone, force: false, trust: false, forget: true, expect: { head: seen?.head, branch: seen?.branch, agents: 0 } }).then(() => "forgotten", (e) => e.code);
	check(seen?.missing === true && refused === "not_missing" && existsSync(`${gone}/.env.local`) && git(`${SRC}/beta`, "worktree", "list").includes("beta-wt/w8"), `Forget of a folder that came back: ${refused}, the checkout and its ignored file stay`);
} catch (e) {
	failures.push(String(e));
	note("ERROR", String(e));
} finally {
	console.log("\ncounters per scan:\n" + table.join("\n"));
	console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nevery check held");
	attach.kill();
	process.exit(failures.length ? 2 : 0);
}
