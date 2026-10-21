import type { Agent, AppEvent, Notification } from "@/core/gen";

interface Tracked {
  hostId: string;
  n: Notification;
  /** Needs-you: the request was seen pending, so its absence later means it was resolved. */
  seen: boolean;
  read: boolean;
  resolved: boolean;
}

const RING = 100;

/**
 * The demo backend's copy of the core's notification sync (crates/tf-client `Inner::sync_needs`,
 * `mark_read`): needs-you notifications resolve when their request leaves host state, and
 * `app.notifyRead` marks notifications read. Both are reported as `notifyDone`. The demo has no
 * OS notifications to retract.
 */
export class NotifySync {
  private readonly agents = new Map<string, Map<string, Agent>>();
  private tracked: Tracked[] = [];

  constructor(private readonly emit: (e: AppEvent) => void) {}

  /** Feed every event the backend emitted (after emitting it). */
  observe(e: AppEvent): void {
    switch (e.type) {
      case "hostSnapshot":
        this.agents.set(e.hostId, new Map(e.state.agents.map((a) => [a.id, a])));
        this.sync(e.hostId);
        break;
      case "hostPatch": {
        const agents = this.agents.get(e.hostId);
        if (!agents) break;
        for (const op of e.ops) {
          if (op.op !== "agent") continue;
          if (op.value) agents.set(op.id, op.value);
          else agents.delete(op.id);
        }
        this.sync(e.hostId);
        break;
      }
      case "notify": {
        const seen = e.notification.kind === "needs" && this.request(e.hostId, e.notification) === "pending";
        this.tracked = [...this.tracked.slice(-(RING - 1)), { hostId: e.hostId, n: e.notification, seen, read: false, resolved: false }];
        break;
      }
    }
  }

  /** `app.notifyRead`. */
  read(hostId: string, agentId?: string): void {
    const ids: string[] = [];
    for (const t of this.tracked) {
      if (t.read || t.hostId !== hostId || (agentId !== undefined && t.n.agentId !== agentId)) continue;
      t.read = true;
      ids.push(t.n.id);
    }
    if (ids.length) this.emit({ type: "notifyDone", hostId, ids, resolved: false });
  }

  /** A host went away: its notifications can't need anyone any more. */
  forget(hostId: string): void {
    this.agents.delete(hostId);
    const ids = this.tracked.filter((t) => t.hostId === hostId && t.n.kind === "needs" && !t.resolved).map((t) => t.n.id);
    this.tracked = this.tracked.filter((t) => t.hostId !== hostId);
    if (ids.length) this.emit({ type: "notifyDone", hostId, ids, resolved: true });
  }

  private request(hostId: string, n: Notification): "pending" | "handled" | "agentGone" {
    const a = this.agents.get(hostId)?.get(n.agentId);
    if (!a || a.archived) return "agentGone";
    return a.needs && a.needs.requestId === n.requestId ? "pending" : "handled";
  }

  private sync(hostId: string): void {
    const ids: string[] = [];
    for (const t of this.tracked) {
      if (t.hostId !== hostId || t.n.kind !== "needs" || t.resolved) continue;
      const r = this.request(hostId, t.n);
      if (r === "pending") t.seen = true;
      else if (r === "agentGone" || t.seen) {
        t.read = true;
        t.resolved = true;
        ids.push(t.n.id);
      }
    }
    if (ids.length) this.emit({ type: "notifyDone", hostId, ids, resolved: true });
  }
}
