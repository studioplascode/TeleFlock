import type { HostClient } from "@/core";
import type { PastSession, SearchPage, SearchSnippet, SearchStop, SessionSearchHit } from "@/core/gen";

/** Fewest non-space characters a message search starts at. */
export const MIN_QUERY = 2;
/** Quiet time after the last keystroke before a search starts. */
export const DEBOUNCE_MS = 300;
/** Long-poll wait: how long the host holds a poll for new hits. */
export const POLL_WAIT_MS = 1500;
/** The host's cap on matching sessions per search (its default). */
export const HIT_LIMIT = 100;

/** What the dialog searches the messages for: the trimmed query, or null while it is too short. */
export function searchQuery(q: string): string | null {
  const t = q.trim();
  return t.replace(/\s/g, "").length >= MIN_QUERY ? t : null;
}

export type SearchStatus = "idle" | "searching" | "done" | "unsupported" | "error";

export interface SearchState {
  status: SearchStatus;
  hits: SessionSearchHit[];
  /** Session files read so far, and in all. */
  files: number;
  filesTotal: number;
  stopped?: SearchStop;
  elapsedMs: number;
  error?: string;
}

export const IDLE: SearchState = { status: "idle", hits: [], files: 0, filesTotal: 0, elapsedMs: 0 };
export const SEARCHING: SearchState = { ...IDLE, status: "searching" };

/** The state after the host answered with `page` (its hits are the ones after those held). */
export function applyPage(prev: SearchState, page: SearchPage): SearchState {
  return {
    status: page.done ? "done" : "searching",
    hits: page.hits.length ? [...prev.hits, ...page.hits] : prev.hits,
    files: page.files,
    filesTotal: page.filesTotal,
    stopped: page.stopped,
    elapsedMs: page.elapsedMs,
  };
}

function codeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" ? e.message : String(e);
}

/** The state after a request failed: an older host answers `unknown_method` for every search method. */
export function failed(prev: SearchState, e: unknown): SearchState {
  if (codeOf(e) === "unknown_method") return { ...IDLE, status: "unsupported" };
  return { ...prev, status: "error", error: messageOf(e) };
}

export interface SearchParams {
  query: string;
  cwd?: string;
}

export interface SearchRun {
  /** Stops the run: no more callbacks, the host drops a search still going. */
  cancel(): void;
  /** Resolves once the run has no request in flight. */
  settled: Promise<void>;
}

/**
 * One search: `search.start`, then `search.poll` (long poll) until the host reports the end. One
 * request at a time (a cancel may overlap, to cut a pending poll short). After `cancel()` nothing
 * more is reported and a search the host still runs is cancelled. `after` delays the first
 * request until the previous run has settled.
 */
export function startSearch(
  host: Pick<HostClient, "call">,
  params: SearchParams,
  on: { page(page: SearchPage): void; error(e: unknown): void },
  after: Promise<void> = Promise.resolve(),
): SearchRun {
  let live = true;
  let searchId: string | undefined;
  let ended = false;
  const drop = () => {
    if (searchId && !ended) host.call("search.cancel", { searchId }).catch(() => {});
    ended = true;
  };
  const settled = (async () => {
    await after;
    if (!live) return;
    try {
      let held = 0;
      let page = await host.call("search.start", { query: params.query, ...(params.cwd ? { cwd: params.cwd } : {}), waitMs: POLL_WAIT_MS });
      for (;;) {
        searchId = page.searchId;
        ended = page.done;
        if (!live) return drop();
        held += page.hits.length;
        on.page(page);
        if (page.done) return;
        page = await host.call("search.poll", { searchId: page.searchId, after: held, waitMs: POLL_WAIT_MS });
      }
    } catch (e) {
      if (live) on.error(e);
    }
  })();
  return {
    settled,
    cancel() {
      if (!live) return;
      live = false;
      drop();
    },
  };
}

// ------------------------------------------------------------------ the merged list

export interface Entry {
  s: PastSession;
  /** The content hit of this session (absent: only its title, folder or id matched). */
  hit?: SessionSearchHit;
}

/** Whether a session's title, folder or id holds the (lowercased) needle. */
export function metaMatches(s: PastSession, needle: string): boolean {
  return `${s.title ?? ""} ${s.cwd ?? ""} ${s.id}`.toLowerCase().includes(needle);
}

/**
 * The sessions to list: those whose title/folder/id match (the instant filter), plus those with
 * content hits, merged by file. A hit's own `PastSession` fills in sessions the list lacks (older
 * than its newest-N); the list's copy wins otherwise (its `live`/`agentId` are fresher).
 */
export function mergeEntries(list: readonly PastSession[], hits: readonly SessionSearchHit[], needle: string): Entry[] {
  const byFile = new Map<string, SessionSearchHit>();
  for (const h of hits) byFile.set(h.session.file, h);
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const hit = byFile.get(s.file);
    if (hit || !needle || metaMatches(s, needle)) out.push({ s, hit });
    seen.add(s.file);
  }
  for (const h of hits) if (!seen.has(h.session.file)) out.push({ s: h.session, hit: h });
  return out;
}

/** The label of a snippet: who said it, or which tool call/output it is in. */
export function snippetLabel(sn: SearchSnippet): string {
  switch (sn.kind) {
    case "user":
      return "You";
    case "assistant":
      return "omp";
    case "thinking":
      return "thinking";
    case "toolCall":
      return sn.tool ? `${sn.tool} call` : "tool call";
    case "toolOutput":
      return sn.tool ? `${sn.tool} output` : "tool output";
    case "summary":
      return "summary";
    case "other":
      return "note";
  }
}

/** One line under the list: what is being searched, and why a search stopped. */
export function searchNote(s: SearchState): string | undefined {
  switch (s.status) {
    case "searching":
      return s.filesTotal > 0 ? `Searching messages… ${s.files} of ${s.filesTotal} sessions` : "Searching messages…";
    case "unsupported":
      return "This host's TeleFlock is too old to search messages";
    case "error":
      return `Couldn't search messages: ${s.error ?? "unknown error"}`;
    case "done":
      if (s.stopped === "hits") return `Showing the first ${s.hits.length} matching sessions`;
      if (s.stopped === "time") return `Stopped after ${Math.round(s.elapsedMs / 1000)} s`;
      if (s.stopped === "bytes") return `Stopped after reading ${s.files} of ${s.filesTotal} sessions (size limit)`;
      return undefined;
    default:
      return undefined;
  }
}

/** Key of the preview's find scope. */
export function previewScope(hostId: string, file: string): string {
  return `preview:${hostId}:${file}`;
}
