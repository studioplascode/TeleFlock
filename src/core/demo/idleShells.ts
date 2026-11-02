/**
 * tf-hostd's idle shells for the demo (`HostInfo.idleShells`, `cleanup.idleShellsSet`, `cleanup.idleShellsClose`,
 * architecture §3.17). forge starts with three shells nobody has touched for a day or more, each its workspace's
 * only pane (dotfiles, ~ and notes: `data.ts` WORKSPACES and `shells.ts`), and closing them by itself switched off,
 * so the board offers it. Like tf-hostd, a check every minute lists every shell at its prompt in a workspace
 * without an agent (live, parked or ended), shown in no terminal, with no input or output for the threshold; with
 * `auto` on it closes them, logs each in Activity, posts one info notification and keeps `lastClosed`. Switching
 * `auto` on closes the listed shells 3 s later. studio-pc plays a tf-hostd before 0.9.0: no `idleShells`, and the
 * methods are unknown.
 */
import { apiError, toApiError } from "../errors";
import type { HostState, IdleShell, IdleShellKept, IdleShells, IdleShellsCloseResult, IdleShellsClosed, PaneInfo, Workspace } from "../gen";
import { HOME } from "./data";

const MIN = 60_000;
/** tf-hostd checks every minute. */
const CHECK_MS = MIN;
/** Switching `auto` on: the demo's tf-hostd closes what is listed this soon (a real one at its next check). */
const AUTO_MS = 3000;
/** Foreground processes that are a shell at its prompt. */
const SHELLS: Record<string, true> = { bash: true, zsh: true, fish: true, sh: true };

/** forge's idle shells when the demo starts, by workspace: idle for how long, what ran in them last. */
const SEEDS: Record<string, { idleMin: number; lastCommand?: string }> = {
  w15: { idleMin: 26 * 60 + 40, lastCommand: "git pull --rebase" },
  w16: { idleMin: (3 * 24 + 5) * 60 },
  w17: { idleMin: 31 * 60, lastCommand: "vim todo.md" },
};

/** What the simulated idle shells need from their demo host. */
export interface IdleShellsHostEnv {
  /** false: the host's tf-hostd predates idle shells. */
  supported(): boolean;
  now(): number;
  after(ms: number, fn: () => void): void;
  /** The board now: workspaces with their panes' processes; agents, parked and ended ones included. */
  state(): HostState;
  /** A TeleFlock terminal shows this pane. */
  viewed(paneId: string): boolean;
  /** herdr closes the pane, and its workspace with its last pane; throws like herdr. */
  closePane(paneId: string): void;
  /** `HostInfo.idleShells` changed. */
  publish(idle: IdleShells): void;
  /** One Activity event without an agent, under the workspace's label. */
  activity(workspace: string, title: string, detail: string): void;
  /** One info notification. */
  notify(title: string, body: string): void;
}

