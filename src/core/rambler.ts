/**
 * Rambler: turns what the user dictates into one clear prompt, on the host (`suggestRamble`, `ai.complete`).
 *
 * One {@link Rambler} per dictation session of one composer. Finished utterances are pushed as they come; the
 * controller keeps the rewrite of "everything said so far" fresh with *incremental, coalesced* calls:
 * - at most one call in flight; while it runs, newer utterances only extend the transcript, and the next call
 *   (newest transcript wins, the previous rewrite attached so the wording stays put) starts when it returns;
 * - live calls are paced (`minGapMs`) and capped (`maxLiveCalls`), so a long ramble costs a bounded number of
 *   model calls; the final call after `finish()` ignores both;
 * - a failure never loses words: the result then is the raw transcript, and after an unavailable host or two
 *   failures in a row the session stops asking.
 */
import type { AiOutcome, RambleInput } from "./ai";
import { RAMBLE_MAX_CHARS } from "./ai";

export type RambleRewrite = (input: RambleInput) => Promise<AiOutcome<string>>;

export interface RambleState {
  /** Everything dictated so far, as recognised. */
  raw: string;
  /** The latest rewrite ("" until the first arrives); it covers all of `raw` only when `upToDate`. */
  clean: string;
  upToDate: boolean;
  /** A rewrite is running or about to start. */
  thinking: boolean;
  /** Why rewriting stopped (the words stay as dictated); null while it works. */
  error: string | null;
  /** `finish()` was called. */
  ended: boolean;
}

export interface RambleResult {
  /** What goes into the composer: the rewrite of the whole transcript, else the raw transcript. */
  text: string;
  raw: string;
  /** `text` is a rewrite (not the raw fallback). */
  cleaned: boolean;
  error: string | null;
}

export interface RambleOptions {
  rewrite: RambleRewrite;
  /** Where the prompt goes (repository, agent), passed to every call. */
  about?: string;
  /** Least time between the starts of two live calls. Default 1 200 ms. */
  minGapMs?: number;
  /** Live (before `finish`) calls at most. Default 24. */
  maxLiveCalls?: number;
  /** After `finish`, the longest wait for the final rewrite before the raw transcript is used. Default 15 s. */
  finalTimeoutMs?: number;
  now?: () => number;
}

export interface Rambler {
  /** One finished utterance, in order. */
  push(segment: string): void;
  /** The user stopped: resolves with the final text once the rewrite covers everything said (or the raw transcript after a failure or timeout). */
  finish(): Promise<RambleResult>;
  /** Drops the session (nothing is applied; a pending `finish` resolves with the raw transcript). */
  cancel(): void;
  state(): RambleState;
  /** Called after every change of `state()`. */
  subscribe(fn: () => void): () => void;
}

const MIN_GAP_MS = 1_200;
const MAX_LIVE_CALLS = 24;
const FINAL_TIMEOUT_MS = 15_000;

/** Failures that no retry in this session will cure. */
const FATAL: Record<string, true> = { unavailable: true, unsupported: true, off: true };

export function createRambler(o: RambleOptions): Rambler {
  const now = o.now ?? (() => Date.now());
  const minGap = o.minGapMs ?? MIN_GAP_MS;
  const maxLive = o.maxLiveCalls ?? MAX_LIVE_CALLS;
  const finalTimeout = o.finalTimeoutMs ?? FINAL_TIMEOUT_MS;

  const parts: string[] = [];
  let raw = "";
  let clean = "";
  /** The transcript `clean` was made from. */
  let covered = "";
  let running = false;
  let ended = false;
  let dropped = false;
  /** Gave up asking (fatal failure, repeated failures, too long). */
  let stopped = false;
  let error: string | null = null;
  let calls = 0;
  let failures = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiters: (() => void)[] = [];
  const listeners = new Set<() => void>();

  const upToDate = () => covered === raw;
  const snapshot = (): RambleState => ({ raw, clean, upToDate: upToDate(), thinking: !dropped && !stopped && raw !== "" && !upToDate(), error, ended });
  let snap = snapshot();
  const notify = () => {
    snap = snapshot();
    for (const l of [...listeners]) l();
  };

  const result = (): RambleResult => {
    const cleaned = clean !== "" && upToDate();
    return { text: cleaned ? clean : raw, raw, cleaned, error: cleaned ? null : (error ?? (raw ? "Couldn't tidy this" : null)) };
  };
  const settle = () => {
    for (const w of waiters.splice(0)) w();
  };

  const fail = (message: string, fatal: boolean) => {
    failures++;
    error = message;
    if (fatal || failures >= 2) stopped = true;
  };

  const start = () => {
    running = true;
    calls++;
    lastStart = now();
    const sent = raw;
    // Only the call made after finish() is the last try: a live call that fails once the user stopped leaves it to that one.
    const final = ended;
    const input: RambleInput = { transcript: sent, ...(clean ? { previous: clean } : {}), ...(o.about ? { about: o.about } : {}) };
    const done = (out: AiOutcome<string>) => {
      running = false;
      if (dropped) return;
      if (out.ok) {
        clean = out.value;
        covered = sent;
        failures = 0;
        error = null;
      } else fail(out.failure.message, FATAL[out.failure.why] === true || final);
      notify();
      pump();
    };
    o.rewrite(input).then(done, (e: unknown) => done({ ok: false, failure: { why: "failed", message: e instanceof Error ? e.message : String(e) } }));
  };

  const pump = () => {
    if (running) return;
    if (dropped || stopped || raw === "" || upToDate()) {
      settle();
      return;
    }
    if (!ended) {
      if (calls >= maxLive) return;
      const wait = lastStart + minGap - now();
      if (wait > 0) {
        timer ??= setTimeout(() => {
          timer = undefined;
          pump();
        }, wait);
        return;
      }
    }
    start();
    notify();
  };

  return {
    push(segment) {
      const s = segment.trim();
      if (!s || dropped) return;
      parts.push(s);
      raw = parts.join(" ");
      if (raw.length > RAMBLE_MAX_CHARS && !stopped) {
        stopped = true;
        error = "Too long to tidy: kept as dictated";
      }
      notify();
      if (!ended) pump();
    },
    finish() {
      if (dropped) return Promise.resolve(result());
      ended = true;
      notify();
      // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
      return new Promise<RambleResult>((resolve) => {
        const giveUp = setTimeout(() => {
          dropped = true;
          clearTimeout(timer);
          error ??= "The model took too long";
          notify();
          settle();
        }, finalTimeout);
        waiters.push(() => {
          clearTimeout(giveUp);
          resolve(result());
        });
        pump();
      });
    },
    cancel() {
      dropped = true;
      clearTimeout(timer);
      notify();
      settle();
    },
    state: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
