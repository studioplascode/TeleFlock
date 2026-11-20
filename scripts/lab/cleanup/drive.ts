#!/usr/bin/env bun
/**
 * Cleanup lab driver (architecture §3.17 "Background scans", "Incremental scans"): plays the app
 * against the lab tf-hostd (setup.sh) through `tf-hostd attach` (hello first, as the app does, which
 * opens the herdr session's context) and checks what the host does by itself, reading its scans from
 * `hostd.log` (the `cleanup scan` line) and the report's `stats`:
 *
 *   a  the first background scan runs by itself (no request asked for one)
 *   g  its gh children ran at nice 19, in the idle I/O class, in a low-weight scope (fake gh's log)
 *   d  `cleanup.worktrees {latest}` answers at once from it and starts no scan
 *   b  the next scheduled scan, past the size TTL, nothing changed: no git status, no listing, no gh,
 *      no session bytes, size checks by `stat` only
 *   c  a commit and a new file deep in node_modules in one worktree: only that one is worked out again
 *   e  `cleanup.remove` with `expect`: a clean worktree goes at once, without a scan; one whose HEAD
 *      moved since the report is refused (`worktree_changed`)
 *   f  Forget of a checkout the report saw gone that came back: `not_missing`, the folder intact
 *   h  bulk "Delete merged/closed", each removal carrying the pull request it was chosen for: the host
 *      asks gh again right before (at the user's priority). A closed PR reopened since the report
 *      (fake gh flips it) → `worktree_changed`; gh rate-limited → `pr_unverified`; both worktrees and
 *      their ignored `.env.local` stay, the row shows gh's answer; the merged ones go
 *   i  Prune stale with the cutoff the user confirmed: a worktree reset on the same HEAD since the report
 *      (its reflog moved, nothing else did) → `worktree_changed` ("used since the report"), it stays; an
 *      untouched one goes
 *
 * Usage: scripts/lab/run cleanup -- env TF_HOSTD_CLEANUP_PACE=30 bun scripts/lab/cleanup/drive.ts
 * Exit 0: every check held; 2: a check failed; 1: error.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { sleep } from "bun";

type Json = Record<string, any>;
const L: Record<string, string> = {};
for (const line of readFileSync("/tmp/tf-lab-cleanup/lab.env", "utf8").split("\n")) {
	const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
	if (m) L[m[1]!] = m[2]!;
}
const { HOSTD, SESSION, RELAY_PORT, HOSTD_HOME, LOGS, SRC } = L as Record<string, string>;
const failures: string[] = [];
const t0 = Date.now();
const out = (line: string) => {
	console.log(line);
	appendFileSync(`${LOGS}/drive.log`, `${line}\n`);
};
const note = (kind: string, text: string) => out(`${`+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8)} ${kind.padEnd(6)} ${text}`);
function check(ok: boolean, what: string, detail?: unknown) {
	if (ok) note("ok", what);
	else {
		failures.push(what);
		note("FAIL", `${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
function git(cwd: string, ...args: string[]): string {
	const p = Bun.spawnSync(["git", "-c", "user.name=lab", "-c", "user.email=lab@example.invalid", ...args], { cwd });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
	return p.stdout.toString().trim();
}

// ── tf-hostd attach ─────────────────────────────────────────────────────────────────────────────
const attach = Bun.spawn([HOSTD!, "--relay-port", RELAY_PORT!, "attach", "--session", SESSION!], { stdin: "pipe", stdout: "pipe", stderr: Bun.file(`${LOGS}/drive.attach.stderr`) });
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error & { code?: string }) => void }>();
let nextId = 1;
const welcome = Promise.withResolvers<void>();
const send = (msg: Json) => {
	attach.stdin.write(`${JSON.stringify(msg)}\n`);
	attach.stdin.flush();
};
function call(method: string, params: Json): Promise<Json> {
	const id = nextId++;
	const { promise, resolve, reject } = Promise.withResolvers<Json>();
	pending.set(id, { resolve, reject });
	send({ t: "req", id, method, params });
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
async function nextScan(after: number, what: string, ms = 180_000): Promise<Json> {
	const end = Date.now() + ms;
	for (;;) {
		const s = scans();
		if (s.length > after) return s[after]!;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(250);
	}
}
const rows = (r: Json): Json[] => (r.repos as Json[]).flatMap((x) => x.worktrees as Json[]);
const expectOf = (w: Json) => ({ head: w.head, branch: w.branch, unpushed: w.unpushed, agents: w.agents, workspaceId: w.workspaceId });
const table: string[] = [
	"| scan | kind | low | ms | git status (kept) | worktree list | git calls | dir stats | read_dir | entries | walks | checks | PR lookups (kept) | session files / bytes |",
	"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];
const row = (what: string, s: Json) =>
	table.push(
		`| ${what} | ${s.kind} | ${s.low} | ${s.ms} | ${s.statuses} (${s.statuses_kept}) | ${s.repos_listed} | ${s.git_calls} | ${s.dir_stats} | ${s.dir_reads} | ${s.dir_entries} | ${s.size_walks} | ${s.size_checks} | ${s.pr_lookups} (${s.prs_kept}) | ${s.session_files} / ${s.session_bytes} |`,
	);

try {
	send({ t: "hello", protocol: 1, client: { app: "teleflock-lab", version: "0.9.6", platform: "linux", device: "cleanup-driver" }, herdrSession: SESSION });
	await Promise.race([welcome.promise, sleep(90_000).then(() => Promise.reject(new Error("no welcome within 90 s")))]);
	const pinger = setInterval(() => send({ t: "ping", ts: Date.now() }), 10_000);
	pinger.unref?.();
	note("info", `attached to ${SESSION}; asking nothing until the host scans by itself`);

	// a: the first background scan, by itself.
	const first = await nextScan(0, "the first background scan");
	row("a. first background scan (by itself)", first);
	check(first.kind === "Background" && first.low === "true", "a. a background scan ran by itself, at low priority", first);

	// g: the gh children of the scan (the pull request lookups; the host's gh status probe at start,
	// `gh --version` and `gh auth status`, is no scan's and runs as before).
	const ghLog = existsSync(`${LOGS}/gh.log`) ? readFileSync(`${LOGS}/gh.log`, "utf8").trim().split("\n").filter(Boolean) : [];
	const gh = ghLog.filter((l) => l.includes("args=pr view"));
	const field = (l: string, k: string) => new RegExp(`${k}=(\\S+)`).exec(l)?.[1];
	note("info", `gh call: ${gh[0] ?? "none"}`);
	check(gh.length > 0 && gh.every((l) => field(l, "nice") === "19" && field(l, "io") === "idle" && field(l, "sid") === field(l, "pid")), `g. all ${gh.length} pull request lookups of the background scan ran at nice 19, in the idle I/O class, in a session of their own`);
	check(gh.every((l) => field(l, "cgroup")?.includes("teleflock-background") && field(l, "cpu.weight") === "1"), `g. …in a scope of their own with CPUWeight 1 (${field(gh[0] ?? "", "cgroup")}, cpu.weight ${field(gh[0] ?? "", "cpu.weight")})`);

	// d: the page's request: at once, no scan.
	let t = Date.now();
	const r = await call("cleanup.worktrees", { refresh: false, waitMs: 1500, latest: true });
	const answerMs = Date.now() - t;
	await sleep(1500);
	check(answerMs < 500 && !r.scanning && r.stats?.kind === "background" && r.background?.everyMs > 0 && rows(r).length === 20, `d. cleanup.worktrees {latest} answered in ${answerMs} ms from the background report (20 worktrees, scanned ${Math.round((Date.now() - r.scannedAt) / 1000)} s ago)`, { scanning: r.scanning, background: r.background });
	check(scans().length === 1, "d. …and started no scan");

	// b: the next scheduled scan, past the size TTL, nothing changed.
	const quiet = await nextScan(1, "the next scheduled scan");
	row("b. scheduled, past SIZE_TTL, nothing changed", quiet);
	check(quiet.kind === "Background" && quiet.statuses === 0 && quiet.repos_listed === 0 && quiet.git_calls === 0 && quiet.dir_reads === 0 && quiet.size_walks === 0 && quiet.pr_lookups === 0 && quiet.session_bytes === 0, "b. a quiet scan: no git at all, no listing, no gh, no session bytes", quiet);
	check(quiet.size_checks === 20 && quiet.dir_stats > 0, `b. …its 20 size checks only stat folders (${quiet.dir_stats} stats)`);

	// c: one worktree changes: a commit and a new file deep in its node_modules.
	const w7 = `${SRC}/beta-wt/w7`;
	let n = scans().length;
	writeFileSync(`${w7}/work.txt`, "w");
	git(w7, "add", "work.txt");
	git(w7, "commit", "-qm", "work");
	writeFileSync(`${w7}/node_modules/pkg5/lib5/new.js`, "n");
	const changed = await nextScan(n, "the scan after the change");
	row("c. after a commit + a new deep file in beta w7", changed);
	check(changed.statuses === 1 && changed.statuses_kept === 19 && changed.repos_listed === 1 && changed.size_walks === 0 && changed.dir_reads === 2 && changed.pr_lookups === 1, "c. only beta w7 worked out again: 1 status, 1 listing (its repository), 2 folders listed (its root and the deep folder), 1 gh lookup (its HEAD moved)", changed);

	// e: removal with `expect`.
	const report = await call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true });
	const clean = rows(report).find((x) => x.path.endsWith("alpha-wt/w4"))!;
	n = scans().length;
	t = Date.now();
	await call("cleanup.remove", { path: clean.path, force: false, trust: false, forget: false, expect: expectOf(clean) });
	const removeMs = Date.now() - t;
	check(!existsSync(clean.path) && !git(`${SRC}/alpha`, "worktree", "list").includes("alpha-wt/w4"), `e. cleanup.remove {expect} deleted the clean alpha w4 in ${removeMs} ms`);
	check(scans().length === n, "e. …without a scan");
	const moved = rows(report).find((x) => x.path.endsWith("beta-wt/w6"))!;
	writeFileSync(`${moved.path}/late.txt`, "l");
	git(moved.path, "add", "late.txt");
	git(moved.path, "commit", "-qm", "late");
	const refused = await call("cleanup.remove", { path: moved.path, force: false, trust: false, forget: false, expect: expectOf(moved) }).then(
		() => "removed",
		(e) => e.message as string,
	);
	note("info", `HEAD moved: ${refused}`);
	check(refused.startsWith("worktree_changed") && existsSync(`${moved.path}/late.txt`), "e. beta w6, whose HEAD moved since the report: worktree_changed, the worktree stays");

	// e: a disk unplugged since the report: Delete with `expect` keeps the registration.
	const plugged = rows(report).find((x) => x.path.endsWith("alpha-wt/w6"))!;
	renameSync(plugged.path, `${plugged.path}.unplugged`);
	const unplugged = await call("cleanup.remove", { path: plugged.path, force: false, trust: false, forget: false, expect: expectOf(plugged) }).then(
		() => "removed",
		(e) => e.message as string,
	);
	note("info", `unplugged: ${unplugged}`);
	const stillListed = git(`${SRC}/alpha`, "worktree", "list").includes("alpha-wt/w6");
	renameSync(`${plugged.path}.unplugged`, plugged.path);
	check(unplugged.startsWith("worktree_changed") && stillListed && git(plugged.path, "status", "--porcelain") === "", "e. alpha w6, its folder gone since the report (a disk unplugged): worktree_changed, git still lists it, whole again once back");

	// f: Forget of a checkout the report saw gone that came back.
	const w8 = `${SRC}/beta-wt/w8`;
	renameSync(w8, `${w8}.away`);
	n = scans().length;
	await nextScan(n, "the scan that sees beta w8 gone");
	const seen = rows(await call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true })).find((x) => x.path === w8);
	renameSync(`${w8}.away`, w8);
	writeFileSync(`${w8}/.env.local`, "SECRET=1\n");
	const forgot = await call("cleanup.remove", { path: w8, force: false, trust: false, forget: true, expect: expectOf(seen ?? {}) }).then(
		() => "forgotten",
		(e) => e.message as string,
	);
	note("info", `Forget: ${forgot}`);
	check(seen?.missing === true && forgot.startsWith("not_missing") && readFileSync(`${w8}/.env.local`, "utf8") === "SECRET=1\n" && git(`${SRC}/beta`, "worktree", "list").includes("beta-wt/w8"), "f. Forget of beta w8 (reported gone, back again): not_missing; the checkout, its ignored .env.local and its registration stay");

	// h: bulk "Delete merged/closed": each removal carries the pull request it was chosen for.
	const shipped = rows(await call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true })).filter((x) => !x.missing && (x.pr?.state === "MERGED" || x.pr?.state === "CLOSED"));
	const short = (p: string) => p.split("/").slice(-2).join("/");
	note("info", `Delete merged/closed: ${shipped.map((x) => `${short(x.path)} #${x.pr.number} ${x.pr.state.toLowerCase()}`).join(", ")}`);
	const reopened = `${SRC}/alpha-wt/w3`;
	const unverified = `${SRC}/beta-wt/w3`;
	for (const p of [reopened, unverified]) writeFileSync(`${p}/.env.local`, "SECRET=1\n");
	const lab = LOGS!.replace(/\/logs$/, "");
	mkdirSync(`${lab}/gh-prs`, { recursive: true });
	writeFileSync(`${lab}/gh-prs/closed-alpha-3`, "OPEN\n");
	writeFileSync(`${lab}/gh-prs/closed-beta-3`, "FAIL HTTP 403: API rate limit exceeded for user ID 1.\n");
	const ghBefore = readFileSync(`${LOGS}/gh.log`, "utf8").trim().split("\n").length;
	const outcome = new Map<string, string>();
	for (const w of shipped) {
		const said = await call("cleanup.remove", { path: w.path, force: false, trust: false, forget: false, expect: { ...expectOf(w), pr: { number: w.pr.number, state: w.pr.state } } }).then(
			() => "removed",
			(e) => e.message as string,
		);
		outcome.set(w.path, said);
		note("info", `  ${short(w.path)}: ${said}`);
	}
	const asked = readFileSync(`${LOGS}/gh.log`, "utf8").trim().split("\n").slice(ghBefore).filter((l) => l.includes("args=pr view"));
	check(shipped.length === 8 && outcome.get(reopened)?.startsWith("worktree_changed") === true && outcome.get(reopened)!.includes("was reopened"), "h. the closed PR of alpha w3, reopened since the report: worktree_changed");
	check(outcome.get(unverified)?.startsWith("pr_unverified") === true, "h. beta w3, gh rate-limited: pr_unverified");
	check([reopened, unverified].every((p) => readFileSync(`${p}/.env.local`, "utf8") === "SECRET=1\n" && git(p, "status", "--porcelain") === ""), "h. …both checkouts and their ignored .env.local stay");
	const removed = shipped.filter((x) => x.path !== reopened && x.path !== unverified);
	check(removed.every((x) => outcome.get(x.path) === "removed" && !existsSync(x.path)), `h. the ${removed.length} merged ones went`);
	check(asked.length === shipped.length && asked.every((l) => field(l, "nice") !== "19" && !field(l, "cgroup")?.includes("teleflock-background")), `h. one gh lookup per removal (${asked.length}), at the user's priority (nice ${field(asked[0] ?? "", "nice")})`);
	const reopenedRow = rows(await call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true })).find((x) => x.path === reopened);
	check(reopenedRow?.pr?.state === "OPEN", `h. the report shows gh's answer for alpha w3: ${reopenedRow?.pr?.state}`);

	// i: Prune stale, its cutoff the one the user confirmed (just after both picks' last use): alpha w8
	// gets a same-HEAD `git reset` since the report, alpha w9 stays untouched.
	const picks = rows(await call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true })).filter((x) => /alpha-wt\/w[89]$/.test(x.path));
	const cutoff = Math.max(...picks.map((x) => x.activeAt ?? x.createdAt));
	const resetIn = `${SRC}/alpha-wt/w8`;
	const untouched = `${SRC}/alpha-wt/w9`;
	await sleep(1100);
	git(resetIn, "reset", "-q", "HEAD");
	const pruned = new Map<string, string>();
	for (const w of picks) {
		const said = await call("cleanup.remove", { path: w.path, force: false, trust: false, forget: false, expect: { ...expectOf(w), staleBefore: cutoff } }).then(
			() => "removed",
			(e) => e.message as string,
		);
		pruned.set(w.path, said);
		note("info", `  prune ${short(w.path)}: ${said}`);
	}
	check(picks.length === 2 && pruned.get(resetIn)?.startsWith("worktree_changed") === true && pruned.get(resetIn)!.includes("used since the report") && existsSync(resetIn), "i. Prune stale: alpha w8, reset on the same HEAD since the report: worktree_changed (used since the report), it stays");
	check(pruned.get(untouched) === "removed" && !existsSync(untouched), "i. …alpha w9, untouched since: pruned");
} catch (e) {
	failures.push(String(e));
	note("ERROR", String(e));
} finally {
	out(`\n${table.join("\n")}`);
	out(failures.length ? `\n${failures.length} check(s) failed` : "\nevery check held");
	attach.kill();
	process.exit(failures.length ? 2 : 0);
}
