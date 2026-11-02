/**
 * Keeps a picture from before a page change off the panel. After the shown page navigated (or a
 * tab was shown) a frame must follow; when none comes within `delay` ms the picture is stale (the
 * panel shows the loading state) and the screencast restarts, which makes Chrome send one. A tab
 * the user doesn't drive (Chrome may not paint it while another tab of its window is in front)
 * gets one more restart once its first frame is in, for the frame of the page as it settled.
 */
export interface FreshHooks {
  /** Runs `fn` after `ms`; the returned function cancels it. */
  after(fn: () => void, ms: number): () => void;
  /** The tab shown now. */
  shown(): string | null;
  /** The user's input drives the tab (their own, or one they took over). */
  driven(tabId: string): boolean;
  /** The picture of this tab is stale until a frame comes; null: no picture is. */
  stale(tabId: string | null): void;
  /** Stops the screencast and starts it again. */
  restart(): void;
}

export class FreshFrames {
  private waiting: string | null = null;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly hooks: FreshHooks,
    private readonly delay: number,
  ) {}

  /** The shown tab's page changed (it navigated, or the tab was just shown): a frame must follow. */
  expect(tabId: string): void {
    this.waiting = tabId;
    this.cancel?.();
    this.cancel = this.hooks.after(() => {
      if (this.waiting !== tabId || this.hooks.shown() !== tabId) return;
      this.hooks.stale(tabId);
      this.hooks.restart();
    }, this.delay);
  }

  /** A frame of the shown tab came. */
  frame(tabId: string): void {
    if (this.waiting !== tabId) return;
    this.waiting = null;
    this.cancel?.();
    this.cancel = null;
    this.hooks.stale(null);
    if (!this.hooks.driven(tabId)) this.cancel = this.hooks.after(() => this.hooks.restart(), this.delay);
  }

  reset(): void {
    this.waiting = null;
    this.cancel?.();
    this.cancel = null;
    this.hooks.stale(null);
  }
}
