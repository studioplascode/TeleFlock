import type { FindHit, PastSession, SearchPage, SearchSnippet, SessionFindResult, SessionRows, SessionSearchHit, SnippetKind, ToolItem, TranscriptItem } from "@/core/gen";
import { apiError } from "../errors";
import { type RepoDef, repoForPath } from "./data";
import { hash, Rng } from "./rng";

/*
 * `search.*` and `session.find` on the demo host (architecture §5, Past sessions' full-text search):
 * the live agents' rows and synthetic rows for the seeded old sessions are searched with a small
 * case-insensitive matcher over the same row fields as the client's Find (`session/find/rowText.ts`).
 * Row ids are the ones `search.read` returns, so a snippet's `rowId` opens the right row in the
 * preview, and a live agent's are its transcript ids, so `openFind` lands on them.
 */

const METHODS: Record<string, true> = { "search.start": true, "search.poll": true, "search.cancel": true, "search.read": true, "session.find": true };

/** Sessions one request "reads": the page grows by this many files per answer, so progress shows. */
const FILES_PER_PAGE = 3;
const SNIPPETS = 3;
const CONTEXT = 48;
const MATCH_CAP = 1000;
const READ_LIMIT = 120;

/** What the search demo needs from its DemoHost (closures over the host's state). */
export interface SearchHost {
  now(): number;
  /** This host's tf-hostd has them (studio-pc plays one that predates 0.7.0: `unknown_method`). */
  supported(): boolean;
  /** Every past session, live ones included, newest first. */
  sessions(): PastSession[];
  /** The transcript rows of a live (or parked) agent, oldest first. */
  rows(agentId: string): readonly TranscriptItem[] | undefined;
}

interface Run {
  id: string;
  hits: SessionSearchHit[];
  /** Sessions read so far, and in all. */
  files: number;
  filesTotal: number;
  /** Hit count after each file: what a page shows once that many files are read. */
  upTo: number[];
  stopped?: "hits";
  elapsedMs: number;
}

export class DemoSearch {
  private run?: Run;
  private seq = 0;
  private readonly synth = new Map<string, TranscriptItem[]>();

  constructor(private readonly host: SearchHost) {}

  /** `undefined`: not a search method, or this host predates them. */
  call(method: string, p: Record<string, unknown>): unknown {
    if (!METHODS[method] || !this.host.supported()) return undefined;
    switch (method) {
      case "search.start":
        return this.start(p);
      case "search.poll":
        return this.poll(p);
      case "search.cancel":
        if (this.run && this.run.id === p.searchId) this.run = undefined;
        return {};
      case "search.read":
        return this.read(p);
      default:
        return this.find(p);
    }
  }

  private start(p: Record<string, unknown>): SearchPage {
    const query = typeof p.query === "string" ? p.query : "";
    if (!query.trim()) throw apiError("invalid_params", "Empty query");
    const caseSensitive = p.caseSensitive === true;
    const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
    const limit = Math.min(500, typeof p.limit === "number" ? p.limit : 100);
    const sessions = this.host.sessions().filter((s) => s.file && (!cwd || s.cwd?.startsWith(cwd)));
    const run: Run = { id: `demo-search-${++this.seq}`, hits: [], files: 0, filesTotal: sessions.length, upTo: [], elapsedMs: 0 };
    for (const s of sessions) {
      if (run.hits.length >= limit) {
        run.stopped = "hits";
        break;
      }
      const hit = searchRows(s, this.rowsOf(s), query, caseSensitive);
      if (hit) run.hits.push(hit);
      run.upTo.push(run.hits.length);
    }
    this.run = run;
    return this.page(run, 0);
  }

  private poll(p: Record<string, unknown>): SearchPage {
    const run = this.run;
    if (!run || run.id !== p.searchId) throw apiError("not_found", "That search is gone", { hint: "Search again" });
    return this.page(run, typeof p.after === "number" ? p.after : 0);
  }