/** tf-hostd's words for a span: "45 min", "26 h", "4 days" (hours up to 72). */
function words(minutes: number): string {
  const m = Math.max(1, Math.floor(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h > 72 ? `${Math.floor(h / 24)} days` : `${h} h`;
}

interface Scan {
  /** Idle now, longest idle first. */
  shells: IdleShell[];
  /** Why each other pane is not idle. */
  why: Map<string, string>;
  /** Every pane, with its workspace. */
  panes: Map<string, { ws: Workspace; pane: PaneInfo }>;
}

export class DemoIdleShells {
  private auto = false;
  private minutes = 1440;
  private lastClosed?: IdleShellsClosed;
  /** Each pane's last input or output: when a check first saw it, or since when its seed has been idle. */
  private readonly io = new Map<string, number>();
  private readonly lastCommand = new Map<string, string>();
  private seeded = false;
  private nextCheck = 0;
  /** The last published `idleShells` (JSON): an unchanged list isn't published again. */
  private published = "";

  constructor(private readonly env: IdleShellsHostEnv) {}

  /** `HostInfo.idleShells`; absent on a host before 0.9.0. */
  status(): IdleShells | undefined {
    return this.env.supported() ? this.view(this.scan().shells) : undefined;
  }

  /** The host's tick: tf-hostd's check, once a minute. */
  tick(): void {
    if (!this.env.supported() || this.env.now() < this.nextCheck) return;
    this.nextCheck = this.env.now() + CHECK_MS;
    this.check();
  }

  call(method: string, p: Record<string, unknown>): IdleShells | IdleShellsCloseResult {
    if (!this.env.supported()) throw apiError("unknown_method", `unknown method \`${method}\``);
    if (method === "cleanup.idleShellsSet") return this.set(p);
    if (method === "cleanup.idleShellsClose") return this.close(p);
    throw apiError("unknown_method", `unknown method \`${method}\``);
  }

  private view(shells: IdleShell[]): IdleShells {
    return { auto: this.auto, minutes: this.minutes, shells, ...(this.lastClosed ? { lastClosed: this.lastClosed } : {}) };
  }

  private scan(): Scan {
    const now = this.env.now();
    const { workspaces, agents } = this.env.state();
    const withAgent = new Set(agents.map((a) => a.workspaceId));
    const out: Scan = { shells: [], why: new Map(), panes: new Map() };
    for (const ws of workspaces) {
      const panes = ws.tabs.flatMap((t) => t.panes);
      for (const pane of panes) {
        out.panes.set(pane.id, { ws, pane });
        const seed = this.seeded ? undefined : SEEDS[ws.id];
        if (seed?.lastCommand) this.lastCommand.set(pane.id, seed.lastCommand);
        if (!this.io.has(pane.id)) this.io.set(pane.id, now - (seed?.idleMin ?? 0) * MIN);
        const busy = pane.agentId || withAgent.has(ws.id) ? "Its workspace has an agent" : !SHELLS[pane.process ?? ""] ? `It runs ${pane.process ?? "a program"}` : this.env.viewed(pane.id) ? "A terminal shows it" : null;
        if (busy) {
          // in use: its idle time starts again
          this.io.set(pane.id, now);
          out.why.set(pane.id, busy);
          continue;
        }
        const since = this.io.get(pane.id) ?? now;
        if (now - since < this.minutes * MIN) {
          out.why.set(pane.id, `It was used ${words((now - since) / MIN)} ago`);
          continue;
        }
        const last = this.lastCommand.get(pane.id);
        out.shells.push({
          paneId: pane.id,
          terminalId: pane.terminalId ?? "",
          workspaceId: ws.id,
          workspace: ws.label,
          cwd: pane.cwd ?? ws.cwd,
          shell: pane.process ?? "",
          idleSince: since,
          ...(last ? { lastCommand: last } : {}),
          closesWorkspace: panes.length === 1,
        });
      }
    }
    this.seeded = true;
    for (const id of [...this.io.keys()]) {
      if (out.panes.has(id)) continue;
      this.io.delete(id);
      this.lastCommand.delete(id);
    }
    out.shells.sort((a, b) => a.idleSince - b.idleSince);
    return out;
  }

  private publish(shells: IdleShell[]): IdleShells {
    const idle = this.view(shells);
    const key = JSON.stringify(idle);
    if (key !== this.published) {
      this.published = key;
      this.env.publish(idle);
    }
    return idle;
  }

  /** Activity for one closed shell; `auto`: the check closed it. */
  private logClosed(s: IdleShell, auto: boolean): void {
    const cwd = s.cwd ?? "";
    const where = cwd === HOME ? "~" : cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd || s.shell;
    const how = auto ? ` · automatically after ${words(this.minutes)} idle` : "";
    this.env.activity(s.workspace, `Closed idle shell ${s.shell}`, `${where} · idle ${words((this.env.now() - s.idleSince) / MIN)}${how}`);
  }

  /** tf-hostd's check: with `auto` on, closes every idle shell (one notification for all); publishes what changed. */
  private check(): IdleShells {
    const shells = this.scan().shells;
    if (!this.auto || shells.length === 0) return this.publish(shells);
    const done: IdleShell[] = [];
    for (const s of shells) {
      try {
        this.env.closePane(s.paneId);
      } catch {
        continue;
      }
      done.push(s);
      this.logClosed(s, true);
    }
    if (done.length > 0) {
      const workspaces = [...new Set(done.map((s) => s.workspace))];
      this.lastClosed = { at: this.env.now(), count: done.length, workspaces };
      const list = workspaces.length > 1 ? `${workspaces.slice(0, -1).join(", ")} and ${workspaces.at(-1)}` : workspaces.join("");
      this.env.notify(`Closed ${done.length} idle shell${done.length === 1 ? "" : "s"}`, `${list}: no input or output for ${words(this.minutes)}`);
    }
    return this.publish(this.scan().shells);
  }

  private set(p: Record<string, unknown>): IdleShells {
    if (p.auto !== undefined && typeof p.auto !== "boolean") throw apiError("invalid_params", "auto must be true or false");
    const m = p.minutes;
    if (m !== undefined && (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 43_200)) throw apiError("invalid_params", "minutes must be a whole number from 1 to 43200 (30 days)");
    const switchedOn = p.auto === true && !this.auto;
    if (typeof p.auto === "boolean") this.auto = p.auto;
    if (typeof m === "number") this.minutes = m;
    if (switchedOn) this.env.after(AUTO_MS, () => this.check());
    return this.publish(this.scan().shells);
  }

  /** Closes the shells asked for, each checked again right before: one in use or no longer idle stays open. */
  private close(p: Record<string, unknown>): IdleShellsCloseResult {
    if (!Array.isArray(p.shells)) throw apiError("invalid_params", "missing shells");
    const closed: string[] = [];
    const kept: IdleShellKept[] = [];
    for (const ref of p.shells as unknown[]) {
      const r = (ref ?? {}) as Record<string, unknown>;
      const paneId = typeof r.paneId === "string" ? r.paneId : "";
      const found = this.scan();
      const at = found.panes.get(paneId);
      const shell = found.shells.find((s) => s.paneId === paneId);
      if (!at || !shell || shell.terminalId !== r.terminalId) {
        const message = !at ? "No such pane any more" : at.pane.terminalId !== r.terminalId ? "Its pane shows another terminal now" : (found.why.get(paneId) ?? "It isn't idle any more");
        kept.push({ paneId, error: { code: at ? "busy" : "not_found", message, retryable: false } });
        continue;
      }
      try {
        this.env.closePane(paneId);
      } catch (e) {
        kept.push({ paneId, error: toApiError(e).toJSON() });
        continue;
      }
      closed.push(paneId);
      this.logClosed(shell, false);
    }
    return { closed, kept, idle: this.publish(this.scan().shells) };
  }
}
