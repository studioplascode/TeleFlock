import type { UiPresence } from "@/core/gen";

/** While input continues, at most one `app.presence` call per this long. */
export const INPUT_EVERY_MS = 20_000;

/**
 * What the window shows of the user, and when to tell the core. Pure: the hook feeds it events and
 * sends what it returns. There are no timers; a report happens only when something changes (the
 * window's visibility or focus) or input arrives after the throttle has run out.
 */
export class PresenceTracker {
  private inputAt: number | undefined;
  private lastInputSent = Number.NEGATIVE_INFINITY;
  private last: { visible: boolean; focused: boolean } | undefined;

  constructor(
    private readonly now: () => number,
    private readonly every = INPUT_EVERY_MS,
  ) {}

  private report(visible: boolean, focused: boolean): UiPresence {
    this.last = { visible, focused };
    return { visible, focused, ...(this.inputAt === undefined ? {} : { inputAt: this.inputAt }) };
  }

  /** The window's visibility or focus (also the first call): a report unless it is the one just sent. */
  state(visible: boolean, focused: boolean): UiPresence | null {
    if (this.last?.visible === visible && this.last.focused === focused) return null;
    return this.report(visible, focused);
  }

  /** Pointer, key, wheel or touch input: a report at most once per `every`. */
  input(visible: boolean, focused: boolean): UiPresence | null {
    const t = this.now();
    this.inputAt = t;
    if (t - this.lastInputSent < this.every) return null;
    this.lastInputSent = t;
    return this.report(visible, focused);
  }
}
