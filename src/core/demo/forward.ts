import type { AppEvent, ForwardList, ForwardRule, ForwardState, ForwardStatus, ForwardStream } from "@/core/gen";
import { fieldErrorMessage, firstFieldError, ruleErrors } from "../forward";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

/** A demo host as forwarding sees it. */
export interface ForwardHost {
  id: string;
  name: string;
  online: boolean;
}

export interface DemoForwardEnv {
  clock: DemoClock;
  emit(e: AppEvent): void;
  /** The demo hosts that exist, with whether each is connected right now. */
  hosts(): ForwardHost[];
}

/** Listen ports the demo's from-hosts can't bind, with the OS's reason (so the port error row can be checked). */
const BUSY_PORTS: Record<number, string> = {
  5432: "address already in use (another program on this host listens there)",
  80: "permission denied (ports below 1024 need root)",
};

/** How often byte counters move, as the real core reports them (at most every ~2 s). */
const TICK_MS = 2000;

/**
 * The demo host's forwarding: rules over the demo hosts with the contract's validation and `forward.*`
 * semantics (docs/architecture.md §6.7), a live status per rule from the hosts' connections, and a few
 * fake active streams whose byte counters grow. Nothing is persisted.
 */
export class DemoForwards {
  private rules: ForwardRule[] = [];
  private streams: ForwardStream[] = [];
  private nextRule = 1;
  private nextStream = 1;
  private stopTick: (() => void) | null = null;
  private lastOnline = new Map<string, boolean>();
  /** Streams a seeded rule opens each time it turns ready (both of its hosts connected). */
  private readonly seeded = new Map<string, () => void>();
  private readonly wasReady = new Set<string>();

  constructor(private readonly env: DemoForwardEnv) {}

  /** Two rules over the seeded demo hosts and the streams one of them has open. */
  seed(): void {
    const hosts = this.env.hosts();
    const forge = hosts.find((h) => h.id === "forge");
    const studio = hosts.find((h) => h.id === "studio-pc");
    if (!forge || !studio) return;
    const a = this.addRule({ id: "", fromHost: forge.id, toHost: studio.id, name: "studio-pc", enabled: true, shell: true, tools: ["agent-browser"], ports: [{ listen: 9222, target: 9222 }] });
    this.addRule({ id: "", fromHost: studio.id, toHost: forge.id, name: "forge", enabled: true, shell: true, tools: [], ports: [{ listen: 5432, target: 5432 }] });
    // studio-pc connects only when asked to (and flaps), so these appear when it does.
    this.seeded.set(a.id, () => {
      this.openStream(a.id, "tool", "agent-browser open http://localhost:3000", 38_000, 12_400, 380_000);
      this.openStream(a.id, "port", "127.0.0.1:9222 → 9222", 212_000, 48_000, 1_950_000);
      this.openStream(a.id, "command", "pnpm test --filter web", 7_000, 900, 14_300);
    });
  }

  list(): ForwardList {
    return {
      rules: this.rules,
      status: this.rules.map((r) => this.statusOf(r)),
      streams: this.streams,
    };
  }

  save(rule: ForwardRule): ForwardList {
    const existing = rule.id ? this.rules.find((r) => r.id === rule.id) : undefined;
    if (rule.id && !existing) throw apiError("not_found", `Unknown forward ${rule.id}`);
    const others = this.rules.filter((r) => r.id !== rule.id);
    const bad = firstFieldError(ruleErrors(rule, this.env.hosts(), others));
    if (bad) throw apiError("invalid_params", fieldErrorMessage(bad));
    if (existing) {
      const next: ForwardRule = { ...rule, tools: [...rule.tools], ports: rule.ports.map((p) => ({ ...p })) };
      this.rules = this.rules.map((r) => (r.id === next.id ? next : r));
      this.streams = this.streams.filter((s) => s.ruleId !== next.id || this.allowed(next, s));
    } else {
      this.addRule(rule);
    }
    this.changed();
    return this.list();
  }

  remove(id: string): ForwardList {
    if (!this.rules.some((r) => r.id === id)) throw apiError("not_found", `Unknown forward ${id}`);
    this.rules = this.rules.filter((r) => r.id !== id);
    this.streams = this.streams.filter((s) => s.ruleId !== id);
    this.changed();
    return this.list();
  }

