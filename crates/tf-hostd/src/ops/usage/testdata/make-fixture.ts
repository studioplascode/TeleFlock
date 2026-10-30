#!/usr/bin/env bun
/**
 * Builds the `host.usage` test fixture with the real omp (18.13.3): writes a handful of omp
 * session files (a main session with a subagent, an advisor, an error, a side call, a priority
 * tier request and two human messages; a second project with an unpriced xai-oauth request)
 * into a throwaway HOME and lets `omp stats` index them; then adds a fork that copies two of
 * the main session's turns and indexes again (`omp stats --json`), so the main session owns the
 * copies as it would on a real host. Stores
 *   omp-18.13.3.sql   messages / tool_calls / user_messages / meta exactly as omp-stats wrote them;
 *   omp-18.13.3.json  `base` (the fixture's first hour, epoch ms), the session files' paths
 *                     relative to HOME, and omp's own dashboard figures for the same rows.
 * Usage: bun crates/tf-hostd/src/ops/usage/testdata/make-fixture.ts
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = import.meta.dir;
const home = mkdtempSync(join(tmpdir(), "tf-usage-fixture-"));
const sessions = join(home, ".omp", "agent", "sessions");
const HOUR = 3_600_000;
const MIN = 60_000;
// Within omp's default 24 h dashboard window, starting on a whole hour.
const base = Math.floor(Date.now() / HOUR) * HOUR - 20 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const fileTs = (ms: number) => iso(ms).replace(/[:.]/g, "-");

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: Cost;
  premiumRequests: number;
}
function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): Usage {
  const cost: Cost = { input: total * 0.4, output: total * 0.4, cacheRead: total * 0.1, cacheWrite: total * 0.1, total };
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost, premiumRequests: 0 };
}

let seq = 0;
const id = () => (++seq).toString(16).padStart(8, "0");

function header(sessionId: string, cwd: string, title: string, at: number, parent?: string): string[] {
  return [
    JSON.stringify({ type: "title", v: 1, title, source: "user", updatedAt: iso(at), pad: "    " }),
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: iso(at), cwd, ...(parent ? { parentSession: parent } : {}) }),
  ];
}

interface Turn {
  entryId: string;
  at: number;
  provider: string;
  model: string;
  api: string;
  usage: Usage;
  stopReason: string;
  duration?: number;
  ttft?: number;
  errorMessage?: string;
  tools?: { id: string; name: string }[];
  serviceTier?: string;
}

function assistant(t: Turn, parentId: string | null): string {
  const content: unknown[] = [{ type: "text", text: "ok" }];
  for (const tc of t.tools ?? []) content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: { path: "x" } });
  return JSON.stringify({
    type: "message",
    id: t.entryId,
    parentId,
    timestamp: iso(t.at),
    message: {
      role: "assistant",
      content,
      api: t.api,
      provider: t.provider,
      model: t.model,
      usage: t.usage,
      stopReason: t.stopReason,
      timestamp: t.at,
      ...(t.duration !== undefined ? { duration: t.duration } : {}),
      ...(t.ttft !== undefined ? { ttft: t.ttft } : {}),
      ...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
      ...(t.serviceTier ? { serviceTier: t.serviceTier } : {}),
    },
  });
}

function user(at: number, text: string): { line: string; entryId: string } {
  const entryId = id();
  return { entryId, line: JSON.stringify({ type: "message", id: entryId, parentId: null, timestamp: iso(at), message: { role: "user", content: text, timestamp: at } }) };
}

function toolResult(at: number, callId: string, name: string, isError: boolean): string {
  return JSON.stringify({
    type: "message",
    id: id(),
    parentId: null,
    timestamp: iso(at),
    message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "result" }], isError, timestamp: at },
  });
}

const OPUS = { provider: "anthropic", model: "claude-opus-5-5", api: "anthropic-messages" };
const SONNET = { provider: "anthropic", model: "claude-sonnet-5", api: "anthropic-messages" };
const LUNA = { provider: "openai-codex", model: "gpt-6-luna", api: "openai-codex-responses" };
const ASTRA = { provider: "openai-codex", model: "gpt-6-astra", api: "openai-codex-responses" };
const GROK = { provider: "xai-oauth", model: "grok-5", api: "openai-responses" };

// ── alpha: main session A, its subagent and advisor, and a fork of A ──
const alpha = join(sessions, "-work-alpha");
const aId = "01aaaaaa-0000-7000-8000-00000000000a";
const aFile = join(alpha, `${fileTs(base)}_${aId}.jsonl`);
const aDir = aFile.slice(0, -".jsonl".length);
mkdirSync(aDir, { recursive: true });
const u1 = user(base + 1 * MIN, "refactor the parser");
const a1: Turn = { entryId: id(), at: base + 2 * MIN, ...OPUS, usage: usage(1000, 200, 5000, 300, 0.014), stopReason: "toolUse", duration: 4000, ttft: 800, tools: [{ id: "tc1", name: "read" }, { id: "tc2", name: "bash" }] };
const a2: Turn = { entryId: id(), at: base + 5 * MIN, ...OPUS, usage: usage(200, 100, 6000, 0, 0.0065), stopReason: "stop", duration: 2000, ttft: 500 };
const a3: Turn = { entryId: id(), at: base + 65 * MIN, ...OPUS, usage: usage(50, 0, 0, 0, 0.0002), stopReason: "error", duration: 300, errorMessage: "overloaded_error" };
const a4: Turn = { entryId: id(), at: base + 130 * MIN, ...ASTRA, usage: usage(3000, 500, 0, 0, 0.02), stopReason: "stop", duration: 6000, ttft: 1200, serviceTier: "priority" };
const sideId = id();
const u2 = user(base + 5 * MIN + 30_000, "now the tests");
const aLines = [
  ...header(aId, join(home, "work", "alpha"), "Alpha refactor", base),
  u1.line,
  assistant(a1, u1.entryId),
  toolResult(base + 3 * MIN, "tc1", "read", false),
  toolResult(base + 3 * MIN, "tc2", "bash", true),
  assistant(a2, a1.entryId),
  // The human writes again before the advisor's note and the next turn.
  u2.line,
  assistant(a3, u2.entryId),
  // A side call omp records as `model_usage` (here: the session title).
  JSON.stringify({ type: "model_usage", id: sideId, parentId: a3.entryId, timestamp: iso(base + 66 * MIN), purpose: "title", ...LUNA, usage: usage(400, 20, 0, 0, 0.0004), stopReason: "stop" }),
  JSON.stringify({ type: "service_tier_change", id: id(), parentId: sideId, timestamp: iso(base + 129 * MIN), serviceTier: { openai: "priority" } }),
  assistant(a4, sideId),
];
writeFileSync(aFile, `${aLines.join("\n")}\n`);

const sId = "01aaaaaa-0000-7000-8000-0000000000a1";
const s1: Turn = { entryId: id(), at: base + 3 * MIN, ...SONNET, usage: usage(800, 300, 0, 0, 0.006), stopReason: "toolUse", duration: 3000, ttft: 600, tools: [{ id: "tc3", name: "grep" }] };
const s2: Turn = { entryId: id(), at: base + 4 * MIN, ...SONNET, usage: usage(900, 150, 800, 0, 0.004), stopReason: "stop", duration: 1500, ttft: 400 };
writeFileSync(
  join(aDir, "0-Explore.jsonl"),
  `${[...header(sId, join(home, "work", "alpha"), "Explore", base + 3 * MIN, aId), assistant(s1, null), toolResult(base + 4 * MIN, "tc3", "grep", false), assistant(s2, s1.entryId)].join("\n")}\n`,
);
const v1: Turn = { entryId: id(), at: base + 6 * MIN, ...LUNA, usage: usage(1200, 80, 0, 0, 0.001), stopReason: "stop", duration: 900, ttft: 300 };
writeFileSync(join(aDir, "__advisor.jsonl"), `${[...header("01aaaaaa-0000-7000-8000-0000000000ad", join(home, "work", "alpha"), "Advisor", base + 6 * MIN, aId), assistant(v1, null)].join("\n")}\n`);

// ── beta: an unpriced subscription request and an expensive one ──
const beta = join(sessions, "-work-beta");
mkdirSync(beta, { recursive: true });
const bId = "01bbbbbb-0000-7000-8000-00000000000b";
const b1: Turn = { entryId: id(), at: base + 10 * HOUR, ...GROK, usage: { ...usage(5000, 1000, 0, 0, 0), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", duration: 7000, ttft: 900 };
const b2: Turn = { entryId: id(), at: base + 10 * HOUR + 20 * MIN, ...OPUS, usage: usage(2000, 1500, 0, 0, 0.05), stopReason: "toolUse", duration: 9000, ttft: 2000, tools: [{ id: "tc4", name: "edit" }] };
writeFileSync(
  join(beta, `${fileTs(base + 10 * HOUR)}_${bId}.jsonl`),
  `${[...header(bId, join(home, "work", "beta"), "Beta bugs", base + 10 * HOUR), assistant(b1, null), assistant(b2, b1.entryId), toolResult(base + 10 * HOUR + 21 * MIN, "tc4", "edit", false)].join("\n")}\n`,
);

// ── index with omp itself: A and beta first, then the fork (so A owns the turns it shares) ──
const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" };
function omp(...args: string[]): string {
  const proc = Bun.spawnSync(["omp", ...args], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(1);
  }
  return proc.stdout.toString();
}
omp("stats", "--summary");

// A fork of A: the first exchange copied verbatim (same entry ids and times) plus one new turn.
const cId = "01cccccc-0000-7000-8000-00000000000c";
const f1: Turn = { entryId: id(), at: base + 15 * HOUR, ...OPUS, usage: usage(500, 50, 7000, 0, 0.003), stopReason: "stop", duration: 1000, ttft: 300 };
writeFileSync(
  join(alpha, `${fileTs(base + 14 * HOUR)}_${cId}.jsonl`),
  `${[...header(cId, join(home, "work", "alpha"), "Alpha fork", base + 14 * HOUR, aId), u1.line, assistant(a1, u1.entryId), assistant(a2, a1.entryId), assistant(f1, a2.entryId)].join("\n")}\n`,
);
const dashboard = JSON.parse(omp("stats", "--json"));
const version = omp("--version").trim();

const db = new Database(join(home, ".omp", "stats.db"), { readonly: true });
const quote = (v: unknown) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const tables = ["messages", "tool_calls", "user_messages", "meta"];
const lines = [`-- omp-stats tables written by ${version} (make-fixture.ts). HOME was ${home}.`, "BEGIN;"];
for (const t of tables) {
  const { sql } = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) as { sql: string };
  lines.push(`${sql};`);
  for (const { sql: idx } of db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t) as { sql: string }[]) lines.push(`${idx};`);
  for (const row of db.query(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[]) {
    const cols = Object.keys(row);
    lines.push(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => quote(row[c])).join(", ")});`);
  }
}
lines.push("COMMIT;");
writeFileSync(join(out, "omp-18.13.3.sql"), `${lines.join("\n")}\n`);
writeFileSync(
  join(out, "omp-18.13.3.json"),
  `${JSON.stringify(
    {
      ompVersion: version,
      home,
      base,
      files: { a: aFile.slice(home.length + 1), beta: join(beta, `${fileTs(base + 10 * HOUR)}_${bId}.jsonl`).slice(home.length + 1) },
      overall: dashboard.overall,
      byModel: dashboard.byModel,
      byFolder: dashboard.byFolder,
      byAgentType: dashboard.byAgentType,
    },
    null,
    2,
  )}\n`,
);
db.close();
rmSync(home, { recursive: true, force: true });
console.log(`fixture: ${version}, base ${iso(base)}, ${dashboard.overall?.totalRequests} requests`);