  /** Advances the simulated reading and answers with the hits after `after`. */
  private page(run: Run, after: number): SearchPage {
    const read = run.upTo.length;
    run.files = Math.min(read, run.files + FILES_PER_PAGE);
    run.elapsedMs = run.files * 140;
    const done = run.files >= read && (run.stopped != null || read >= run.filesTotal);
    const shown = run.files === 0 ? 0 : (run.upTo[run.files - 1] ?? 0);
    return {
      searchId: run.id,
      hits: run.hits.slice(after, shown),
      total: shown,
      files: done && !run.stopped ? run.filesTotal : run.files,
      filesTotal: run.filesTotal,
      bytes: run.files * 48_000,
      elapsedMs: run.elapsedMs,
      done,
      ...(done && run.stopped ? { stopped: run.stopped } : {}),
    };
  }

  private read(p: Record<string, unknown>): SessionRows {
    const file = typeof p.file === "string" ? p.file : "";
    const session = this.host.sessions().find((s) => s.file === file);
    if (!session) throw apiError("not_found", `session file ${file} not found`);
    const rows = this.rowsOf(session);
    const limit = Math.max(1, Math.min(1000, typeof p.limit === "number" ? p.limit : READ_LIMIT));
    const indexOf = (id: string) => rows.findIndex((r) => r.id === id);
    let start: number;
    let end: number;
    if (typeof p.before === "string") {
      const i = indexOf(p.before);
      if (i < 0) throw apiError("not_found", `row ${p.before} not found`);
      end = i;
      start = Math.max(0, i - limit);
    } else if (typeof p.after === "string") {
      const i = indexOf(p.after);
      if (i < 0) throw apiError("not_found", `row ${p.after} not found`);
      start = i + 1;
      end = Math.min(rows.length, start + limit);
    } else {
      const around = typeof p.around === "string" ? indexOf(p.around) : -1;
      const at = typeof p.aroundAt === "number" ? nearest(rows, p.aroundAt) : -1;
      const centre = around >= 0 ? around : at;
      if (centre < 0) {
        end = rows.length;
        start = Math.max(0, end - limit);
      } else {
        start = Math.max(0, Math.min(centre - Math.floor(limit / 2), rows.length - limit));
        end = Math.min(rows.length, start + limit);
      }
    }
    return { items: rows.slice(start, end), start, rows: rows.length };
  }

  private find(p: Record<string, unknown>): SessionFindResult {
    const rows = typeof p.agentId === "string" ? this.host.rows(p.agentId) : undefined;
    if (!rows) throw apiError("not_found", `agent ${String(p.agentId)} not found`);
    const query = typeof p.query === "string" ? p.query : "";
    const limit = Math.max(1, Math.min(10_000, typeof p.limit === "number" ? p.limit : 2000));
    const before = typeof p.before === "string" ? rows.findIndex((r) => r.id === p.before) : -1;
    const upTo = before >= 0 ? before : rows.length;
    const hits: FindHit[] = [];
    if (query.trim()) {
      for (let i = 0; i < upTo; i++) {
        const count = countRow(rows[i] as TranscriptItem, query, p.caseSensitive === true);
        if (count > 0) hits.push({ id: (rows[i] as TranscriptItem).id, index: i, count });
      }
    }
    const truncated = hits.length > limit;
    return { hits: truncated ? hits.slice(hits.length - limit) : hits, rows: rows.length, truncated };
  }

  private rowsOf(s: PastSession): readonly TranscriptItem[] {
    if (s.live && s.agentId) {
      const rows = this.host.rows(s.agentId);
      if (rows) return rows;
    }
    let rows = this.synth.get(s.file);
    if (!rows) {
      rows = synthRows(s);
      this.synth.set(s.file, rows);
    }
    return rows;
  }
}

