import type { RetryWait, TranscriptItem } from "@/core/gen";
import { countdown } from "../resume/words";

/** What a provider-limit error row is, by omp's error text and the HTTP status it carried. */
export type LimitKind = "rateLimit" | "usageLimit" | "overloaded";

const USAGE = /usage[ _]?limit|insufficient_quota|exceeded your current quota|quota exceeded|credit balance|out of credits|billing/i;
const OVERLOAD = /overloaded|at capacity|service unavailable|server is busy|temporarily unavailable|high demand/i;
const RATE = /rate[ _]?limit|too many requests|throttl/i;
const hasStatus = (text: string, code: string) => new RegExp(`(^|\\D)${code}(\\D|$)`).test(text);

/** The kind of a provider limit in `error` (`status`: the HTTP status, when omp had one); null for any other error. */
export function limitKind(error: string, status?: number | null): LimitKind | null {
  if (USAGE.test(error)) return "usageLimit";
  if (OVERLOAD.test(error) || status === 529 || status === 503 || hasStatus(error, "529") || hasStatus(error, "503")) return "overloaded";
  if (RATE.test(error) || status === 429 || hasStatus(error, "429")) return "rateLimit";
  return null;
}

/** A failed attempt that said only that: an assistant row with a provider-limit error and no text. */
export function limitErrorOf(item: TranscriptItem | undefined): LimitKind | null {
  if (item?.kind !== "assistant" || !item.error || item.text.trim() !== "" || item.refusal) return null;
  return limitKind(item.error, item.errorStatus);
}

/** What a run of limit errors is called in the transcript. */
export const LIMIT_WORDS: Record<LimitKind, string> = {
  rateLimit: "Rate limited",
  usageLimit: "Usage limit",
  overloaded: "Provider overloaded",
};

/** Consecutive provider-limit errors folded into one row. */
export interface LimitRun {
  /** The first error row: the folded row takes its place. */
  leader: string;
  /** Every row folded in, in order: the errors and the system turns between them. */
  members: string[];
  /** How many of them are errors. */
  errors: number;
  /** When the first and the last error happened. */
  from: number;
  to: number;
  /** The last error's kind (a run can change from a rate limit to a usage limit). */
  kind: LimitKind;
}

export interface Folded {
  ids: string[];
  items: (TranscriptItem | undefined)[];
  /** Run by its leader's id. */
  runs: ReadonlyMap<string, LimitRun>;
}

const isSystemTurn = (item: TranscriptItem | undefined) => item?.kind === "user" && item.synthetic;

/**
 * Folds consecutive provider-limit error rows into one run. While omp waits on a limit, background
 * deliveries start system turns that each fail the same way; the system turns between two errors
 * fold in with them, the one after the last stays a row of its own. Presentation only: the
 * transcript keeps every row (the folded row lists them, expanded). A lone error stays as it is.
 */
export function foldLimitRuns(ids: readonly string[], items: readonly (TranscriptItem | undefined)[]): Folded {
  const out: Folded = { ids: [], items: [], runs: new Map() };
  const runs = out.runs as Map<string, LimitRun>;
  for (let i = 0; i < ids.length; ) {
    const id = ids[i] as string;
    const first = limitErrorOf(items[i]);
    let end = i;
    let errors = 1;
    let kind = first;
    for (let j = i + 1; first && j < ids.length; ) {
      // system turns between two errors belong to the run; look past them for the next error
      let k = j;
      while (k < ids.length && isSystemTurn(items[k])) k++;
      const next = limitErrorOf(items[k]);
      if (!next) break;
      errors++;
      kind = next;
      end = k;
      j = k + 1;
    }
    out.ids.push(id);
    out.items.push(items[i]);
    if (kind && errors >= 2) {
      const lead = items[i];
      const last = items[end];
      runs.set(id, {
        leader: id,
        members: ids.slice(i, end + 1),
        errors,
        from: lead?.kind === "assistant" ? lead.at : 0,
        to: last?.kind === "assistant" ? last.at : 0,
        kind,
      });
      i = end + 1;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * What `foldLimitRuns` reads of the rows, one character each (`E` provider-limit error, `S` system turn, `.`
 * other): a row that becomes an error in place keeps its id, so the id list alone can't tell the fold to run.
 */
export function limitSignature(ids: readonly string[], items: Readonly<Record<string, TranscriptItem | undefined>>): string {
  let out = "";
  for (const id of ids) {
    const it = items[id];
    out += limitErrorOf(it) ? "E" : isSystemTurn(it) ? "S" : ".";
  }
  return out;
}

const RETRYING = /^Retrying \((\d+)\/(\d+)\) in [\d.]+s: ([\s\S]*)$/;

/**
 * omp's "Retrying (n/m) in 294.0s: …" notice with a live countdown while that retry is the one
 * omp waits for (`OmpInfo.retry`, same attempt): "Retrying (1/10) in 4:54: …", "… now: …" once due.
 * Any other text (an earlier attempt, a finished wait) is returned as it is.
 */
export function retryNoticeText(text: string, wait: RetryWait | undefined, now: number): string {
  const m = RETRYING.exec(text);
  if (!m || !wait || Number(m[1]) !== wait.attempt || Number(m[2]) !== wait.maxAttempts) return text;
  const when = now >= wait.retryAt ? "now" : `in ${countdown(wait.retryAt - now)}`;
  return `Retrying (${m[1]}/${m[2]}) ${when}: ${m[3]}`;
}
