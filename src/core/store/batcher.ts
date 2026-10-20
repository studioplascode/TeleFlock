/** Schedules one callback; returns a cancel function. */
export type FrameScheduler = (cb: () => void) => () => void;

/**
 * Next animation frame, with a timer fallback: rAF never fires in hidden tabs / backgrounded
 * webviews, and events must still be applied there (throttled timers keep the queue bounded).
 */
export const animationFrameScheduler: FrameScheduler = (cb) => {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    clearTimeout(timer);
    cb();
  };
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : 0;
  const timer = setTimeout(run, 100);
  return () => {
    done = true;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
};

/** Queues items and hands them to `flush` once per frame, in arrival order. */
export class FrameBatcher<T> {
  private queue: T[] = [];
  private cancel: (() => void) | null = null;

  constructor(
    private readonly flush: (items: T[]) => void,
    private readonly schedule: FrameScheduler = animationFrameScheduler,
  ) {}

  push(item: T): void {
    this.queue.push(item);
    if (!this.cancel) this.cancel = this.schedule(() => this.flushNow());
  }

  /** Applies everything queued right now (also used by tests and before synchronous reads). */
  flushNow(): void {
    this.cancel?.();
    this.cancel = null;
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    this.flush(items);
  }

  get pending(): number {
    return this.queue.length;
  }
}
