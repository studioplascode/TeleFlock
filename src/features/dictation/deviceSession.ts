import type { DictationEvent } from "@/core/gen";

/** What one on-device dictation session reports to its text box. */
export interface DeviceSessionHandlers {
  /** What is being said so far (replaces the previous one). */
  partial(text: string): void;
  /** A finished utterance, in order. */
  final(text: string): void;
  /** Why the session stops early; `end` follows. */
  error(message: string): void;
  /** Always last, once a session ran (a start that failed has none). */
  end(): void;
}

export interface DeviceSessionDeps {
  call(method: "dictation.start" | "dictation.stop" | "dictation.cancel", params: { session: string; locale?: string }): Promise<unknown>;
  /** Routes the events of `session` to `cb` until the returned function is called. */
  listen(session: string, cb: (e: DictationEvent) => void): () => void;
  id: string;
  /** The device locale (`de-DE`): the language for a model that needs one while the choice is `auto`. */
  locale?: string;
}

/**
 * One listening session of the on-device engine (`dictation.start` / `stop` / `cancel` on the app core, events by
 * the id the page picked, so nothing that arrives before the start answers is lost). `start` rejects when nothing
 * started (no model, no microphone, refused): then no event follows and `end` is not called. A stop or cancel
 * while the start is on its way is sent once it answered: the app core knows a session only from then on and
 * would drop it, leaving the microphone open.
 */
export class DeviceSession {
  private stopListening: (() => void) | null = null;
  private ended = false;
  /** The start's answer, once asked for. */
  private started: Promise<unknown> | null = null;

  constructor(
    private readonly deps: DeviceSessionDeps,
    private readonly on: DeviceSessionHandlers,
  ) {}

  get id(): string {
    return this.deps.id;
  }

  async start(): Promise<void> {
    this.stopListening = this.deps.listen(this.deps.id, (e) => this.event(e));
    this.started = this.deps.call("dictation.start", { session: this.deps.id, ...(this.deps.locale ? { locale: this.deps.locale } : {}) });
    try {
      await this.started;
    } catch (e) {
      this.ended = true;
      this.release();
      throw e;
    }
  }

  /** What is being said still arrives, then the end. */
  stop(): void {
    if (!this.ended) this.afterStart("dictation.stop");
  }

  /** Ends now, dropping what is being said; nothing more is reported (the box is going away). */
  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.release();
    this.afterStart("dictation.cancel");
  }

  /** Sends `method` for this session once the start answered; after a failed start nothing runs, so nothing is sent. */
  private afterStart(method: "dictation.stop" | "dictation.cancel"): void {
    void (this.started ?? Promise.resolve()).then(
      () => this.deps.call(method, { session: this.deps.id }).catch(() => {}),
      () => {},
    );
  }

  private event(e: DictationEvent): void {
    if (this.ended) return;
    switch (e.type) {
      case "partial":
        this.on.partial(e.text);
        break;
      case "final":
        this.on.final(e.text);
        break;
      case "error":
        this.on.error(e.message);
        break;
      case "end":
        this.ended = true;
        this.release();
        this.on.end();
        break;
      case "listening":
        break;
    }
  }

  private release(): void {
    this.stopListening?.();
    this.stopListening = null;
  }
}
