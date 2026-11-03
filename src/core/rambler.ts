/**
 * Rambler: turns what the user dictates into one clear prompt, on the host (`suggestRamble`, `ai.complete`).
 *
 * One {@link Rambler} per dictation session of one text box. While the person speaks, the finished utterances are only
 * collected: no model call runs before the dictation ends. `finish()` then makes the session's one call, over the whole
 * transcript. Words are never lost: a failed or slow call, or a transcript too long to send, leaves the raw transcript
 * with the reason. Nothing said, or a cancelled session: no call at all.
 */
import type { AiOutcome, RambleInput } from "./ai";
import { RAMBLE_MAX_CHARS } from "./ai";

export type RambleRewrite = (input: RambleInput) => Promise<AiOutcome<string>>;

export interface RambleState {
  /** Everything dictated so far, as recognised. */
  raw: string;
  /** The rewrite is running (after `finish()`). */
  thinking: boolean;
  /** Why the words will stay as dictated, known before any call (too long to tidy); null otherwise. */
  error: string | null;
}

export interface RambleResult {
  /** What goes into the composer: the rewrite of the whole transcript, else the raw transcript. */
  text: string;
  raw: string;
  /** `text` is a rewrite (not the raw fallback). */
  cleaned: boolean;
  /** Why `text` is the raw transcript; null for a rewrite, nothing said or a cancelled session. */
  error: string | null;
}

export interface RambleOptions {
  rewrite: RambleRewrite;
  /** Where the prompt goes (repository, agent), sent with the call. */
  about?: string;
  /**
   * Gets the host's model worker started for the call (`prewarmRamble`): called when the session is created and every
   * `warmEveryMs` until it finishes or is cancelled, so the call finds the worker running however long the person speaks.
   */
  warm?: () => void;
  /** Default 60 s: the host stops a worker that has been idle for 2 min. */
  warmEveryMs?: number;
  /** After `finish()`, the longest wait for the rewrite before the raw transcript is used. Default 15 s. */
  timeoutMs?: number;
}

export interface Rambler {
  /** One finished utterance, in order: it extends the transcript, nothing is sent. Ignored after `finish()` or `cancel()`. */
  push(segment: string): void;
  /** The dictation ended: one call rewrites the whole transcript; resolves with the rewrite, else with the raw transcript and why. Calling it again returns the same promise. */
  finish(): Promise<RambleResult>;
  /** Drops the session: no call is made, a running call's answer is ignored, and a pending `finish` resolves with the raw transcript. */
  cancel(): void;
  state(): RambleState;
  /** Called after every change of `state()`. */
  subscribe(fn: () => void): () => void;
}

const TIMEOUT_MS = 15_000;
const WARM_EVERY_MS = 60_000;
const TOO_LONG = "Too long to tidy: kept as dictated";

export function createRambler(o: RambleOptions): Rambler {
  const parts: string[] = [];
  let raw = "";
  let thinking = false;
  /** `finish()` or `cancel()` was called: the transcript is final. */
  let closed = false;
  let cancelled = false;
  let finished: Promise<RambleResult> | undefined;
  /** Resolves the pending `finish()` once: with the answer, at the timeout or on a cancel, whichever comes first. */
  let settle: ((r: RambleResult) => void) | undefined;
  const listeners = new Set<() => void>();

  const snapshot = (): RambleState => ({ raw, thinking, error: raw.length > RAMBLE_MAX_CHARS ? TOO_LONG : null });
  let snap = snapshot();
  const notify = () => {
    snap = snapshot();
    for (const l of [...listeners]) l();
  };
  const kept = (error: string | null): RambleResult => ({ text: raw, raw, cleaned: false, error });

  o.warm?.();
  const warming = o.warm ? setInterval(o.warm, o.warmEveryMs ?? WARM_EVERY_MS) : undefined;
  const close = () => {
    closed = true;
    clearInterval(warming);
  };

  return {
    push(segment) {
      const s = segment.trim();
      if (!s || closed) return;
      parts.push(s);
      raw = parts.join(" ");
      notify();
    },
    finish() {
      if (finished) return finished;
      close();
      if (cancelled || !raw) return (finished = Promise.resolve(kept(null)));
      if (raw.length > RAMBLE_MAX_CHARS) return (finished = Promise.resolve(kept(TOO_LONG)));
      // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
      finished = new Promise<RambleResult>((resolve) => {
        const giveUp = setTimeout(() => settle?.(kept("The model took too long")), o.timeoutMs ?? TIMEOUT_MS);
        settle = (r) => {
          settle = undefined;
          clearTimeout(giveUp);
          thinking = false;
          notify();
          resolve(r);
        };
      });
      thinking = true;
      notify();
      o.rewrite({ transcript: raw, ...(o.about ? { about: o.about } : {}) }).then(
        (out) => settle?.(out.ok ? { text: out.value, raw, cleaned: true, error: null } : kept(out.failure.message)),
        (e: unknown) => settle?.(kept(e instanceof Error ? e.message : String(e))),
      );
      return finished;
    },
    cancel() {
      cancelled = true;
      close();
      settle?.(kept(null));
    },
    state: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