/** Index of the row nearest to `at` (rows are in time order). */
function nearest(rows: readonly TranscriptItem[], at: number): number {
  let best = -1;
  let gap = Number.POSITIVE_INFINITY;
  rows.forEach((r, i) => {
    const d = Math.abs(r.at - at);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}

// ------------------------------------------------------------------ matching

/** One searchable text of a row, and the snippet kind a match in it gets. */
interface Part {
  text: string;
  kind: SnippetKind;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The texts Find searches in a row (the client's `rowTexts`): what the card shows, not its chrome. */
function rowParts(item: TranscriptItem): Part[] {
  const out: Part[] = [];
  const add = (kind: SnippetKind, text: string | null | undefined) => {
    if (text) out.push({ kind, text });
  };
  switch (item.kind) {
    case "user":
      add("user", item.text);
      break;
    case "assistant":
      add("assistant", item.text);
      add("assistant", item.error);
      break;
    case "thinking":
      if (!item.redacted) add("thinking", item.text);
      break;
    case "tool":
      toolParts(item, add);
      break;
    case "notice":
      add("other", item.text);
      add("other", item.source);
      break;
    case "compaction":
      add("summary", item.summary);
      break;
    case "mode":
      add("other", item.text);
      break;
    case "irc":
      add("other", item.message?.peer);
      add("other", item.message?.text);
      break;
  }
  return out;
}

function toolParts(t: ToolItem, add: (kind: SnippetKind, text: string | null | undefined) => void): void {
  add("toolCall", t.title);
  add("toolCall", t.intent);
  const v = t.view;
  if (!v) {
    const args = t.args == null ? "" : typeof t.args === "string" ? t.args : JSON.stringify(t.args, null, 2);
    if (args !== "{}") add("toolCall", args);
    if (t.output) add("toolOutput", t.output.replace(ANSI, ""));
  } else if (v.type === "bash") {
    add("toolCall", v.command);
    add("toolCall", v.cwd);
    add("toolOutput", (v.output ?? "").replace(ANSI, ""));
  } else if (v.type === "read") {
    add("toolCall", v.path);
    add("toolCall", v.range);
    add("toolOutput", v.preview);
  } else if (v.type === "diff") {
    for (const f of v.files ?? []) {
      add("toolCall", f.path);
      add("toolOutput", f.patch);
    }
  } else if (v.type === "search") {
    add("toolCall", v.query);
    for (const h of v.hits ?? []) {
      add("toolOutput", h.path);
      add("toolOutput", h.text);
    }
  } else if (v.type === "markdown") {
    add("toolOutput", v.text);
  } else if (t.output) add("toolOutput", t.output.replace(ANSI, ""));
  add("toolOutput", t.error);
}

/** Start offsets of `needle` in `text`, non-overlapping (case-insensitive unless `exact`). */
function offsets(text: string, needle: string, exact: boolean): number[] {
  const out: number[] = [];
  if (!needle) return out;
  const hay = exact ? text : text.toLowerCase();
  const n = exact ? needle : needle.toLowerCase();
  for (let at = hay.indexOf(n); at >= 0; at = hay.indexOf(n, at + n.length)) out.push(at);
  return out;
}

function countRow(item: TranscriptItem, query: string, exact: boolean): number {
  let n = 0;
  for (const part of rowParts(item)) n += offsets(part.text, query, exact).length;
  return n;
}

/** The first match of a row as a snippet: `CONTEXT` characters each side, whitespace collapsed. */
function snippetOf(item: TranscriptItem, query: string, exact: boolean): SearchSnippet | undefined {
  for (const part of rowParts(item)) {
    const at = offsets(part.text, query, exact)[0];
    if (at === undefined) continue;
    const from = Math.max(0, at - CONTEXT);
    const to = Math.min(part.text.length, at + query.length + CONTEXT);
    const before = part.text.slice(from, at).replace(/\s+/g, " ");
    const after = part.text.slice(at + query.length, to).replace(/\s+/g, " ");
    return {
      kind: part.kind,
      before: (from > 0 ? "…" : "") + before.trimStart(),
      hit: part.text.slice(at, at + query.length),
      after: after.trimEnd() + (to < part.text.length ? "…" : ""),
      ...(item.kind === "tool" && (part.kind === "toolCall" || part.kind === "toolOutput") ? { tool: item.tool } : {}),
      rowId: item.id,
      at: item.at,
    };
  }
  return undefined;
}

/** The hit a session has for `query` (undefined: no match anywhere in its rows). */
function searchRows(session: PastSession, rows: readonly TranscriptItem[], query: string, exact: boolean): SessionSearchHit | undefined {
  let matches = 0;
  const snippets: SearchSnippet[] = [];
  for (const row of rows) {
    const n = countRow(row, query, exact);
    if (n === 0) continue;
    matches = Math.min(MATCH_CAP, matches + n);
    if (snippets.length < SNIPPETS) {
      const s = snippetOf(row, query, exact);
      if (s) snippets.push(s);
    }
  }
  return matches > 0 ? { session, matches, snippets } : undefined;
}

// ------------------------------------------------------------------ synthetic rows of old sessions

const ASKS = [
  "Pick up where we left off: {title}. What is still open?",
  "Before the next release I want a clear answer on {title}.",
  "Why does this keep failing in CI? It looks related to {title}.",
  "Write down what we decided so far about {title}.",
  "Can you check the {repo} tests once more? Something about {title} is flaky.",
];
const THOUGHTS = [
  "The tests only fail under load, so a timeout is more likely than a logic error. Reading the retry path first.",
  "Two ways to do this: keep the old cache and invalidate on write, or drop it and measure. Measuring is cheaper.",
  "The benchmark noise is larger than the difference. Pin the CPU frequency, run it three times, take the median.",
  "The config is read once at startup, so a restart is needed for the change to apply; worth documenting.",
];
const REPLIES = [
  "Found it: the retry loop never resets its backoff, so a single timeout makes every later request wait. Fixed and covered with a test.",
  "The benchmark shows a **12% improvement** on the hot path and no regression elsewhere. The remaining cost is allocation in the parser.",
  "Two changes are needed: the timeout moves into the config, and the websocket reconnect keeps its session id. I'll start with the config.",
  "I traced it to a stale cache entry. Clearing the cache on logout fixes the flicker; the pane resize path was a red herring.",
  "Done. The permissions prompt now appears once per install, and the settings screen explains why a notification can be blocked.",
  "Nothing else references the flag, so it is safe to delete. I removed it and its two dead branches.",
];
const COMMANDS: [string, string[]][] = [
  ["bun test", ["bun test v1.2.4", " 41 pass", " 1 fail", "error: expected 200, received 504 (timeout after 5000ms)"]],
  ["git log --oneline -5", ["a3f9c21 fix: reset backoff after a successful retry", "7be01d4 chore: bump dependencies", "19dd0aa feat: reconnect keeps the session id"]],
  ["cargo test -p tf-client", ["running 28 tests", "test reconnect::backoff_resets ... ok", "test result: ok. 28 passed; 0 failed"]],
  ["rg -n timeout src", ["src/net/client.ts:42:  const timeout = opts.timeout ?? 5000;", "src/net/retry.ts:17:  // timeout doubles per attempt"]],
];

/** A believable transcript for a seeded old session: `messages` rows, oldest first, ids stable per file. */
function synthRows(s: PastSession): TranscriptItem[] {
  const rng = new Rng(hash(s.file));
  const base = (s.file.split("/").pop() ?? s.id).replace(/\.jsonl$/, "");
  const repo: RepoDef | undefined = s.cwd ? repoForPath(s.cwd) : undefined;
  const repoName = repo?.name ?? "the project";
  const files = repo?.files ?? ["README.md"];
  const title = s.title ?? "this session";
  const fill = (t: string) => t.replaceAll("{title}", title).replaceAll("{repo}", repoName);
  const n = Math.max(6, Math.min(240, s.messages ?? 12));
  const step = 90_000;
  const rows: TranscriptItem[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${base}-${i.toString(36)}`;
    const at = s.updatedAt - (n - i) * step;
    if (i === 0) {
      rows.push({ kind: "user", id, at, text: fill(ASKS[0] as string), images: [], steering: false, synthetic: false });
      continue;
    }
    switch (i % 6) {
      case 1:
        rows.push({ kind: "user", id, at, text: fill(rng.pick(ASKS)), images: [], steering: false, synthetic: false });
        break;
      case 2:
        rows.push({ kind: "thinking", id, at, text: rng.pick(THOUGHTS), streaming: false, redacted: false });
        break;
      case 3: {
        const path = rng.pick(files);
        rows.push({
          kind: "tool", id, at, callId: id, tool: "read", title: `read ${path}`, args: { path }, status: "ok", truncated: false,
          view: { type: "read", path, range: "1-60", lines: 60, preview: `// ${path}\n// ${title}: ${rng.pick(THOUGHTS)}`, lang: path.split(".").pop() },
        });
        break;
      }
      case 4: {
        const [command, out] = rng.pick(COMMANDS) as [string, string[]];
        const output = out.join("\n");
        rows.push({
          kind: "tool", id, at, callId: id, tool: "bash", title: command, args: { command }, status: "ok", truncated: false, output,
          view: { type: "bash", command, cwd: s.cwd, output, exitCode: 0, background: false, timedOut: false },
        });
        break;
      }
      default:
        rows.push({ kind: "assistant", id, at, text: fill(rng.pick(REPLIES)), streaming: false });
    }
  }
  return rows;
}
