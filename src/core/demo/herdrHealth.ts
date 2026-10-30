/**
 * Demo herdr server health (`HostInfo.herdrHealth`, `host.herdrRestart`, `host.herdrLoad`,
 * `host.herdrConfig`): forge runs herdr 0.9.5 with 0.9.6 installed (a live-handoff update waiting while
 * "2 agents working", idle 45 s after start, then the 20-minute idle window counts down); studio-pc
 * runs 0.9.0 with nothing to load.
 *
 * - `host.herdrRestart {force: true}` replaces the server: restarting (2.5 s) → starting (3 s) → up, a
 *   new epoch and the installed version.
 * - `herdr server stop` typed in a demo shell stops it like the incident did: down at once (cause
 *   `stopped`, the omp agents ended), started again after 12 s, or by Restart herdr right away.
 * - `host.herdrLoad` hands the panes over (updating 3 s → up, panes kept) or, for a herdr too old for
 *   that, stops and starts it (mode `restart`).
 * - `host.herdrConfig` changes the settings; an idle window of `idleMinutes` after the session went
 *   idle loads the update by itself (a short window makes that visible in the demo).
 */
import type { HerdrConfigParams, HerdrHealth, HerdrUpdate } from "../gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

const MIN = 60_000;
/** forge's agents stop being busy this long after start. */
const BUSY_MS = 45_000;
const RETRY_MS = 12_000;
const RESTART_MS = 2500;
const START_MS = 3000;
const HANDOFF_MS = 3000;

export class DemoHerdr {
  private h: HerdrHealth;
  private readonly installed: string;
  private cancel: (() => void) | null = null;
  private cancelIdle: (() => void) | null = null;

  constructor(
    variant: "forge" | "studio",
    private readonly clock: DemoClock,
    /** omp agents live right now: what an outage ends. */
    private readonly liveAgents: () => number,
    /** Called with the new health after every change (the host patches `HostInfo.herdrHealth`). */
    private readonly onChange: (h: HerdrHealth) => void,
  ) {
    const now = clock.now();
    const base = { since: now - 3 * 60 * MIN, epoch: 1, pid: 4894, keptPanes: false, herdrResumes: false, endedAgents: 0, attempt: 0, restartHeld: false, configEdited: false, config: { autoRestart: true, idleUpdate: true, idleMinutes: 20 } };
    if (variant === "forge") {
      this.installed = "0.9.6";
      const update: HerdrUpdate = { state: "waiting", from: "0.9.5", to: "0.9.6", mode: "handoff", blockers: ["2 agents working"] };
      this.h = { ...base, state: "up", version: "0.9.5", update };
      this.cancelIdle = clock.after(BUSY_MS, () => this.goIdle());
    } else {
      this.installed = "0.9.0";
      this.h = { ...base, state: "up", version: "0.9.0" };
    }
  }

  status(): HerdrHealth {
    return this.h;
  }

  stop(): void {
    this.cancel?.();
    this.cancelIdle?.();
    this.cancel = this.cancelIdle = null;
  }

