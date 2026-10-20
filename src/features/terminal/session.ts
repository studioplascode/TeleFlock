import type { Terminal } from "@xterm/xterm";
import { core, termBus, toApiError } from "@/core";
import type { ApiError, ScrollDirection, TermEvent, TermMode, TermTarget } from "@/core/gen";
import { decodeBase64 } from "./frames";

/** Lifecycle of one attached terminal. */
export type TermPhase =
  | { k: "idle" }
  | { k: "opening"; takeover: boolean }
  | { k: "live"; termId: string; paneId: string; title?: string }
  | { k: "closed"; reason: string; takenOver: boolean }
  | { k: "error"; error: ApiError };

type FrameEvent = Extract<TermEvent, { k: "frame" }>;

export interface TermSessionOpts {
  hostId: string;
  target: TermTarget;
  mode: TermMode;
  term: Terminal;
  onPhase(phase: TermPhase): void;
  /** Every frame after it has been written (liveness, observe-mode sizing). */
  onFrame(ev: FrameEvent): void;
}

const TAKEN_OVER_RE = /taken over|takeover/i;
/** No frame this long after attaching → nudge herdr with a resize, which forces a full repaint. */
const FIRST_FRAME_NUDGE_MS = 1500;

/**
 * Imperative owner of one herdr terminal attachment: `term.open` → termBus frames → xterm,
 * input/resize/scroll forwarding and `term.close`. React only renders the phase it reports.
 */
export class TermSession {
  private gen = 0;
  private termId: string | null = null;
  private unsub: (() => void) | null = null;
  private nudge: number | undefined;
  private gotFrame = false;
  private disposed = false;
  phase: TermPhase = { k: "idle" };
  /** Grid size sent with the latest `term.open` (observers crop to it). */
  openedSize: { cols: number; rows: number } | null = null;

  constructor(private readonly o: TermSessionOpts) {}

  get currentTermId(): string | null {
    return this.termId;
  }

  private setPhase(p: TermPhase) {
    this.phase = p;
    this.o.onPhase(p);
  }

  /** (Re)attach. Any current attachment is released first. */
  async open(takeover: boolean): Promise<void> {
    const gen = ++this.gen;
    this.detach(true);
    this.setPhase({ k: "opening", takeover });
    const { cols, rows } = this.o.term;
    this.openedSize = { cols, rows };
    let opened;
    try {
      opened = await core.host(this.o.hostId).call("term.open", { target: this.o.target, cols, rows, mode: this.o.mode, takeover });
    } catch (e) {
      if (gen === this.gen && !this.disposed) this.setPhase({ k: "error", error: toApiError(e) });
      return;
    }
    if (gen !== this.gen || this.disposed) {
      // Superseded while opening: release the lease we just got.
      void core.host(this.o.hostId).call("term.close", { termId: opened.termId }).catch(() => {});
      return;
    }
    this.termId = opened.termId;
    this.gotFrame = false;
    this.unsub = termBus.subscribe(this.o.hostId, opened.termId, (ev) => this.onEvent(gen, ev));
    if (gen !== this.gen) return; // a replayed `closed` already ended it
    this.setPhase({ k: "live", termId: opened.termId, paneId: opened.paneId, title: opened.title });
    this.nudge = window.setTimeout(() => {
      if (gen === this.gen && !this.gotFrame) this.resize(this.o.term.cols, this.o.term.rows);
    }, FIRST_FRAME_NUDGE_MS);
  }

  private onEvent(gen: number, ev: TermEvent) {
    if (gen !== this.gen) return;
    switch (ev.k) {
      case "frame":
        this.gotFrame = true;
        this.o.term.write(decodeBase64(ev.data));
        this.o.onFrame(ev);
        break;
      case "title":
        if (this.phase.k === "live") this.setPhase({ ...this.phase, title: ev.title });
        break;
      case "closed":
        this.gen++;
        this.detach(false);
        this.setPhase({ k: "closed", reason: ev.reason, takenOver: TAKEN_OVER_RE.test(ev.reason) });
        break;
      case "error":
        this.gen++;
        this.detach(true);
        this.setPhase({ k: "error", error: { code: "herdr_error", message: ev.message, retryable: true } });
        break;
    }
  }

  /** Drop the subscription; `release` also sends `term.close` (not needed after `closed`). */
  private detach(release: boolean) {
    clearTimeout(this.nudge);
    this.unsub?.();
    this.unsub = null;
    const termId = this.termId;
    this.termId = null;
    if (release && termId) void core.host(this.o.hostId).call("term.close", { termId }).catch(() => {});
  }

  /** Host went away: the attachment is gone with it; keep the last screen, wait for reconnect. */
  hostLost() {
    this.gen++;
    clearTimeout(this.nudge);
    this.unsub?.();
    this.unsub = null;
    this.termId = null;
  }

  input(data: string) {
    if (this.termId && this.o.mode === "control") core.termInput(this.o.hostId, this.termId, data);
  }

  /** Control only: hostd answers `unsupported` for observers (their crop size is fixed at open). */
  resize(cols: number, rows: number) {
    if (!this.termId || this.o.mode !== "control") return;
    void core.host(this.o.hostId).call("term.resize", { termId: this.termId, cols, rows }).catch(() => {});
  }

  /** Host scrollback (herdr `terminal.scroll`); control only, like resize. */
  scroll(direction: ScrollDirection, lines: number) {
    if (!this.termId || lines <= 0 || this.o.mode !== "control") return;
    void core.host(this.o.hostId).call("term.scroll", { termId: this.termId, direction, lines }).catch(() => {});
  }

  dispose() {
    this.disposed = true;
    this.gen++;
    this.detach(true);
  }
}
