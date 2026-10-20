/** Time source for the demo engine. Real time in the app; a manual clock in tests. */
export interface DemoClock {
  now(): number;
  /** Repeating timer; returns cancel. */
  every(ms: number, cb: () => void): () => void;
  /** One-shot timer; returns cancel. */
  after(ms: number, cb: () => void): () => void;
}

export const realClock: DemoClock = {
  now: () => Date.now(),
  every(ms, cb) {
    const id = setInterval(cb, ms);
    return () => clearInterval(id);
  },
  after(ms, cb) {
    const id = setTimeout(cb, ms);
    return () => clearTimeout(id);
  },
};

interface ManualTimer {
  id: number;
  at: number;
  every: number;
  cb: () => void;
}

/** Deterministic clock: time moves only through `advance`. Timers fire in time order. */
export class ManualClock implements DemoClock {
  private t: number;
  private seq = 0;
  private timers: ManualTimer[] = [];

  constructor(start = Date.UTC(2026, 9, 20, 14, 30, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  every(ms: number, cb: () => void): () => void {
    return this.add(ms, ms, cb);
  }

  after(ms: number, cb: () => void): () => void {
    return this.add(ms, 0, cb);
  }

  private add(ms: number, every: number, cb: () => void): () => void {
    const timer: ManualTimer = { id: ++this.seq, at: this.t + Math.max(0, ms), every, cb };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }

  /** Moves time forward, firing every due timer in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: ManualTimer | undefined;
      for (const timer of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer;
      }
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.every > 0) next.at += next.every;
      else this.timers = this.timers.filter((x) => x !== next);
      next.cb();
    }
    this.t = end;
  }
}