  call(method: string, p: Record<string, unknown>): HerdrHealth {
    switch (method) {
      case "host.herdrRestart":
        return this.restart(p.force === true);
      case "host.herdrLoad":
        return this.load();
      case "host.herdrConfig":
        return this.configure(p as HerdrConfigParams);
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  /** The demo shell's `herdr server stop`: what the incident looked like (every pane process gone, server away). */
  stopServer(cause: "stopped" | "crashed" = "stopped"): void {
    if (this.h.state !== "up" && this.h.state !== "unresponsive") return;
    this.cancelIdle?.();
    this.cancelIdle = null;
    const now = this.clock.now();
    this.set({ state: "down", since: now, downAt: now, cause, endedAgents: this.liveAgents(), attempt: 0, error: undefined, retryAt: this.h.config.autoRestart ? now + RETRY_MS : undefined, keptPanes: false, pid: undefined });
    if (this.h.config.autoRestart) this.after(RETRY_MS, () => this.start());
  }

  // ------------------------------------------------------------------------------ transitions

  private restart(force: boolean): HerdrHealth {
    const s = this.h.state;
    if (s === "starting" || s === "restarting" || s === "updating") return this.h;
    if (s === "down") {
      this.start();
      return this.h;
    }
    if (!force) return this.h;
    this.beginRestart("restart");
    return this.h;
  }

  /** The running server stops (its panes end) and starts again. */
  private beginRestart(cause: "restart" | "update"): void {
    this.cancel?.();
    this.cancelIdle?.();
    const now = this.clock.now();
    this.set({ state: "restarting", since: now, downAt: now, cause, endedAgents: this.liveAgents(), attempt: 0, error: undefined, retryAt: undefined, keptPanes: false, pid: undefined, ...(this.h.update && cause === "update" ? { update: { ...this.h.update, state: "running" } } : {}) });
    this.after(RESTART_MS, () => this.start());
  }

  /** Starts a server now (backoff skipped): starting → up. */
  private start(): void {
    this.cancel?.();
    const now = this.clock.now();
    this.set({ state: "starting", since: now, attempt: this.h.attempt + 1, retryAt: undefined });
    this.after(START_MS, () => this.up(false));
  }

  private up(keptPanes: boolean): void {
    const now = this.clock.now();
    const version = this.installed;
    const wasLoading = this.h.update && this.h.update.state !== "waiting" && this.h.update.state !== "manual";
    const update: HerdrUpdate | undefined = this.h.update && (wasLoading || version === this.h.update.to) ? { ...this.h.update, state: "done", at: now, blockers: [], idleSince: undefined, dueAt: undefined, error: undefined } : this.h.update;
    this.set({
      state: "up",
      since: now,
      epoch: this.h.epoch + 1,
      version,
      pid: 5100 + this.h.epoch,
      downAt: undefined,
      cause: undefined,
      keptPanes,
      attempt: 0,
      retryAt: undefined,
      error: undefined,
      update,
    });
  }

  private load(): HerdrHealth {
    const u = this.h.update;
    if (this.h.state !== "up") throw apiError("invalid_params", "herdr isn't running: start it first", { hint: "Restart herdr starts the installed version." });
    if (!u || u.state === "done" || u.state === "running") throw apiError("invalid_params", "Nothing to load: the running herdr is the installed one");
    this.cancelIdle?.();
    this.cancelIdle = null;
    if (u.mode === "restart") {
      this.beginRestart("update");
      return this.h;
    }
    this.set({ state: "updating", since: this.clock.now(), update: { ...u, state: "running", idleSince: undefined, dueAt: undefined } });
    this.after(HANDOFF_MS, () => this.up(true));
    return this.h;
  }

  private configure(p: HerdrConfigParams): HerdrHealth {
    if (p.idleMinutes !== undefined && (!Number.isInteger(p.idleMinutes) || p.idleMinutes < 1 || p.idleMinutes > 1440)) throw apiError("invalid_params", "idleMinutes must be 1–1440");
    const config = { ...this.h.config, ...(p.autoRestart !== undefined && { autoRestart: p.autoRestart }), ...(p.idleUpdate !== undefined && { idleUpdate: p.idleUpdate }), ...(p.idleMinutes !== undefined && { idleMinutes: p.idleMinutes }) };
    let update = this.h.update;
    if (update?.state === "waiting" && !config.idleUpdate) update = { ...update, state: "manual", dueAt: undefined };
    else if (update?.state === "manual" && config.idleUpdate) update = { ...update, state: "waiting" };
    this.set({ config, update });
    // an idle session counts to the new window
    if (update?.state === "waiting" && update.idleSince !== undefined) this.schedule(update.idleSince);
    // a down server with the automatic restart switched on starts again
    if (this.h.state === "down") {
      if (!config.autoRestart) {
        this.cancel?.();
        this.set({ retryAt: undefined });
      } else if (this.h.retryAt === undefined) {
        const at = this.clock.now() + RETRY_MS;
        this.set({ retryAt: at });
        this.after(RETRY_MS, () => this.start());
      }
    }
    return this.h;
  }

  /** The agents went quiet: the idle window starts counting. */
  private goIdle(): void {
    const u = this.h.update;
    this.cancelIdle = null;
    if (this.h.state !== "up" || u?.state !== "waiting") return;
    this.set({ update: { ...u, blockers: [] } });
    this.schedule(this.clock.now());
  }

  /** Idle since `idleSince`: loads by itself when the window ends. */
  private schedule(idleSince: number): void {
    const u = this.h.update;
    if (!u || u.state !== "waiting") return;
    const dueAt = idleSince + this.h.config.idleMinutes * MIN;
    this.set({ update: { ...u, idleSince, dueAt, blockers: [] } });
    this.cancelIdle?.();
    this.cancelIdle = this.clock.after(Math.max(0, dueAt - this.clock.now()), () => {
      this.cancelIdle = null;
      if (this.h.state === "up" && this.h.update?.state === "waiting") this.load();
    });
  }

  private after(ms: number, fn: () => void): void {
    this.cancel?.();
    this.cancel = this.clock.after(ms, () => {
      this.cancel = null;
      fn();
    });
  }

  private set(change: Partial<HerdrHealth>): void {
    this.h = { ...this.h, ...change };
    this.onChange(this.h);
  }
}
