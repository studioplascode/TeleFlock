/*
 * Failure isolation on the event path: every transport listener, `onAppEvent` listener, bus
 * subscriber, reducer step and effect is called on its own, so one that throws never costs the
 * events, listeners or effects after it. Call sites catch around each call and report here.
 */

/** One console line per call site per window: a listener that throws on every terminal frame logs once per 10 s. */
const REPORT_WINDOW_MS = 10_000;

export type FailureReport = (err: unknown, detail?: string) => void;

/**
 * A reporter for one call site: logs a caught failure with `console.error`, at most once every
 * 10 s; the next line counts the failures folded in meanwhile. `now`/`log` are test seams.
 */
export function failureReporter(site: string, opts: { now?: () => number; log?: (message: string, err: unknown) => void } = {}): FailureReport {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((message: string, err: unknown) => console.error(message, err));
  let lastAt = Number.NEGATIVE_INFINITY;
  let folded = 0;
  return (err, detail) => {
    const t = now();
    if (t - lastAt < REPORT_WINDOW_MS) {
      folded++;
      return;
    }
    const more = folded > 0 ? ` (${folded} more since the last report)` : "";
    lastAt = t;
    folded = 0;
    log(`[core] ${site} threw${detail ? ` (${detail})` : ""}${more}; the rest went on`, err);
  };
}
