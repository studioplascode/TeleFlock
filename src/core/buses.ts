import type { Pulse, TermEvent } from "@/core/gen";
import { failureReporter } from "./failures";
import { agentKey } from "./keys";

const pulseFailed = failureReporter("pulse listener");
const termFailed = failureReporter("terminal listener");

export type PulseListener = (p: Pulse, at: number) => void;
export type PulseAllListener = (key: string, p: Pulse, at: number) => void;

/**
 * Liveness ticks per agent, delivered imperatively (no React state): drive heartbeats and
 * orbs from refs. Keys are agent keys (`agentKey(hostId, agentId)`). A subscriber that throws
 * is reported and skipped; the others still get the pulse.
 */
class PulseBus {
  private readonly byKey = new Map<string, Set<PulseListener>>();
  private readonly all = new Set<PulseAllListener>();

  subscribe(key: string, cb: PulseListener): () => void {
    let set = this.byKey.get(key);
    if (!set) {
      set = new Set();
      this.byKey.set(key, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0 && this.byKey.get(key) === set) this.byKey.delete(key);
    };
  }

  /** Every pulse of every agent (global heartbeat, ambient glow). */
  subscribeAll(cb: PulseAllListener): () => void {
    this.all.add(cb);
    return () => this.all.delete(cb);
  }

  emit(hostId: string, at: number, pulses: readonly Pulse[]): void {
    for (const p of pulses) {
      const key = agentKey(hostId, p.agentId);
      const set = this.byKey.get(key);
      if (set) {
        for (const cb of set) {
          try {
            cb(p, at);
          } catch (err) {
            pulseFailed(err);
          }
        }
      }
      for (const cb of this.all) {
        try {
          cb(key, p, at);
        } catch (err) {
          pulseFailed(err);
        }
      }
    }
  }
}

export type TermListener = (ev: TermEvent) => void;

interface TermBuffer {
  events: TermEvent[];
  touchedAt: number;
}

const TERM_BUFFER_MAX = 256;
const TERM_BUFFER_TTL = 15_000;

/**
 * Terminal output per open terminal. Events for terminals nobody listens to yet are buffered
 * (from the last full frame on; ≤ 256 events, 15 s) and replayed to the first subscriber, so a
 * `term.open` caller never misses the initial full frame. A subscriber that throws is reported
 * and skipped; the others (and the rest of a replay) still get every event.
 */
class TermBus {
  private readonly subs = new Map<string, Set<TermListener>>();
  private readonly buffers = new Map<string, TermBuffer>();

  subscribe(hostId: string, termId: string, cb: TermListener): () => void {
    const id = `${hostId}\u0000${termId}`;
    let set = this.subs.get(id);
    if (!set) {
      set = new Set();
      this.subs.set(id, set);
    }
    set.add(cb);
    const buf = this.buffers.get(id);
    if (buf) {
      this.buffers.delete(id);
      for (const ev of buf.events) {
        try {
          cb(ev);
        } catch (err) {
          termFailed(err);
        }
      }
    }
    return () => {
      set.delete(cb);
      if (set.size === 0 && this.subs.get(id) === set) this.subs.delete(id);
    };
  }

  emit(hostId: string, termId: string, ev: TermEvent): void {
    const id = `${hostId}\u0000${termId}`;
    const set = this.subs.get(id);
    if (set && set.size > 0) {
      for (const cb of set) {
        try {
          cb(ev);
        } catch (err) {
          termFailed(err);
        }
      }
      return;
    }
    const now = Date.now();
    this.prune(now);
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = { events: [], touchedAt: now };
      this.buffers.set(id, buf);
    }
    if (ev.k === "frame" && ev.full) buf.events = [];
    buf.events.push(ev);
    if (buf.events.length > TERM_BUFFER_MAX) buf.events.splice(0, buf.events.length - TERM_BUFFER_MAX);
    buf.touchedAt = now;
  }

  private prune(now: number): void {
    for (const [id, buf] of this.buffers) {
      if (now - buf.touchedAt > TERM_BUFFER_TTL) this.buffers.delete(id);
    }
  }
}

export const pulseBus = new PulseBus();
export const termBus = new TermBus();