  stop(streamId: string): ForwardList {
    if (!this.streams.some((s) => s.id === streamId)) throw apiError("not_found", `Unknown stream ${streamId}`);
    this.streams = this.streams.filter((s) => s.id !== streamId);
    this.changed();
    return this.list();
  }

  /** A demo host was added, removed, connected or disconnected. Rules naming a removed host go; streams of rules that are not ready end. */
  hostsChanged(): void {
    const hosts = this.env.hosts();
    const ids = new Set(hosts.map((h) => h.id));
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => ids.has(r.fromHost) && ids.has(r.toHost));
    const online = new Map(hosts.map((h) => [h.id, h.online]));
    let moved = before !== this.rules.length;
    for (const h of hosts) {
      if (this.lastOnline.get(h.id) !== h.online) moved = true;
    }
    this.lastOnline = online;
    if (moved) this.changed();
  }

  dispose(): void {
    this.stopTick?.();
    this.stopTick = null;
  }

  private addRule(rule: ForwardRule): ForwardRule {
    const added: ForwardRule = { ...rule, id: `fr-${this.nextRule++}`, tools: [...rule.tools], ports: rule.ports.map((p) => ({ ...p })) };
    this.rules = [...this.rules, added];
    return added;
  }

  private openStream(ruleId: string, kind: ForwardStream["kind"], label: string, ageMs: number, up: number, down: number): void {
    this.streams = [...this.streams, { id: `fs-${this.nextStream++}`, ruleId, kind, label, startedAt: this.env.clock.now() - ageMs, bytesUp: up, bytesDown: down }];
  }

  /** Does the saved rule still allow what this stream is doing? */
  private allowed(rule: ForwardRule, s: ForwardStream): boolean {
    switch (s.kind) {
      case "command":
      case "shell":
        return rule.shell;
      case "tool":
        return rule.tools.includes(s.label.split(" ")[0] ?? "");
      case "port":
        return rule.ports.some((p) => s.label.startsWith(`127.0.0.1:${p.listen} `));
      // Browser connections never run through a rule (tf-client forward.rs).
      case "browser":
        return false;
    }
  }

  private statusOf(rule: ForwardRule): ForwardStatus {
    const hosts = this.env.hosts();
    const offline = [rule.fromHost, rule.toHost].map((id) => hosts.find((h) => h.id === id)).filter((h): h is ForwardHost => !!h && !h.online);
    let state: ForwardState = "ready";
    let message: string | undefined;
    if (!rule.enabled) state = "disabled";
    else if (offline.length > 0) {
      state = "waiting";
      message = `Waiting for ${offline.map((h) => h.name).join(" and ")} to connect`;
    }
    const portErrors = state === "ready" ? rule.ports.filter((p) => BUSY_PORTS[p.listen]).map((p) => ({ listen: p.listen, message: BUSY_PORTS[p.listen] as string })) : [];
    return { id: rule.id, state, message, portErrors };
  }

  /** Streams of rules that are off or not ready end, seeded ones open when their rule turns ready, and the counters tick only while something is open. */
  private sync(): void {
    const ready = new Set(this.rules.filter((r) => this.statusOf(r).state === "ready").map((r) => r.id));
    this.streams = this.streams.filter((s) => ready.has(s.ruleId));
    for (const [ruleId, open] of this.seeded) {
      if (ready.has(ruleId) && !this.wasReady.has(ruleId)) open();
    }
    this.wasReady.clear();
    for (const id of ready) this.wasReady.add(id);
    if (this.streams.length > 0 && !this.stopTick) {
      this.stopTick = this.env.clock.every(TICK_MS, () => this.tick());
    } else if (this.streams.length === 0 && this.stopTick) {
      this.stopTick();
      this.stopTick = null;
    }
  }

  private changed(): void {
    this.sync();
    this.env.emit({ type: "forwards", forwards: this.list() });
  }

  private tick(): void {
    this.streams = this.streams.map((s, i) => ({
      ...s,
      bytesUp: s.bytesUp + (s.kind === "port" ? 1_800 : 220 + i * 40),
      bytesDown: s.bytesDown + (s.kind === "port" ? 21_000 : 1_400 + i * 300),
    }));
    this.env.emit({ type: "forwards", forwards: this.list() });
  }
}
